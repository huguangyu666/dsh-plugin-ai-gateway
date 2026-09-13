/**
 * 把本插件装进指定 dsh profile —— 带备份、编码校验与回滚提示。
 *
 * 用法:
 *   node tools/install-into-profile.mjs --profile web            # 真装
 *   node tools/install-into-profile.mjs --profile web --dry-run  # 只检查并打印将执行的命令
 *
 * 做四件事：备份 → 官方命令安装 → 校验（JSON 可解析 / 无 BOM / bundles 已含本插件）→ dump-config 复核。
 * 任一步失败即打印回滚方法，不会留下半装状态。
 * 注意：pnpm 需要代理才能访问 registry —— 调用前请设好 HTTPS_PROXY。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_NAME = 'dsh-plugin-ai-gateway'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const profile = argOf('--profile', 'web')
const dryRun = args.includes('--dry-run')
const profileDir = join(homedir(), '.dsh', 'profiles', profile)
const pkgFile = join(profileDir, 'package.json')
const patchFile = join(profileDir, 'cordis.patch.yml')

const fail = (msg, rollback) => {
  console.error(`\n❌ ${msg}`)
  if (rollback) console.error(`   回滚：${rollback}`)
  process.exit(1)
}

console.log(`[install] 插件目录 : ${ROOT}`)
console.log(`[install] 目标 profile: ${profile}  (${profileDir})`)

if (!existsSync(pkgFile)) fail(`profile 不存在或缺少 package.json：${pkgFile}（先用 dsh --profile ${profile} 初始化）`)
if (!existsSync(join(ROOT, 'lib', 'index.js')) || !existsSync(join(ROOT, 'lib', 'client.js'))) {
  fail('lib/ 产物缺失：先在插件目录跑 node build.mjs')
}
if (!process.env.HTTPS_PROXY && !process.env.HTTP_PROXY && !dryRun) {
  console.warn('[install] ⚠ 未检测到 HTTPS_PROXY/HTTP_PROXY —— pnpm 可能挂起（你的环境走系统代理 127.0.0.1:7892）')
}

const before = JSON.parse(readFileSync(pkgFile, 'utf8'))
const already = (before.dsh?.profile?.bundles ?? []).includes(PKG_NAME)
console.log(`[install] 当前 bundles: ${(before.dsh?.profile?.bundles ?? []).join(', ')}`)
console.log(`[install] 已安装: ${already ? '是（将重装/更新）' : '否'}`)

const cmd = ['plugin', '--profile', profile, 'add', ROOT]
console.log(`\n[install] 将执行: dsh ${cmd.join(' ')}`)
if (dryRun) {
  console.log('[install] --dry-run：到此为止，未做任何修改')
  process.exit(0)
}

// 1) 备份
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const pkgBackup = `${pkgFile}.bak-agy-gateway-${stamp}`
copyFileSync(pkgFile, pkgBackup)
let patchBackup = null
if (existsSync(patchFile)) {
  patchBackup = `${patchFile}.bak-agy-gateway-${stamp}`
  copyFileSync(patchFile, patchBackup)
}
console.log(`[install] 已备份: ${pkgBackup}${patchBackup ? '\n[install] 已备份: ' + patchBackup : ''}`)

// 2) 官方安装命令
const r = spawnSync('dsh', cmd, { stdio: 'inherit', shell: true })
if (r.status !== 0) fail(`dsh plugin add 失败（exit ${r.status}）`, `copy /Y "${pkgBackup}" "${pkgFile}"`)

// 3) 校验
let after
try {
  after = JSON.parse(readFileSync(pkgFile, 'utf8'))
} catch (err) {
  fail(`安装后 package.json 无法解析：${err.message}`, `copy /Y "${pkgBackup}" "${pkgFile}"`)
}
const bytes = readFileSync(pkgFile).subarray(0, 3)
const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
if (hasBom) {
  // 你 DEVELOPMENT.md 坑 28：官方命令可能写回 BOM，会让 dsh 启动时 JSON.parse 直接挂
  const text = readFileSync(pkgFile, 'utf8').replace(/^\uFEFF/, '')
  writeFileSync(pkgFile, text, 'utf8')
  console.log('[install] ⚠ 检测到 BOM 并已去除（坑 28）')
}
const bundles = after.dsh?.profile?.bundles ?? []
if (!bundles.includes(PKG_NAME)) {
  fail(`bundles 未包含 ${PKG_NAME}（package.json 可能没声明 dsh.bundle.patch）`, `copy /Y "${pkgBackup}" "${pkgFile}"`)
}
console.log(`[install] ✅ bundles 已包含 ${PKG_NAME}，BOM=${hasBom ? '已清理' : '无'}`)

// 4) dump-config 复核
const dump = spawnSync('dsh', ['--profile', profile, '--dump-config'], { encoding: 'utf8', shell: true })
if (dump.status !== 0) fail(`dump-config 失败（exit ${dump.status}）`, `copy /Y "${pkgBackup}" "${pkgFile}"`)
if (!String(dump.stdout).includes(PKG_NAME)) {
  fail('合成树里没有本插件层', `copy /Y "${pkgBackup}" "${pkgFile}"`)
}
console.log('[install] ✅ dump-config 合成树包含本插件层')

console.log(`\n✅ 安装完成。重启 dsh web 后，设置里会出现「反重力网关」。`)
console.log(`   卸载：dsh plugin --profile ${profile} remove ${PKG_NAME}`)
console.log(`   回滚：copy /Y "${pkgBackup}" "${pkgFile}"`)
