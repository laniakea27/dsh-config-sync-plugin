/**
 * dsh-config-sync —— host 半边（node 进程）。
 *
 * 职责（阶段5 骨架，先做到"能挂载 + 重启还在"）：
 *   1. 在 webServer 上注册 /api/config-sync/* 同源路由，供浏览器半边 fetch 调用。
 *   2. 用 subprocess **以绝对路径直接 spawn node** 驱动用户私有仓里的 framework 脚本
 *      —— 不复制逻辑，保住单一事实源（改 framework 即改行为）。
 *
 * ── 已核实的两条硬性约定（照抄 anchored-monitor@0.3.1 的真实写法）────────────
 *   · host 半边是普通 ESM：export name / export inject / export apply(ctx)
 *   · apply 返回 disposer；所有副作用（路由、进程、定时器）必须可回收
 *
 * ── 与浏览器半边的通道 ──────────────────────────────────────────────────────
 *   **不是** host.call（那是动态插件独有的）。正式包走同源 HTTP：
 *     host: ctx.webServer.register({ kind:'exact'|'prefix', path, handler(req,res) })
 *     client: await fetch('/api/config-sync/...')
 */
import { existsSync } from 'node:fs'
import path from 'node:path'

/** 稳定 cordis 插件名（与 cordis.patch.yml 的 insert id 一致）。 */
export const name = 'config-sync'

/**
 * 硬依赖。`webServer` 是注册路由的前提，`timer` 是 runNode 里超时
 * （ctx.timeout）的前提 —— 用到的核心服务都得 inject，否则 DSH 会报
 * `cannot get property "timer" without inject`。
 * （`subprocess` / `fs` 走 ctx.get 可选读取，不声明成硬依赖。）
 */
export const inject = ['webServer', 'timer']

/** 所有路由挂在这个前缀下，避免污染全局命名空间。 */
const API_PREFIX = '/api/config-sync'

/**
 * 候选仓库根 —— 必须在插件里显式列出，不能靠 cwd：
 * 宿主进程的 cwd 与用户 clone 的位置无关。
 */
const REPO_CANDIDATES = [
  'F:/AIagent/DeepH/dsh-config-sync',
  'F:\\AIagent\\DeepH\\dsh-config-sync',
  '/f/AIagent/DeepH/dsh-config-sync',
]

/** 仓库的"指纹文件"：有它才认这是一个 dsh-config-sync 仓。 */
const REPO_FINGERPRINT = ['framework', 'sync.mjs']

/** 懒解析并缓存仓库根（apply 作用域内，disposer 里清掉）。 */
let cachedRoot

function msg(e) {
  return String(e && e.message ? e.message : e)
}

function textOf(v) {
  return v === undefined || v === null ? '' : String(v)
}

