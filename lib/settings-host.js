/**
 * 设置页的宿主半：三条 HTTP 路由 + 配置落盘。
 *
 *   GET  /api/dsh-host-fs/sessions   全部会话（含批量拿到的标题、分组）
 *   GET  /api/dsh-host-fs/config     当前配置（分层合并后的生效值）
 *   POST /api/dsh-host-fs/config     一次写入（ConfigEditor → profile 的覆盖行）
 *
 * 几条设计约束（都是踩过的）：
 * - **不硬 inject webServer**：纯 headless 部署里没有它，硬 inject 会让整个插件挂起、
 *   连 fs_remove 都没了。这里先 `ctx.get`，拿不到再 `ctx.inject(['webServer'], …)` 等它。
 * - **不手写 profile patch**：写入一律走 `configEditor.edit()`，和运维手改 YAML 是同一条路径；
 *   它会校验、原子写、并触发 Loader 重载。
 * - 标题必须**批量**读：`readTitleSnapshots(ids)` 一次观察整批会话；
 *   一个个 `readTitle` 在几百个会话上会把设置页拖成几十秒。
 * - 回调里绝不把异常甩给事件循环：所有 handler 自己兜住，返回 JSON 错误信封。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SESSION_GROUPS,
  SESSION_MODES,
  effectiveConfig,
  groupOfSession,
  mergeSessionList,
  parseSaveRequest,
} from './settings.js'

export const ROUTE_BASE = '/api/dsh-host-fs'

/** 本插件在 profile 里的 patch 行 id（= 包名）。 */
const ENTRY_ID = 'dsh-host-fs'

const BODY_LIMIT = 2 * 1024 * 1024
/** 列表 + 标题折叠的总预算；超时就先返回空标题，别让设置页一直转圈。 */
const SESSION_READ_TIMEOUT_MS = 30_000

function getService(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

function sendJson(res, status, value) {
  try {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    // 连接已经断了 / 头已发出：没有别的可做
    try {
      res.end()
    } catch {
      /* ignore */
    }
  }
}

const errorBody = (code, message) => ({ ok: false, error: { code, message } })

function failure(res, status, code, message) {
  sendJson(res, status, errorBody(code, message))
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 读 JSON 请求体；带大小上限，绝不无限吃内存。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > BODY_LIMIT) {
        const error = new Error(`请求体太大（上限 ${Math.round(BODY_LIMIT / 1024)} KB）`)
        error.code = 'too-large'
        finish(reject, error)
        try {
          req.destroy()
        } catch {
          /* ignore */
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        finish(reject, Object.assign(new Error('请求体是空的'), { code: 'bad-json' }))
        return
      }
      try {
        finish(resolve, JSON.parse(text))
      } catch {
        finish(reject, Object.assign(new Error('请求体不是合法 JSON'), { code: 'bad-json' }))
      }
    })
    req.on('error', (error) => finish(reject, error))
  })
}

const sameEntry = (a, b) =>
  a !== undefined && b !== undefined && a === b

/** 在 ConfigEditor 的条目表里找本插件那一行（id 优先，name 兜底）。 */
export function findConfigEntry(editor) {
  let entries
  try {
    entries = editor.entries()
  } catch {
    return undefined
  }
  if (!Array.isArray(entries)) return undefined
  return (
    entries.find((entry) => entry?.options?.id === ENTRY_ID) ??
    entries.find((entry) => entry?.options?.name === ENTRY_ID) ??
    entries.find((entry) => String(entry?.options?.id ?? '').endsWith(':' + ENTRY_ID))
  )
}

/**
 * 读当前生效配置（分层合并）。返回 `{ config, entryId, warnings }`。
 *
 * 优先 `configuration()`：它把「包/patches 给的继承层」与「profile 覆盖行」分开给，
 * 这样界面显示的是**真正生效**的值，而不是某一份文件。
 */
