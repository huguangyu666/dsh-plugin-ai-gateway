/**
 * ZCode / 智谱 BigModel 适配服务
 *
 * 1. 自动提取并解密本地 ~/.zcode/v2/credentials.json 凭据（AES-256-GCM 机器派生密钥）
 * 2. OpenAI Chat Completions 与 智谱 Anthropic Messages 协议双向互转
 * 3. 思维链（thinking_delta -> reasoning_content）与函数调用（tool_use -> tool_calls）实时流式转换
 * 4. 提供内置 HTTP 处理函数与独立端口守护进程
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, platform, userInfo } from 'node:os'
import { join } from 'node:path'

const CIPHER_ALGO = 'aes-256-gcm'
const IV_LENGTH = 12
const TAG_LENGTH = 16
const PREFIX = 'enc:v1:'

export const DEFAULT_BIGMODEL_UPSTREAM = 'https://open.bigmodel.cn/api/anthropic/v1/messages'
export const DEFAULT_ZAI_UPSTREAM = 'https://api.z.ai/api/anthropic/v1/messages'
export const DEFAULT_ZCODE_PORT = 8325
const MAX_BODY_BYTES = 32 * 1024 * 1024

export const KNOWN_GLM_MODELS = new Map([
  ['glm-5.3', 'GLM-5.3'],
  ['glm-5.3-flash', 'GLM-5.3-Flash'],
  ['glm-5.2', 'GLM-5.2'],
  ['glm-5-turbo', 'GLM-5-Turbo'],
  ['glm-4.7', 'GLM-4.7'],
  ['glm-4.6', 'GLM-4.6'],
  ['glm-4.5', 'GLM-4.5'],
  ['glm-4.5-air', 'GLM-4.5-Air'],
  ['glm-5v-turbo', 'GLM-5V-Turbo'],
])

export function normalizeGlmModelId(modelId) {
  if (!modelId || typeof modelId !== 'string') return 'GLM-5.3-Flash'
  const trimmed = modelId.trim()
  const lower = trimmed.toLowerCase()
  return KNOWN_GLM_MODELS.get(lower) || trimmed
}

export function listSupportedGlmModels() {
  return [
    {
      id: 'GLM-5.3',
      name: 'GLM 5.3 (旗舰推理·深度思考)',
      contextWindow: 128000,
      input: ['text'],
      reasoningEfforts: { off: 'none', low: 'low', medium: 'medium', high: 'high' },
    },
    {
      id: 'GLM-5.3-Flash',
      name: 'GLM 5.3 Flash (极速高并发代码模型)',
      contextWindow: 128000,
      input: ['text'],
      reasoningEfforts: { off: 'none', low: 'low', medium: 'medium', high: 'high' },
    },
    {
      id: 'GLM-5.2',
      name: 'GLM 5.2 (通用代码生成)',
      contextWindow: 128000,
      input: ['text'],
    },
    {
      id: 'GLM-5-Turbo',
      name: 'GLM 5 Turbo (高速对话)',
      contextWindow: 128000,
      input: ['text'],
    },
    {
      id: 'GLM-4.7',
      name: 'GLM 4.7',
      contextWindow: 128000,
      input: ['text'],
    },
    {
      id: 'GLM-4.6',
      name: 'GLM 4.6',
      contextWindow: 128000,
      input: ['text'],
    },
  ]
}

export function resolveCredentialSecret(env = process.env) {
  const custom = env.ZCODE_CREDENTIAL_SECRET?.trim()
  if (custom) return custom
  let user = 'unknown'
  try {
    user = userInfo().username
  } catch {
    /* ignore */
  }
  return `zcode-credential-fallback:${platform()}:${homedir()}:${user}`
}

export function deriveCipherKey(secret) {
  if (Buffer.isBuffer(secret) && secret.length === 32) return secret
  return createHash('sha256').update(secret).digest()
}

