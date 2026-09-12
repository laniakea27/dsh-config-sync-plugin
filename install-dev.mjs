#!/usr/bin/env node
/**
 * install-dev.mjs —— 把本插件装进本地 profile 的开发用装配器。
 *
 * ★ 为什么需要它：`dsh plugin add` 本质是 pnpm add，而 pnpm 每次都会重新应用
 *   `patchedDependencies`（本机对 @a9i5k4/dsh-anchored-monitor 有一个本地 patch），
 *   那需要 **rename 已加载的包目录** —— 宿主在跑时 Windows 会拒绝，报
 *     [ERR_PNPM_EPERM] rename '..._tmp_xxx' -> '...'
 *   然后整个安装事务失败（profile 会回滚干净，但插件装不进去）。
 *   agent.md §11.7 记录过这个坑；2026-09-12 在本插件上**实测复现了一次**。
 *
 * 所以本脚本第一件事就是**检查 3080 是否还在监听**，在跑就拒绝执行 ——
 * 让"忘了停服"变成一条明确报错，而不是一次看似成功的失败安装。
 *
 * 用法（两行，缺一不可）：
 *   1) 在跑 dsh web 的终端按 Ctrl+C 停掉它
 *   2) node install-dev.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME || path.join(homedir(), '.dsh')
const PROFILE = process.env.DSH_FRAMEWORK_PROFILE || 'web'
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE)
const REPO = 'F:/AIagent/DeepH/dsh-config-sync'
const LOG = path.join(HERE, 'install-dev.log')
const HOST_PORT = Number(process.env.DSH_WEB_PORT || 3080)

const lines = []
function say(s) { lines.push(s); console.log(s) }

/** 探测某个端口是否有人在听（用来判断 dsh web 是否还在跑）。 */
function portInUse(port) {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port })
    const done = (v) => { try { sock.destroy() } catch { /* ignore */ } resolve(v) }
    sock.setTimeout(1200)
    sock.on('connect', () => done(true))
    sock.on('timeout', () => done(false))
    sock.on('error', () => done(false))
  })
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', shell: false, ...opts })
}

async function main() {
  say('')
  say('  dsh-config-sync · 开发装配')
  say('  ' + '─'.repeat(64))
  say(`  插件目录 : ${HERE}`)
  say(`  profile  : ${PROFILE}  (${PROFILE_DIR})`)

  // ── 闸门 1：dsh web 必须已停 ──────────────────────────────────────────
  if (await portInUse(HOST_PORT)) {
    say('')
    say(`  ✗ 检测到 127.0.0.1:${HOST_PORT} 仍在监听 —— dsh web 还在跑。`)
    say('')
    say('    现在安装**必定失败**（pnpm 无法 rename 已被宿主占用的包目录）：')
    say('      [ERR_PNPM_EPERM] rename \'...dsh-anchored-monitor_tmp_xxx\' -> \'...dsh-anchored-monitor\'')
    say('')
    say('    处置：在跑 dsh web 的那个终端按 Ctrl+C，然后重跑本脚本。')
    say('    （注意：关掉浏览器标签页**不算**停服，服务器进程还在。）')
    say('')
    writeFileSync(LOG, lines.join('\n') + '\n', 'utf8')
    process.exit(2)
  }

  if (!existsSync(path.join(REPO, 'framework', 'install.mjs'))) {
    say(`  ✗ 找不到 ${REPO}/framework/install.mjs —— 请确认 dsh-config-sync 仓的位置`)
    writeFileSync(LOG, lines.join('\n') + '\n', 'utf8')
    process.exit(2)
  }

  say('  ✓ 3080 未被占用（dsh web 已停）')
  say('')
  say('  [1/2] 调用受护栏的安装器 framework/install.mjs …')
  const spec = HERE.replace(/\\/g, '/')
  const ins = run(process.execPath, [path.join(REPO, 'framework', 'install.mjs'), spec], {
    cwd: REPO, timeout: 900000,
  })
  const insOut = String(ins.stdout || '') + String(ins.stderr || '')
  for (const l of insOut.split('\n')) if (l.trim() !== '') say('        ' + l.replace(/\s+$/, ''))
  say(`        install.mjs exit = ${ins.status}`)

  say('')
  say('  [2/2] 断言：真的进了 dsh.profile.bundles …')
  let bundled = false
  try {
    const pkg = JSON.parse(
      (await import('node:fs')).readFileSync(path.join(PROFILE_DIR, 'package.json'), 'utf8'))
    bundled = Array.isArray(pkg?.dsh?.profile?.bundles)
      && pkg.dsh.profile.bundles.includes('dsh-config-sync')
    say(`        bundles = ${JSON.stringify(pkg?.dsh?.profile?.bundles ?? null)}`)
  } catch (e) {
    say(`        读取 profile package.json 失败：${e && e.message ? e.message : e}`)
  }

  // install.mjs 内部已做 dump-config 冒烟 + 失败自动回滚，这里不重复：
  // （重复的冒烟还会依赖 `dsh` 在 PATH 上 —— 装插件在用户 shell 里常找不到 dsh，
  //   反而制造一个「看起来是插件/ profile 坏了」的假失败。这是 2026-09-12 踩过的。）
  const ok = ins.status === 0 && bundled
  say('')
  say('  ' + '─'.repeat(64))
  say(ok
    ? '  ✅ 安装成功。下一步：重启 dsh web，然后到「设置 → 配置同步」看面板。'
    : '  ❌ 未通过。profile 可能已回滚 —— 用 node framework/restore.mjs --baseline 回到基线。')
  say(`  （本次输出已存到 ${LOG}）`)
  say('')
  writeFileSync(LOG, lines.join('\n') + '\n', 'utf8')
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  say(`  ✗ 装配器自身抛错：${e && e.stack ? e.stack : e}`)
  try { writeFileSync(LOG, lines.join('\n') + '\n', 'utf8') } catch { /* ignore */ }
  process.exit(1)
})