export function readEffectiveConfig(editor, liveConfig) {
  const warnings = []
  let config = effectiveConfig({}, {}, liveConfig)
  let entryId = null

  if (editor === undefined || editor === null || typeof editor.entries !== 'function') {
    warnings.push('宿主没有 configEditor 服务：这里显示的是插件当前生效值，保存会失败。')
    return { config, entryId, warnings }
  }

  const entry = findConfigEntry(editor)
  if (entry === undefined) {
    warnings.push(`在 profile 的 Loader 树里找不到 id 为 "${ENTRY_ID}" 的条目，保存会失败。`)
    return { config, entryId, warnings }
  }
  entryId = String(entry.options?.id ?? ENTRY_ID)

  let inherited = {}
  let override = {}
  let sawLayers = false
  try {
    if (typeof editor.configuration === 'function') {
      const rows = editor.configuration()
      if (Array.isArray(rows)) {
        const row = rows.find(
          (item) => sameEntry(item?.entry, entry) || item?.entry?.options?.id === entry.options?.id,
        )
        if (row !== undefined) {
          inherited = row.inherited ?? {}
          override = row.override ?? {}
          sawLayers = true
        }
      }
    }
  } catch (error) {
    warnings.push(`读取配置分层失败，退回 entry.options.config：${describe(error)}`)
  }
  if (!sawLayers) {
    const raw = entry.options?.config
    override = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  }

  config = effectiveConfig(inherited, override, liveConfig)
  return { config, entryId, warnings }
}

/**
 * 「最后一次更新时间」= 会话日志文件的 mtime。
 * 宿主没给这个字段（SessionRecord 只有 header.createdAt）；标题的 updatedAt 是
 * "标题事件时间"（定下就不动），也不代表活跃度。看文件 mtime 最准，代价是
 * 一次目录扫描；扫不到就返回 null，前端退回 createdAt。
 */
function sessionStampMap() {
  const root = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'sessions')
  const map = new Map()
  let workspaces = []
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return map
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    let entries = []
    try {
      entries = fs.readdirSync(path.join(root, workspace.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(root, workspace.name, entry.name)
      try {
        if (entry.isDirectory()) {
          map.set(entry.name, fs.statSync(path.join(full, 'session.v4.jsonl.zstd')).mtimeMs)
        } else if (entry.isFile()) {
          map.set(entry.name.replace(/\.zstd$/, ''), fs.statSync(full).mtimeMs)
        }
      } catch {
        // 正在写 / 权限问题：跳过这一个，不影响整页
      }
    }
  }
  return map
}

let stampCache = { at: 0, map: new Map() }

function updatedAtOf(id) {
  const now = Date.now()
  if (now - stampCache.at > 2000) stampCache = { at: now, map: sessionStampMap() }
  const hit = stampCache.map.get(id)
  if (hit !== undefined) return hit
  const prefixed = stampCache.map.get('session-' + id)
  if (prefixed !== undefined) return prefixed
  const stripped = stampCache.map.get(id.replace(/^session-/, ''))
  return stripped === undefined ? null : stripped
}

function normalizeSessionRow(record) {
  const header = record?.header ?? {}
  const id = String(header.id ?? '').trim()
  if (!id) return null
  return {
    id,
    title: '',
    group: groupOfSession(id),
    createdAt: Number.isFinite(header.createdAt) ? header.createdAt : null,
    updatedAt: updatedAtOf(id),
    live: record?.live === true,
    persisted: record?.persisted === true,
    parentSession: header.parentSession === undefined ? null : String(header.parentSession),
  }
}

/** 批量取标题：一次观察整批会话；单个会话失败只留空标题，不影响整页。 */
async function readTitles(sessionQuery, ids, signal) {
  const titles = new Map()
  if (ids.length === 0) return titles
  if (typeof sessionQuery.readTitleSnapshots !== 'function') return titles
  const results = await sessionQuery.readTitleSnapshots(ids, signal)
  if (!Array.isArray(results)) return titles
  for (const result of results) {
    if (result?.status !== 'fulfilled') continue
    const title = result.value?.title?.title
    if (typeof title !== 'string') continue
    const text = title.trim()
    if (text === '') continue
    titles.set(String(result.sessionId), text)
  }
  return titles
}