export function decryptCredential(cipherText, secretOrKey) {
  if (typeof cipherText !== 'string' || !cipherText.startsWith(PREFIX)) {
    return cipherText
  }

  const key = deriveCipherKey(secretOrKey)
  const parts = cipherText.slice(PREFIX.length).split('.')
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted credential format: expected 3 dot-separated parts')
  }

  const iv = Buffer.from(parts[0], 'base64url')
  const tag = Buffer.from(parts[1], 'base64url')
  const data = Buffer.from(parts[2], 'base64url')

  if (iv.length !== IV_LENGTH) throw new Error('Invalid IV length')
  if (tag.length !== TAG_LENGTH) throw new Error('Invalid tag length')

  const decipher = createDecipheriv(CIPHER_ALGO, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf-8')
}

export function defaultCredentialsPath() {
  return join(homedir(), '.zcode', 'v2', 'credentials.json')
}

export function loadZCodeCredentials(options = {}) {
  const filePath = options.credentialsPath || process.env.ZCODE_CREDENTIALS_FILE || defaultCredentialsPath()
  if (!existsSync(filePath)) {
    return null
  }

  let rawJson = {}
  try {
    rawJson = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }

  const secret = resolveCredentialSecret(options.env || process.env)
  const key = deriveCipherKey(secret)

  const decryptedMap = {}
  for (const [k, v] of Object.entries(rawJson)) {
    if (typeof v === 'string') {
      try {
        decryptedMap[k] = decryptCredential(v, key)
      } catch {
        decryptedMap[k] = v
      }
    } else {
      decryptedMap[k] = v
    }
  }

  let individualKey = ''
  let teamKey = ''
  for (const [k, v] of Object.entries(decryptedMap)) {
    if (k.includes('individual-coding-plan') && k.endsWith(':api-key')) {
      individualKey = v
    } else if (k.includes('team-coding-plan') && k.endsWith(':api-key')) {
      teamKey = v
    }
  }

  let userInfoObj = null
  const userInfoStr = decryptedMap['oauth:bigmodel:user_info'] || decryptedMap['oauth:zai:user_info']
  if (userInfoStr) {
    try {
      userInfoObj = JSON.parse(userInfoStr)
    } catch {
      /* ignore */
    }
  }

  return {
    raw: decryptedMap,
    apiKey: individualKey || teamKey,
    individualApiKey: individualKey,
    teamApiKey: teamKey,
    accessToken: decryptedMap['oauth:bigmodel:access_token'] || decryptedMap['oauth:zai:access_token'] || '',
    activeProvider: decryptedMap['oauth:active_provider'] || 'bigmodel',
    jwtToken: decryptedMap.zcodejwttoken || '',
    userInfo: userInfoObj,
    credentialsPath: filePath,
  }
}

