// node test/guard.test.mjs —— 不依赖宿主、不依赖 schemastery；纯 node 断言。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  assertNotAncestorOfCwd,
  assertNotIntoOwnSubtree,
  decidePath,
  decideSession,
  isDriveRoot,
  isInside,
  isLinkLike,
  measureTree,
  matchSessionEntry,
  resolveConfig,
  resolveTarget,
  splitList,
} from '../lib/guard.js'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const tmp = path.join(here, '..', '.test-tmp')

let pass = 0
const check = (label, fn) => {
  fn()
  pass += 1
  console.log('ok  ' + label)
}
const throws = (fn, pattern) => assert.throws(fn, pattern)

// ── 路径闸门 ────────────────────────────────────────────────
check('drive root always refused, even if whitelisted', () => {
  const verdict = decidePath('H:\\', { allow: ['H:\\'], deny: [] })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'drive-root')
  assert.equal(isDriveRoot('C:\\'), true)
  assert.equal(isDriveRoot('C:\\Windows'), false)
})

check('default deny: unlisted path is not allowed', () => {
  const verdict = decidePath('D:\\dsh-home\\x.txt', { allow: [], deny: [] })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'unlisted')
})

check('allowlist covers the path itself AND every subpath', () => {
  const policy = { allow: ['D:\\dsh-home'], deny: [] }
  assert.equal(decidePath('D:\\dsh-home', policy).ok, true)
  assert.equal(decidePath('D:\\dsh-home\\a.txt', policy).ok, true)
  assert.equal(decidePath('D:\\dsh-home\\deep\\er\\x.txt', policy).ok, true)
  assert.equal(decidePath('D:\\dsh-homeX\\a.txt', policy).ok, false, 'sibling prefix must not match')
  assert.equal(decidePath('H:\\other\\a.txt', policy).ok, false)
})

check("deny wins over allow (the user's exact example)", () => {
  const policy = { allow: ['C:\\1'], deny: ['C:\\1\\2'] }
  assert.equal(decidePath('C:\\1', policy).ok, true)
  assert.equal(decidePath('C:\\1\\3', policy).ok, true)
  assert.equal(decidePath('C:\\1\\3\\deep.txt', policy).ok, true)

  const blocked = decidePath('C:\\1\\2', policy)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'denied')
  assert.equal(blocked.rule, 'C:\\1\\2')

  assert.equal(decidePath('C:\\1\\2\\3', policy).ok, false)
  assert.equal(decidePath('C:\\1\\2\\deep\\x', policy).ok, false)
  assert.equal(decidePath('C:\\1\\20', policy).ok, true, 'C:\\1\\20 is not under C:\\1\\2')
})

check('deny-only policy still refuses everything else (default deny)', () => {
  const policy = { allow: [], deny: ['C:\\secret'] }
  assert.equal(decidePath('C:\\secret\\x', policy).reason, 'denied')
  assert.equal(decidePath('C:\\public\\x', policy).reason, 'unlisted')
})

check('paths are case-insensitive and separator-insensitive', () => {
  const policy = { allow: ['d:/DSH-Home'], deny: ['D:\\dsh-home\\Profiles'] }
  assert.equal(decidePath('D:\\dsh-home\\x', policy).ok, true)
  assert.equal(decidePath('d:\\DSH-HOME\\profiles\\y', policy).reason, 'denied')
})

check('isInside boundary', () => {
  assert.equal(isInside('C:\\Windows\\System32', 'C:\\Windows'), true)
  assert.equal(isInside('C:\\Windows', 'C:\\Windows'), true)
  assert.equal(isInside('C:\\WindowsX', 'C:\\Windows'), false)
  assert.equal(isInside('D:/dsh-home/a', 'D:\\dsh-home'), true)
})

// ── 会话闸门 ────────────────────────────────────────────────
const who = { sessionId: 'qq-group-123456789', preset: 'example', cwd: 'H:\\w' }

check('sessionMode off denies everyone (default)', () => {
  assert.equal(decideSession('off', ['*'], who).reason, 'off')
  assert.equal(decideSession(undefined, ['*'], who).reason, 'off')
})

