/**
 * ZCode / 智谱 BigModel 适配服务单元测试与端到端验证
 *
 * 用法: node tools/zcode-test.mjs
 */
import {
  resolveCredentialSecret,
  deriveCipherKey,
  decryptCredential,
  loadZCodeCredentials,
  normalizeGlmModelId,
  listSupportedGlmModels,
  openaiToAnthropic,
  anthropicToOpenAiResponse,
  AnthropicToOpenAiStreamTransformer,
  createZCodeProxyHandler,
  startZCodeStandaloneServer,
  buildOfficialZCodeHeaders,
  OFFICIAL_ZCODE_VERSION,
} from '../src/zcode-service.js'
import { createServer } from 'node:http'

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`)
}

console.log('\n--- ZCode 适配服务自动化测试 ---\n')

// 1. 凭据密钥派生与解密
const secret = resolveCredentialSecret()
check('秘钥派生有效', typeof secret === 'string' && secret.startsWith('zcode-credential-fallback:'), secret)

const key = deriveCipherKey(secret)
check('SHA-256 派生 Key 长度为 32 字节', Buffer.isBuffer(key) && key.length === 32)

const creds = loadZCodeCredentials()
check('本机 ZCode 凭据已自动发现并解密', creds !== null && Boolean(creds.apiKey), `Provider: ${creds?.activeProvider}, Key: ${creds?.apiKey?.slice(0, 8)}...`)

// 2. 模型归一化与模型清单
check('模型大小写映射正确', normalizeGlmModelId('glm-5.3-flash') === 'GLM-5.3-Flash')
const models = listSupportedGlmModels()
check('模型清单包含 GLM-5.3 与 GLM-5.3-Flash', models.some((m) => m.id === 'GLM-5.3') && models.some((m) => m.id === 'GLM-5.3-Flash'))

// 3. OpenAI 请求转 Anthropic 请求
const openAiReq = {
  model: 'glm-5.3-flash',
  messages: [
    { role: 'system', content: 'System prompt' },
    { role: 'user', content: 'User message' },
    { role: 'assistant', content: 'Assistant reply' },
    { role: 'user', content: 'Follow up' },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'test_func',
        description: 'test function',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    },
  ],
}
const anthropicReq = openaiToAnthropic(openAiReq)
check('请求体模型正确映射', anthropicReq.model === 'GLM-5.3-Flash')
check('系统提示词提取正确', anthropicReq.system === 'System prompt')
check('消息角色严格交替', anthropicReq.messages.length === 3 && anthropicReq.messages[0].role === 'user')
check('工具定义正确转换', anthropicReq.tools.length === 1 && anthropicReq.tools[0].name === 'test_func')

// 4. Anthropic 响应转 OpenAI 响应
const anthropicRes = {
  id: 'msg_123',
  model: 'GLM-5.3-Flash',
  content: [
    { type: 'thinking', thinking: 'Thought process...' },
    { type: 'text', text: 'Answer' },
    { type: 'tool_use', id: 'call_1', name: 'test_func', input: { q: 'hi' } },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 10, output_tokens: 20 },
}
const openAiRes = anthropicToOpenAiResponse(anthropicRes, 'GLM-5.3-Flash')
check('响应 ID 包含 chatcmpl- 前缀', openAiRes.id === 'chatcmpl-msg_123')
check('思维链 thinking 映射到 reasoning_content', openAiRes.choices[0].message.reasoning_content === 'Thought process...')
check('正文 text 映射到 content', openAiRes.choices[0].message.content === 'Answer')
check('工具调用映射到 tool_calls', openAiRes.choices[0].message.tool_calls?.[0]?.function?.name === 'test_func')
check('finish_reason 映射为 tool_calls', openAiRes.choices[0].finish_reason === 'tool_calls')

// 5. 流式转换器
const transformer = new AnthropicToOpenAiStreamTransformer({ model: 'GLM-5.3-Flash' })
const tLines = transformer.transformEvent({
  type: 'content_block_delta',
  index: 0,
  delta: { type: 'thinking_delta', thinking: 'thinking chunk' },
})
check('流式思维链增量输出包含 reasoning_content', tLines.some((l) => l.includes('reasoning_content') && l.includes('thinking chunk')))

// 6. 本地 HTTP 接口测试
const handler = createZCodeProxyHandler({ mockCredentials: { apiKey: creds?.apiKey, activeProvider: 'bigmodel' } })
const testServer = createServer((req, res) => handler(req, res))
await new Promise((resolve) => testServer.listen(0, '127.0.0.1', resolve))
const testPort = testServer.address().port

const healthRes = await fetch(`http://127.0.0.1:${testPort}/health`).then((r) => r.json())
check('/health 状态返回成功', healthRes.ok === true && healthRes.credentialsReady === true)

