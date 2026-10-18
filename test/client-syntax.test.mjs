// node test/client-syntax.test.mjs —— 浏览器半是经典脚本（宿主按字节下发），
// 编译不过就是整个 tab 消失。这里做三条检查：
//   1. 整个文件能被 JS 引擎编译（new Function 只编译、不执行，不会碰 window）；
//   2. 顶层没有 import / export（那会让 <script> 直接语法错误）；
//   3. 注册了正确的包名、槽位、路由前缀。
// 顺带 import 一下宿主半 —— 抓「模块求值就炸」那一类错误。
import assert from 'node:assert/strict'
import fs from 'node:fs'

const here = new URL('.', import.meta.url)
const source = fs.readFileSync(new URL('../client/client.js', here), 'utf8')

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

check('client half compiles as a classic script', () => {
  assert.doesNotThrow(() => new Function(source))
})

check('client half has no top-level import / export', () => {
  assert.doesNotMatch(source, /^\s*(?:import|export)\s/m)
  assert.doesNotMatch(source, /^\s*export\s*\{/m)
})

check('client half registers under the package name and the settings tab slot', () => {
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(source, /id:\s*'dsh-host-fs'/)
  assert.match(source, /settings\.plugins\.tab/)
  assert.match(source, /id:\s*'dsh-host-fs',\s*\n\s*order:\s*60/)
  assert.match(source, /api\/dsh-host-fs/)
})

check('client half keeps the safety wording visible', () => {
  assert.match(source, /默认拒绝/)
  assert.match(source, /黑名单优先于白名单/)
  assert.match(source, /驱动器根永远拒绝/)
})

await checkAsync('host half imports cleanly and exports the route base', async () => {
  const host = await import('../lib/settings-host.js')
  assert.equal(host.ROUTE_BASE, '/api/dsh-host-fs')
  assert.equal(typeof host.installSettingsRoutes, 'function')
})

console.log(`\n${pass} checks passed`)
