# dsh-config-sync（插件）

> DSH 的**配置同步插件**：设置页三按钮 + 首次安装引导。
> 本仓是**通用代码**（将来公开发布）；你的能力清单与踩坑数据始终留在**你自己的私有仓**。

---

## 它解决什么

DSH 迭代极快（几天一变），而「把配置和插件清单原样复制到新机器」有个致命假设 ——
**配置是可移植的**。这个假设是错的：同一个 DSH 版本上，一个功能完好的预设可能三处同时不兼容。

所以这套东西不问"装哪个包"，它问 **"这个能力在这台机器上是否真的工作"**。
本插件是它的操作面：让你在设置页一键做「同步环境配置 / 总结对话并推送 / 浏览仓库汇总」，
并在**首次安装时**引导一次。

---

## 三颗按钮

| 按钮 | 做什么 | 落点 |
|---|---|---|
| ① 同步环境配置 | 导出/导入「能力清单 + 基线 + 状态快照」，导入侧**只读漂移检测**，不复制整包配置 | `framework/sync.mjs` |
| ② 总结当前对话并推送 | 复用 `note.mjs` 生成脱敏 `agent.md` → **显式确认** → 提交推送进**私有仓** | `framework/push-note.mjs` |
| ③ 浏览仓库会话汇总 | 列出 `sync/*.md` 摘要 + 给可拉回本地的地址。**纯只读** | `framework/browse.mjs` |

首次引导：仅**首次安装**弹一次（一次性标记文件，在 git 之外），版本检查 + 全新/有SSH key/已有仓 分叉。

---

## 两个半边（已核实的协议）

```
dsh-config-sync/
├── package.json          main=lib/index.js · exports "." & "./client" · dsh.bundle.patch & dsh.client
├── cordis.patch.yml      把插件行插进 profile 的 roster
├── lib/
│   ├── index.js          host 半边：webServer 路由 /api/config-sync/*（驱动用户仓的 framework 脚本）
│   └── client.js         浏览器半边：手写 __ModuleLoader__ bundle（设置页 + 引导对话框）
├── probe.mjs             不安装就能验证两边半边（mock ctx 直接调 apply）
└── install-dev.mjs       本地开发装配（先查 3080 是否已停，避免 ERR_PNPM_EPERM）
```

**host ↔ client 通道是「同源 HTTP 路由 + fetch」**，不是 `host.call`（那是动态插件独有的）：

```js
// host
ctx.webServer.register({ kind: 'exact', path: '/api/config-sync/ping', handler: (req, res) => {...} })
// client
const j = await (await fetch('/api/config-sync/ping')).json()
```

### 两条硬性约定（照抄已装插件的真实写法，别凭猜）

1. **client**：`id` 必须 == `package.json.name`；`factory` 必须 `return module.exports`；
   React 用 `require('react')`；服务从 `ctx.slots` 直接取（不是 `ctx.get('slots')`）。
2. **host**：普通 ESM，`export name / inject / apply`；`apply` 返回 disposer，
   **所有副作用（路由/进程/定时器）都必须可回收**。

---

## 依赖的私有仓

本插件的 host 半边**不复制业务逻辑** —— 它用 `subprocess` 以**绝对路径**直接 spawn `node`，
去跑你私有仓里的 `framework/*.mjs`。这样「改 framework 即改行为」，且你随时能改。

> ⚠ **不要用 `shell` 服务跑 Node 脚本**：`shell` 交给 subprocess 的 argv 是 `["bash", command]`，
> 而 Windows 上 Git Bash 常常不在 PATH → 每次调用都解析解释器失败，**所有按钮静默失效**。
> 必须 `subprocess.spawn({ argv: [nodePath, ...] })`，`nodePath` 由 `resolveExecutable('node')` 解析。

---

## 开发

```bash
node probe.mjs          # 不安装、不改 profile —— 验证两边半边形状与运行通道
node install-dev.mjs    # 本地装配（会先检查 dsh web 是否已停）
```

`install-dev.mjs` **必须先停 `dsh web`**：`dsh plugin add` 本质是 pnpm add，而 pnpm 每次都会
重新应用 `patchedDependencies`，那需要 rename 已被宿主占用的包目录 → Windows 报
`ERR_PNPM_EPERM`，整个安装事务失败。脚本会在 3080 仍在监听时直接拒绝执行。

> 关掉浏览器标签页**不算**停服 —— 要停的是跑 `dsh web` 的那个**服务器进程**。