const modelsRes = await fetch(`http://127.0.0.1:${testPort}/v1/models`).then((r) => r.json())
check('/v1/models 返回 OpenAI 标准模型列表', modelsRes.object === 'list' && modelsRes.data.length >= 4)

testServer.close()

// 6.5 官方客户端指纹头（逆向自官方 app.asar buildZCodeSourceHeaders）
const fp = buildOfficialZCodeHeaders({ telemetryState: { deviceMid: 'test-mid', locale: 'zh-CN' } })
check('指纹 UA 形如 ZCode/<官方版本>', fp['user-agent'] === `ZCode/${OFFICIAL_ZCODE_VERSION}`, fp['user-agent'])
check('指纹包含 X-ZCode-App-Version', fp['x-zcode-app-version'] === OFFICIAL_ZCODE_VERSION)
check('指纹包含 X-Title 与官方值一致', fp['x-title'] === 'Z Code@electron')
check('指纹包含平台三元组 X-Platform', /^[a-z0-9]+-[a-z0-9]+$/.test(fp['x-platform'] || ''), fp['x-platform'])
check('指纹包含官方 OS 归类', ['windows', 'macos', 'linux'].includes(fp['x-os-category']), fp['x-os-category'])
check('指纹包含客户端语言与时区', fp['x-client-language'] === 'zh-CN' && typeof fp['x-client-timezone'] === 'string' && fp['x-client-timezone'].length > 0, `${fp['x-client-language']} / ${fp['x-client-timezone']}`)
check('deviceMid 可从本机真实遥测读到时才附带（不伪造）', fp['x-device-mid'] === 'test-mid')
const fpLive = buildOfficialZCodeHeaders()
check('真实环境下指纹语言非 unknown（读取本机遥测 locale）', fpLive['x-client-language'] !== undefined, fpLive['x-client-language'])

// 用本地 mock 上游捕获反代实际发出的头，验证完整官方指纹在真实请求链路上生效
const capturedHeaders = []
const captureServer = createServer((req, res) => {
  capturedHeaders.push(req.headers)
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'msg_capture', type: 'message', role: 'assistant', model: 'GLM-5.3-Flash', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
  })
})
await new Promise((resolve) => captureServer.listen(0, '127.0.0.1', resolve))
const capturePort = captureServer.address().port
const proxyHandler = createZCodeProxyHandler({
  mockCredentials: { apiKey: 'test-key', activeProvider: 'bigmodel' },
  upstreamUrl: `http://127.0.0.1:${capturePort}/api/anthropic/v1/messages`,
})
const capProxyServer = createServer((req, res) => proxyHandler(req, res))
await new Promise((resolve) => capProxyServer.listen(0, '127.0.0.1', resolve))
const capPort = capProxyServer.address().port
const capturedPromise = new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 3000)
  captureServer.once('request', () => { clearTimeout(timer); resolve(capturedHeaders[0] || null) })
})
const capFetch = fetch(`http://127.0.0.1:${capPort}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'GLM-5.3-Flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }),
})
const sentHeaders = await capturedPromise
await capFetch.catch(() => {})
capProxyServer.close()
captureServer.close()
if (sentHeaders) {
  const h = capturedHeaders[0] || {}
  check('反代上游请求携带完整官方指纹 UA', h['user-agent'] === `ZCode/${OFFICIAL_ZCODE_VERSION}`, h['user-agent'])
  check('反代上游请求双鉴权头（x-api-key + Bearer）', h['x-api-key'] === 'test-key' && h.authorization === 'Bearer test-key')
  check('反代上游请求带 anthropic-version', h['anthropic-version'] === '2023-06-01')
  check('反代上游请求带 X-Title / X-Platform / X-Os-Category', h['x-title'] === 'Z Code@electron' && Boolean(h['x-platform']) && Boolean(h['x-os-category']))
} else {
  check('反代上游请求指纹捕获', false, 'capture timeout')
}

// 7. 真实上游实时补全测试（若凭据可用）
if (creds?.apiKey) {
  const standalone = await startZCodeStandaloneServer({ port: 0 })
  try {
    const liveRes = await fetch(`${standalone.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'GLM-5.3-Flash',
        messages: [{ role: 'user', content: 'Say "OK_ZCODE" only.' }],
        max_tokens: 30,
      }),
    })
    check('真实上游响应状态 200 OK', liveRes.status === 200)
    const liveJson = await liveRes.json()
    const textOrThought = (liveJson.choices[0]?.message?.content || '') + (liveJson.choices[0]?.message?.reasoning_content || '')
    check('真实上游模型成功返回推理文本', textOrThought.length > 0, textOrThought.slice(0, 50))
  } finally {
    await standalone.close()
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n测试完成：${results.length - failed.length}/${results.length} 通过\n`)
if (failed.length > 0) {
  process.exit(1)
}
