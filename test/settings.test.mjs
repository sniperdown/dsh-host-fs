// node test/settings.test.mjs —— 设置页的纯逻辑 + 宿主路由（假 webServer / 假 ConfigEditor）。
// 不启动宿主、不依赖 schemastery：所有对象都是本地构造的。
import assert from 'node:assert/strict'
import {
  CONFIG_DEFAULTS,
  effectiveConfig,
  groupOfSession,
  mergeSessionList,
  normalizeLines,
  parseSaveRequest,
} from '../lib/settings.js'
import { findConfigEntry, installSettingsRoutes, readEffectiveConfig, ROUTE_BASE } from '../lib/settings-host.js'

let pass = 0
const check = (label, fn) => {
  fn()
  pass += 1
  console.log('ok  ' + label)
}
const checkAsync = async (label, fn) => {
  await fn()
  pass += 1
  console.log('ok  ' + label)
}

// ── 分组 ────────────────────────────────────────────────────
check('groupOfSession: session / qq-group / qq-private / 其余', () => {
  assert.equal(groupOfSession('session-00000000-0000-4000-8000-000000000000'), 'local')
  assert.equal(groupOfSession('qq-group-123456789'), 'group')
  assert.equal(groupOfSession('qq-private-100000001'), 'private')
  assert.equal(groupOfSession('11111111-1111-4111-8111-111111111111'), 'sub')
  assert.equal(groupOfSession(''), 'sub')
  assert.equal(groupOfSession(undefined), 'sub')
})

check('groupOfSession: legacy onebot- ids still count as QQ, not subagents', () => {
  assert.equal(groupOfSession('onebot-group-123456789'), 'group')
  assert.equal(groupOfSession('onebot-private-100000001'), 'private')
  assert.equal(groupOfSession('QQ-GROUP-123'), 'group')
})

// ── 配置分层 ────────────────────────────────────────────────
check('effectiveConfig: safe defaults, unknown mode fails closed', () => {
  assert.deepEqual(effectiveConfig({}, {}, undefined), {
    sessionMode: 'off',
    sessionList: '',
    pathAllow: '',
    pathDeny: '',
    askOutside: true,
  })
  assert.equal(effectiveConfig({}, { sessionMode: 'banana' }).sessionMode, 'off')
  assert.equal(effectiveConfig({}, { askOutside: false }).askOutside, false)
  assert.equal(effectiveConfig({}, {}, { pathAllow: 'H:/x' }).pathAllow, 'H:/x')
  assert.equal(CONFIG_DEFAULTS.sessionMode, 'off')
})

check('effectiveConfig: inherited < override, non-string values fall back', () => {
  const merged = effectiveConfig(
    { sessionMode: 'allowlist', pathAllow: 'D:/dsh-home', askOutside: false },
    { sessionMode: 'denylist', pathDeny: 'D:/dsh-home/profiles', pathAllow: 42 },
  )
  assert.equal(merged.sessionMode, 'denylist')
  assert.equal(merged.pathDeny, 'D:/dsh-home/profiles')
  assert.equal(merged.pathAllow, 'D:/dsh-home')
  assert.equal(merged.askOutside, false)
})

check('normalizeLines: CRLF, whitespace and empty lines', () => {
  assert.equal(normalizeLines('  H:/a  \r\n\r\n H:/b\n'), 'H:/a\nH:/b')
  assert.equal(normalizeLines(undefined), '')
})

// ── sessionList 重算 ────────────────────────────────────────
const visible = ['qq-group-123456789', 'qq-private-100000001', 'session-example-01']

check('mergeSessionList: keeps wildcards/presets and adds checked ids', () => {
  assert.equal(
    mergeSessionList('qq-*\npreset:example', visible, ['qq-group-123456789']),
    'qq-*\npreset:example\nqq-group-123456789',
  )
  assert.equal(mergeSessionList('*', visible, []), '*')
})

check('mergeSessionList: unchecked visible session id is removed', () => {
  assert.equal(mergeSessionList('session-example-01', visible, []), '')
  assert.equal(mergeSessionList('session-example-01', visible, ['session-example-01']), 'session-example-01')
})

check('mergeSessionList: old ids that are not on screen survive a save', () => {
  assert.equal(
    mergeSessionList('session-old-that-no-longer-exists', visible, ['qq-group-123456789']),
    'session-old-that-no-longer-exists\nqq-group-123456789',
  )
})

