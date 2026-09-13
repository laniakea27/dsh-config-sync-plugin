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
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
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
 * 候选仓库根 —— 不能靠 cwd（宿主进程的 cwd 与用户 clone 的位置无关），
 * 也**绝不能写死某一台机器的盘符**（那样发布后在别的机器上根本找不到仓库）。
 *
 * 三层探测，顺序 = 优先级（全部与机器无关）：
 *   1. 环境变量 `DSH_CONFIG_SYNC_REPO` —— 显式指定，最可信
 *   2. `~/.dsh/.dsh-config-sync/repo.json` 里的 `repoRoot` —— 持久化配置（可被设置界面写入）
 *   3. `~/dsh-config-sync` —— 默认约定位置（新机器 clone 到这里即可零配置）
 *
 * ★ 如果**同时存在多份**，会在 /repo.info 里报 ambiguous + 列出全部命中，
 *   避免"插件用了 A、你在终端改了 B"这种各自漂移（实测踩过）。
 */
const REPO_CONFIG_FILE = () => path.join(homedir(), '.dsh', '.dsh-config-sync', 'repo.json')

function repoCandidates() {
  const raw = []
  const push = p => { if (typeof p === 'string' && p.trim() !== '') raw.push(p.trim()) }

  push(process.env.DSH_CONFIG_SYNC_REPO)

  // 持久化配置（用户/设置界面写的），格式 {"repoRoot":"<绝对路径>"}
  try {
    const cfg = REPO_CONFIG_FILE()
    if (existsSync(cfg)) {
      const j = JSON.parse(readFileSync(cfg, 'utf8'))
      if (j !== null && typeof j === 'object') push(j.repoRoot)
    }
  } catch { /* 配置坏了就当没有，不阻断 */ }

  try { push(path.join(homedir(), 'dsh-config-sync')) } catch { /* ignore */ }

  // 去重：同一目录用正/反斜杠写两遍是同一个地方，不该被算成"两份副本"
  const norm = p => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const seen = new Set()
  const out = []
  for (const p of raw) {
    const k = norm(p)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(p)
  }
  return out
}

/** 找不到仓库时，给用户**可直接照做**的三条出路（而不是一句"找不到"）。 */
function repoNotFoundHint() {
  return [
    '找不到配置仓（dsh-config-sync）。任选一种即可：',
    '  a) 把配置仓 clone 到主目录：git clone <你的私有仓> ' + path.join(homedir(), 'dsh-config-sync'),
    '  b) 设环境变量：DSH_CONFIG_SYNC_REPO=<配置仓绝对路径>',
    '  c) 写配置文件：' + REPO_CONFIG_FILE() + '  内容 {"repoRoot":"<配置仓绝对路径>"}',
  ].join('\n')
}

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

  /** 全部命中的候选（用于"多份副本"歧义检测）。 */
  function allRepoRoots() {
    const hits = []
    for (const base of repoCandidates()) {
      const probe = path.join(base, REPO_FINGERPRINT[0], REPO_FINGERPRINT[1])
      try { if (existsSync(probe)) hits.push(String(base)) } catch { /* ignore */ }
    }
    return hits
  }

  /**
   * 找用户私有仓的根目录（先查候选路径上的指纹文件）。
   * ★ 命中多个时不静默取第一个 —— 由 /repo.info 报 ambiguous，让人知道有两份。
   */
  function repoRoot() {
    if (cachedRoot !== undefined) return cachedRoot
    const hits = allRepoRoots()
    cachedRoot = hits.length > 0 ? hits[0] : null
    return cachedRoot
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
    if (root === null) return { ok: false, error: repoNotFoundHint() }

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
      const all = allRepoRoots()
      const out = {
        ok: true,
        plugin: name,
        hasWebServer: true,
        hasSubprocess: sub !== undefined,
        repoRoot: root === null ? null : String(root),
        repoAllFound: all,
        repoAmbiguous: all.length > 1,
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

  /**
   * 用户私有仓是否可定位。
   * ★ 同时报出"一共找到几份"：命中 >1 就 ambiguous=true —— 多份副本会各自漂移
   *   （插件用了 A、你在终端改了 B，改动看起来"没生效"），必须让人看见而不是静默取第一个。
   */
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: API_PREFIX + '/repo.info',
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if ((req.method || 'GET') !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      const root = repoRoot()
      const all = allRepoRoots()
      return writeJson(res, 200, {
        ok: true,
        found: root !== null,
        root: root === null ? null : String(root),
        allFound: all,
        ambiguous: all.length > 1,
      })
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

  /** ★ 当前搭配 + 该走哪些步骤（只读，机器可读）—— 供引导界面让用户"按分支走进对应流程"。 */
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: API_PREFIX + '/onboarding.situation',
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if ((req.method || 'GET') !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      const r = await runScript('framework/onboarding.mjs', ['--situation', '--json'], 60000)
      if (r.error !== undefined) {
        return writeJson(res, 200, { ok: false, error: textOf(r.error), via: textOf(r.via) })
      }
      let j = null
      try { j = JSON.parse(textOf(r.stdout)) } catch { j = null }
      if (j === null) {
        return writeJson(res, 200, { ok: false, error: 'onboarding.mjs --situation --json 的输出不是合法 JSON' })
      }
      // 透传（只产出 lossless 值）
      return writeJson(res, 200, {
        ok: true,
        due: j.due === true,
        branch: textOf(j.branch),
        branchLabel: textOf(j.branchLabel),
        account: j.account === undefined || j.account === null ? null : String(j.account),
        email: j.email === undefined || j.email === null ? null : String(j.email),
        branches: Array.isArray(j.branches) ? j.branches : [],
        evidence: Array.isArray(j.evidence) ? j.evidence.map(textOf) : [],
        steps: Array.isArray(j.steps) ? j.steps : [],
        via: textOf(r.via),
      })
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
