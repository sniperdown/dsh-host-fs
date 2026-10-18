/**
 * 纯 node 的判定逻辑（ESM）。故意不 import 任何 @deepseek-ai/* —— 单测可以直接跑。
 *
 * 两层闸门 + 三区判定（设计约定）：
 *   会话：off（默认，谁都不行）/ allowlist / denylist / all
 *   路径：黑名单（含子路径）拒 > 白名单（含子路径）允 > 其余【默认拒】
 *         驱动器根（C:\ H:\）永远拒，不看任何配置。
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * 规范化：normalize → 去尾部分隔符 → 仅在 Windows 上小写。
 *
 * ⚠️ 不能无条件 toLowerCase：Windows 的文件系统大小写不敏感（`C:\A` 和 `c:\a` 是同一个），
 * 但 Linux/macOS 是敏感的 —— 在那里把两条路径都折成小写，会把 `/tmp/A` 和 `/tmp/a`
 * 当成同一个，白名单/黑名单的边界就会**放宽**（该拒的不拒）。
 */
function canon(input) {
  let s = path.normalize(String(input))
  while (s.length > 1 && (s.endsWith('\\') || s.endsWith('/'))) s = s.slice(0, -1)
  return process.platform === 'win32' ? s.toLowerCase() : s
}

export function isSamePath(a, b) {
  return canon(a) === canon(b)
}

/** child 是否等于 parent 或位于其下（"含子路径"语义的唯一实现）。 */
export function isInside(child, parent) {
  const c = canon(child)
  const p = canon(parent)
  if (!p) return false
  if (c === p) return true
  const prefix = p.endsWith(path.sep) ? p : p + path.sep
  return c.startsWith(prefix)
}

export function isDriveRoot(target) {
  const abs = path.resolve(target)
  return isSamePath(abs, path.parse(abs).root)
}

/**
 * 路径闸门。返回 { ok, reason, rule, target }。
 * reason: 'ok' | 'drive-root' | 'denied' | 'unlisted'
 */
export function decidePath(target, policy = {}) {
  const allow = policy.allow ?? []
  const deny = policy.deny ?? []
  const abs = path.resolve(String(target))

  if (isDriveRoot(abs)) return { ok: false, reason: 'drive-root', target: abs }

  const denied = deny.find((rule) => isInside(abs, rule))
  if (denied) return { ok: false, reason: 'denied', rule: denied, target: abs }

  const allowed = allow.find((rule) => isInside(abs, rule))
  if (allowed) return { ok: true, reason: 'ok', rule: allowed, target: abs }

  return { ok: false, reason: 'unlisted', target: abs }
}

/**
 * 单条会话规则是否命中。
 *   *              全部
 *   preset:example    会话 agentPreset 等于 example（"一类"，不是一个人）
 *   qq-*           id 前缀通配
 *   session-xxxx   精确 id
 * id 一律由宿主给（exec.agent.id），模型伪造不了。
 */
export function matchSessionEntry(entry, who = {}) {
  const rule = String(entry ?? '').trim()
  if (!rule) return false
  if (rule === '*') return true
  const id = String(who.sessionId ?? '')
  if (/^preset:/i.test(rule)) {
    const want = rule.slice('preset:'.length).trim().toLowerCase()
    if (!want || !who.preset) return false
    return String(who.preset).toLowerCase() === want
  }
  if (rule.endsWith('*')) {
    return id.toLowerCase().startsWith(rule.slice(0, -1).toLowerCase())
  }
  return id.toLowerCase() === rule.toLowerCase()
}

/** 会话闸门。reason: 'ok' | 'off' | 'not-in-allowlist' | 'in-denylist' */
export function decideSession(mode, entries = [], who = {}) {
  if (mode === 'all') return { ok: true, reason: 'ok' }
  if (mode !== 'allowlist' && mode !== 'denylist') return { ok: false, reason: 'off' }

  const hit = entries.find((entry) => matchSessionEntry(entry, who))
  if (mode === 'allowlist') {
    return hit ? { ok: true, reason: 'ok', rule: hit } : { ok: false, reason: 'not-in-allowlist' }
  }
  return hit ? { ok: false, reason: 'in-denylist', rule: hit } : { ok: true, reason: 'ok' }
}