check('mergeSessionList: canonical casing, dedupe, ignores unknown checked ids', () => {
  assert.equal(
    mergeSessionList('', ['qq-group-ABC'], ['QQ-GROUP-abc', 'qq-group-ABC', 'qq-group-unknown']),
    'qq-group-ABC',
  )
  assert.equal(mergeSessionList('qq-*\nqq-*', visible, []), 'qq-*')
})

check('mergeSessionList: commas and semicolons in the stored list are still separated', () => {
  assert.equal(
    mergeSessionList('qq-*, preset:example; session-example-01', visible, []),
    'qq-*\npreset:example',
  )
})

// ── 保存请求校验 ────────────────────────────────────────────
check('parseSaveRequest: valid payload normalizes paths', () => {
  const parsed = parseSaveRequest({
    sessionMode: 'allowlist',
    visibleSessionIds: ['qq-group-1'],
    checkedSessionIds: ['qq-group-1'],
    pathAllow: ' D:/dsh-home \r\n',
    pathDeny: 'D:/dsh-home/profiles\n\nD:/dsh-home/sessions',
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.value.sessionMode, 'allowlist')
  assert.equal(parsed.value.pathAllow, 'D:/dsh-home')
  assert.equal(parsed.value.pathDeny, 'D:/dsh-home/profiles\nD:/dsh-home/sessions')
})

check('parseSaveRequest: rejects bad input without throwing', () => {
  assert.equal(parseSaveRequest(null).ok, false)
  assert.equal(parseSaveRequest([]).ok, false)
  assert.equal(parseSaveRequest({ sessionMode: 'off' }).ok, false, 'missing arrays is rejected')
  assert.equal(
    parseSaveRequest({ sessionMode: 'banana', visibleSessionIds: [], checkedSessionIds: [] }).ok,
    false,
  )
  assert.equal(
    parseSaveRequest({
      sessionMode: 'off',
      visibleSessionIds: 'nope',
      checkedSessionIds: [],
      pathAllow: '',
      pathDeny: '',
    }).ok,
    false,
  )
  assert.equal(
    parseSaveRequest({
      sessionMode: 'off',
      visibleSessionIds: [],
      checkedSessionIds: [42],
      pathAllow: '',
      pathDeny: '',
    }).ok,
    false,
  )
  assert.equal(
    parseSaveRequest({
      sessionMode: 'off',
      visibleSessionIds: [],
      checkedSessionIds: [],
      pathAllow: {},
    }).ok,
    false,
  )
})

// ── ConfigEditor 适配 ───────────────────────────────────────
const entry = { options: { id: 'dsh-host-fs', name: 'dsh-host-fs', config: { pathAllow: 'H:/from-entry' } } }

check('findConfigEntry: id first, name fallback, include: prefix fallback', () => {
  assert.equal(findConfigEntry({ entries: () => [entry] }), entry)
  const byName = { options: { id: 'include:dsh-host-fs', name: 'dsh-host-fs' } }
  assert.equal(findConfigEntry({ entries: () => [byName] }), byName)
  assert.equal(findConfigEntry({ entries: () => [{ options: { id: 'other' } }] }), undefined)
  assert.equal(findConfigEntry({ entries: () => { throw new Error('boom') } }), undefined)
})

check('readEffectiveConfig: layers win, and a missing editor is reported', () => {
  const editor = {
    entries: () => [entry],
    configuration: () => [
      { entry, inherited: { pathAllow: 'H:/inherited', askOutside: false }, override: { sessionMode: 'allowlist' } },
    ],
  }
  const result = readEffectiveConfig(editor, {})
  assert.equal(result.entryId, 'dsh-host-fs')
  assert.equal(result.config.pathAllow, 'H:/inherited')
  assert.equal(result.config.sessionMode, 'allowlist')
  assert.equal(result.config.askOutside, false)
  assert.deepEqual(result.warnings, [])

  const missing = readEffectiveConfig(undefined, { sessionMode: 'all' })
  assert.equal(missing.config.sessionMode, 'all')
  assert.equal(missing.warnings.length, 1)

  // configuration() 抛错时必须退回 entry.options.config，而不是把配置显示成空
  const broken = { entries: () => [entry], configuration: () => { throw new Error('no layers') } }
  const fallback = readEffectiveConfig(broken, {})
  assert.equal(fallback.config.pathAllow, 'H:/from-entry')
  assert.equal(fallback.warnings.length, 1)
})

// ── 路由（假宿主）────────────────────────────────────────────
function fakeResponse() {
  let resolve
  const done = new Promise((value) => {
    resolve = value
  })
  const res = {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      if (typeof body === 'string') this.body += body
      resolve(this)
    },
  }
  return { res, done }
}