export function openaiToAnthropic(openaiBody) {
  const model = normalizeGlmModelId(openaiBody.model)
  const systemParts = []
  const rawMessages = Array.isArray(openaiBody.messages) ? openaiBody.messages : []

  const converted = []
  for (const msg of rawMessages) {
    const role = msg.role
    if (role === 'system' || role === 'developer') {
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      if (text) systemParts.push(text)
      continue
    }

    if (role === 'tool') {
      converted.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id || '',
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''),
          },
        ],
      })
      continue
    }

    if (role === 'assistant') {
      const blocks = []
      if (typeof msg.content === 'string' && msg.content.length > 0) {
        blocks.push({ type: 'text', text: msg.content })
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let input = {}
          try {
            input = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {})
          } catch {
            input = { raw: tc.function?.arguments || '' }
          }
          blocks.push({
            type: 'tool_use',
            id: tc.id || '',
            name: tc.function?.name || '',
            input,
          })
        }
      }
      converted.push({
        role: 'assistant',
        content: blocks.length > 0 ? blocks : (msg.content || ''),
      })
      continue
    }

    if (typeof msg.content === 'string') {
      converted.push({ role: 'user', content: msg.content })
    } else if (Array.isArray(msg.content)) {
      const parts = []
      for (const part of msg.content) {
        if (part.type === 'text') {
          parts.push({ type: 'text', text: part.text || '' })
        } else if (part.type === 'image_url') {
          const url = part.image_url?.url || ''
          if (url.startsWith('data:')) {
            const m = url.match(/^data:([^;]+);base64,(.+)$/)
            if (m) {
              parts.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: m[1],
                  data: m[2],
                },
              })
            }
          }
        }
      }
      converted.push({ role: 'user', content: parts })
    } else {
      converted.push({ role: 'user', content: String(msg.content ?? '') })
    }
  }

  const alternating = []
  for (const item of converted) {
    const prev = alternating[alternating.length - 1]
    if (prev && prev.role === item.role) {
      if (typeof prev.content === 'string' && typeof item.content === 'string') {
        prev.content = `${prev.content}\n${item.content}`
      } else {
        const prevBlocks = Array.isArray(prev.content)
          ? prev.content
          : [{ type: 'text', text: String(prev.content ?? '') }]
        const itemBlocks = Array.isArray(item.content)
          ? item.content
          : [{ type: 'text', text: String(item.content ?? '') }]
        prev.content = [...prevBlocks, ...itemBlocks]
      }
    } else {
      alternating.push(item)
    }
  }

  if (alternating.length > 0 && alternating[0].role === 'assistant') {
    alternating.unshift({ role: 'user', content: ' ' })
  }

  let anthropicTools = undefined
  if (Array.isArray(openaiBody.tools) && openaiBody.tools.length > 0) {
    anthropicTools = []
    for (const tool of openaiBody.tools) {
      if (tool.type === 'function' && tool.function) {
        anthropicTools.push({
          name: tool.function.name,
          description: tool.function.description || '',
          input_schema: tool.function.parameters || { type: 'object' },
        })
      }
    }
  }

  const maxTokens = openaiBody.max_tokens ?? openaiBody.max_completion_tokens ?? 4096

  const result = {
    model,
    messages: alternating,
    max_tokens: maxTokens,
  }

  if (systemParts.length > 0) {
    result.system = systemParts.join('\n\n')
  }

  if (anthropicTools && anthropicTools.length > 0) {
    result.tools = anthropicTools
  }

  if (typeof openaiBody.temperature === 'number') {
    result.temperature = openaiBody.temperature
  }

  if (typeof openaiBody.top_p === 'number') {
    result.top_p = openaiBody.top_p
  }

  if (openaiBody.stream !== undefined) {
    result.stream = Boolean(openaiBody.stream)
  }

  return result
}

export function anthropicToOpenAiResponse(anthropicRes, modelId) {
  const id = `chatcmpl-${anthropicRes.id || Math.random().toString(36).slice(2)}`
  const model = modelId || anthropicRes.model || 'GLM-5.3-Flash'
  const created = Math.floor(Date.now() / 1000)

  let textContent = ''
  let reasoningContent = ''
  const toolCalls = []

  if (Array.isArray(anthropicRes.content)) {
    for (const block of anthropicRes.content) {
      if (block.type === 'text') {
        textContent += block.text || ''
      } else if (block.type === 'thinking') {
        reasoningContent += block.thinking || ''
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id || `call_${Math.random().toString(36).slice(2)}`,
          type: 'function',
          function: {
            name: block.name || '',
            arguments: JSON.stringify(block.input || {}),
          },
        })
      }
    }
  }

  let finishReason = 'stop'
  if (anthropicRes.stop_reason === 'tool_use') {
    finishReason = 'tool_calls'
  } else if (anthropicRes.stop_reason === 'max_tokens') {
    finishReason = 'length'
  }

  const message = {
    role: 'assistant',
    content: textContent || null,
  }

  if (reasoningContent) {
    message.reasoning_content = reasoningContent
  }

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls
  }

  const promptTokens = anthropicRes.usage?.input_tokens ?? 0
  const completionTokens = anthropicRes.usage?.output_tokens ?? 0

  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }
}

export class AnthropicToOpenAiStreamTransformer {
  constructor(options = {}) {
    this.model = options.model || 'GLM-5.3-Flash'
    this.chatId = options.id || `chatcmpl-${Math.random().toString(36).slice(2)}`
    this.created = Math.floor(Date.now() / 1000)
    this.currentToolIndex = -1
    this.hasSentRole = false
  }

