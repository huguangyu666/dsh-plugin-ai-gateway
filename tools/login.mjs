/**
 * 触发 Antigravity OAuth 登录，并把授权链接打印出来（阶段 2 插件复用同一套逻辑）。
 *
 * 用法: node tools/login.mjs [--clip]
 *   --clip  额外把授权链接复制到剪贴板
 *
 * 说明：CLIProxyAPI 的登录窗口约 5 分钟；回调地址固定 http://localhost:51121/oauth-callback，
 * 浏览器授权后自动接住，无需手动粘贴。进程退出后本脚本报告是否落盘了账号文件。
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()
const BIN = join(HOME, '.dsh', 'agy-gateway', 'bin', process.platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api')
const CONFIG = join(HOME, '.cli-proxy-api', 'config.yaml')
const AUTH_DIR = join(HOME, '.cli-proxy-api')
const WANT_CLIP = process.argv.includes('--clip')

const countAccounts = () =>
  existsSync(AUTH_DIR) ? readdirSync(AUTH_DIR).filter((f) => f.toLowerCase().endsWith('.json')).length : 0

const before = countAccounts()
console.log(`[login] 二进制: ${BIN}`)
console.log(`[login] 现有账号文件: ${before}`)

const child = spawn(BIN, ['-config', CONFIG, '-antigravity-login', '-no-browser'], {
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
})

let url = null
let buf = ''
const onChunk = (text) => {
  buf += text
  const m = buf.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?[^\s"']+/)
  if (m && !url) {
    url = m[0]
    console.log('\n=== 授权链接（5 分钟内有效）===')
    console.log(url)
    console.log('=== 链接结束 ===\n')
    if (WANT_CLIP) {
      const clip = spawn('cmd', ['/c', 'clip'], { windowsHide: true })
      clip.stdin.end(url)
      clip.on('close', () => console.log('[login] 已复制到剪贴板'))
    }
  }
  process.stdout.write(text.replace(/https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?[^\s"']+/, '<授权链接已在上方单独输出>'))
}

child.stdout.on('data', (d) => onChunk(d.toString()))
child.stderr.on('data', (d) => onChunk(d.toString()))

child.on('exit', (code) => {
  const after = countAccounts()
  console.log(`\n[login] 登录进程退出，code=${code}`)
  console.log(`[login] 账号文件: ${before} → ${after}`)
  console.log(after > before ? '[login] ✅ 登录成功，凭据已落盘' : '[login] ❌ 未获得凭据（超时或取消）')
  process.exitCode = after > before ? 0 : 1
})
