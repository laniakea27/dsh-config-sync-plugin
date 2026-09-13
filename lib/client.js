/* dsh-config-sync — 浏览器半边（手写 __ModuleLoader__ bundle）。
 *
 * 形状逐字对齐已核实的 @a9i5k4/dsh-anchored-monitor@0.3.1 lib/client.js：
 *   1. id 必须 == package.json 的 name
 *   2. factory 必须 return module.exports（不是 {apply} 字面量）
 *   3. React 用 require('react')；用 React.createElement（没有 JSX、没有构建链）
 *   4. 服务从 ctx.slots 直接取（exports.inject 已声明），不是 ctx.get('slots')
 *   5. 调宿主用同源 fetch('/api/config-sync/...')，不是 host.call
 *
 * 内容：
 *   · settings.section「配置同步」：三按钮（① 同步环境配置 ② 总结对话并推送 ③ 浏览仓库）+ 诊断
 *   · shell.overlay「首次引导」：install 后弹一次（一次性标记），reset/markDone 后重查
 *
 * 三条纪律：
 *   - 失败**必须显性暴露** error 字段，绝不伪装成正常值（坑 3）。
 *   - 推送 = 显式确认（两段式按钮），未确认不发请求（红线 5）。
 *   - 颜色用真 token（--dsw-alias-*）（坑 4）。
 */