function fakeRequest({ method = 'GET', contentType = 'application/json', body = '' } = {}) {
  const listeners = {}
  const req = {
    method,
    headers: contentType === null ? {} : { 'content-type': contentType },
    on(event, listener) {
      listeners[event] = listeners[event] || []
      listeners[event].push(listener)
      return req
    },
  }
  setTimeout(() => {
    if (body !== '') for (const listener of listeners.data || []) listener(Buffer.from(body, 'utf8'))
    for (const listener of listeners.end || []) listener()
  }, 0)
  return req
}

function fakeRouter() {
  const routes = new Map()
  const webServer = {
    register(route) {
      assert.equal(routes.has(route.path), false, 'duplicate route ' + route.path)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const ctx = {
    get(name) {
      return name === 'webServer' ? webServer : undefined
    },
    effect(fn) {
      return fn()
    },
    inject() {
      throw new Error('webServer was already available; inject() must not be used')
    },
  }
  return { routes, ctx, webServer }
}

await checkAsync('installSettingsRoutes: registers exactly the two documented routes', async () => {
  const { routes, ctx } = fakeRouter()
  installSettingsRoutes(ctx, { getLiveConfig: () => ({}) })
  assert.deepEqual([...routes.keys()].sort(), [
    ROUTE_BASE + '/config',
    ROUTE_BASE + '/sessions',
  ])
  assert.equal(ROUTE_BASE, '/api/dsh-host-fs')
})

await checkAsync('GET /sessions: one batched title read, grouped rows, title fallback', async () => {
  const { routes, ctx, webServer } = fakeRouter()
  let listCalls = 0
  let titleCalls = 0
  const sessionQuery = {
    listSessions() {
      listCalls += 1
      return [
        { header: { id: 'qq-group-123456789', createdAt: 3 }, live: true, persisted: true },
        { header: { id: 'session-example-01', createdAt: 2 }, live: false, persisted: true },
        { header: { id: '11111111-1111-4111-8111-111111111111', createdAt: 1 }, live: false, persisted: true },
        { header: { id: 'qq-group-123456789', createdAt: 3 }, live: true, persisted: true },
      ]
    },
    readTitleSnapshots(ids) {
      titleCalls += 1
      assert.deepEqual(ids, ['qq-group-123456789', 'session-example-01', '11111111-1111-4111-8111-111111111111'])
      return [
        { sessionId: 'qq-group-123456789', status: 'fulfilled', value: { title: { title: 'QQ群聊-示例群' } } },
        { sessionId: 'session-example-01', status: 'fulfilled', value: {} },
        { sessionId: '11111111-1111-4111-8111-111111111111', status: 'rejected', reason: new Error('old log') },
      ]
    },
  }
  ctx.get = (name) => (name === 'webServer' ? webServer : name === 'sessionQuery' ? sessionQuery : undefined)
  installSettingsRoutes(ctx, { getLiveConfig: () => ({}) })

  const { res, done } = fakeResponse()
  routes.get(ROUTE_BASE + '/sessions').handler(fakeRequest(), res)
  await done
  const payload = JSON.parse(res.body)
  assert.equal(listCalls, 1)
  assert.equal(titleCalls, 1, 'titles must be read in ONE batch')
  assert.equal(payload.ok, true)
  assert.equal(payload.sessions.length, 3, 'duplicate ids collapse')
  assert.equal(payload.sessions[0].title, 'QQ群聊-示例群')
  assert.equal(payload.sessions[0].group, 'group')
  assert.equal(payload.sessions[1].title, '', 'old session without title stays empty')
  assert.equal(payload.sessions[1].group, 'local')
  assert.equal(payload.sessions[2].group, 'sub')
  assert.equal(payload.stats.titled, 1)
})

await checkAsync('GET /config: returns effective values and canSave', async () => {
  const { routes, ctx, webServer } = fakeRouter()
  const editor = {
    entries: () => [entry],
    configuration: () => [{ entry, inherited: {}, override: { sessionMode: 'allowlist', sessionList: 'qq-*' } }],
    edit: async () => {},
  }
  ctx.get = (name) => (name === 'webServer' ? webServer : name === 'configEditor' ? editor : undefined)
  installSettingsRoutes(ctx, { getLiveConfig: () => ({}) })

  const { res, done } = fakeResponse()
  routes.get(ROUTE_BASE + '/config').handler(fakeRequest(), res)
  await done
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.entryId, 'dsh-host-fs')
  assert.equal(payload.config.sessionMode, 'allowlist')
  assert.equal(payload.config.sessionList, 'qq-*')
  assert.equal(payload.canSave, true)
})

await checkAsync('POST /config: writes the four fields once and keeps other keys', async () => {
  const { routes, ctx, webServer } = fakeRouter()
  let written = null
  const editor = {
    entries: () => [entry],
    configuration: () => [
      { entry, inherited: { sessionList: 'preset:example', askOutside: false }, override: { maintainer: 'keep-me' } },
    ],
    async edit(target, change) {
      assert.equal(target, entry)
      written = change({ ...entry.options.config, maintainer: 'keep-me' }, { sessionList: 'preset:example', askOutside: false })
    },
  }
  ctx.get = (name) => (name === 'webServer' ? webServer : name === 'configEditor' ? editor : undefined)
  installSettingsRoutes(ctx, { getLiveConfig: () => ({}) })

  const body = JSON.stringify({
    sessionMode: 'denylist',
    visibleSessionIds: ['qq-group-123456789'],
    checkedSessionIds: ['qq-group-123456789'],
    pathAllow: 'H:/a\r\nH:/b',
    pathDeny: 'H:/a/private',
  })
  const { res, done } = fakeResponse()
  routes.get(ROUTE_BASE + '/config').handler(fakeRequest({ method: 'POST', body }), res)
  await done

  assert.equal(written.sessionMode, 'denylist')
  assert.equal(written.sessionList, 'preset:example\nqq-group-123456789')
  assert.equal(written.pathAllow, 'H:/a\nH:/b')
  assert.equal(written.pathDeny, 'H:/a/private')
  assert.equal(written.askOutside, false, 'askOutside is preserved, not reset to true')
  assert.equal(written.maintainer, 'keep-me', 'unknown keys are not dropped')
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.applied, ['sessionMode', 'sessionList', 'pathAllow', 'pathDeny'])
})

