/**
 * dsh-host-fs —— 在**宿主进程**里删除 / 移动路径。
 *
 * 为什么需要它：
 *   1. DSH 的 fs 服务只有 stat/read/list/write/edit —— **没有删除**；
 *   2. shell 工具的子进程在 Windows 上跑在 **Low 完整性级别**，而用户的目录
 *      （例如 DSH 自己的 D:\dsh-home）是 Medium 标签 ⇒ 子进程连 unlink 都被拒。
 * 本插件把删除/移动放在宿主进程里执行（与 DSH 自己的 write 工具同一层），
 * 因此拥有与用户本人相同的权限。
 *
 * ⚠️ 为什么是 ESM：schemastery 的 CJS 入口会 require 一个 ESM 包（cosmokit），
 * 在 Electron 宿主里实测抛 ERR_REQUIRE_ESM_RACE_CONDITION ⇒ Config 拿不到、
 * 设置页就没有表单。走 ESM 入口（lib/index.mjs）没有这个竞态。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  assertNotAncestorOfCwd,
  assertNotIntoOwnSubtree,
  decidePath,
  decideSession,
  isLinkLike,
  measureTree,
  resolveConfig,
  resolveTarget,
} from './guard.js'
import { Config } from './config.js'
import { installSettingsRoutes } from './settings-host.js'

const TEXT = (text) => [{ type: 'text', text }]

const log = (ctx, message) => {
  try {
    ctx.logger?.info?.(`[dsh-host-fs] ${message}`)
  } catch {
    // 记日志失败绝不能让工具调用失败
  }
}

/** 会话身份：id 由宿主给（模型伪造不了），preset/cwd 只在提示语里用。 */
function whoOf(exec) {
  const header = exec?.agent?.session?.header
  return {
    sessionId: String(exec?.agent?.id ?? ''),
    preset: header?.agentPreset,
    cwd: header?.cwd,
  }
}

const allowHint = (who) =>
  `要放行就把它加进「设置 → 插件 → dsh-host-fs → sessionList」，这一行可直接复制：${who.sessionId || '(取不到 id)'}`

function sessionDeniedMessage(verdict, who) {
  if (verdict.reason === 'off') {
    return `dsh-host-fs 未开启：sessionMode 现在是 off（默认，谁都不能用）。${allowHint(who)}`
  }
  if (verdict.reason === 'in-denylist') {
    return `本会话在 dsh-host-fs 的黑名单里（命中规则 "${verdict.rule}"，会话 ${who.sessionId}）。从 sessionList 里删掉这条规则才能用。`
  }
  return `本会话不在 dsh-host-fs 的白名单里（会话 ${who.sessionId}）。${allowHint(who)}`
}

function pathDeniedMessage(verdict) {
  if (verdict.reason === 'drive-root') {
    return `拒绝操作驱动器根 "${verdict.target}"：驱动器根永远拒绝，不受任何配置影响。`
  }
  if (verdict.reason === 'denied') {
    return `路径被 pathDeny 规则 "${verdict.rule}" 挡住：${verdict.target}（黑名单优先于白名单）。`
  }
  const parent = path.dirname(verdict.target)
  return (
    `路径不在 pathAllow 里：${verdict.target}（默认拒绝）。` +
    `把它的上级目录加进 pathAllow 即可，例如：${parent}`
  )
}

/** 取审批服务（可选依赖：没装就当作没有，一律拒）。 */
function approvalService(ctx) {
  try {
    return typeof ctx.get === 'function' ? ctx.get('approval') : undefined
  } catch {
    return undefined
  }
}

/** 弹一次审批框。只有 'allowed-once' 算通过；其余一律当拒绝（fail closed）。 */
async function askOnce(ctx, exec, toolName, targets, who) {
  const approval = approvalService(ctx)
  if (!approval || typeof approval.request !== 'function') return false
  const list = targets.map((t) => `- ${t}`).join('\n')
  try {
    const outcome = await approval.request({
      agent: exec.agent,
      toolName,
      reason: `dsh-host-fs（宿主进程文件操作）想动一个不在白名单里的路径。\n${list}\n会话：${who.sessionId}`,
      displayReason: {
        en: `Allow this one operation?\n${list}`,
        zh: `允许这一次操作吗？\n${list}`,
      },
      signal: exec?.signal,
    })
    return outcome === 'allowed-once'
  } catch (error) {
    log(ctx, `approval request failed: ${error?.message ?? error}`)
    return false
  }
}

/** 路径闸门：硬拒直接抛；"未列出"先问审批，问不到就抛。 */
async function assertPaths(ctx, cfg, exec, toolName, who, decisions) {
  const hard = decisions.find((d) => !d.ok && d.reason !== 'unlisted')
  if (hard) throw new Error(pathDeniedMessage(hard))

  const unlisted = decisions.filter((d) => !d.ok)
  if (unlisted.length === 0) return

  if (!cfg.askOutside) {
    throw new Error(pathDeniedMessage(unlisted[0]) + '（askOutside 已关闭，不会弹审批）')
  }
  const granted = await askOnce(
    ctx,
    exec,
    toolName,
    unlisted.map((d) => d.target),
    who,
  )
  if (!granted) {
    throw new Error(
      pathDeniedMessage(unlisted[0]) +
        '（审批未通过，或这个会话拿不到审批框 —— QQ 那边没有审批框，一律拒绝）',
    )
  }
  log(ctx, `approved once: ${unlisted.map((d) => d.target).join(', ')}`)
}