/** 目标路径不能是"会话工作区自己或它的祖先"。 */
export function assertNotAncestorOfCwd(target, cwd) {
  if (!cwd) return
  if (isInside(cwd, target)) {
    throw new Error(`refusing to touch ${target}: the session working directory (${cwd}) is inside it`)
  }
}

/** 不许把目录移进它自己的子树。 */
export function assertNotIntoOwnSubtree(from, to) {
  if (isInside(to, from)) {
    throw new Error(`refusing to move ${from} into its own subtree (${to})`)
  }
}

/** 相对路径以会话 cwd 为基准。 */
export function resolveTarget(input, cwd) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('path is required')
  if (path.isAbsolute(raw)) return path.resolve(raw)
  return path.resolve(cwd ?? process.cwd(), raw)
}

/**
 * Windows 的 junction **不是 lstat 意义上的符号链接**（实测 Node 24：
 * lstat.isSymbolicLink()=false、isDirectory()=true，readlinkSync 抛 EINVAL）。
 * 两条实测可靠的判据：
 *   1. 列父目录时 Dirent.isSymbolicLink() === true（junction 也算链接）；
 *   2. realpathSync.native(p) ≠ p（会解析到真实目标）。
 * 这里先用 1（精确），读不到父目录再退回 2；都不确定时按"是链接"保守处理。
 */
export function isLinkLike(target) {
  const abs = path.resolve(String(target))
  try {
    const parent = fs.readdirSync(path.dirname(abs), { withFileTypes: true })
    const name = path.basename(abs).toLowerCase()
    const entry = parent.find((item) => item.name.toLowerCase() === name)
    if (entry) return entry.isSymbolicLink()
  } catch {
    // 父目录读不了 → 走 realpath 判据
  }
  try {
    return canon(fs.realpathSync.native(abs)) !== canon(abs)
  } catch {
    return true
  }
}

/** 统计一棵树里有多少项、共多少字节（不跟随符号链接 / junction）。 */
export function measureTree(target, stat) {
  const st = stat ?? fs.lstatSync(target)
  if (st.isFile()) return { entries: 1, bytes: st.size }
  if (!st.isDirectory()) return { entries: 1, bytes: 0 }
  if (isLinkLike(target)) return { entries: 1, bytes: 0 }
  let entries = 1
  let bytes = st.size
  const stack = [target]
  while (stack.length > 0) {
    const dir = stack.pop()
    let list
    try {
      list = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of list) {
      const child = path.join(dir, entry.name)
      let s
      try {
        s = fs.lstatSync(child)
      } catch {
        continue
      }
      entries += 1
      bytes += s.size
      // entry.isSymbolicLink() 才是 junction 的正确判据（lstat 认不出来）
      if (s.isDirectory() && !entry.isSymbolicLink()) stack.push(child)
    }
  }
  return { entries, bytes }
}

const SEPARATORS = /[\r\n,;]+/

/** 把分隔符字符串切成条目（去空白、丢空项）。换行 / 逗号 / 分号都认。 */
export function splitList(raw) {
  return String(raw ?? '')
    .split(SEPARATORS)
    .map((item) => item.trim())
    .filter(Boolean)
}

/** 把插件收到的原始 config 规范成运行时形状（缺字段一律取安全的默认）。 */
export function resolveConfig(config) {
  const mode = ['off', 'allowlist', 'denylist', 'all'].includes(config?.sessionMode)
    ? config.sessionMode
    : 'off'
  return {
    mode,
    sessions: splitList(config?.sessionList),
    pathAllow: splitList(config?.pathAllow),
    pathDeny: splitList(config?.pathDeny),
    askOutside: config?.askOutside !== false,
  }
}