  formatChunk(delta, finishReason = null, usage = null) {
    const chunk = {
      id: this.chatId,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason,
        },
      ],
    }
    if (usage) {
      chunk.usage = usage
    }
    return `data: ${JSON.stringify(chunk)}\n\n`
  }

  transformEvent(event) {
    const lines = []
    if (!event || typeof event !== 'object') return lines

    switch (event.type) {
      case 'message_start': {
        if (event.message?.id) {
          this.chatId = `chatcmpl-${event.message.id}`
        }
        if (event.message?.model) {
          this.model = event.message.model
        }
        if (!this.hasSentRole) {
          lines.push(this.formatChunk({ role: 'assistant', content: '' }))
          this.hasSentRole = true
        }
        break
      }

      case 'content_block_start': {
        const block = event.content_block
        if (block?.type === 'tool_use') {
          this.currentToolIndex += 1
          lines.push(
            this.formatChunk({
              tool_calls: [
                {
                  index: this.currentToolIndex,
                  id: block.id || '',
                  type: 'function',
                  function: {
                    name: block.name || '',
                    arguments: '',
                  },
                },
              ],
            })
          )
        }
        break
      }

      case 'content_block_delta': {
        const delta = event.delta
        if (delta?.type === 'thinking_delta') {
          lines.push(this.formatChunk({ reasoning_content: delta.thinking || '' }))
        } else if (delta?.type === 'text_delta') {
          lines.push(this.formatChunk({ content: delta.text || '' }))
        } else if (delta?.type === 'input_json_delta') {
          lines.push(
            this.formatChunk({
              tool_calls: [
                {
                  index: this.currentToolIndex,
                  function: {
                    arguments: delta.partial_json || '',
                  },
                },
              ],
            })
          )
        }
        break
      }

      case 'message_delta': {
        let finishReason = 'stop'
        if (event.delta?.stop_reason === 'tool_use') {
          finishReason = 'tool_calls'
        } else if (event.delta?.stop_reason === 'max_tokens') {
          finishReason = 'length'
        }
        lines.push(this.formatChunk({}, finishReason))
        break
      }

      case 'message_stop': {
        lines.push('data: [DONE]\n\n')
        break
      }

      default:
        break
    }

    return lines
  }
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0
    const chunks = []
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error('Request body exceeds size limit'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(text ? JSON.parse(text) : {})
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, statusCode, data) {
  const payload = JSON.stringify(data)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  })
  res.end(payload)
}

function sendError(res, statusCode, message, type = 'invalid_request_error') {
  sendJson(res, statusCode, {
    error: {
      message,
      type,
      code: statusCode,
    },
  })
}

