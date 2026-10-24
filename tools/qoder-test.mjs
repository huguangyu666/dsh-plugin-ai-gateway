/** Qoder 国内版：真实协议适配模块 + 假上游，始终只使用临时账号。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { EventEmitter } from 'node:events'
import { createQoderService } from '../src/qoder-service.js'
import { _internal } from '../src/vendor/qoder.mjs'
import { apply, Config } from '../src/index.js'

const ACCESS = 'fixture-qoder-access'
const REFRESH = 'fixture-qoder-refresh'
const DEVICE = 'fixture-qoder-device'
const PROXY = 'fixture-qoder-proxy'
const message = { role: 'user', content: '你好' }
const chunks = [
  { choices: [{ delta: { reasoning_content: '想一想' } }] },
  { choices: [{ delta: { content: '你好' } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'fixture-call', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, finish_reason: 'tool_calls' }] },
  { usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } } },
]
const sse = () => new Response([...chunks.map(c => ({ statusCodeValue: 200, body: JSON.stringify(c) })), { body: '[DONE]' }]
  .map(c => `data: ${JSON.stringify(c)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })

function fixture({ loggedIn = false, expired = false, waitForLogin = false, deviceChat = false, chatResponse = sse, onLogin, waitForModels = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qoder-test-'))
  const statePath = join(dir, 'qoder.json')
  if (loggedIn) writeFileSync(statePath, JSON.stringify({ proxyKey: PROXY, auth: {
    type: 'oauth', uid: 'fixture-uid', accountId: '测试国内账号', machineId: 'fixture-machine',
    access: ACCESS, refresh: REFRESH, expires: Date.now() + (expired ? -1000 : 3600000),
    deviceToken: DEVICE, deviceRefresh: 'fixture-device-refresh',
  } }))
  const calls = []
  const fetchFn = async (input, init = {}) => {
    const url = new URL(input)
    assert.ok(['openapi.qoder.com.cn', 'gateway.qoder.com.cn'].includes(url.hostname), '只允许国内版上游')
    const call = { url: url.href, headers: new Headers(init.headers), body: init.body, signal: init.signal }
    calls.push(call)
    if (url.pathname.endsWith('/model/list') && waitForModels) return new Promise((_, reject) => {
      init.signal.throwIfAborted()
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    })
    if (url.pathname.endsWith('/ask/queue/status')) return Response.json({ isQueued: false, retryAfterSeconds: 0 })
    if (url.pathname.endsWith('/deviceToken/poll')) return Response.json(waitForLogin ? {} : { token: DEVICE, refresh_token: 'fixture-device-refresh', user_id: 'fixture-uid', expires_in: 3600 })
    if (url.pathname.endsWith('/me/jobToken')) return deviceChat
      ? Response.json({ message: 'device chat only' }, { status: 403 })
      : Response.json({ token: ACCESS, refresh_token: REFRESH, expires_in: 3600000 })
    if (url.pathname.endsWith('/userinfo')) return Response.json({ email: 'fixture@example.invalid', name: '国内测试账号' })
    if (url.pathname.endsWith('/jobToken/refresh')) return Response.json({ token: ACCESS + '-new', refresh_token: REFRESH + '-new', expires_in: 3600000 })
    if (url.pathname.endsWith('/model/list')) return Response.json({ app: [
      { key: 'fixture-model', display_name: '测试模型', enable: true, source: 'fixture', max_input_tokens: 180000,
        context_config: { '200k': { token_count: 200000, is_default: true }, '400k': { token_count: 400000 } },
        is_vl: true, thinking_config: { enabled: { efforts: { high: { is_default: true }, max: {} } } } },
      { key: 'disabled-model', enable: false },
    ] })
    if (url.pathname.endsWith('/me/usage')) return Response.json({ displayMode: 'qoder', qoderUsage: {
      userType: 'Pro', userQuota: { total: 100, used: 25 }, addOnQuota: { total: 50, remaining: 50 },
    } })
    if (url.pathname.endsWith('/agent_chat_generation')) {
      call.decoded = JSON.parse(_internal.decodeBody(init.body))
      return chatResponse(call)
    }
    throw new Error('未预期的假上游端点：' + url.pathname)
  }
  const service = createQoderService({ statePath, port: 0, fetchFn, onLogin })
  return { service, statePath, calls, fetchFn, async cleanup() {
    await service.close()
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep) && basename(dir).startsWith('dsh-qoder-test-'))
    rmSync(dir, { recursive: true, force: true })
  } }
}
async function until(fn) {
  for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)) }
  assert.fail('等待状态超时')
}
async function chat(service, body = {}, headers = {}) {
  const { baseURL } = await service.start()
  return fetch(baseURL + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${PROXY}`, ...headers },
    body: JSON.stringify({ model: 'fixture-model', messages: [message], ...body }) })
}

test('浏览器登录国内账号、自动接入并持久化；状态不泄漏密钥', async () => {
  let applied = 0
  const f = fixture({ onLogin: async () => { applied++ } })
  try {
    const started = await f.service.beginLogin()
    assert.equal(new URL(started.url).hostname, 'qoder.cn')
    assert.equal(new URL(started.url).searchParams.get('challenge_method'), 'S256')
    await until(() => f.service.status().login.status === 'success')
    assert.equal(applied, 1)
    assert.equal(f.service.status().ready, true)
    const saved = JSON.parse(readFileSync(f.statePath, 'utf8'))
    assert.equal(saved.auth.access, ACCESS)
    assert.equal(saved.auth.deviceToken, DEVICE)
    assert.ok(saved.auth.machineId)
    for (const secret of [ACCESS, REFRESH, DEVICE, saved.proxyKey]) assert.ok(!JSON.stringify(f.service.status()).includes(secret))
  } finally { await f.cleanup() }
})

test('国内版拒绝 job token 时使用官方设备令牌通道', async () => {
  const f = fixture({ deviceChat: true })
  try {
    await f.service.beginLogin()
    await until(() => f.service.status().login.status === 'success')
    const auth = JSON.parse(readFileSync(f.statePath, 'utf8')).auth
    assert.equal(auth.deviceChat, true)
    assert.equal(auth.access, DEVICE)
  } finally { await f.cleanup() }
})

test('读取账号真实模型窗口、图像与推理档位，保留各积分池', async () => {
  const f = fixture({ loggedIn: true })
  try {
    const models = await f.service.models()
    assert.equal(models.length, 1)
    assert.equal(models[0].contextWindow, 400000)
    assert.deepEqual(models[0].input, ['text', 'image'])
    assert.deepEqual(models[0].reasoningEfforts, { high: 'high', max: 'max' })
    const quota = await f.service.quota()
    assert.equal(quota.plan, 'Pro')
    assert.equal(quota.windows.length, 2)
    assert.equal(quota.windows[0].used, 25)
    assert.match(quota.windows[1].display, /0 \/ 50/)
  } finally { await f.cleanup() }
})

test('本地反代校验独立密钥和来源；原生 COSY 协议保留推理与工具调用', async () => {
  const f = fixture({ loggedIn: true })
  try {
    const { baseURL } = await f.service.start()
    assert.equal((await fetch(baseURL + '/models')).status, 401)
    assert.equal((await fetch(baseURL + '/models', { headers: { authorization: `Bearer ${PROXY}`, origin: 'https://foreign.invalid' } })).status, 403)
    assert.equal(f.calls.length, 0)
    const r = await chat(f.service, { stream: true }, { 'x-deepseek-harness-session-id': 'fixture-session' })
    assert.equal(r.status, 200)
    const text = await r.text()
    assert.match(text, /reasoning_content/)
    assert.match(text, /tool_calls/)
    assert.match(text, /\[DONE\]/)
    const upstream = f.calls.find(c => c.decoded)
    assert.match(upstream.headers.get('authorization'), /^Bearer COSY\./)
    assert.ok(!JSON.stringify([...upstream.headers]).includes(PROXY))
    assert.equal(upstream.decoded.session_id, _internal.sessionOf({ messages: [message] }, 'fixture-session'))
    assert.equal(upstream.decoded.parameters.context_length, 200000)
  } finally { await f.cleanup() }
})

test('普通响应聚合推理、工具参数与用量；同会话工具循环共用一个任务', async () => {
  const f = fixture({ loggedIn: true })
  try {
    const headers = { 'x-deepseek-harness-session-id': 'fixture-tool-session' }
    const first = await chat(f.service, {}, headers)
    const body = await first.json()
    assert.equal(first.status, 200)
    const m = body.choices[0].message
    assert.equal(m.content, '你好')
    assert.equal(m.reasoning_content, '想一想')
    assert.equal(m.tool_calls[0].function.arguments, '{"path":"a.txt"}')
    assert.equal(body.usage.total_tokens, 15)
    const next = await chat(f.service, { messages: [message, m, { role: 'tool', tool_call_id: m.tool_calls[0].id, content: 'file body' }] }, headers)
    assert.equal(next.status, 200)
    await next.text()
    const calls = f.calls.filter(c => c.decoded)
    assert.equal(calls[0].decoded.session_id, calls[1].decoded.session_id)
    assert.equal(calls[0].decoded.request_set_id, calls[1].decoded.request_set_id)
    assert.equal(calls[1].decoded.business.stage, 'processing')
    assert.notEqual(calls[0].decoded.request_id, calls[1].decoded.request_id)
  } finally { await f.cleanup() }
})

test('上游额度不足保留错误状态，错误不泄漏账号令牌', async () => {
  const f = fixture({ loggedIn: true, chatResponse: () => Response.json({ code: 110, message: `credits exhausted ${ACCESS} ${REFRESH} ${DEVICE}` }, { status: 400 }) })
  try {
    const r = await chat(f.service)
    assert.equal(r.status, 429)
    const message = (await r.json()).error.message
    assert.match(message, /credits exhausted/)
    for (const secret of [ACCESS, REFRESH, DEVICE]) assert.ok(!message.includes(secret), '错误不能泄漏上游凭据')
  } finally { await f.cleanup() }
})

test('资源排队按上游状态恢复，沿用原任务且不误判为登录失效', async () => {
  let attempts = 0
  const f = fixture({ loggedIn: true, chatResponse: () => ++attempts === 1
    ? Response.json({ code: 10605, message: 'busy', isQueued: true, retryAfterSeconds: 0 }, { status: 403 }) : sse() })
  try {
    const r = await chat(f.service)
    assert.equal(r.status, 200)
    await r.text()
    assert.equal(attempts, 2)
    assert.ok(f.calls.some(c => c.url.includes('/ask/queue/status')))
    const asks = f.calls.filter(c => c.decoded)
    assert.equal(asks[0].decoded.request_set_id, asks[1].decoded.request_set_id)
    assert.equal(f.service.status().ready, true)
  } finally { await f.cleanup() }
})

test('流开始后的错误会保留错误帧，并遮盖上游回显的令牌', async () => {
  const f = fixture({ loggedIn: true, chatResponse: () => new Response([
    { statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta: { content: '开始回复' } }] }) },
    { statusCodeValue: 500, body: JSON.stringify({ message: 'fixture failure ' + ACCESS }) },
  ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }) })
  try {
    const r = await chat(f.service, { stream: true })
    const text = await r.text()
    assert.match(text, /开始回复/)
    assert.match(text, /"error"/)
    assert.ok(!text.includes(ACCESS))
  } finally { await f.cleanup() }
})

test('卸载取消进行中的模型读取，网络请求不遗留后台任务', async () => {
  const f = fixture({ loggedIn: true, waitForModels: true })
  try {
    const pending = f.service.models()
    await until(() => f.calls.some(c => c.url.includes('/model/list')))
    await f.service.close()
    await pending.catch(() => {})
    assert.ok(f.calls.find(c => c.url.includes('/model/list')).signal.aborted)
  } finally { await f.cleanup() }
})

test('并发读取只续期一次，轮换的 refresh token 立即保存', async () => {
  const f = fixture({ loggedIn: true, expired: true })
  try {
    await Promise.all([f.service.models(), f.service.quota()])
    assert.equal(f.calls.filter(c => c.url.includes('/jobToken/refresh')).length, 1)
    assert.equal(JSON.parse(readFileSync(f.statePath, 'utf8')).auth.refresh, REFRESH + '-new')
  } finally { await f.cleanup() }
})

test('重复点击不重复登录，退出或卸载会取消轮询；退出清除账号', async () => {
  const waiting = fixture({ waitForLogin: true })
  try {
    await waiting.service.beginLogin()
    assert.equal((await waiting.service.beginLogin()).alreadyWaiting, true)
    await until(() => waiting.calls.length > 0)
    await waiting.service.logout()
    assert.equal(waiting.service.status().ready, false)
    assert.equal(waiting.service.status().login.status, 'idle')
    assert.ok(waiting.calls[0].signal.aborted)
  } finally { await waiting.cleanup() }
  const signed = fixture({ loggedIn: true })
  try {
    await signed.service.logout()
    assert.ok(!readFileSync(signed.statePath, 'utf8').includes(ACCESS))
  } finally { await signed.cleanup() }
})

test('DSH 一键接入独立于 CPA，使用官方凭据服务且拒绝未授权远程管理', async () => {
  const f = fixture({ loggedIn: true })
  const routes = [], disposers = [], changes = [], keys = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = f.fetchFn
  try {
    const dir = dirname(f.statePath)
    const config = Config({ autoStart: false, autoSyncDshProvider: false, qoderPort: 0,
      statePath: join(dir, 'state.json'), runtimePath: join(dir, 'runtime.json'), authDir: join(dir, 'no-auth'), binPath: join(dir, 'not-installed') })
    const ctx = { effect: fn => disposers.push(fn()), webServer: { host: '127.0.0.1', register: r => { routes.push(r); return () => {} } },
      settings: { get: () => ({ providers: {} }), update: async (ns, patch) => changes.push({ ns, patch }) },
      credentials: { set: async (ref, key) => keys.push({ ref, key }) } }
    apply(ctx, config)
    async function call(path, method = 'GET', body) {
      const req = new EventEmitter()
      Object.assign(req, { url: '/ai-gateway/api' + path, method, headers: {} })
      let result
      const res = { writeHead(status) { this.status = status }, end(value) { result = { status: this.status, body: JSON.parse(value) } } }
      const task = routes[0].handler(req, res)
      if (body) req.emit('data', JSON.stringify(body))
      req.emit('end')
      await task
      return result
    }
    const applied = await call('/provider/apply', 'POST', { target: 'qoder' })
    assert.equal(applied.status, 200, JSON.stringify(applied.body))
    const p = changes.at(-1).patch.providers['qoder-gateway']
    assert.equal(p.api, 'openai-completions')
    assert.equal(p.apiKeyEnv, 'QODER_GATEWAY_API_KEY')
    assert.equal(p.models[0].contextWindow, 400000)
    assert.equal(keys.at(-1).key, PROXY)
    assert.equal((await call('/qoder/status')).body.ready, true)
    ctx.webServer.host = '0.0.0.0'
    for (const path of ['/qoder/status', '/qoder/quota']) assert.equal((await call(path)).status, 403)
    for (const path of ['/qoder/login', '/qoder/key', '/qoder/logout']) assert.equal((await call(path, 'POST')).status, 403)
  } finally {
    for (const dispose of disposers.reverse()) await dispose?.()
    globalThis.fetch = originalFetch
    await f.cleanup()
  }
})