async function handleSessions(ctx, req, res, log) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    failure(res, 405, 'method-not-allowed', '这个路由只接受 GET')
    return
  }

  const sessionQuery = getService(ctx, 'sessionQuery')
  if (sessionQuery === undefined || sessionQuery === null || typeof sessionQuery.listSessions !== 'function') {
    failure(res, 503, 'no-session-query', '宿主没有 sessionQuery 服务，取不到会话列表。')
    return
  }

  const warnings = []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SESSION_READ_TIMEOUT_MS)

  try {
    let records
    try {
      records = await sessionQuery.listSessions(controller.signal)
    } catch (error) {
      failure(res, 500, 'list-failed', `读取会话列表失败：${describe(error)}`)
      return
    }
    if (!Array.isArray(records)) {
      failure(res, 500, 'list-shape', 'sessionQuery.listSessions() 没有返回数组。')
      return
    }

    const rows = []
    const seen = new Set()
    for (const record of records) {
      const row = normalizeSessionRow(record)
      if (row === null || seen.has(row.id)) continue
      seen.add(row.id)
      rows.push(row)
    }

    try {
      const titles = await readTitles(sessionQuery, rows.map((row) => row.id), controller.signal)
      for (const row of rows) {
        const title = titles.get(row.id)
        if (title !== undefined) row.title = title
      }
    } catch (error) {
      // 标题只是装饰：拿不到就显示 (未命名)，但要把原因告诉调用者
      warnings.push(
        controller.signal.aborted
          ? `标题读取超过 ${Math.round(SESSION_READ_TIMEOUT_MS / 1000)} 秒已取消；会话列表仍然可用，标题先显示为 (未命名)。`
          : `批量读取标题失败（标题先显示为 (未命名)）：${describe(error)}`,
      )
    }

    sendJson(res, 200, {
      ok: true,
      sessions: rows,
      groups: SESSION_GROUPS,
      stats: { total: rows.length, titled: rows.filter((row) => row.title !== '').length },
      warnings,
      fetchedAt: Date.now(),
    })
  } finally {
    clearTimeout(timer)
  }
}

function liveConfigOf(getLiveConfig) {
  try {
    const value = getLiveConfig()
    return value !== null && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function handleGetConfig(ctx, req, res, getLiveConfig) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    failure(res, 405, 'method-not-allowed', '这个路由只接受 GET')
    return
  }
  const editor = getService(ctx, 'configEditor')
  const { config, entryId, warnings } = readEffectiveConfig(editor, liveConfigOf(getLiveConfig))
  sendJson(res, 200, {
    ok: true,
    entryId,
    config,
    modes: SESSION_MODES,
    canSave: editor !== undefined && editor !== null && typeof editor.edit === 'function',
    warnings,
  })
}

