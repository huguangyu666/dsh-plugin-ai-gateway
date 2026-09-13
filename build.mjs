/**
 * 构建脚本：生成 lib/ 发布产物（本地 esbuild API，不用 execSync(npx esbuild)）。
 */
import * as esbuild from 'esbuild'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = 'dsh-plugin-ai-gateway'
const ROUTE_NAME = 'ai-gateway'
const ROOT = dirname(fileURLToPath(import.meta.url))
const fromRoot = (...parts) => resolve(ROOT, ...parts)

rmSync(fromRoot('lib'), { recursive: true, force: true })
mkdirSync(fromRoot('lib'), { recursive: true })

// host 端：ESM bundle
await esbuild.build({
  entryPoints: [fromRoot('src/index.js')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  charset: 'utf8',
  external: [
    'node:fs', 'node:path', 'node:os', 'node:url', 'node:child_process', 'node:http', 'node:https', 'node:crypto',
    '@deepseek-ai/*',
  ],
  outfile: fromRoot('lib/index.js'),
})

// client bundle：CJS + __ModuleLoader__ 包装
const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports; Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`
const footer = `return module.exports; } });`
await esbuild.build({
  entryPoints: [fromRoot('src/client-source.js')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  charset: 'utf8',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/*'],
  banner: { js: banner },
  footer: { js: footer },
  outfile: fromRoot('lib/client.js'),
})

// 产物自检
const host = readFileSync(fromRoot('lib/index.js'), 'utf8')
const client = readFileSync(fromRoot('lib/client.js'), 'utf8')

if (!host.includes(`'${ROUTE_NAME}'`) && !host.includes(`"${ROUTE_NAME}"`)) {
  throw new Error(`host bundle 缺插件名 ${ROUTE_NAME}`)
}
if (!host.includes('/agy-gateway')) throw new Error('host bundle 缺路由前缀')
if (/from\s*["']@deepseek-ai\/schemastery["']/.test(host) === false && !host.includes('schemastery')) {
  throw new Error('host bundle 未保留 schemastery 依赖（应为 external）')
}
const registration = client.match(/window\.__ModuleLoader__\.load\(\{\s*id:\s*["']([^"']+)["']/)
if (!registration) throw new Error('client bundle 缺 ModuleLoader 注册')
if (registration[1] !== ID) throw new Error(`client bundle 注册了 ${registration[1]}，预期 ${ID}`)
if (!client.includes('settings.section')) throw new Error('client bundle 缺 settings.section 注册')
if (/\$\{/.test(client.slice(0, 200))) throw new Error('client bundle banner 含模板串，可能被转义破坏')

console.log('构建完成：lib/index.js + lib/client.js')
