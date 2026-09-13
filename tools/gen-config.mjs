/**
 * 生成 CLIProxyAPI 的加固配置 + 状态文件（插件内同一份逻辑的 CLI 入口）。
 *
 * 用法: node tools/gen-config.mjs [--force] [--port 8317]
 *   --force  重新生成密钥（会让已填入 DSH 的 API key 失效）
 *
 * 逻辑与 host 端共用 src/config-writer.js —— 单一真源，避免脚本与插件漂移。
 * 全程 node 写文件：UTF-8 无 BOM + LF（DEVELOPMENT.md 坑 27）。
 */
import { defaultPaths, writeHardenedConfig } from '../src/config-writer.js'

const args = process.argv.slice(2)
const FORCE = args.includes('--force')
const portIdx = args.indexOf('--port')
const paths = defaultPaths()
const port = portIdx >= 0 ? Number(args[portIdx + 1]) || paths.port : paths.port

const result = writeHardenedConfig({
  statePath: paths.statePath,
  configPath: paths.configPath,
  authDir: paths.authDir,
  port,
  force: FORCE,
})

console.log('[gen-config] config :', result.configPath)
console.log('[gen-config] state  :', result.statePath)
console.log('[gen-config] BOM    :', result.hasBom ? '❌ 有 BOM' : '✅ 无 BOM')
console.log('[gen-config] CRLF   :', result.hasCrlf ? '❌ 有 CRLF' : '✅ 纯 LF')
console.log('[gen-config] 结构自检:', result.secretLineOk ? '✅ 密钥单行完整' : '❌ 密钥行异常')
console.log('[gen-config] 密钥    :', result.reusedKeys ? '复用已有（DSH 侧无需重填）' : '已重新生成（⚠ DSH 侧需重填）')
console.log('[gen-config] apiKey  :', result.state.apiKey.slice(0, 10) + '…' + result.state.apiKey.slice(-4))
console.log('[gen-config] 二进制  :', paths.binPath)
console.log('[gen-config] 下一步  : 启动网关后访问 http://127.0.0.1:' + port + '/v1/models 验证')