/** Windows 上只读属性会让 unlink 报 EPERM：清一次属性再重试，其余错误照抛。 */
function removePath(target, recursive) {
  try {
    fs.rmSync(target, { recursive, force: true, maxRetries: 2 })
  } catch (error) {
    const code = error?.code
    if (code !== 'EPERM' && code !== 'EACCES') throw error
    try {
      fs.chmodSync(target, 0o666)
    } catch {
      throw error
    }
    fs.rmSync(target, { recursive, force: true, maxRetries: 2 })
  }
}

function makeRemoveTool(ctx, cfg) {
  return {
    name: 'fs_remove',
    description:
      'Delete a file or directory through the HOST process. Use it when DSH\'s own file tools cannot: they have ' +
      'no delete operation at all, and shell commands on Windows run at low integrity so they cannot unlink or ' +
      'write in directories owned at normal integrity (e.g. the DSH home). ' +
      'Access is gated twice: the session must be allowed by the plugin config, and the path must fall inside ' +
      'pathAllow without hitting pathDeny. A path in neither list needs a one-shot approval when askOutside is on. ' +
      'Drive roots are always refused. ' +
      'Pass dryRun first to see exactly what would be removed; non-empty directories need recursive: true. ' +
      'Removes the link itself, never the target, when the path is a symlink or junction.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to remove. A relative path resolves against the session working directory.',
        },
        recursive: { type: 'boolean', description: 'Required to delete a directory that is not empty.' },
        dryRun: { type: 'boolean', description: 'Only measure and report; delete nothing. Do this first when unsure.' },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          kind: { type: 'string', enum: ['file', 'dir', 'link', 'other', 'missing'] },
          entries: { type: 'integer' },
          bytes: { type: 'integer' },
          dryRun: { type: 'boolean' },
          approved: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['path', 'kind', 'entries', 'bytes', 'dryRun'],
      },
      render: (_args, value) =>
        TEXT(
          `${value.dryRun ? 'would remove' : 'removed'} ${value.kind} ${value.path}` +
            (value.entries > 0 ? ` (${value.entries} entries, ${value.bytes} bytes)` : '') +
            (value.approved ? ' [approved once]' : '') +
            (value.note ? ` — ${value.note}` : ''),
        ),
    },
    async execute(args, exec) {
      const who = whoOf(exec)
      const session = decideSession(cfg.mode, cfg.sessions, who)
      if (!session.ok) throw new Error(sessionDeniedMessage(session, who))

      const target = resolveTarget(args.path, who.cwd)
      const decision = decidePath(target, { allow: cfg.pathAllow, deny: cfg.pathDeny })
      await assertPaths(ctx, cfg, exec, 'fs_remove', who, [decision])
      assertNotAncestorOfCwd(target, who.cwd)

      let stat
      try {
        stat = fs.lstatSync(target)
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return {
            path: target,
            kind: 'missing',
            entries: 0,
            bytes: 0,
            dryRun: args.dryRun === true,
            approved: !decision.ok,
            note: 'nothing at that path',
          }
        }
        throw error
      }

      const linkLike = isLinkLike(target)
      const kind = linkLike ? 'link' : stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other'
      if (kind === 'dir') {
        const children = fs.readdirSync(target)
        if (children.length > 0 && args.recursive !== true) {
          throw new Error(
            `directory is not empty (${children.length} entries); pass recursive: true to delete it: ${target}`,
          )
        }
      }

      const { entries, bytes } = linkLike ? { entries: 1, bytes: 0 } : measureTree(target, stat)
      const dryRun = args.dryRun === true
      if (!dryRun) removePath(target, stat.isDirectory())
      log(
        ctx,
        `${dryRun ? 'dry-run' : 'removed'} ${kind} ${target} (${entries} entries, ${bytes} bytes) by ${who.sessionId}`,
      )
      return { path: target, kind, entries, bytes, dryRun, approved: !decision.ok }
    },
  }
}

