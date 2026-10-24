/**
 * 订阅登录插件的 DSH 本地接入层，供 WorkBuddy 与 Qoder 国内版共用。
 * 上游适配来源：yetone / magpie-community (MIT)，详见 THIRD_PARTY_NOTICES.md。
 * https://github.com/magpie-community/plugins
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'

const MAX_BODY = 32 * 1024 * 1024

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
const failure = (res, status, message) => send(res, status, { error: { message, type: 'api_error' } })

async function readBody(req) {
  let length = 0
  const chunks = []
  for await (const chunk of req) {
    length += chunk.length
    if (length > MAX_BODY) throw Object.assign(new Error('请求体超过 32 MB'), { status: 413 })
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw Object.assign(new Error('请求体必须是有效 JSON'), { status: 400 }) }
}

/** 将 Chat Completions SSE 聚合成普通 OpenAI 响应。 */
async function collectCompletion(response, model, label) {
  const result = { id: '', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [] }
  const choices = new Map()
  const decoder = new TextDecoder()
  let buffer = '', bytes = 0, completed = false
  const consume = (line) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data === '[DONE]') { completed = true; return }
    if (!data) return
    const event = JSON.parse(data)
    if (event.error) throw new Error(event.error.message || `${label} 返回流式错误`)
    if (event.id) result.id = event.id
    if (event.created) result.created = event.created
    if (event.model) result.model = event.model
    if (event.usage) result.usage = event.usage
    for (const c of event.choices ?? []) {
      const index = c.index ?? 0
      if (!choices.has(index)) choices.set(index, { index, message: { role: 'assistant', content: '' }, finish_reason: null, tools: new Map() })
      const choice = choices.get(index), delta = c.delta ?? {}
      if (typeof delta.content === 'string') choice.message.content += delta.content
      if (typeof delta.reasoning_content === 'string') choice.message.reasoning_content = (choice.message.reasoning_content ?? '') + delta.reasoning_content
      for (const t of delta.tool_calls ?? []) {
        const ti = t.index ?? 0
        if (!choice.tools.has(ti)) choice.tools.set(ti, { id: '', type: 'function', function: { name: '', arguments: '' } })
        const tool = choice.tools.get(ti)
        if (t.id) tool.id = t.id
        tool.function.name += t.function?.name ?? ''
        tool.function.arguments += t.function?.arguments ?? ''
      }
      if (c.finish_reason) choice.finish_reason = c.finish_reason
    }
  }
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > MAX_BODY) throw new Error('上游响应超过 32 MB')
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) consume(line.replace(/\r$/, ''))
  }
  buffer += decoder.decode()
  if (buffer.trim()) consume(buffer.trim())
  if (!completed || !choices.size || [...choices.values()].some(c => !c.finish_reason)) throw new Error(`${label} 响应提前结束，请重试`)
  result.choices = [...choices.values()].sort((a, b) => a.index - b.index).map(({ tools, ...c }) => {
    if (tools.size) c.message.tool_calls = [...tools].sort(([a], [b]) => a - b).map(([, t]) => t)
    return c
  })
  return result
}