check('allowlist: exact id / prefix glob / preset / star', () => {
  assert.equal(decideSession('allowlist', ['session-example-01'], { sessionId: 'session-example-01' }).ok, true)
  assert.equal(decideSession('allowlist', ['session-example-01'], who).ok, false)
  assert.equal(decideSession('allowlist', ['qq-*'], who).ok, true)
  assert.equal(decideSession('allowlist', ['qq-group-*'], who).ok, true)
  assert.equal(decideSession('allowlist', ['qq-private-*'], who).ok, false)
  assert.equal(decideSession('allowlist', ['preset:example'], who).ok, true)
  assert.equal(decideSession('allowlist', ['preset:EXAMPLE'], { sessionId: 'x', preset: 'example' }).ok, true)
  assert.equal(decideSession('allowlist', ['preset:other'], who).ok, false)
  assert.equal(decideSession('allowlist', ['*'], who).ok, true)
})

check('matchSessionEntry never matches an empty rule', () => {
  assert.equal(matchSessionEntry('', who), false)
  assert.equal(matchSessionEntry('   ', who), false)
  assert.equal(matchSessionEntry('preset:', who), false)
})

check('denylist: listed sessions denied, everything else allowed', () => {
  assert.equal(decideSession('denylist', ['preset:example'], who).reason, 'in-denylist')
  assert.equal(decideSession('denylist', ['qq-*'], who).reason, 'in-denylist')
  assert.equal(decideSession('denylist', ['session-other'], who).ok, true)
})

check('sessionMode all allows everyone', () => {
  assert.equal(decideSession('all', [], who).ok, true)
})

// ── 其它守卫 ────────────────────────────────────────────────
check('refuses to remove an ancestor of the session cwd', () => {
  throws(() => assertNotAncestorOfCwd('H:\\workspace', 'H:\\workspace\\shared'), /inside it/)
  throws(() => assertNotAncestorOfCwd('H:\\workspace', 'H:\\workspace'), /inside it/)
  assert.equal(assertNotAncestorOfCwd('H:\\workspace\\shared', 'H:\\workspace'), undefined)
})

check('refuses to move a directory into its own subtree', () => {
  throws(() => assertNotIntoOwnSubtree('H:\\a', 'H:\\a\\b'), /own subtree/)
  assert.equal(assertNotIntoOwnSubtree('H:\\a', 'H:\\b'), undefined)
})

check('relative paths resolve against the session cwd', () => {
  assert.equal(resolveTarget('x.txt', 'H:\\w'), path.resolve('H:\\w', 'x.txt'))
  throws(() => resolveTarget('  ', 'H:\\w'), /required/)
})

// ── 配置解析 ────────────────────────────────────────────────
check('splitList accepts newlines, commas and semicolons', () => {
  assert.deepEqual(splitList('a\nb, c;d\r\ne'), ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(splitList(''), [])
  assert.deepEqual(splitList('  ,, \n '), [])
})

check('resolveConfig: safe defaults and unknown mode falls back to off', () => {
  const cfg = resolveConfig(undefined)
  assert.equal(cfg.mode, 'off')
  assert.deepEqual(cfg.sessions, [])
  assert.deepEqual(cfg.pathAllow, [])
  assert.deepEqual(cfg.pathDeny, [])
  assert.equal(cfg.askOutside, true)
  assert.equal(resolveConfig({ sessionMode: 'banana' }).mode, 'off')
  assert.equal(resolveConfig({ askOutside: false }).askOutside, false)
  assert.deepEqual(resolveConfig({ sessionList: 'qq-*\npreset:example' }).sessions, ['qq-*', 'preset:example'])
})

// ── 度量 ────────────────────────────────────────────────────
check('measureTree walks the tree and does not follow links', () => {
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(path.join(tmp, 'a', 'b'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'a', 'x.txt'), 'hello')
  fs.writeFileSync(path.join(tmp, 'a', 'b', 'y.txt'), 'hi')
  let linkMade = false
  try {
    fs.symlinkSync(path.join(tmp, 'a'), path.join(tmp, 'link'), 'junction')
    linkMade = true
  } catch {
    // 没有权限建链接就跳过这部分断言
  }
  const measured = measureTree(tmp)
  assert.ok(measured.entries >= 5, 'entries: ' + measured.entries)
  if (linkMade) {
    assert.equal(isLinkLike(path.join(tmp, 'link')), true, 'junction must be recognized as a link')
    assert.equal(isLinkLike(path.join(tmp, 'a')), false, 'plain directory must not be a link')
    assert.ok(measured.entries <= 7, 'junction must not be descended into: ' + measured.entries)
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  assert.equal(fs.existsSync(tmp), false)
})

console.log(`\n${pass} checks passed`)