console.log('[dsh-config-sync] client loading…')
window.__ModuleLoader__.load({
  id: 'dsh-config-sync',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    var API = '/api/config-sync'
    var STYLE_ID = 'dsh-config-sync-style'

    /* 主题变量一律用真实 token（--dsw-alias-*）。 */
    var CSS = [
      '.cfgsync-wrap{padding:4px 0;max-width:680px}',
      '.cfgsync-group{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:10px;padding:12px 14px;margin-bottom:12px}',
      '.cfgsync-gtitle{margin:0 0 4px;font-size:14px;color:var(--dsw-alias-label-primary)}',
      '.cfgsync-gdesc{margin:0 0 8px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}',
      '.cfgsync-row{display:flex;flex-wrap:wrap;gap:8px}',
      '.cfgsync-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);',
      'color:var(--dsw-alias-label-primary);border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer}',
      '.cfgsync-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.cfgsync-btn:disabled{opacity:.5;cursor:default}',
      '.cfgsync-btn.primary{background:var(--dsw-alias-brand-primary);color:#fff;border-color:transparent}',
      '.cfgsync-btn.danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.cfgsync-out{background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:8px;padding:12px 14px;font-size:12px;line-height:1.7;white-space:pre-wrap;',
      'word-break:break-all;max-height:320px;overflow:auto;color:var(--dsw-alias-label-primary);margin:8px 0 0}',
      '.cfgsync-muted{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.cfgsync-err{color:var(--dsw-alias-state-error-primary);font-weight:600}',
      // 引导对话框
      '.cfgsync-onb{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;',
      'background:var(--dsw-alias-bg-overlay);pointer-events:auto}',
      '.cfgsync-onb-card{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);',
      'border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:22px 24px;max-width:520px;width:92%;',
      'box-shadow:0 16px 48px rgba(0,0,0,.35);font-size:14px;line-height:1.7}',
      '.cfgsync-onb h3{margin:0 0 10px;font-size:17px}',
    ].join('')

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      var el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
    }
    function removeStyle() {
      if (typeof document === 'undefined') return
      var el = document.getElementById(STYLE_ID)
      if (el && el.parentNode) el.parentNode.removeChild(el)
    }

    /* ★ 共享信号（简报 §6.3）：设置页做完 reset / markDone 后，让引导对话框重新自查，
     *   否则 useEffect 只在挂载时查一次，reset 后要重启才能看到（坑 5）。 */
    var onboard = {
      fns: [],
      sub(fn) { this.fns.push(fn); var self = this; return function () { var i = self.fns.indexOf(fn); if (i >= 0) self.fns.splice(i, 1) } },
      emit() { for (var i = 0; i < this.fns.length; i++) { try { this.fns[i]() } catch (e) { /* 单个订阅者失败不拖累其它 */ } } },
    }

    /** 统一的宿主调用：GET 或带 body 的 POST。失败**必须显性暴露** error。 */
    async function callApi(route, method, body) {
      var m = method || 'GET'
      var opts = { method: m, headers: { accept: 'application/json' } }
      if (body !== undefined) opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body)
      var res = await fetch(API + route, opts)
      var text = await res.text()
      var json = null
      try { json = JSON.parse(text) } catch (e) { json = null }
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ' ' + String(text || '').slice(0, 300) }
      if (json === null) return { ok: false, error: '响应不是 JSON：' + String(text || '').slice(0, 300) }
      return json
    }

    // ───────────────────────── 设置页：三按钮 ─────────────────────────

    /* ★ 结果渲染：每个动作**格式化**成可读文本，而不是整段 dump 原始 JSON。
     *   框架脚本（framework/*.mjs）很多自带人类可读的 stdout（output），
     *   结构化字段只挑关键项；失败仍走显性 error（坑 3）。 */
    function renderResult(action, r) {
      switch (action) {
        case 'diag':
          return '仓库根   : ' + (r.repoRoot || '(未找到)')
            + '\nnode     : ' + (r.nodePath || '(未解析)')
            + '\n运行通道 : ' + (r.probe && r.probe.ok === true
              ? 'OK，node 输出 = ' + JSON.stringify(r.probe.output)
              : (r.probe && r.probe.error ? '失败：' + r.probe.error : '(subprocess 不可用)'))
        case 'browse': {
          var items = r.items || []
          var lines = ['远端: ' + (r.remote || '(无远端)')]
          for (var k = 0; k < items.length; k++) {
            var it = items[k]
            var size = (it.size && it.size > 0) ? (' (' + (it.size / 1024).toFixed(1) + ' KB)') : ''
            lines.push('· ' + it.file + size + (it.source_device ? ('  来自 ' + it.source_device) : ''))
            if (it.firstLine) lines.push('    ' + String(it.firstLine).slice(0, 80))
          }
          lines.push('共 ' + items.length + ' 条摘要。')
          return lines.join('\n')
        }
        case 'drift': {
          var alerts = r.alerts || []
          if (alerts.length === 0) return '无漂移 —— 快照与本机一致（或没有可比的基线项）。'
          return '漂移 ' + alerts.length + ' 项：\n' + alerts.map(function (x) { return '· [' + x.kind + '] ' + x.message }).join('\n')
        }
        case 'export':
          return String(r.output || '已导出。').trim()
        case 'preview':
          return String(r.output || '（空）').trim()
        case 'push':
          return String(r.output || '已推送。').trim()
        default:
          return JSON.stringify(r, null, 2)
      }
    }

    function Panel() {
      var [busy, setBusy] = useState(false)
      var [out, setOut] = useState('')
      var [isErr, setIsErr] = useState(false)
      var [armedPush, setArmedPush] = useState(false)

      useEffect(function () { ensureStyle() }, [])

      function show(text, err) { setOut(text); setIsErr(!!err) }

      async function run(action, label, route, method, body) {
        setBusy(true)
        show('（' + label + ' 执行中…）', false)
        try {
          var r = await callApi(route, method, body)
          if (r && r.ok === true) show(label + ' ✓\n' + renderResult(action, r), false)
          else show(label + ' 失败：\n' + String((r && r.error) || '未知错误'), true)
        } catch (e) {
          show(label + ' 抛错：\n' + String(e && e.message ? e.message : e), true)
        } finally {
          setBusy(false)
        }
      }

      function onReset() {
        setBusy(true)
        show('（重置引导 …）', false)
        callApi('/onboarding.reset').then(function (r) {
          setBusy(false)
          if (r && r.ok === true) { show('已重置引导标记 —— 首次引导对话框会重新弹出。', false); onboard.emit() }
          else show('重置引导失败：\n' + String((r && r.error) || '未知错误'), true)
        }).catch(function (e) { setBusy(false); show('重置引导抛错：\n' + String(e && e.message ? e.message : e), true) })
      }

      // ② 推送：两段式显式确认
      function onPush() {
        if (!armedPush) { setArmedPush(true); show('已进入确认态：**再点一次**「确认并推送私有仓」才真正推送。', false); return }
        setArmedPush(false)
        run('push', '总结并推送', '/note.push', 'POST', { confirmed: true })
      }

      // 三颗（组）按钮
      return h('div', { className: 'cfgsync-wrap' },
        h('div', { className: 'cfgsync-group' },
          h('p', { className: 'cfgsync-gtitle' }, '① 同步环境配置'),
          h('p', { className: 'cfgsync-gdesc' }, '导出「能力清单 + 基线 + 状态快照」到私有仓；导入只做只读漂移检测，不复制整包配置。'),
          h('div', { className: 'cfgsync-row' },
            h('button', { className: 'cfgsync-btn', disabled: busy, onClick: function () { run('export', '导出快照', '/sync.export') } }, '导出快照'),
            h('button', { className: 'cfgsync-btn', disabled: busy, onClick: function () { run('drift', '检查漂移', '/sync.drift') } }, '检查漂移'))),
        h('div', { className: 'cfgsync-group' },
          h('p', { className: 'cfgsync-gtitle' }, '② 总结当前对话并推送'),
          h('p', { className: 'cfgsync-gdesc' }, '生成脱敏的 agent.md 摘要到私有仓。预览不推送；推送需要**显式二次确认**。'),
          h('div', { className: 'cfgsync-row' },
            h('button', { className: 'cfgsync-btn', disabled: busy, onClick: function () { run('preview', '预览摘要', '/note.preview') } }, '预览摘要'),
            h('button', {
              className: 'cfgsync-btn ' + (armedPush ? 'danger primary' : 'primary'),
              disabled: busy,
              onClick: onPush,
            }, armedPush ? '再次点击确认推送' : '确认并推送私有仓'))),
        h('div', { className: 'cfgsync-group' },
          h('p', { className: 'cfgsync-gtitle' }, '③ 浏览仓库会话汇总'),
          h('p', { className: 'cfgsync-gdesc' }, '列出私有仓里的 sync/*.md 摘要与远端地址。纯只读。'),
          h('div', { className: 'cfgsync-row' },
            h('button', { className: 'cfgsync-btn', disabled: busy, onClick: function () { run('browse', '浏览汇总', '/browse.list') } }, '浏览会话汇总'))),
        h('div', { className: 'cfgsync-row' },
          h('button', { className: 'cfgsync-btn', disabled: busy, onClick: function () { run('diag', '诊断', '/diag') } }, '诊断'),
          h('button', { className: 'cfgsync-btn', disabled: busy, onClick: onReset }, '重新引导')),
        out
          ? h('pre', { className: 'cfgsync-out' + (isErr ? ' cfgsync-err' : '') }, out)
          : h('p', { className: 'cfgsync-muted' }, '未运行。所有操作都会当场把结果或**错误原文**显示在这里。'))
    }

    // ───────────────────────── 首次引导对话框 ─────────────────────────

    function OnboardingDialog() {
      var [state, setState] = useState('checking') // checking | due | done | error
      var [info, setInfo] = useState(null)
      var [sit, setSit] = useState(null)            // /onboarding.situation 的结果
      var [picked, setPicked] = useState(null)      // 用户选的分支（默认=自动判断）

      function check() {
        callApi('/onboarding.check').then(function (r) {
          if (!r || r.ok !== true) {
            // 执行失败 → error（绝不伪装成"已引导"）
            if (r && r.error) { setState('error'); setInfo(r.error) }
            else { setState('error'); setInfo('onboarding.check 无响应') }
            return
          }
          setInfo(r)
          setState(r.due ? 'due' : 'done')
        }).catch(function (e) { setState('error'); setInfo(String(e && e.message ? e.message : e)) })
      }

      // 拉"当前搭配 + 各分支步骤"，让用户能按分支走进对应流程
      function loadSituation() {
        callApi('/onboarding.situation').then(function (r) {
          if (r && r.ok === true) {
            setSit(r)
            setPicked(r.branch)          // 默认用自动判断的分支
          }
        }).catch(function () { /* 拉不到就退化为只显示完成按钮 */ })
      }

      useEffect(function () {
        ensureStyle()
        check()
        loadSituation()
        return onboard.sub(function () { check(); loadSituation() })
      }, [])

      function onDone() {
        setState('done')
        callApi('/onboarding.markDone', 'POST').then(function (r) {
          if (r && r.ok === true) onboard.emit()
        }).catch(function () { /* 标记尽力而为 */ })
      }

      if (state !== 'due') return null

      var cardBody = []
      if (state === 'error') {
        cardBody.push(h('p', { className: 'cfgsync-err' }, '检查引导状态失败：' + String(info || '')))
      } else if (sit !== null) {
        // ★ 当前搭配 + 让它可选（"根据用户选择走进对应流程"）
        cardBody.push(h('p', null,
          '自动判断你的情况：', h('b', null, sit.branchLabel || sit.branch),
          '。如果判错了，点下面的按钮改成正确的：'))
        cardBody.push(h('div', { className: 'cfgsync-row' },
          (sit.branches || []).map(function (b) {
            return h('button', {
              key: b.id,
              className: 'cfgsync-btn' + (b.id === picked ? ' primary' : ''),
              onClick: function () { setPicked(b.id) },
            }, b.label)
          })))
        if ((sit.evidence || []).length) {
          cardBody.push(h('p', { className: 'cfgsync-muted' }, '依据：' + sit.evidence.join('；')))
        }
        // 该分支的步骤
        var cur = (sit.branches || []).filter(function (b) { return b.id === picked })[0]
        var steps = cur ? cur.steps : (sit.steps || [])
        cardBody.push(h('p', { style: { margin: '10px 0 4px' } }, '要走这几步（' + steps.length + ' 步）：'))
        steps.forEach(function (s, i) {
          cardBody.push(h('div', { key: s.id || i, style: { margin: '0 0 8px' } },
            h('div', null, (i + 1) + '. ' + s.label),
            s.command ? h('pre', { className: 'cfgsync-out', style: { marginTop: '4px', maxHeight: '120px' } }, s.command) : null))
        })
        cardBody.push(h('p', { className: 'cfgsync-muted' },
          '想要逐步打勾的交互版：在终端跑 node framework/onboarding.mjs --run'))
        cardBody.push(h('div', { className: 'cfgsync-row' },
          h('button', { className: 'cfgsync-btn primary', onClick: onDone }, '我已完成引导')))
      } else {
        cardBody.push(h('p', { className: 'cfgsync-muted' }, '正在读取当前搭配…'))
        cardBody.push(h('div', { className: 'cfgsync-row' },
          h('button', { className: 'cfgsync-btn primary', onClick: onDone }, '我已完成引导')))
      }
      return h('div', { className: 'cfgsync-onb' },
        h('div', { className: 'cfgsync-onb-card' },
          h('h3', null, '欢迎使用 dsh-config-sync'),
          h('p', null, '这是一套「配置同步」插件：把本机 DSH 环境配置同步到你的私有仓，并把当前对话总结成可跨设备阅读的摘要。'),
          cardBody))
    }

    function apply(ctx) {
      var slots = ctx.slots
      try {
        slots.inject('settings.section', function () {
          return slots.register(
            { name: 'settings.section', id: 'config-sync', order: 35, label: '配置同步' },
            function () { return h(Panel) })
        })
      } catch (e) { console.warn('[dsh-config-sync] settings.section 注册失败', e) }
      try {
        slots.inject('shell.overlay', function () {
          return slots.register(
            { name: 'shell.overlay', id: 'config-sync-onboarding', order: 90 },
            function () { return h(OnboardingDialog) })
        })
      } catch (e) { console.warn('[dsh-config-sync] shell.overlay 注册失败', e) }
      console.log('[dsh-config-sync] client ready: settings.section 三按钮 + shell.overlay 引导')
      return function () { removeStyle() }
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