await checkAsync('POST /config: rejects non-JSON content-type and invalid bodies', async () => {
  const { routes, ctx, webServer } = fakeRouter()
  const editor = { entries: () => [entry], edit: async () => { throw new Error('must not be called') } }
  ctx.get = (name) => (name === 'webServer' ? webServer : name === 'configEditor' ? editor : undefined)
  installSettingsRoutes(ctx, { getLiveConfig: () => ({}) })

  const first = fakeResponse()
  routes.get(ROUTE_BASE + '/config').handler(
    fakeRequest({ method: 'POST', contentType: 'text/plain', body: '{}' }),
    first.res,
  )
  await first.done
  assert.equal(first.res.status, 415)

  const second = fakeResponse()
  routes
    .get(ROUTE_BASE + '/config')
    .handler(fakeRequest({ method: 'POST', body: JSON.stringify({ sessionMode: 'banana' }) }), second.res)
  await second.done
  assert.equal(second.res.status, 400)
  assert.equal(JSON.parse(second.res.body).ok, false)
})

await checkAsync('POST /config: no configEditor → 503 with a readable message', async () => {
  const { routes, ctx, webServer } = fakeRouter()
  ctx.get = (name) => (name === 'webServer' ? webServer : undefined)
  installSettingsRoutes(ctx, { getLiveConfig: () => ({}) })
  const body = JSON.stringify({
    sessionMode: 'off',
    visibleSessionIds: [],
    checkedSessionIds: [],
    pathAllow: '',
    pathDeny: '',
  })
  const { res, done } = fakeResponse()
  routes.get(ROUTE_BASE + '/config').handler(fakeRequest({ method: 'POST', body }), res)
  await done
  assert.equal(res.status, 503)
  assert.match(JSON.parse(res.body).error.message, /configEditor/)
})

console.log(`\n${pass} checks passed`)
