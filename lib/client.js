/* dsh-config-sync — 浏览器半边（手写 __ModuleLoader__ bundle）。
 *
 * 形状逐字对齐已核实的 @a9i5k4/dsh-anchored-monitor@0.3.1 lib/client.js：
 *   1. id 必须 == package.json 的 name
 *   2. factory 必须 return module.exports（不是 {apply} 字面量）
 *   3. React 用 require('react')；用 React.createElement（没有 JSX、没有构建链）
 *   4. 服务从 ctx.slots 直接取（exports.inject 已声明），不是 ctx.get('slots')
 *   5. 调宿主用同源 fetch('/api/config-sync/...')，不是 host.call
 *
 * 阶段5 骨架：先把「能挂载 + 能渲染 + 能通宿主」验掉，业务三按钮下一步再搬。
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

    /* 主题变量一律用真实 token（--dsw-alias-*）。
     * 踩过的坑：曾自造 --dsh-surface/--dsh-border，两个变量根本不存在 →
     * 颜色全落到深色兜底，弹窗发暗、不跟主题。 */
    var CSS = [
      '.cfgsync-wrap{padding:4px 0;max-width:640px}',
      '.cfgsync-desc{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.7;margin:0 0 14px}',
      '.cfgsync-row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}',
      '.cfgsync-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);',
      'color:var(--dsw-alias-label-primary);border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer}',
      '.cfgsync-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.cfgsync-btn:disabled{opacity:.5;cursor:default}',
      '.cfgsync-btn.primary{background:var(--dsw-alias-brand-primary);color:#fff;border-color:transparent}',
      '.cfgsync-out{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.6;white-space:pre-wrap;',
      'word-break:break-all;max-height:280px;overflow:auto;color:var(--dsw-alias-label-primary);margin:0}',
      '.cfgsync-muted{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.cfgsync-err{color:var(--dsw-alias-state-error-primary)}',
      '.cfgsync-ok{color:var(--dsw-alias-state-success-primary)}',
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

    /** 统一的宿主调用：失败**必须显性暴露**，绝不伪装成正常值。
     *  踩过的坑：onboarding.check 失败时返回 due:false，界面显示成「已引导」——
     *  把「执行失败」伪装成「已引导过」，差点把排查带偏。 */
    async function callApi(route) {
      var res = await fetch(API + route, { headers: { accept: 'application/json' } })
      var text = await res.text()
      var json = null
      try { json = JSON.parse(text) } catch (e) { json = null }
      if (!res.ok) {
        return { ok: false, error: 'HTTP ' + res.status + ' ' + String(text || '').slice(0, 300) }
      }
      if (json === null) return { ok: false, error: '响应不是 JSON：' + String(text || '').slice(0, 300) }
      return json
    }

    function Panel() {
      var [busy, setBusy] = useState(false)
      var [out, setOut] = useState('')
      var [isErr, setIsErr] = useState(false)

      useEffect(function () { ensureStyle() }, [])

      function show(text, err) { setOut(text); setIsErr(!!err) }

      async function run(label, route) {
        setBusy(true)
        show('（' + label + ' 执行中…）', false)
        try {
          var r = await callApi(route)
          if (r && r.ok === true) show(label + ' 成功：\n' + JSON.stringify(r, null, 2), false)
          else show(label + ' 失败：\n' + String((r && r.error) || '未知错误'), true)
        } catch (e) {
          show(label + ' 抛错：\n' + String(e && e.message ? e.message : e), true)
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'cfgsync-wrap' },
        h('p', { className: 'cfgsync-desc' },
          '把本机 DSH 环境配置同步到你的私有仓，并把当前对话总结成可跨设备阅读的摘要。',
          h('br'),
          h('span', { className: 'cfgsync-muted' }, '（骨架版本：先验证插件能挂载、能渲染、能通宿主。）')),
        h('div', { className: 'cfgsync-row' },
          h('button', { className: 'cfgsync-btn', disabled: busy, onClick: function () { run('连通性检测', '/ping') } }, '检测连通性'),
          h('button', { className: 'cfgsync-btn primary', disabled: busy, onClick: function () { run('诊断', '/diag') } }, '诊断')),
        out
          ? h('pre', { className: 'cfgsync-out ' + (isErr ? 'cfgsync-err' : 'cfgsync-ok') }, out)
          : h('p', { className: 'cfgsync-muted' }, '未运行。点「诊断」看宿主半边是否激活、运行通道是否可用。'))
    }

    function apply(ctx) {
      var slots = ctx.slots
      try {
        slots.inject('settings.section', function () {
          return slots.register(
            { name: 'settings.section', id: 'config-sync', order: 35, label: '配置同步' },
            function () { return h(Panel) })
        })
      } catch (e) {
        console.warn('[dsh-config-sync] settings.section 注册失败', e)
      }
      console.log('[dsh-config-sync] client ready: settings.section 已注册')
      return function () { removeStyle() }
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