export function createZCodeProxyHandler(options = {}) {
  const fetchFn = options.fetchFn || fetch
  const timeoutMs = options.timeoutMs || 180000

  return async (req, res, subPath = '') => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      })
      res.end()
      return true
    }

    const url = new URL(req.url, 'http://127.0.0.1')
    const pathname = (subPath || url.pathname).replace(/\/+$/, '')

    if (pathname === '/status' || pathname === '/health' || pathname === '' || pathname === '/zcode') {
      const creds = options.mockCredentials || loadZCodeCredentials(options)
      sendJson(res, 200, {
        ok: true,
        service: 'zcode-proxy',
        provider: creds?.activeProvider || 'bigmodel',
        credentialsReady: Boolean(creds?.apiKey),
        keyMasked: creds?.apiKey ? `${creds.apiKey.slice(0, 8)}...${creds.apiKey.slice(-6)}` : null,
        upstream: creds?.activeProvider === 'zai' ? DEFAULT_ZAI_UPSTREAM : DEFAULT_BIGMODEL_UPSTREAM,
        models: listSupportedGlmModels().map((m) => m.id),
      })
      return true
    }

    if (pathname === '/v1/models' || pathname.endsWith('/models')) {
      sendJson(res, 200, {
        object: 'list',
        data: listSupportedGlmModels().map((m) => ({ id: m.id, object: 'model', owned_by: 'zcode-bigmodel' })),
      })
      return true
    }

    if (pathname === '/v1/chat/completions' || pathname.endsWith('/chat/completions')) {
      if (req.method !== 'POST') {
        sendError(res, 405, 'Only POST method is allowed', 'method_not_allowed')
        return true
      }

      let body = {}
      try {
        body = await readBody(req)
      } catch (err) {
        sendError(res, 400, err.message)
        return true
      }

      const authHeader = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim()
      const creds = options.mockCredentials || loadZCodeCredentials(options)
      const apiKey = authHeader && authHeader.startsWith('467e') ? authHeader : creds?.apiKey

      if (!apiKey) {
        sendError(
          res,
          401,
          'No ZCode credentials found. Ensure ZCode is logged in (~/.zcode/v2/credentials.json).',
          'authentication_error'
        )
        return true
      }

      const upstreamUrl = options.upstreamUrl
        || (creds?.activeProvider === 'zai' ? DEFAULT_ZAI_UPSTREAM : DEFAULT_BIGMODEL_UPSTREAM)

      let anthropicReq = {}
      try {
        anthropicReq = openaiToAnthropic(body)
      } catch (err) {
        sendError(res, 400, `Failed to convert OpenAI request: ${err.message}`)
        return true
      }

      const isStream = Boolean(body.stream)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const upstream = await fetchFn(upstreamUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'user-agent': 'ZCode/3.12.1',
            'x-zcode-app-version': '3.12.1',
          },
          body: JSON.stringify(anthropicReq),
          signal: controller.signal,
        })

        if (!upstream.ok) {
          const errText = await upstream.text().catch(() => '')
          sendError(res, upstream.status, `Upstream ZCode error: ${errText || upstream.statusText}`, 'upstream_error')
          return true
        }

        if (isStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          })

          const transformer = new AnthropicToOpenAiStreamTransformer({
            model: anthropicReq.model,
          })

          const reader = upstream.body?.getReader ? upstream.body.getReader() : null
          if (!reader) {
            const data = await upstream.json()
            const converted = anthropicToOpenAiResponse(data, anthropicReq.model)
            res.write(`data: ${JSON.stringify(converted)}\n\n`)
            res.write('data: [DONE]\n\n')
            res.end()
            return true
          }

          const decoder = new TextDecoder()
          let buffer = ''

          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })
              const lines = buffer.split('\n')
              buffer = lines.pop() || ''

              for (const line of lines) {
                const trimmed = line.trim()
                if (trimmed.startsWith('data: ')) {
                  const rawData = trimmed.slice(6).trim()
                  if (!rawData || rawData === '[DONE]') continue
                  try {
                    const event = JSON.parse(rawData)
                    const outLines = transformer.transformEvent(event)
                    for (const outLine of outLines) {
                      res.write(outLine)
                    }
                  } catch {
                    /* ignore JSON parse error in SSE chunk */
                  }
                }
              }
            }
          } finally {
            res.end()
          }
          return true
        }

        const anthropicRes = await upstream.json()
        const openAiRes = anthropicToOpenAiResponse(anthropicRes, anthropicReq.model)
        sendJson(res, 200, openAiRes)
        return true
      } catch (err) {
        if (err.name === 'AbortError') {
          sendError(res, 504, 'Upstream ZCode request timeout', 'gateway_timeout')
          return true
        }
        sendError(res, 502, `Failed to communicate with ZCode upstream: ${err.message}`, 'upstream_error')
        return true
      } finally {
        clearTimeout(timer)
      }
    }

    return false
  }
}

export async function startZCodeStandaloneServer(options = {}) {
  const host = options.host || '127.0.0.1'
  const port = typeof options.port === 'number' ? options.port : DEFAULT_ZCODE_PORT
  const handler = createZCodeProxyHandler(options)
  const server = createServer((req, res) => handler(req, res))

  await new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, host, () => resolve())
  })

  const addr = server.address()
  const actualPort = typeof addr === 'object' && addr?.port ? addr.port : port

  return {
    server,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