async function handleSaveConfig(ctx, req, res, getLiveConfig, log) {
  if (req.method !== 'POST') {
    failure(res, 405, 'method-not-allowed', '这个路由只接受 POST')
    return
  }
  // 只收 application/json：跨站页面没法在不触发 CORS 预检的情况下发这个 content-type，
  // 是一条成本很低、又不影响本页面的 CSRF 门槛。
  const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase()
  if (!contentType.includes('application/json')) {
    failure(res, 415, 'unsupported-media-type', '请用 content-type: application/json 提交。')
    return
  }

  let payload
  try {
    payload = await readJsonBody(req)
  } catch (error) {
    failure(res, error?.code === 'too-large' ? 413 : 400, 'bad-body', describe(error))
    return
  }

  const parsed = parseSaveRequest(payload)
  if (parsed.ok !== true) {
    failure(res, 400, 'invalid', parsed.error)
    return
  }

  const editor = getService(ctx, 'configEditor')
  if (editor === undefined || editor === null || typeof editor.edit !== 'function') {
    failure(
      res,
      503,
      'no-editor',
      '当前 profile 没有 configEditor 服务，无法持久化配置。请改为手工编辑 profile 的 cordis.patch.yml。',
    )
    return
  }

  const entry = findConfigEntry(editor)
  if (entry === undefined) {
    failure(res, 409, 'no-entry', `在 profile 的 Loader 树里找不到 id 为 "${ENTRY_ID}" 的条目，无法写回配置。`)
    return
  }

  const live = liveConfigOf(getLiveConfig)
  const request = parsed.value
  let applied = null

  try {
    // 写入前把「当前覆盖层」与「继承层」都过一遍：保存只改这四项（askOutside 取当前生效值），
    // 其余键原样保留，不替用户丢配置。
    await editor.edit(entry, (current, inherited) => {
      const currentConfig = current !== null && typeof current === 'object' && !Array.isArray(current) ? current : {}
      const effective = effectiveConfig(inherited, currentConfig, live)
      const next = {
        ...currentConfig,
        sessionMode: request.sessionMode,
        sessionList: mergeSessionList(effective.sessionList, request.visibleSessionIds, request.checkedSessionIds),
        pathAllow: request.pathAllow,
        pathDeny: request.pathDeny,
        askOutside: effective.askOutside !== false,
      }
      applied = next
      return next
    })
  } catch (error) {
    log(`保存配置失败：${describe(error)}`)
    failure(res, 500, 'write-failed', `写入 profile 配置失败：${describe(error)}`)
    return
  }

  log(
    `设置页已更新配置：sessionMode=${request.sessionMode}, ` +
      `checked=${request.checkedSessionIds.length}/${request.visibleSessionIds.length}`,
  )
  sendJson(res, 200, {
    ok: true,
    entryId: String(entry.options?.id ?? ENTRY_ID),
    config: applied ?? effectiveConfig({}, {}, live),
    applied: ['sessionMode', 'sessionList', 'pathAllow', 'pathDeny'],
  })
}

/**
 * 把三条路由挂到 webServer 上。
 *
 * @param {object} ctx Cordis 上下文
 * @param {{ getLiveConfig?: () => object, log?: (message: string) => void }} options
 */
export function installSettingsRoutes(ctx, options = {}) {
  const getLiveConfig = typeof options.getLiveConfig === 'function' ? options.getLiveConfig : () => ({})
  const log = typeof options.log === 'function' ? options.log : () => {}

  const attach = (ownerCtx) => {
    const webServer = getService(ownerCtx, 'webServer')
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
      log('webServer 不可用，设置页路由没挂上（工具本身不受影响）')
      return
    }
    try {
      ownerCtx.effect(() => {
        const disposers = [
          webServer.register({
            kind: 'exact',
            path: `${ROUTE_BASE}/sessions`,
            handler: (req, res) => {
              handleSessions(ownerCtx, req, res, log).catch((error) => {
                log(`/sessions 处理失败：${describe(error)}`)
                failure(res, 500, 'internal', describe(error))
              })
            },
          }),
          webServer.register({
            kind: 'exact',
            path: `${ROUTE_BASE}/config`,
            handler: (req, res) => {
              if (req.method === 'POST') {
                handleSaveConfig(ownerCtx, req, res, getLiveConfig, log).catch((error) => {
                  log(`/config 保存失败：${describe(error)}`)
                  failure(res, 500, 'internal', describe(error))
                })
                return
              }
              try {
                handleGetConfig(ownerCtx, req, res, getLiveConfig)
              } catch (error) {
                log(`/config 读取失败：${describe(error)}`)
                failure(res, 500, 'internal', describe(error))
              }
            },
          }),
        ]
        return () => {
          for (const dispose of disposers.reverse()) {
            try {
              dispose()
            } catch {
              /* 已经卸掉了 */
            }
          }
        }
      }, 'dsh-host-fs: settings routes')
    } catch (error) {
      log(`挂设置页路由失败：${describe(error)}`)
    }
  }

  // 先看服务在不在；不在就等它（不写进模块级 inject，headless 部署才不会挂起）。
  if (getService(ctx, 'webServer') !== undefined) {
    attach(ctx)
    return
  }
  try {
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['webServer'], (webCtx) => {
        attach(webCtx)
      })
      return
    }
  } catch (error) {
    log(`等待 webServer 失败：${describe(error)}`)
  }
  log('没有 webServer，设置页路由没挂上（工具本身不受影响）')
}
