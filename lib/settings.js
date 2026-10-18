/**
 * 设置页的纯逻辑：会话分组、配置分层合并、会话名单的重算、保存请求的校验。
 *
 * 故意不 import 任何 `@deepseek-ai/*`，也不碰 node:fs —— 单测可以直接跑
 * （和 guard.js 一样：能被 `node test/*.test.mjs` 单独加载）。
 *
 * 为什么不把这段写进 client：浏览器半是零构建的经典脚本，import 不了 ESM 模块；
 * 宿主半与浏览器半各有一份**语义相同**的分隔符解析（见 client/client.js 的 splitEntries），
 * 两边一致性由 test/settings.test.mjs 钉住关键规则。
 */
import { splitList } from './guard.js'

/** 四档会话权限。顺序就是界面上的顺序。 */
export const SESSION_MODES = ['off', 'allowlist', 'denylist', 'all']

/** 新装 / 没配置时的安全默认值（与 schemastery 的 Config 保持一致）。 */
export const CONFIG_DEFAULTS = Object.freeze({
  sessionMode: 'off',
  sessionList: '',
  pathAllow: '',
  pathDeny: '',
  askOutside: true,
})

/**
 * 会话表的分组。`groupOfSession` 的返回值必须落在这里的某个 id 上。
 *
 * 注意 `onebot-*`：QQ 插件早期版本用的是 `onebot-group-…` / `onebot-private-…`，
 * 现在新会话叫 `qq-…`。两种都按真实语义归到「群聊 / 私聊」，
 * 否则那些历史会话会掉进「子会话」里，看着像子 agent —— 那会误导人。
 */
export const SESSION_GROUPS = Object.freeze([
  { id: 'local', label: '本机会话', pattern: 'session-*' },
  { id: 'group', label: 'QQ 群聊', pattern: 'qq-group-*' },
  { id: 'private', label: 'QQ 私聊', pattern: 'qq-private-*' },
  { id: 'sub', label: '子会话', pattern: '其余' },
])

/** 会话 id → 分组 id。 */
export function groupOfSession(id) {
  const text = String(id ?? '').trim()
  if (/^session-/i.test(text)) return 'local'
  if (/^(?:qq|onebot)-group-/i.test(text)) return 'group'
  if (/^(?:qq|onebot)-private-/i.test(text)) return 'private'
  return 'sub'
}

/** 多行文本规范化：CRLF → LF，逐行去空白、丢空行。 */
export function normalizeLines(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
}

/**
 * 三层配置合并成运行时形状：默认值 < bundle/继承层 < profile 覆盖行。
 *
 * 逐键向下取第一个**类型正确**的值：覆盖层写了个数字/对象不会把继承层的好值顶掉。
 * 未知的 sessionMode 同样跳过该层，最后降级成 off（fail closed）。
 */
export function effectiveConfig(inherited, override, fallback) {
  const layers = [override, inherited, fallback]
  const firstString = (key, whenMissing) => {
    for (const layer of layers) {
      if (layer !== null && typeof layer === 'object' && typeof layer[key] === 'string') return layer[key]
    }
    return whenMissing
  }
  let sessionMode = CONFIG_DEFAULTS.sessionMode
  for (const layer of layers) {
    if (layer !== null && typeof layer === 'object' && SESSION_MODES.includes(layer.sessionMode)) {
      sessionMode = layer.sessionMode
      break
    }
  }
  let askOutside = CONFIG_DEFAULTS.askOutside
  for (const layer of layers) {
    if (layer !== null && typeof layer === 'object' && typeof layer.askOutside === 'boolean') {
      askOutside = layer.askOutside
      break
    }
  }
  return {
    sessionMode,
    sessionList: firstString('sessionList', CONFIG_DEFAULTS.sessionList),
    pathAllow: firstString('pathAllow', CONFIG_DEFAULTS.pathAllow),
    pathDeny: firstString('pathDeny', CONFIG_DEFAULTS.pathDeny),
    askOutside,
  }
}

/**
 * 保存时重算 sessionList。规则：
 *
 * 1. 旧条目里**不是**「当前这批会话的精确 id」的，原样保留 ——
 *    通配（`qq-*`）、`preset:example`、`*`、以及已经不在列表里的旧会话 id 都不能因为
 *    这次保存被悄悄丢掉。设置页只勾选它看得见的那批。
 * 2. 旧条目里**是**精确 id 的，去留完全由 checkedIds 决定。
 * 3. 勾选的 id 追加在末尾，用会话表里的原始大小写（不是用户输入的大小写）。
 * 4. checkedIds 里不在 visibleIds 中的（客户端陈旧 / 手工构造的请求）一律忽略。
 */
export function mergeSessionList(currentList, visibleIds, checkedIds) {
  const visible = new Map()
  for (const raw of visibleIds ?? []) {
    const text = String(raw ?? '').trim()
    if (text) visible.set(text.toLowerCase(), text)
  }

  const checked = []
  const seen = new Set()
  for (const raw of checkedIds ?? []) {
    const text = String(raw ?? '').trim()
    const canonical = visible.get(text.toLowerCase())
    if (!canonical) continue
    const key = canonical.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    checked.push(canonical)
  }

  const kept = []
  const keptKeys = new Set()
  for (const entry of splitList(currentList)) {
    const key = entry.toLowerCase()
    if (visible.has(key)) continue
    if (keptKeys.has(key)) continue
    keptKeys.add(key)
    kept.push(entry)
  }

  return [...kept, ...checked].join('\n')
}

const MAX_ARRAY = 5000
const MAX_ID_LENGTH = 512
const MAX_TEXT = 512 * 1024

function fail(error) {
  return { ok: false, error }
}

function readStringArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是字符串数组`)
  if (value.length > MAX_ARRAY) throw new Error(`${label} 条目太多（上限 ${MAX_ARRAY}）`)
  return value.map((item) => {
    if (typeof item !== 'string') throw new Error(`${label} 里每一项都必须是字符串`)
    const text = item.trim()
    if (text.length > MAX_ID_LENGTH) throw new Error(`${label} 里有超长的 id（上限 ${MAX_ID_LENGTH} 字符）`)
    return text
  })
}

function readText(value, label) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`)
  if (value.length > MAX_TEXT) throw new Error(`${label} 太长（上限 ${MAX_TEXT} 字符）`)
  return value
}

/**
 * 校验保存请求。返回 `{ ok:true, value }` 或 `{ ok:false, error }`（不抛）。
 *
 * 形状刻意与「界面此刻看见什么」对齐：`visibleSessionIds` 是**当时表里全部会话**，
 * 宿主用它们在保存时判断哪些旧条目该被勾选状态取代；`checkedSessionIds` 是勾上的那批。
 */
export function parseSaveRequest(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('请求体必须是一个 JSON 对象')
  }
  try {
    if (!SESSION_MODES.includes(payload.sessionMode)) {
      return fail(`sessionMode 必须是 ${SESSION_MODES.join(' / ')} 之一（收到 ${JSON.stringify(payload.sessionMode)}）`)
    }
    return {
      ok: true,
      value: {
        sessionMode: payload.sessionMode,
        visibleSessionIds: readStringArray(payload.visibleSessionIds, 'visibleSessionIds'),
        checkedSessionIds: readStringArray(payload.checkedSessionIds, 'checkedSessionIds'),
        pathAllow: normalizeLines(readText(payload.pathAllow, 'pathAllow')),
        pathDeny: normalizeLines(readText(payload.pathDeny, 'pathDeny')),
      },
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}
