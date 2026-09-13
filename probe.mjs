#!/usr/bin/env node
/**
 * probe.mjs —— 把插件从环境里拎出来单跑，用 mock ctx 直接调 apply()。
 *
 * ★ 这是 agent.md §11.6 改进点 3 要求固化的手法：判断"宿主半边是否真的激活"
 *   最有效的证据来自**隔离复现**，而不是从环境里反推。
 *   它一次就推翻过三个"看起来很像"的错误推断（§11.5）。
 *
 * 本探针**不安装、不改 profile、不碰正在跑的宿主**，只做四件事：
 *   1. host 半边：检查导出形状（name / inject / apply）
 *   2. host 半边：用 mock webServer 调用 apply，确认路由注册正确
 *   3. host 半边：**真的**用 mock subprocess 跑一次 /diag，确认能 spawn node 并拿到输出
 *   4. client 半边：用 mock window/require 执行 bundle，确认 factory 与 apply 形状正确
 *   5. 两边：确认 apply 返回的 disposer 真的能回收副作用
 *
 * 用法：node probe.mjs
 */
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const results = []

function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? '  ✔' : '  ✘'} ${name}${detail ? '  —— ' + detail : ''}`)
}

// ─────────────────────────── mock 基础设施 ───────────────────────────

/** mock webServer：记录注册的路由，返回可用的 disposer。 */
function makeWebServer() {
  const routes = new Map()
  return {
    routes,
    register(route) {
      const key = `${route.kind} ${route.path}`
      routes.set(key, route)
      return () => { routes.delete(key) }
    },
  }
}

/**
 * mock subprocess：忠实模拟真实服务的形状
 *   { resolveExecutable(name), spawn({argv,cwd,stdio,graceMs}) -> {done, collected, terminate} }
 * collected.stdout.readFrom(0) -> { text }
 * 底层真的用 node:child_process spawn，所以这是端到端验证而不是打桩。
 */
function makeSubprocess() {
  return {
    async resolveExecutable(name) {
      if (name === 'node') return process.execPath
      throw new Error('未找到可执行文件：' + name)
    },
    spawn({ argv, cwd }) {
      const child = spawn(argv[0], argv.slice(1), { cwd, windowsHide: true })
      const buf = { stdout: [], stderr: [] }
      child.stdout.on('data', (d) => buf.stdout.push(d))
      child.stderr.on('data', (d) => buf.stderr.push(d))
      const done = new Promise((resolve, reject) => {
        child.on('error', reject)
        child.on('close', (exitCode) => resolve({ exitCode }))
      })
      const reader = (k) => ({ readFrom: () => ({ text: Buffer.concat(buf[k]).toString('utf8') }) })
      return {
        done,
        collected: { stdout: reader('stdout'), stderr: reader('stderr') },
        terminate: () => { try { child.kill() } catch { /* ignore */ } },
      }
    },
  }
}

/** 极简 React 桩：只需要让 factory 能跑通、不真的渲染。 */
function makeReactStub() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [init, () => {}],
    useEffect: () => {},
    useRef: (init) => ({ current: init }),
    Fragment: 'Fragment',
  }
}

/** 假的 req/res，用来直接调用路由 handler。 */
function fakeReq(method = 'GET') {
  return { method, url: '/', socket: { remoteAddress: '127.0.0.1' } }
}
function fakeRes() {
  return {
    code: 0,
    body: '',
    headers: null,
    writeHead(code, headers) { this.code = code; this.headers = headers },
    end(body) { this.body = body === undefined ? '' : String(body) },
  }
}

// ─────────────────────────── 1/2/3. host 半边 ───────────────────────────

console.log('\n── host 半边（lib/index.js）──')
const hostPath = path.join(HERE, 'lib', 'index.js')
const host = await import(pathToFileURL(hostPath).href)

check('导出 name', typeof host.name === 'string' && host.name.length > 0, `name = ${JSON.stringify(host.name)}`)
check('导出 inject 数组', Array.isArray(host.inject), `inject = ${JSON.stringify(host.inject)}`)
check('导出 apply 函数', typeof host.apply === 'function')
check('inject 声明了 webServer', Array.isArray(host.inject) && host.inject.includes('webServer'))

const injected = new Set(host.inject ?? [])
const webServer = makeWebServer()
const sub = makeSubprocess()
// ★ 忠实模拟 DSH 的 inject 契约：**只有 inject 里声明的服务**才作为 ctx 属性提供。
//   （真实 DSH 里，用了没 inject 的服务会报 `cannot get property "timer" without inject`。）
//   这样"apply 用了没声明服务"的类 bug 能在探针阶段被抓到，而不是在真实运行时才炸。
//   `subprocess` 是可选服务，走 ctx.get（不声明也是合法用法，所以无条件提供）。
const ctx = {
  ...(injected.has('webServer') ? { webServer } : {}),
  ...(injected.has('timer') ? { timeout: () => new Promise(() => {}) } : {}),
  get: (n) => (n === 'subprocess' ? sub : undefined),
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}

let dispose
try {
  dispose = host.apply(ctx)
  check('apply(ctx) 正常返回', true, `返回 ${typeof dispose}`)
} catch (e) {
  check('apply(ctx) 正常返回', false, String(e && e.message ? e.message : e))
}
check('apply 返回 disposer', typeof dispose === 'function')

const routeKeys = [...webServer.routes.keys()]
check('注册了 /ping 路由', routeKeys.includes('exact /api/config-sync/ping'), routeKeys.join(' | '))
check('注册了 /diag 路由', routeKeys.includes('exact /api/config-sync/diag'))

// 真的跑一次 /diag（会经 mock subprocess 真的 spawn node）
const diagRoute = webServer.routes.get('exact /api/config-sync/diag')
if (diagRoute === undefined) {
  check('/diag 端到端调用', false, '路由未注册')
} else {
  const res = fakeRes()
  try {
    await diagRoute.handler(fakeReq('GET'), res)
    const body = JSON.parse(res.body)
    check('/diag 返回 200 JSON', res.code === 200 && body.ok === true, `HTTP ${res.code}`)
    check('/diag 认出了仓库根', typeof body.repoRoot === 'string' && body.repoRoot.length > 0, `repoRoot = ${body.repoRoot}`)
    check('/diag 解析到 node 绝对路径', typeof body.nodePath === 'string' && body.nodePath.length > 0, `nodePath = ${body.nodePath}`)
    check('/diag 真的 spawn 了 node 并拿到输出', body.probe && body.probe.ok === true && String(body.probe.output).includes('2'),
      `probe.output = ${JSON.stringify(body.probe && body.probe.output)}`)
    check('/diag 返回值无 undefined 字段', !res.body.includes('undefined'), '（lossless JSON 约定）')
  } catch (e) {
    check('/diag 端到端调用', false, String(e && e.message ? e.message : e))
  }
}

// 405 分支
if (diagRoute !== undefined) {
  const res405 = fakeRes()
  await diagRoute.handler(fakeReq('POST'), res405)
  check('非 GET 返回 405', res405.code === 405, `HTTP ${res405.code}`)
}

// ── 业务路由（只读部分）端到端：经 mock subprocess **真的跑用户私有仓的 framework 脚本** ──
//   只测只读路由，不碰会改 profile / 推送 / 写快照的（note.push / sync.export 等）——
//   探针保持零副作用。
async function hit(route, method = 'GET') {
  const res = fakeRes()
  await route.handler(fakeReq(method), res)
  let body = null
  try { body = JSON.parse(res.body) } catch { /* keep null */ }
  return { code: res.code, body, raw: res.body }
}

const busCases = [
  ['exact /api/config-sync/repo.info', 'repo.info 端到端', (b) => b.ok === true && b.found === true],
  ['exact /api/config-sync/onboarding.check', 'onboarding.check 端到端', (b) => b.ok === true && typeof b.due === 'boolean'],
  ['exact /api/config-sync/onboarding.situation', 'onboarding.situation 端到端（三分支+步骤）', (b) => b.ok === true && Array.isArray(b.branches) && b.branches.length === 3 && Array.isArray(b.steps)],
  // sync.drift 在"还没有快照"时会返回 error 字段（合法且正确：提示先导出快照）——
  // 探针只要求"路由活着 + 返回结构化的 alerts 数组"，不要求快照一定存在。
  ['exact /api/config-sync/sync.drift', 'sync.drift 端到端', (b) => Array.isArray(b.alerts) && (b.ok === true || typeof b.error === 'string')],
  ['exact /api/config-sync/browse.list', 'browse.list 端到端', (b) => b.ok === true && Array.isArray(b.items)],
  ['exact /api/config-sync/note.preview', 'note.preview 端到端', (b) => b.ok === true || (b.error !== undefined && typeof b.error === 'string')],
]
for (const [key, label, pred] of busCases) {
  const route = webServer.routes.get(key)
  if (route === undefined) { check(label, false, '路由未注册'); continue }
  try {
    const r = await hit(route)
    const pass = r.code === 200 && r.body !== null && pred(r.body)
    check(label, pass,
      pass ? `HTTP ${r.code}${r.body && r.body.error ? '（返回了 error 字段，未伪装成正常值 ✓）' : ''}`
           : `HTTP ${r.code} raw=${String(r.raw || '').slice(0, 120)}`)
  } catch (e) { check(label, false, String(e && e.message ? e.message : e)) }
}

// disposer 真的回收
if (typeof dispose === 'function') {
  dispose()
  check('disposer 回收了全部路由', webServer.routes.size === 0, `剩余 ${webServer.routes.size} 条`)
}

// ─────────────────────────── 4/5. client 半边 ───────────────────────────

console.log('\n── client 半边（lib/client.js）──')
let spec
globalThis.window = {
  __ModuleLoader__: { load(s) { spec = s } },
}

try {
  await import(pathToFileURL(path.join(HERE, 'lib', 'client.js')).href)
  check('bundle 执行并调用 __ModuleLoader__.load', spec !== undefined)
} catch (e) {
  check('bundle 执行并调用 __ModuleLoader__.load', false, String(e && e.message ? e.message : e))
}

if (spec !== undefined) {
  check('load 的 id 与包名一致（必须）', spec.id === 'dsh-config-sync', `id = ${JSON.stringify(spec.id)}`)
  check('load 提供 factory 函数', typeof spec.factory === 'function')

  // 读 package.json 交叉校验 id
  const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(HERE, 'package.json'), 'utf8'))
  check('id == package.json.name', spec.id === pkg.name, `${spec.id} vs ${pkg.name}`)

  let mod
  try {
    mod = spec.factory((id) => {
      if (id === 'react') return makeReactStub()
      throw new Error('未预期的 require：' + id)
    })
    check('factory(require) 正常返回', mod !== undefined && mod !== null)
  } catch (e) {
    check('factory(require) 正常返回', false, String(e && e.message ? e.message : e))
  }

  check('返回的是 module.exports（有 apply）', mod !== undefined && typeof mod.apply === 'function')
  check('exports.inject 声明了 slots', mod !== undefined && Array.isArray(mod.inject) && mod.inject.includes('slots'),
    `inject = ${JSON.stringify(mod && mod.inject)}`)

  // 用 mock slots 调 apply
  const registered = []
  let injectedSlots = []
  const mockSlots = {
    inject(name, fn) { injectedSlots.push(name); try { fn() } catch { /* ignore */ } return () => {} },
    register(desc) { registered.push(desc); return () => {} },
  }
  let clientDispose
  try {
    clientDispose = mod.apply({ slots: mockSlots })
    check('client apply(ctx) 正常返回', true)
  } catch (e) {
    check('client apply(ctx) 正常返回', false, String(e && e.message ? e.message : e))
  }
  check('inject 到 settings.section', injectedSlots.includes('settings.section'), injectedSlots.join(' | '))
  const panel = registered.find((d) => d.id === 'config-sync')
  check('注册了 settings.section 条目（id=config-sync）', panel !== undefined,
    panel ? `order=${panel.order} label=${panel.label}` : registered.map((d) => d.id).join(','))
  check('注册条目带 label', panel !== undefined && typeof panel.label === 'string' && panel.label.length > 0)
  check('inject 到 shell.overlay（首次引导）', injectedSlots.includes('shell.overlay'), injectedSlots.join(' | '))
  const onb = registered.find((d) => d.id === 'config-sync-onboarding')
  check('注册了 shell.overlay 引导条目（id=config-sync-onboarding）', onb !== undefined,
    onb ? `order=${onb.order} name=${onb.name}` : registered.map((d) => d.id).join(','))
  check('client apply 返回 disposer 或 undefined（不报错即可）', clientDispose === undefined || typeof clientDispose === 'function')
}

delete globalThis.window

// ─────────────────────────── 汇总 ───────────────────────────

const failed = results.filter((r) => !r.pass)
console.log('\n' + '─'.repeat(60))
console.log(`探针结果：${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const f of failed) console.log(`  ✘ ${f.name}${f.detail ? '  —— ' + f.detail : ''}`)
  process.exit(1)
}
console.log('两边半边形状与运行通道均正常（未安装、未改 profile）。')
process.exit(0)
