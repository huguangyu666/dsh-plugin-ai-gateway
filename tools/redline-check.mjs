/**
 * 工程红线自检 —— 对照 dsh-plugins/DEVELOPMENT.md 里踩过的真实故障。
 * 用法: node tools/redline-check.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const results = []
const check = (label, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`)
}
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const bytes = (...p) => readFileSync(join(ROOT, ...p)).subarray(0, 3)

// --- 编码红线（坑 27/28：BOM 让 dsh 起不来）---
const textFiles = ['package.json', 'cordis.patch.yml', 'src/index.js', 'src/client-source.js', 'build.mjs', 'README.md']
for (const f of textFiles) {
  const b = bytes(f)
  const hasBom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf
  const body = read(f)
  check(`${f} UTF-8 无 BOM + LF`, !hasBom && !body.includes('\r\n'), hasBom ? '有 BOM' : body.includes('\r\n') ? '有 CRLF' : '')
}

// --- 挂载红线（坑 29 / 发布贴士：files 必须含 patch，且只留一个挂载源）---
const pkg = JSON.parse(read('package.json'))
check('files 含 cordis.patch.yml', Array.isArray(pkg.files) && pkg.files.includes('cordis.patch.yml'))
check('声明 dsh.bundle.patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
check('声明 dsh.client(platform=web)', pkg.dsh?.client?.platform === 'web' && Array.isArray(pkg.dsh?.client?.inject))
check('exports 暴露 ./client', typeof pkg.exports?.['./client']?.default === 'string', pkg.exports?.['./client']?.default)
const patch = read('cordis.patch.yml')
check('patch 只插入一条挂载源', (patch.match(/id:\s*ai-gateway/g) ?? []).length === 1 && patch.includes("name: 'dsh-plugin-ai-gateway'"))

// --- 客户端红线（坑 3/19/20 + rc.1 的 slots.inject 变更）---
const client = read('src/client-source.js')
check('客户端用 ctx.slots.inject 注册', client.includes('slots.inject("settings.section"'))

// 允许两种写死颜色：
//   1) 纯白/纯黑 —— 主按钮填充上的前景色，dsh 未提供 token，官方 UI 包同样写死
//   2) DSW("token", "#hex") / var(--dsw-alias-token, #hex) 里的兜底色 —— 实测部分 token 名
//      在产物里并不存在，不带兜底会解析失败变透明（进度条看起来就是白的）
const withoutFallbacks = client
  .replace(/var\(\s*--dsw-alias-[a-zA-Z0-9-]+\s*,\s*#[0-9a-fA-F]{3,8}\s*\)/g, 'var(--dsw-alias-token)')
  .replace(/DSW\([^)]*\)/g, 'DSW(token)')
const strayHex = (withoutFallbacks.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).filter((c) => !/^#(fff|ffffff|000|000000)$/i.test(c))
check('客户端无硬编码十六进制色值（纯白/纯黑与 var() 兜底色除外）', strayHex.length === 0, strayHex.join(','))
check('客户端为语义色提供了兜底', /C_OK\s*=\s*DSW\(/.test(client) && /#(00c853|16a34a|22c55e)/.test(client))
check('客户端不写内联模板字符串取页面', !/PAGE\s*=\s*`/.test(client))

// --- 构建红线（坑 21：execSync(npx esbuild) 在 Windows 上报 PTY 错）---
const build = read('build.mjs')
const buildCode = build.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n')
check('build 用本地 esbuild API', buildCode.includes("import * as esbuild from 'esbuild'") && !/\bexecSync\s*\(/.test(buildCode))
check('build 把 node:* 与 @deepseek-ai/* 设为 external', build.includes("'@deepseek-ai/*'") && build.includes("'node:fs'"))

// --- 产物契约 ---
for (const f of ['lib/index.js', 'lib/client.js']) check(`产物存在 ${f}`, existsSync(join(ROOT, f)))
if (existsSync(join(ROOT, 'lib/client.js'))) {
  const bundle = read('lib/client.js')
  const m = bundle.match(/window\.__ModuleLoader__\.load\(\{\s*id:\s*["']([^"']+)["']/)
  check('client bundle 注册 id 与包名一致', m?.[1] === pkg.name, `id=${m?.[1]}`)
}
if (existsSync(join(ROOT, 'lib/index.js'))) {
  const host = read('lib/index.js')
  check('host bundle 未内联 schemastery', !/function\s+\w*[Ss]chema\w*\s*\(/.test(host.slice(0, 4000)) || host.includes("from '@deepseek-ai/schemastery'") || host.includes('from"@deepseek-ai/schemastery"'))
}

const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exitCode = failed === 0 ? 0 : 1