/** 统一 JSON 输出（只产出 lossless 值：string/number/boolean/null）。 */
function writeJson(res, code, body) {
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** loopback-only 守卫：本地工具不该被外部来源调用。 */
function guard(req, res) {
  const addr = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : ''
  const ok = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === ''
  if (!ok) {
    writeJson(res, 403, { ok: false, error: 'loopback only' })
    return false
  }
  return true
}

/**
 * ★ 统一结果构造器：返回值里**绝不允许出现 undefined**。
 * （动态插件时期踩过：`{ error: r.error || undefined }` 会被宿主拒，
 *   报 `result.error must be lossless JSON data`。这里虽然走 HTTP 不会被拒，
 *   但保持一致 —— 少一种"看起来正常其实缺字段"的状态。）
 */
function result(r) {
  const src = r === null || r === undefined ? {} : r
  const out = { ok: src.ok === true, output: textOf(src.stdout) }
  if (typeof src.exitCode === 'number') out.exitCode = src.exitCode
  if (src.via !== undefined && src.via !== null) out.via = String(src.via)
  let err = textOf(src.error)
  if (err === '' && src.ok !== true) {
    err = textOf(src.stderr)
    if (err === '') err = '执行失败'
  }
  if (err !== '') out.error = err
  return out
}

export function apply(ctx) {
  const disposers = []
  cachedRoot = undefined

  /** 找用户私有仓的根目录（先查候选路径上的指纹文件）。 */
  function repoRoot() {
    if (cachedRoot !== undefined) return cachedRoot
    for (const base of REPO_CANDIDATES) {
      const probe = path.join(base, REPO_FINGERPRINT[0], REPO_FINGERPRINT[1])
      try {
        if (existsSync(probe)) { cachedRoot = base; return base }
      } catch { /* 忽略：继续下一个候选 */ }
    }
    cachedRoot = null
    return null
  }

  function readCollected(reader) {
    if (reader === undefined || reader === null) return ''
    try {
      const r = reader.readFrom(0)
      return r && r.text ? String(r.text) : ''
    } catch { return '' }
  }

  /**
   * ★ 首选通道：subprocess 直接 spawn node（**不要包 bash 层**）。
   *
   * 踩过的坑：`shell` 服务交给 ctx.subprocess 的 argv 是 ["bash", command]，
   * 而本机 Git Bash 不在 PATH → 每次 shell.run() 都解析解释器失败，
   * 所有按钮**静默失效**。跑 Node 脚本必须直接用 subprocess + 绝对路径。
   */
  async function runNode(argv, timeoutMs) {
    const sub = ctx.get('subprocess')
    if (sub === undefined) return { ok: false, error: 'subprocess 服务不可用' }
    const root = repoRoot()
    if (root === null) return { ok: false, error: '找不到 dsh-config-sync 仓库（候选路径都没命中）' }

    let nodePath
    try { nodePath = await sub.resolveExecutable('node') }
    catch (e) { return { ok: false, error: 'resolveExecutable(node) 失败：' + msg(e) } }

    let handle
    try {
      handle = sub.spawn({
        argv: [nodePath, ...argv],
        cwd: root,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 4000000 },
          stderr: { maxBytes: 1000000 },
        },
        graceMs: 5000,
      })
    } catch (e) {
      return { ok: false, error: 'subprocess.spawn 抛错：' + msg(e) }
    }

    const limit = timeoutMs || 180000
    let res
    try {
      res = await Promise.race([
        handle.done.then((o) => ({ t: 'done', o }), (e) => ({ t: 'reject', e })),
        ctx.timeout(limit).then(() => ({ t: 'timeout' })),
      ])
    } catch (e) {
      return { ok: false, error: '等待子进程失败：' + msg(e) }
    }

    const stdout = readCollected(handle.collected && handle.collected.stdout)
    const stderr = readCollected(handle.collected && handle.collected.stderr)

    if (res.t === 'timeout') {
      try { handle.terminate() } catch { /* 已退出则忽略 */ }
      return { ok: false, error: `超时 ${limit}ms（已终止）`, stdout, stderr }
    }
    if (res.t === 'reject') {
      return { ok: false, error: '子进程失败：' + msg(res.e), stdout, stderr }
    }
    const code = res.o && typeof res.o.exitCode === 'number' ? res.o.exitCode : -1
    return { ok: code === 0, exitCode: code, stdout, stderr, via: 'subprocess' }
  }

  /** 跑用户私有仓 framework 下的一个脚本（相对路径 + 参数）。 */
  function runScript(rel, extraArgs, timeoutMs) {
    return runNode([rel, ...(extraArgs || [])], timeoutMs)
  }

  /** 读 HTTP 请求体并把 JSON 解析出来（POST 用）。 */
  function readJsonBody(req) {
    return new Promise((resolve) => {
      const chunks = []
      let n = 0
      req.on('data', (d) => { n += d.length; if (n <= 200000) chunks.push(d) })
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (text.trim() === '') return resolve({})
        try { resolve(JSON.parse(text)) } catch { resolve({ error: 'body 不是合法 JSON' }) }
      })
      req.on('error', () => resolve({ error: '读取请求体失败' }))
    })
  }

  // ── 路由 ────────────────────────────────────────────────────────────────

  /** 连通性探针：浏览器半边据此判断 host 是否活着。 */
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: API_PREFIX + '/ping',
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if ((req.method || 'GET') !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      return writeJson(res, 200, { ok: true, pong: true, ts: Date.now() })
    },
  }))

  /**
   * 诊断：不猜、只报事实。这是"宿主半边是否真的激活 + 运行通道是否可用"的探针
   * （agent.md §11.6 改进点 3：把组件拎出来单跑，是最有效的判定手法）。
   */
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: API_PREFIX + '/diag',
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if ((req.method || 'GET') !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      const sub = ctx.get('subprocess')
      const root = repoRoot()
      const out = {
        ok: true,
        plugin: name,
        hasWebServer: true,
        hasSubprocess: sub !== undefined,
        repoRoot: root === null ? null : String(root),
      }
      if (sub !== undefined) {
        try { out.nodePath = String(await sub.resolveExecutable('node')) }
        catch (e) { out.nodeResolveError = msg(e) }
        // 真的跑一次 node：证明"能 spawn 且能拿到输出"，而不是假设它行
        out.probe = result(await runNode(['-e', 'console.log(1+1)'], 30000))
      }
      return writeJson(res, 200, out)
    },
  }))

  // ── 仓库 / 首次引导 ────────────────────────────────────────────────────

  /** 用户私有仓是否可定位。 */
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: API_PREFIX + '/repo.info',
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if ((req.method || 'GET') !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      const root = repoRoot()
      return writeJson(res, 200, { ok: true, found: root !== null, root: root === null ? null : String(root) })
    },
  }))

  /** 是否该弹首次引导（exit 0=该弹）。失败走独立 error，绝不伪装成"已引导"（坑 3）。 */
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: API_PREFIX + '/onboarding.check',
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if ((req.method || 'GET') !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      const r = await runScript('framework/onboarding.mjs', ['--check'], 60000)
      if (r.error !== undefined) return writeJson(res, 200, { ok: false, due: false, error: textOf(r.error), via: textOf(r.via) })
      const code = typeof r.exitCode === 'number' ? r.exitCode : -1
      return writeJson(res, 200, { ok: true, due: code === 0, output: textOf(r.stdout), exitCode: code, via: textOf(r.via) })
    },
  }))

  /** 标记引导完成（写一次性标记文件，git 之外）。 */
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: API_PREFIX + '/onboarding.markDone',
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if ((req.method || 'POST') !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      const code = "import('./framework/onboarding.mjs').then(function(m){m.markDone();console.log('marked')})"
      const r = await runNode(['--input-type=module', '-e', code], 60000)
      return writeJson(res, 200, result(r))
    },
  }))

  /** 清除引导标记（= 模拟卸载重装，下次再弹）。 */
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: API_PREFIX + '/onboarding.reset',
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if ((req.method || 'GET') !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      const r = await runScript('framework/onboarding.mjs', ['--reset'], 60000)
      return writeJson(res, 200, result(r))
    },
  }))

  // ── 三按钮 ──────────────────────────────────────────────────────────────

  /** ① 同步环境配置：导出脱敏快照。 */
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: API_PREFIX + '/sync.export',
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if ((req.method || 'GET') !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      return writeJson(res, 200, result(await runScript('framework/sync.mjs', ['export'], 180000)))
    },
  }))

  /** ① 同步环境配置：只读漂移检测。 */
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: API_PREFIX + '/sync.drift',
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if ((req.method || 'GET') !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      const r = await runScript('framework/sync.mjs', ['import', 'sync/environment/last-sync.json', '--json'], 180000)
      const base = result(r)
      let alerts = []
      try { alerts = JSON.parse(textOf(r.stdout)).alerts || [] } catch { alerts = [] }
      const out = { ok: base.ok, alerts, output: base.output }
      if (base.error !== undefined) out.error = base.error
      return writeJson(res, 200, out)
    },
  }))

  /** ② 总结当前对话：预览（不推送）。 */
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: API_PREFIX + '/note.preview',
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if ((req.method || 'GET') !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      return writeJson(res, 200, result(await runScript('framework/push-note.mjs', ['--dry-run'], 180000)))
    },
  }))

  /** ② 总结当前对话：确认后推送到私有仓。未确认直接拒绝。 */
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: API_PREFIX + '/note.push',
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if ((req.method || 'POST') !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      const body = await readJsonBody(req)
      if (body.error !== undefined) return writeJson(res, 400, { ok: false, error: body.error })
      if (body.confirmed !== true) {
        return writeJson(res, 200, { ok: false, output: '', error: '未确认，拒绝推送（需要显式确认）' })
      }
      return writeJson(res, 200, result(await runScript('framework/push-note.mjs', ['--yes'], 300000)))
    },
  }))

  /** ③ 浏览仓库会话汇总（纯只读）。 */
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: API_PREFIX + '/browse.list',
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if ((req.method || 'GET') !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      const r = await runScript('framework/browse.mjs', ['--json', '--remote'], 120000)
      const base = result(r)
      let items = []
      let remote = null
      try {
        const j = JSON.parse(textOf(r.stdout))
        items = Array.isArray(j.summaries) ? j.summaries : []
        remote = j.remote === undefined || j.remote === null ? null : String(j.remote)
      } catch { items = [] }
      const out = { ok: base.ok, items, remote, output: base.output }
      if (base.error !== undefined) out.error = base.error
      return writeJson(res, 200, out)
    },
  }))

  ctx.logger?.info?.(`[${name}] host half ready: ${API_PREFIX}/*`)

  // ★ 所有副作用统一回收（路由必须 dispose，否则重载后会重复注册）
  return () => {
    cachedRoot = undefined
    for (const dispose of disposers) {
      try { dispose() } catch { /* 卸载失败不阻塞 */ }
    }
  }
}