export function createSubscriptionService({ statePath, port, fetchFn = fetch, onLogin, label, providerId, authPlugin, parseQuota } = {}) {
  const lifetime = new AbortController()
  let closed = false, server = null, starting = null, actualPort = port
  let modelsCache = null, quotaCache = null, loginTask = null, loginController = null
  let login = { status: 'idle', url: null, message: null }
  let state = {}
  if (existsSync(statePath)) {
    // 损坏时明确报错，避免静默覆盖用户的已存凭据。
    state = JSON.parse(readFileSync(statePath, 'utf8'))
  }
  const ready = () => state.auth?.type === 'oauth' && Boolean(state.auth.access && state.auth.uid)
  const redact = message => {
    let text = String(message ?? '')
    const secrets = [state.proxyKey, ...['access', 'refresh', 'deviceToken', 'deviceRefresh', 'pat'].map(k => state.auth?.[k])]
      .filter(s => typeof s === 'string' && s.length >= 8).sort((a, b) => b.length - a.length)
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]')
    return text
  }
  const fail = (res, status, message) => failure(res, status, redact(message))
  // 按完整 SSE 行遮盖密钥，处理跨网络分片的错误文字；不缓存整个回复。
  async function* safeStream(body) {
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true })
      if (buffer.length > MAX_BODY) throw new Error('上游响应行超过 32 MB')
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        yield Buffer.from(redact(buffer.slice(0, end + 1)))
        buffer = buffer.slice(end + 1)
      }
    }
    buffer += decoder.decode()
    if (buffer) yield Buffer.from(redact(buffer))
  }
  const baseURL = () => `http://127.0.0.1:${actualPort}/v1`
  const save = () => {
    lifetime.signal.throwIfAborted()
    mkdirSync(dirname(statePath), { recursive: true })
    const temp = `${statePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, statePath)
  }
  const client = { auth: { set: async ({ body }) => {
    if (closed || !state.auth) return
    state.auth = { ...state.auth, ...body, type: 'oauth' }
    save()
  } } }
  const plugin = authPlugin({ client, signal: lifetime.signal, fetch: fetchFn })
  const status = () => ({ ready: ready(), account: ready() ? state.auth.accountId || state.auth.uid : null,
    running: Boolean(server?.listening), baseURL: baseURL(), models: modelsCache?.data?.length ?? 0,
    quota: quotaCache?.data ?? null, login: { ...login, message: login.message ? redact(login.message) : null } })

  async function models({ fresh = false } = {}) {
    if (!ready()) throw new Error(`请先登录 ${label} 国内版`)
    if (!fresh && modelsCache && Date.now() - modelsCache.at < 60000) return modelsCache.data
    const hooks = await plugin, config = {}
    await hooks.config(config)
    const p = { id: providerId, ...config.provider[providerId] }
    const listed = await hooks.provider.models(p, { auth: state.auth })
    const data = Object.entries(listed).map(([id, m]) => ({
      id, name: m.name || id, contextWindow: Number(m.limit?.context) || 128000,
      ...(m.limit?.output > 0 ? { maxTokens: m.limit.output } : {}),
      input: (m.capabilities?.input?.image || m.modalities?.input?.includes('image')) ? ['text', 'image'] : ['text'],
      ...(Object.keys(m.variants ?? {}).length ? { reasoningEfforts: Object.fromEntries(Object.keys(m.variants).map(k => [k === 'none' ? 'off' : k, k])) } : {}),
    }))
    modelsCache = { at: Date.now(), data }
    return data
  }

  async function quota({ fresh = false } = {}) {
    if (!ready()) return null
    if (!fresh && quotaCache && Date.now() - quotaCache.at < 30000) return quotaCache.data
    const value = await (await plugin).auth.usage(async () => state.auth)
    const data = { account: state.auth.accountId || state.auth.uid, ...parseQuota(value),
      error: value.error ? redact(value.error) : null, updatedAt: new Date().toISOString() }
    quotaCache = { at: Date.now(), data }
    return data
  }

  async function beginLogin() {
    lifetime.signal.throwIfAborted()
    if (loginTask) return { started: false, alreadyWaiting: true, url: login.url }
    loginController = new AbortController()
    const controller = loginController
    login = { status: 'waiting', url: null, message: null }
    // 在获取授权链接前就占住登录席位，避免双击产生两个并行授权。
    let resolveStarted, rejectStarted
    const started = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject })
    loginTask = (async () => {
      try {
        const hooks = await authPlugin({ client, signal: AbortSignal.any([lifetime.signal, controller.signal]), fetch: fetchFn })
        const flow = await hooks.auth.methods[0].authorize()
        controller.signal.throwIfAborted()
        login.url = flow.url
        resolveStarted({ started: true, url: flow.url })
        const result = await flow.callback()
        if (closed || controller.signal.aborted) return
        if (result.type !== 'success' || !result.access || !result.uid) throw new Error(result.error || `${label} 登录未完成`)
        const { type, ...auth } = result
        state = { proxyKey: state.proxyKey || randomBytes(32).toString('hex'), auth: { ...auth, type: 'oauth' } }
        save()
        modelsCache = quotaCache = null
        await start()
        login = { status: 'success', url: null, message: `${label} 国内版已登录，可接入 DSH` }
        if (onLogin) {
          try { await onLogin(); login.message = `${label} 国内版已接入 DSH，开一个新会话即可选择模型` }
          catch (err) { login.message = `已登录，请点击「接入 DSH」重试：${err.message}` }
        }
      } catch (err) {
        if (!closed && !controller.signal.aborted) login = { status: 'failed', url: null, message: err.message }
        rejectStarted(new Error(redact(err.message)))
      } finally { loginTask = null }
    })()
    return started
  }

  async function handler(req, res) {
    const abort = new AbortController()
    const disconnected = () => { if (!res.writableFinished) abort.abort() }
    res.on('close', disconnected)
    try {
      if (req.headers.origin && new URL(req.headers.origin).origin !== `http://127.0.0.1:${actualPort}`) return fail(res, 403, '跨站请求被拒绝')
      const supplied = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''))
      const expected = Buffer.from(state.proxyKey || '')
      if (!expected.length || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return fail(res, 401, `无效的 ${label} 网关密钥`)
      if (!ready()) return fail(res, 401, `请先在 DSH 设置里登录 ${label} 国内版`)
      const path = new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '')
      if (path === '/v1/models' && req.method === 'GET') {
        return send(res, 200, { object: 'list', data: (await models()).map(m => ({ ...m, object: 'model', owned_by: providerId })) })
      }
      if (path !== '/v1/chat/completions') return fail(res, 404, '未知端点')
      if (req.method !== 'POST') return fail(res, 405, '只支持 POST')
      const body = await readBody(req)
      if (!body || typeof body.model !== 'string' || !Array.isArray(body.messages)) return fail(res, 400, '缺少 model 或 messages')
      const upstream = await (await plugin).auth.loader(async () => state.auth)
      const headers = new Headers({ 'content-type': 'application/json' })
      const session = req.headers['x-deepseek-harness-session-id'] || req.headers['x-magpie-session'] || req.headers['x-session-id'] || req.headers.session_id || req.headers['x-client-request-id']
      if (typeof session === 'string') {
        const output = { headers: {} }
        await (await plugin)['chat.headers']?.({ sessionID: session, model: { providerID: providerId } }, output)
        for (const [key, value] of Object.entries(output.headers)) headers.set(key, value)
      }
      const response = await upstream.fetch(`${upstream.baseURL}/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }),
        signal: AbortSignal.any([abort.signal, lifetime.signal, AbortSignal.timeout(180000)]),
      })
      if (!response.ok) {
        const text = await response.text()
        let message = text.slice(0, 1000)
        try { const parsed = JSON.parse(text); message = parsed.error?.message || parsed.msg || message } catch {}
        const retryAfter = response.headers.get('retry-after')
        if (retryAfter) res.setHeader('retry-after', retryAfter)
        return fail(res, response.status, message)
      }
      if (!response.headers.get('content-type')?.includes('text/event-stream')) {
        const value = await response.json().catch(() => null)
        return fail(res, 502, value?.error?.message || value?.msg || `${label} 未返回有效的流式响应`)
      }
      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
        await pipeline(safeStream(response.body), res, { signal: abort.signal })
      } else send(res, 200, await collectCompletion(response, body.model, label))
    } catch (err) {
      if (res.destroyed) return
      if (res.headersSent) { res.destroy(); return }
      fail(res, err.status || (err.name === 'TimeoutError' ? 504 : 502), err.message)
    } finally { res.off('close', disconnected) }
  }

  async function start() {
    lifetime.signal.throwIfAborted()
    if (!ready()) throw new Error(`请先登录 ${label} 国内版`)
    if (server?.listening) return { baseURL: baseURL() }
    if (starting) return starting
    if (!state.proxyKey) { state.proxyKey = randomBytes(32).toString('hex'); save() }
    starting = (async () => {
      const candidate = createServer((req, res) => { void handler(req, res) })
      server = candidate
      try {
        await new Promise((resolve, reject) => {
          candidate.once('error', reject)
          candidate.listen(port, '127.0.0.1', resolve)
        })
        if (closed) { candidate.close(); throw new Error(`${label} 服务已关闭`) }
        actualPort = candidate.address().port
        candidate.unref()
        return { baseURL: baseURL() }
      } catch (err) { if (server === candidate) server = null; throw err }
      finally { starting = null }
    })()
    return starting
  }

  async function close() {
    if (closed) return
    closed = true
    lifetime.abort()
    loginController?.abort()
    if (login.status === 'waiting') login = { status: 'cancelled', url: null, message: '登录已取消' }
    await starting?.catch(() => {})
    if (server) {
      const current = server
      server = null
      await new Promise(resolve => { current.close(resolve); current.closeAllConnections() })
    }
    await loginTask
  }

  async function logout() {
    loginController?.abort()
    await loginTask
    delete state.auth
    save()
    modelsCache = quotaCache = null
    login = { status: 'idle', url: null, message: null }
  }
  return { status, beginLogin, models, quota, start, close, logout, apiKey: () => state.proxyKey }
}
