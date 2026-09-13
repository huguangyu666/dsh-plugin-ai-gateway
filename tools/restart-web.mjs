/**
 * 安全重启 dsh web —— 用于让新装的插件生效。
 *
 * 用法:
 *   node tools/restart-web.mjs                 # 只检查并打印计划（默认 dry-run）
 *   node tools/restart-web.mjs --yes           # 真的重启
 *   node tools/restart-web.mjs --yes --port 3080
 *
 * 安全措施：
 *   1. 只杀「命令行确实是 dsh web」的 node 进程；端口被别的程序占用时直接放弃
 *   2. 等端口真正释放再拉起，避免 EADDRINUSE
 *   3. 新进程 detached + 日志落盘，父进程死了也不影响它
 *   4. 起来后轮询端口，并从日志里抓出带 token 的 URL 打印出来
 *
 * 注：浏览器登录 cookie 的签名密钥持久化在凭据库里（不是每进程随机），
 *     所以重启后刷新页面即可，通常不需要重新打开带 token 的 URL。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const portIdx = args.indexOf('--port')
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) || 3080 : 3080
const DO_IT = args.includes('--yes')
const LOG_PATH = join(homedir(), '.dsh', 'agy-gateway', 'web-restart.log')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function run(cmd, cmdArgs, timeoutMs = 15000) {
  return new Promise((resolvePromise) => {
    let out = ''
    let child
    try {
      child = spawn(cmd, cmdArgs, { windowsHide: true })
    } catch {
      resolvePromise('')
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      resolvePromise(out)
    }, timeoutMs)
    child.stdout?.on('data', (d) => (out += d))
    child.stderr?.on('data', (d) => (out += d))
    child.on('error', () => { clearTimeout(timer); resolvePromise('') })
    child.on('close', () => { clearTimeout(timer); resolvePromise(out) })
  })
}

async function portPid(port) {
  const out = await run('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
  ])
  const pid = Number(out.trim())
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

async function commandLineOf(pid) {
  const out = await run('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
  ])
  return out.trim()
}

async function main() {
  console.log(`[restart] 目标端口: ${PORT}`)
  const pid = await portPid(PORT)
  if (!pid) {
    console.log(`[restart] 端口 ${PORT} 上没有进程在监听 —— 直接拉起即可`)
  } else {
    const cmdline = await commandLineOf(pid)
    console.log(`[restart] 占用进程: pid=${pid}`)
    console.log(`[restart]   命令行: ${cmdline.slice(0, 160)}`)
    if (!/dsh/i.test(cmdline) || !/web/i.test(cmdline)) {
      console.error('[restart] ❌ 该进程看起来不是 dsh web，拒绝终止（避免误杀你的其他程序）')
      process.exitCode = 1
      return
    }
    if (!DO_IT) {
      console.log('[restart] dry-run：未做任何操作。加 --yes 才会真正重启。')
      return
    }
    console.log('[restart] 正在停止旧进程…')
    await run('taskkill', ['/PID', String(pid), '/T', '/F'])
    const deadline = Date.now() + 20000
    while (Date.now() < deadline && (await portPid(PORT))) await sleep(400)
    if (await portPid(PORT)) {
      console.error(`[restart] ❌ 端口 ${PORT} 仍未释放，放弃启动（旧进程可能没退干净）`)
      process.exitCode = 1
      return
    }
    console.log('[restart] 端口已释放')
  }

  if (!DO_IT) {
    console.log('[restart] dry-run：未做任何操作。加 --yes 才会真正重启。')
    return
  }

  mkdirSync(dirname(LOG_PATH), { recursive: true })
  const fd = openSync(LOG_PATH, 'a')
  const child = spawn('dsh', ['web', '--port', String(PORT), '--no-open'], {
    detached: true,
    stdio: ['ignore', fd, fd],
    shell: true,
  })
  child.unref()
  console.log(`[restart] 已拉起新进程 pid=${child.pid}，日志：${LOG_PATH}`)

  const upDeadline = Date.now() + 60000
  while (Date.now() < upDeadline) {
    if (await portPid(PORT)) break
    await sleep(700)
  }
  if (!(await portPid(PORT))) {
    console.error('[restart] ❌ 60 秒内端口未监听，启动可能失败；请查看日志：', LOG_PATH)
    process.exitCode = 1
    return
  }
  console.log(`[restart] ✅ ${PORT} 已监听`)

  await sleep(1500)
  if (existsSync(LOG_PATH)) {
    const text = readFileSync(LOG_PATH, 'utf8')
    const urls = [...text.matchAll(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/g)].map((m) => m[0])
    const last = urls[urls.length - 1]
    if (last) console.log(`[restart] 带 token 的入口（一般用不上，Cookie 仍然有效）：\n  ${last}`)
  }
  console.log('[restart] 完成。刷新浏览器页面即可；设置里应出现「反重力网关」。')
  console.log(`[restart] 插件目录: ${ROOT}`)
}

await main()
