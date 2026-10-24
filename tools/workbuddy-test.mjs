/** WorkBuddy 国内版：只用临时凭据和假上游，不读取或调用真实账号。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { EventEmitter } from 'node:events'
import { createWorkBuddyService } from '../src/workbuddy-service.js'
import { apply, Config } from '../src/index.js'

const ACCESS = 'fixture-access-never-a-real-token'
const REFRESH = 'fixture-refresh-never-a-real-token'
const envelope = (data, code = 0) => Response.json({ code, data })
const chunk = (delta, extra = {}) => ({ id: 'chatcmpl-fixture', model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: null }], ...extra })
const events = [
  chunk({ role: 'assistant', reasoning_content: '想一想' }),
  chunk({ content: '你好' }),
  chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }),
  chunk({}, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
]
const sse = () => new Response(events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n', { headers: { 'content-type': 'text/event-stream' } })

function fixture({ loggedIn = false, expired = false, chatResponse = sse, waitForLogin = false, onLogin } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workbuddy-test-'))
  const statePath = join(dir, 'workbuddy.json')
  if (loggedIn) writeFileSync(statePath, JSON.stringify({ proxyKey: 'fixture-proxy-key', auth: {
    type: 'oauth', access: ACCESS, refresh: REFRESH, expires: Date.now() + (expired ? -1000 : 3600000), uid: 'fixture-uid', accountId: '测试账号', domain: 'www.codebuddy.cn',
  } }))
  const calls = []
  const fetchFn = async (input, init = {}) => {
    const url = String(input)
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ url, headers: new Headers(init.headers), body })
    if (url.includes('/auth/state')) return envelope({ state: 'fixture-state', authUrl: 'https://www.codebuddy.cn/login?state=fixture-state' })
    if (url.includes('/auth/token/refresh')) return envelope({ accessToken: ACCESS + '-renewed', refreshToken: REFRESH + '-renewed', expiresIn: 3600 })
    if (url.includes('/auth/token')) {
      if (waitForLogin) return envelope({}, 11217)
      return envelope({ accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 3600, domain: 'www.codebuddy.cn' })
    }
    if (url.includes('/login/account')) return envelope({ uid: 'fixture-uid', nickname: '测试账号' })
    if (url.endsWith('/v3/config')) return envelope({ agents: [{ name: 'cli', models: ['fixture-model'] }], models: [
      { id: 'fixture-model', name: '测试模型', maxInputTokens: 128000, maxOutputTokens: 8192, supportsImages: true, reasoning: { supportedEfforts: ['low', 'high'] } },
    ] })
    if (url.endsWith('/chat/completions')) return chatResponse()
    if (url.includes('get-user-resource-summary')) return envelope({ Packages: [{ CycleTotalCapacity: '100', CycleUsedCapacity: '25' }] })
    return envelope({})
  }
  const service = createWorkBuddyService({ statePath, port: 0, fetchFn, onLogin })
  return { service, statePath, calls, fetchFn, async cleanup() {
    await service.close()
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep) && basename(dir).startsWith('dsh-workbuddy-test-'))
    rmSync(dir, { recursive: true, force: true })
  } }
}

async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return
    await new Promise(r => setTimeout(r, 5))
  }
  assert.fail('等待状态变化超时')
}

test('浏览器登录：自动完成、持久化，状态不返回上游或网关密钥', async () => {
  const f = fixture()
  try {
    assert.equal(f.service.status().ready, false)
    const login = await f.service.beginLogin()
    assert.equal(login.started, true)
    assert.match(login.url, /^https:\/\/www\.codebuddy\.cn\//)
    await until(() => f.service.status().login.status === 'success')
    assert.equal(f.service.status().account, '测试账号')
    const saved = JSON.parse(readFileSync(f.statePath, 'utf8'))
    assert.equal(saved.auth.access, ACCESS)
    const publicState = JSON.stringify(f.service.status())
    for (const secret of [ACCESS, REFRESH, saved.proxyKey]) assert.ok(!publicState.includes(secret))
  } finally { await f.cleanup() }
})

test('模型清单保留真实窗口、图像和推理档位；额度显示剩余积分', async () => {
  const f = fixture({ loggedIn: true })
  try {
    const models = await f.service.models()
    assert.equal(models[0].contextWindow, 128000)
    assert.equal(models[0].maxTokens, 8192)
    assert.deepEqual(models[0].input, ['text', 'image'])
    assert.equal(models[0].reasoningEfforts.high, 'high')
    const quota = await f.service.quota()
    assert.equal(quota.remaining, 75)
    assert.equal(quota.total, 100)
    assert.equal(quota.percent, 75)
  } finally { await f.cleanup() }
})

test('本地反代必须鉴权，错误密钥与跨站请求均不能调用上游', async () => {
  const f = fixture({ loggedIn: true })
  try {
    const { baseURL } = await f.service.start()
    const noKey = await fetch(`${baseURL}/models`)
    assert.equal(noKey.status, 401)
    const wrongKey = await fetch(`${baseURL}/models`, { headers: { authorization: 'Bearer wrong' } })
    assert.equal(wrongKey.status, 401)
    const crossSite = await fetch(`${baseURL}/models`, { headers: { authorization: 'Bearer fixture-proxy-key', origin: 'https://foreign.example' } })
    assert.equal(crossSite.status, 403)
    assert.equal(f.calls.length, 0)
    const good = await fetch(`${baseURL}/models`, { headers: { authorization: 'Bearer fixture-proxy-key' } })
    assert.equal(good.status, 200)
    assert.equal((await good.json()).data[0].id, 'fixture-model')
  } finally { await f.cleanup() }
})

test('流式转发保留推理和工具调用，上游使用账号令牌，网关密钥不外传', async () => {
  const f = fixture({ loggedIn: true })
  try {
    const { baseURL } = await f.service.start()
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST', headers: { authorization: 'Bearer fixture-proxy-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fixture-model', stream: true, messages: [{ role: 'user', content: '你好' }] }),
    })
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.match(text, /reasoning_content/)
    assert.match(text, /tool_calls/)
    assert.match(text, /\[DONE\]/)
    const chat = f.calls.find(c => c.url.endsWith('/chat/completions'))
    assert.equal(chat.url, 'https://copilot.tencent.com/v2/chat/completions')
    assert.equal(chat.headers.get('authorization'), `Bearer ${ACCESS}`)
    assert.ok(!JSON.stringify([...chat.headers]).includes('fixture-proxy-key'))
  } finally { await f.cleanup() }
})

test('非流式请求聚合 SSE 文本、推理、工具参数与 token 用量', async () => {
  const f = fixture({ loggedIn: true })
  try {
    const { baseURL } = await f.service.start()
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST', headers: { authorization: 'Bearer fixture-proxy-key' },
      body: JSON.stringify({ model: 'fixture-model', messages: [{ role: 'user', content: '你好' }] }),
    })
    assert.equal(res.status, 200)
    const result = await res.json()
    assert.equal(result.choices[0].message.content, '你好')
    assert.equal(result.choices[0].message.reasoning_content, '想一想')
    assert.equal(result.choices[0].message.tool_calls[0].function.arguments, '{"path":"a.txt"}')
    assert.equal(result.choices[0].finish_reason, 'tool_calls')
    assert.equal(result.usage.total_tokens, 15)
    assert.equal(f.calls.find(c => c.url.endsWith('/chat/completions')).body.stream, true)
  } finally { await f.cleanup() }
})

test('上游拒绝与无效 JSON 返回明确错误，不伪装为成功', async () => {
  const f = fixture({ loggedIn: true, chatResponse: () => Response.json({ error: { message: 'fixture quota error' } }, { status: 429 }) })
  try {
    const { baseURL } = await f.service.start()
    const options = { method: 'POST', headers: { authorization: 'Bearer fixture-proxy-key' } }
    const bad = await fetch(`${baseURL}/chat/completions`, { ...options, body: '{broken' })
    assert.equal(bad.status, 400)
    const refused = await fetch(`${baseURL}/chat/completions`, { ...options, body: JSON.stringify({ model: 'fixture-model', messages: [] }) })
    assert.equal(refused.status, 429)
    assert.match((await refused.json()).error.message, /fixture quota error/)
  } finally { await f.cleanup() }
})

test('HTTP 200 中的业务错误不会当成 SSE 成功响应', async () => {
  const f = fixture({ loggedIn: true, chatResponse: () => Response.json({ code: 14018, msg: 'fixture credits exhausted' }) })
  try {
    const { baseURL } = await f.service.start()
    const res = await fetch(`${baseURL}/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer fixture-proxy-key' },
      body: JSON.stringify({ model: 'fixture-model', stream: true, messages: [] }) })
    assert.equal(res.status, 502)
    assert.match((await res.json()).error.message, /fixture credits exhausted/)
  } finally { await f.cleanup() }
})

test('并行请求只续期一次，新的 refresh token 持久化', async () => {
  const f = fixture({ loggedIn: true, expired: true })
  try {
    await Promise.all([f.service.models(), f.service.quota()])
    assert.equal(f.calls.filter(c => c.url.includes('/auth/token/refresh')).length, 1)
    const saved = JSON.parse(readFileSync(f.statePath, 'utf8'))
    assert.equal(saved.auth.access, ACCESS + '-renewed')
    assert.equal(saved.auth.refresh, REFRESH + '-renewed')
  } finally { await f.cleanup() }
})

test('登录完成自动接入，接入失败保留已登录账号并提示重试', async () => {
  let called = 0
  const f = fixture({ onLogin: async () => { called++; throw new Error('fixture settings unavailable') } })
  try {
    await f.service.beginLogin()
    await until(() => f.service.status().login.message?.includes('fixture settings unavailable'))
    assert.equal(called, 1)
    assert.equal(f.service.status().ready, true)
    assert.equal(f.service.status().login.status, 'success')
  } finally { await f.cleanup() }
})

test('退出登录清除本地令牌；卸载取消未完成登录并关闭监听', async () => {
  const f = fixture({ waitForLogin: true })
  try {
    await f.service.beginLogin()
    assert.equal(f.service.status().login.status, 'waiting')
    await f.service.close()
    assert.equal(f.service.status().running, false)
    assert.equal(f.service.status().login.status, 'cancelled')
    await new Promise(r => setTimeout(r, 20))
    assert.equal(f.service.status().ready, false)
  } finally { await f.cleanup() }
  const signed = fixture({ loggedIn: true })
  try {
    await signed.service.logout()
    assert.equal(signed.service.status().ready, false)
    assert.ok(!readFileSync(signed.statePath, 'utf8').includes(ACCESS))
  } finally { await signed.cleanup() }
})

test('DSH 接入不依赖 CPA 在线，模型元数据和密钥写入官方服务', async () => {
  const f = fixture({ loggedIn: true })
  const routes = [], disposers = [], changes = [], keys = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = f.fetchFn
  try {
    const dir = dirnameFor(f.statePath)
    const config = Config({ autoStart: false, autoSyncDshProvider: false, workbuddyPort: 0,
      statePath: join(dir, 'gateway-state.json'), runtimePath: join(dir, 'runtime.json'),
      authDir: join(dir, 'no-auth'), binPath: join(dir, 'not-installed'), routePrefix: '/ai-gateway' })
    const ctx = { effect: fn => disposers.push(fn()), webServer: { host: '127.0.0.1', register: route => { routes.push(route); return () => {} } },
      settings: { get: () => ({ providers: {} }), update: async (ns, patch) => changes.push({ ns, patch }) },
      credentials: { set: async (ref, key) => keys.push({ ref, key }) } }
    apply(ctx, config)
    async function call(path, method = 'GET', body) {
      const req = new EventEmitter()
      Object.assign(req, { url: '/ai-gateway/api' + path, method, headers: {} })
      let output
      const res = { writeHead(status) { this.status = status }, end(value) { output = { status: this.status, body: JSON.parse(value) } } }
      const task = routes[0].handler(req, res)
      if (body) req.emit('data', JSON.stringify(body))
      req.emit('end')
      await task
      return output
    }
    const applied = await call('/provider/apply', 'POST', { target: 'workbuddy' })
    assert.equal(applied.status, 200, JSON.stringify(applied.body))
    const p = changes.at(-1).patch.providers['workbuddy-gateway']
    assert.match(p.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    assert.equal(p.models[0].contextWindow, 128000)
    assert.equal(p.apiKeyEnv, 'WORKBUDDY_GATEWAY_API_KEY')
    assert.equal(keys.at(-1).key, 'fixture-proxy-key')
    const status = await call('/workbuddy/status')
    assert.equal(status.body.ready, true)
    assert.ok(!JSON.stringify(status.body).includes(ACCESS))
    ctx.webServer.host = '0.0.0.0'
    assert.equal((await call('/workbuddy/status')).status, 403)
    assert.equal((await call('/workbuddy/logout', 'POST')).status, 403)
  } finally {
    for (const dispose of disposers.reverse()) await dispose?.()
    globalThis.fetch = originalFetch
    await f.cleanup()
  }
})

function dirnameFor(file) { return resolve(file, '..') }