function makeMoveTool(ctx, cfg) {
  return {
    name: 'fs_move',
    description:
      'Move or rename a path through the HOST process — same rationale as fs_remove: DSH\'s fs service has no ' +
      'move, and a Windows shell child at low integrity cannot rename outside the workspace. ' +
      'Both ends go through the same two gates (allowed session, plus path allow/deny). ' +
      'Creates missing parent directories of the destination, refuses to clobber an existing destination unless ' +
      'overwrite=true, refuses to move a directory into its own subtree, and fails with a clear error across ' +
      'drives. Pass dryRun first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: {
          type: 'string',
          description: 'Absolute source path (relative resolves against the session working directory).',
        },
        to: { type: 'string', description: 'Absolute destination path.' },
        overwrite: { type: 'boolean', description: 'Allow replacing an existing destination.' },
        dryRun: { type: 'boolean', description: 'Only report; move nothing.' },
      },
      required: ['from', 'to'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          dryRun: { type: 'boolean' },
          approved: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['from', 'to', 'dryRun'],
      },
      render: (_args, value) =>
        TEXT(
          `${value.dryRun ? 'would move' : 'moved'} ${value.from} -> ${value.to}` +
            (value.approved ? ' [approved once]' : ''),
        ),
    },
    async execute(args, exec) {
      const who = whoOf(exec)
      const session = decideSession(cfg.mode, cfg.sessions, who)
      if (!session.ok) throw new Error(sessionDeniedMessage(session, who))

      const from = resolveTarget(args.from, who.cwd)
      const to = resolveTarget(args.to, who.cwd)
      const decisions = [
        decidePath(from, { allow: cfg.pathAllow, deny: cfg.pathDeny }),
        decidePath(to, { allow: cfg.pathAllow, deny: cfg.pathDeny }),
      ]
      await assertPaths(ctx, cfg, exec, 'fs_move', who, decisions)
      assertNotAncestorOfCwd(from, who.cwd)
      assertNotIntoOwnSubtree(from, to)

      if (!fs.existsSync(from)) throw new Error(`source does not exist: ${from}`)
      let destinationExists = false
      try {
        fs.lstatSync(to)
        destinationExists = true
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      if (destinationExists && args.overwrite !== true) {
        throw new Error(`destination already exists: ${to} (pass overwrite: true to replace it)`)
      }

      const approved = decisions.some((d) => !d.ok)
      const dryRun = args.dryRun === true
      if (dryRun) return { from, to, dryRun: true, approved }

      fs.mkdirSync(path.dirname(to), { recursive: true })
      try {
        fs.renameSync(from, to)
      } catch (error) {
        if (error?.code === 'EXDEV') {
          throw new Error(
            `cross-volume move is not supported: ${from} -> ${to}; copy first, then fs_remove the source`,
          )
        }
        throw error
      }
      log(ctx, `moved ${from} -> ${to} by ${who.sessionId}`)
      return { from, to, dryRun: false, approved }
    },
  }
}

/** 只读诊断：把插件【当前加载的】配置和本会话的判定结果一次摊开。 */
function aclReport(cfg, who, sessionVerdict) {
  const status = sessionVerdict.ok
    ? `允许${sessionVerdict.rule ? `（命中 ${sessionVerdict.rule}）` : ''}`
    : `拒绝（${sessionVerdict.reason}）`
  const lines = [
    'dsh-host-fs · 当前会话',
    `  会话 id  : ${who.sessionId || '(取不到)'}`,
    `  preset   : ${who.preset || '(默认)'}`,
    `  cwd      : ${who.cwd || '(未知)'}`,
    '',
    `  会话闸门 : sessionMode=${cfg.mode} → ${status}`,
    `  名单     : ${cfg.sessions.length ? cfg.sessions.join(' , ') : '(空)'}`,
    `  路径白名单: ${cfg.pathAllow.length ? cfg.pathAllow.join(' , ') : '(空 —— 默认拒绝)'}`,
    `  路径黑名单: ${cfg.pathDeny.length ? cfg.pathDeny.join(' , ') : '(空)'}`,
    `  未命中时 : ${cfg.askOutside ? '弹一次审批（批准只对这一次生效）' : '直接拒绝'}`,
    '',
    'sessionList 里放这一行即可放行本会话：',
    `  ${who.sessionId || '(取不到 id，无法放行)'}`,
    '',
    '⚠️ 若你刚在设置里改过而这里没变，说明插件还没重载 —— 这份报告反映的是内存里正在跑的那份配置。',
  ]
  return lines.join('\n')
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  const rawConfig = config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {}

  ctx.tools.register(makeRemoveTool(ctx, cfg))
  ctx.tools.register(makeMoveTool(ctx, cfg))

  // 设置页（client 半的宿主）：会话勾选表 / 路径白黑名单 / 一次保存。
  // 路由是可选能力：没有 webServer 的部署照样能删/移文件。
  installSettingsRoutes(ctx, {
    getLiveConfig: () => rawConfig,
    log: (message) => log(ctx, message),
  })

  let commands
  try {
    commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined
  } catch {
    commands = undefined
  }
  if (commands && typeof commands.register === 'function') {
    commands.register({
      name: 'fs-acl',
      description: '显示 dsh-host-fs 的准入状态（只读）：会话 id、两个名单、以及放行本会话要填的那一行',
      handler: (invocation) => {
        const who = {
          sessionId: String(invocation?.agent?.id ?? ''),
          preset: invocation?.agent?.session?.header?.agentPreset,
          cwd: invocation?.agent?.session?.header?.cwd,
        }
        return { kind: 'success', text: aclReport(cfg, who, decideSession(cfg.mode, cfg.sessions, who)) }
      },
    })
  }

  log(ctx, `ready: sessionMode=${cfg.mode}, sessions=${cfg.sessions.length}`)
}

export const name = 'dsh-host-fs'
export const inject = ['tools']
export { Config }
