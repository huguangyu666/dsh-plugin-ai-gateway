/**
 * 账号额度与双 Bucket (5小时滚动 + 7天周额度) 获取服务 —— 高性能优化版。
 *
 * 支持：
 * 1. Google Antigravity 账号：
 *    - 5h 滚动额度 + 7 天周额度 + 恢复倒计时
 *    - 套餐层级 (Google AI Pro / 免费版)
 *    - Project ID
 * 2. OpenAI Codex 账号：
 *    - 官方 WHAM 接口实时调用 (https://chatgpt.com/backend-api/wham/usage)
 *    - 5h 滚动额度 + 7 天周额度 + 恢复倒计时
 *    - Banked Rate-Limit Reset Credits 额度重置券可用次数与一键兑换消耗
 *    - 订阅有效期天数与精确到期时间
 *    - Team Name（组织归属 / 个人账户）与用户 ID
 * 3. 性能加速：
 *    - SWR (Stale-While-Revalidate) 毫秒级瞬时直出 (0~1ms)
 *    - 后台异步刷新与定期预热循环
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export function formatResetCountdown(resetTimeStr) {
  if (!resetTimeStr) return null
  const resetDate = new Date(resetTimeStr)
  const diffMs = resetDate.getTime() - Date.now()
  if (diffMs <= 0) return '已重置'
  const diffMinutes = Math.floor(diffMs / 60000)
  const days = Math.floor(diffMinutes / (60 * 24))
  const hours = Math.floor((diffMinutes % (60 * 24)) / 60)
  const mins = diffMinutes % 60

  const parts = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0 || days > 0) parts.push(`${hours}h`)
  parts.push(`${mins}m`)
  const countdown = parts.join(' ')

  const mm = String(resetDate.getMonth() + 1).padStart(2, '0')
  const dd = String(resetDate.getDate()).padStart(2, '0')
  const hh = String(resetDate.getHours()).padStart(2, '0')
  const min = String(resetDate.getMinutes()).padStart(2, '0')
  const timeStr = `${mm}/${dd} ${hh}:${min}`

  return `${countdown} (${timeStr})`
}

export function formatResetSeconds(secs) {
  if (typeof secs !== 'number' || secs <= 0) return '已重置'
  const mins = Math.floor(secs / 60)
  const days = Math.floor(mins / (60 * 24))
  const hours = Math.floor((mins % (60 * 24)) / 60)
  const m = mins % 60
  const parts = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0 || days > 0) parts.push(`${hours}h`)
  parts.push(`${m}m`)
  const now = new Date(Date.now() + secs * 1000)
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const min = String(now.getMinutes()).padStart(2, '0')
  return `${parts.join(' ')} (${mm}/${dd} ${hh}:${min})`
}

export function formatExpiry(isoStr) {
  if (!isoStr) return null
  const target = new Date(isoStr)
  const diffDays = Math.max(0, Math.ceil((target.getTime() - Date.now()) / 86400000))
  const yyyy = target.getFullYear()
  const mm = String(target.getMonth() + 1).padStart(2, '0')
  const dd = String(target.getDate()).padStart(2, '0')
  const hh = String(target.getHours()).padStart(2, '0')
  const min = String(target.getMinutes()).padStart(2, '0')
  return {
    days: diffDays,
    dateStr: `${yyyy}-${mm}-${dd} ${hh}:${min}`,
    summary: `${diffDays}天  ${yyyy}-${mm}-${dd} ${hh}:${min}`,
  }
}

// 长期记忆各账号的套餐级别（如 Google AI Pro / 免费版），避免每次额度查询重复打卡
const tierCache = new Map()

async function fetchTierInBackground(token, cacheKey) {
  if (!token || tierCache.has(cacheKey)) return
  try {
    const res = await fetch('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'antigravity/1.1.26',
      },
      body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) {
      const d = await res.json()
      const tierName = d.paidTier?.name || d.currentTier?.name
      if (tierName) {
        tierCache.set(cacheKey, tierName)
      }
    }
  } catch {
    // 静默降级
  }
}

export async function fetchSingleAccountQuota(filePath) {
  let data = null
  try {
    data = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
  const token = data?.access_token
  const fileName = filePath.split(/[\\/]/).pop() || ''
  if (!token) {
    return {
      email: data?.email || '未知账号',
      fileName,
      error: '凭据文件中未包含 access_token',
    }
  }

  // 区分账号类型：Codex (OpenAI OAuth) 还是 Antigravity (Google OAuth)
  const isCodex = fileName.toLowerCase().includes('codex')
    || data?.provider === 'codex'
    || Boolean(data?.chatgpt_account_id)
    || Boolean(data?.account_id && !data?.project_id)

  if (isCodex) {
    let claims = {}
    if (typeof data.id_token === 'string') {
      try {
        const parts = data.id_token.split('.')
        claims = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'))
      } catch {
        /* ignore */
      }
    }
    const auth = claims['https://api.openai.com/auth'] || {}
    const accountId = auth.chatgpt_account_id || data.account_id
    const orgTitle = auth.organizations?.[0]?.title
    const teamName = orgTitle === 'Personal' ? '个人账户' : (orgTitle || '个人账户')
    const tier = (auth.chatgpt_plan_type || data.plan_type || 'PLUS').toUpperCase()
    const expiry = formatExpiry(auth.chatgpt_subscription_active_until)

    let h5 = null
    let weekly = null
    let resetCredits = 0
    let codexError = null

    try {
      const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
        headers: {
          Authorization: `Bearer ${token}`,
          'ChatGPT-Account-ID': accountId,
          'User-Agent': 'codex_cli_rs/0.144.0',
        },
        signal: AbortSignal.timeout(6000),
      })
      if (res.ok) {
        const usage = await res.json()
        const rl = usage.rate_limit || {}
        if (rl.primary_window) {
          h5 = {
            percent: Math.max(0, 100 - (rl.primary_window.used_percent ?? 0)),
            countdown: formatResetSeconds(rl.primary_window.reset_after_seconds),
            resetAfterSeconds: rl.primary_window.reset_after_seconds,
          }
        }
        if (rl.secondary_window) {
          weekly = {
            percent: Math.max(0, 100 - (rl.secondary_window.used_percent ?? 0)),
            countdown: formatResetSeconds(rl.secondary_window.reset_after_seconds),
            resetAfterSeconds: rl.secondary_window.reset_after_seconds,
          }
        }
        resetCredits = usage.rate_limit_reset_credits?.available_count ?? 0
      } else {
        codexError = `HTTP ${res.status}`
      }
    } catch (err) {
      codexError = err instanceof Error ? err.message : String(err)
    }

    return {
      email: data.email || 'Codex 账号',
      fileName,
      provider: 'codex',
      tier,
      teamName,
      userId: auth.chatgpt_user_id || data.account_id,
      subscriptionExpiry: expiry?.summary || null,
      resetCredits,
      codex: {
        h5: h5 || { percent: 100, countdown: '—' },
        weekly: weekly || { percent: 100, countdown: '—' },
      },
      error: codexError,
      updatedAt: new Date().toISOString(),
    }
  }

  const cacheKey = data.email || fileName
  if (!tierCache.has(cacheKey)) {
    // 首次在后台轻量探测套餐名，不阻塞当前的额度查询
    void fetchTierInBackground(token, cacheKey)
  }

  let summary = null
  let summaryError = null
  try {
    const res = await fetch('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'antigravity/1.1.26',
      },
      body: '{}',
      signal: AbortSignal.timeout(6500),
    })
    if (res.ok) {
      summary = await res.json()
    } else {
      summaryError = `HTTP ${res.status}`
    }
  } catch (err) {
    summaryError = err instanceof Error ? err.message : String(err)
  }

  const tier = tierCache.get(cacheKey) || 'Google AI Pro'

  const gemini = { h5: null, weekly: null }
  const claude = { h5: null, weekly: null }

  for (const g of summary?.groups || []) {
    const isGemini = /gemini/i.test(g.displayName || '')
    const isClaude = /claude|3p|gpt/i.test(g.displayName || '')
    for (const b of g.buckets || []) {
      const frac = typeof b.remainingFraction === 'number' ? b.remainingFraction : null
      const pct = frac !== null ? Math.round(frac * 100) : null
      const item = {
        fraction: frac,
        percent: pct,
        resetTime: b.resetTime,
        countdown: formatResetCountdown(b.resetTime),
        desc: b.description,
      }
      const is5h = /5h/i.test(b.window || '') || /5-hour|five hour/i.test(b.displayName || '')
      const isWeekly = /week/i.test(b.window || '') || /weekly/i.test(b.displayName || '')

      if (isGemini) {
        if (is5h) gemini.h5 = item
        else if (isWeekly) gemini.weekly = item
      } else if (isClaude) {
        if (is5h) claude.h5 = item
        else if (isWeekly) claude.weekly = item
      }
    }
  }

  return {
    email: data.email || '未知账号',
    fileName,
    projectId: data.project_id || null,
    provider: 'antigravity',
    tier,
    gemini,
    claude,
    error: summaryError,
    updatedAt: new Date().toISOString(),
  }
}

/**
 * 兑换/消耗 Codex 账号的 Banked Rate-Limit Reset 额度券
 */
export async function consumeCodexResetCredit(authDir, fileName) {
  const filePath = join(authDir, fileName)
  if (!existsSync(filePath)) {
    return { ok: false, error: '账号文件不存在' }
  }
  let data = null
  try {
    data = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return { ok: false, error: '账号文件无法解析' }
  }
  const token = data?.access_token
  if (!token) return { ok: false, error: '未找到 access_token' }

  let claims = {}
  if (typeof data.id_token === 'string') {
    try {
      const parts = data.id_token.split('.')
      claims = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'))
    } catch {
      /* ignore */
    }
  }
  const accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id || data.account_id

  // 1. 查询可用的额度券
  const listRes = await fetch('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits', {
    headers: {
      Authorization: `Bearer ${token}`,
      'ChatGPT-Account-ID': accountId,
      'User-Agent': 'codex_cli_rs/0.144.0',
    },
    signal: AbortSignal.timeout(8000),
  })
  if (!listRes.ok) {
    return { ok: false, error: `查询重置额度失败: HTTP ${listRes.status}` }
  }
  const creditsData = await listRes.json()
  const available = (creditsData.credits || []).filter((c) => c.status === 'available')
  if (available.length === 0) {
    return { ok: false, error: '当前账号可用重置额度券为 0 次' }
  }

  const creditId = available[0].id
  const redeemRequestId = randomUUID()

  // 2. 消耗额度券
  const consumeRes = await fetch('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'ChatGPT-Account-ID': accountId,
      'Content-Type': 'application/json',
      'User-Agent': 'codex_cli_rs/0.144.0',
    },
    body: JSON.stringify({
      credit_id: creditId,
      redeem_request_id: redeemRequestId,
    }),
    signal: AbortSignal.timeout(10000),
  })

  if (!consumeRes.ok) {
    return { ok: false, error: `重置额度兑换失败: HTTP ${consumeRes.status}` }
  }
  const result = await consumeRes.json()

  // 使缓存失效
  cacheMap.delete(fileName)
  return { ok: true, result }
}

// 内存缓存字典
const cacheMap = new Map()
const CACHE_FRESH_MS = 25000 // 25s 内视作新鲜
const CACHE_MAX_STALE_MS = 120000 // 2 分钟内可作为 SWR 旧数据立刻返回

// ---------------------------------------------------------------------------
// 实测限流信号（Rate-Limit Signal）
//
// 为什么需要它：官方 `retrieveUserQuotaSummary` 是异步批处理账本，存在明显滞后。
// 实测复现过「面板显示 100%，但请求立刻 429 QUOTA_EXHAUSTED」——账本没跟上消耗。
// 而真实 429 报文里带有权威的 `quotaResetTimeStamp`，比滞后账本可信得多。
// 因此捕获 429 后立刻覆盖对应桶为 0%，并在 reset 时刻自动失效。
//
// 归属说明：429 报文不携带账号身份，无法定位到具体账号；故按池级信号处理，
// 覆盖该 provider 下全部账号。单账号场景下这等价于精确归属。
// ---------------------------------------------------------------------------
const rateLimitSignals = new Map() // key('*' | `email:xxx`) -> { group, bucket, resetAt, model, at }

/** 从 429 报文里提取权威的重置时刻与模型名。 */
export function parseQuotaExhausted(message) {
  const msg = String(message || '')
  if (!/429|QUOTA_EXHAUSTED|RESOURCE_EXHAUSTED/i.test(msg)) return null
  const ts = msg.match(/"quotaResetTimeStamp"\s*:\s*"([^"]+)"/)
  if (!ts) return null
  const model = msg.match(/"model"\s*:\s*"([^"]+)"/)
  const resetAt = Date.parse(ts[1])
  if (!Number.isFinite(resetAt)) return null
  return { resetTimeIso: ts[1], model: model ? model[1] : '' }
}

/**
 * 记录一次实测限流：把权威 reset 时刻写成池级信号，直到该时刻自动失效。
 * @returns {{group: string, bucket: string, resetAt: number, hoursAway: number} | null}
 */
export function recordRateLimitSignal({ model, resetTimeIso, email } = {}) {
  const resetAt = Date.parse(String(resetTimeIso || ''))
  if (!Number.isFinite(resetAt)) return null
  const hoursAway = (resetAt - Date.now()) / 3_600_000
  // 5 小时桶的重置必然落在 5 小时内；周桶重置在数天之后，据此判定归属。
  const bucket = hoursAway <= 6 ? 'h5' : 'weekly'
  const group = /claude|gpt|opus|sonnet|3p/i.test(String(model || '')) ? 'claude' : 'gemini'
  const key = email ? `email:${String(email).toLowerCase()}` : '*'
  rateLimitSignals.set(key, { group, bucket, resetAt, model: String(model || ''), at: Date.now() })
  return { group, bucket, resetAt, hoursAway }
}

/** 当前活跃的池级限流信号（过期即自动清理）。 */
export function activeRateLimitSignals() {
  const now = Date.now()
  for (const [key, sig] of rateLimitSignals) {
    if (now >= sig.resetAt) rateLimitSignals.delete(key)
  }
  return [...rateLimitSignals.values()]
}

/**
 * 把实测信号叠加到官方账本结果上：信号存在时以 0% 覆盖对应桶。
 * 不修改缓存本身，只在读取路径上生效，因此刷新面板即可立刻看到真实状态。
 */
function applySignals(data) {
  if (!data || data.provider !== 'antigravity') return data
  const emailKey = data.email ? `email:${String(data.email).toLowerCase()}` : null
  const sig = (emailKey && rateLimitSignals.get(emailKey)) || rateLimitSignals.get('*')
  if (!sig) return data
  if (Date.now() >= sig.resetAt) {
    rateLimitSignals.delete(emailKey || '*')
    return data
  }
  const resetIso = new Date(sig.resetAt).toISOString()
  const bucket = {
    fraction: 0,
    percent: 0,
    resetTime: resetIso,
    countdown: formatResetCountdown(resetIso),
    desc: `实测已达上限（${sig.model || '未知模型'}）；官方账本尚未同步`,
    source: 'rate-limit-signal',
  }
  return {
    ...data,
    [sig.group]: { ...data[sig.group], [sig.bucket]: bucket },
    rateLimitSignal: {
      group: sig.group,
      bucket: sig.bucket,
      resetAt: resetIso,
      model: sig.model,
      poolLevel: true,
    },
  }
}

export async function fetchAllAccountsQuota(authDir, forceFresh = false) {
  if (!existsSync(authDir)) return []
  const files = readdirSync(authDir).filter((f) => f.toLowerCase().endsWith('.json'))

  const now = Date.now()

  // 1. 如果不是强刷，且所有文件都有新鲜缓存，直接 0ms 返回！
  if (!forceFresh) {
    const allFresh = files.every((f) => {
      const c = cacheMap.get(f)
      return c && now - c.timestamp < CACHE_FRESH_MS
    })
    if (allFresh && files.length > 0) {
      return files.map((f) => applySignals(cacheMap.get(f).data)).filter(Boolean)
    }

    // 2. SWR (Stale-While-Revalidate): 如果有陈旧缓存，先直接把旧缓存返回给前端，后台异步拉最新数据！
    const hasAnyStale = files.some((f) => {
      const c = cacheMap.get(f)
      return c && now - c.timestamp < CACHE_MAX_STALE_MS
    })
    if (hasAnyStale) {
      // 启动后台异步拉取
      void (async () => {
        await Promise.all(
          files.map(async (fileName) => {
            const data = await fetchSingleAccountQuota(join(authDir, fileName))
            if (data) cacheMap.set(fileName, { timestamp: Date.now(), data })
          })
        )
      })()
      // 立刻返回现有内存缓存
      return files.map((f) => applySignals(cacheMap.get(f)?.data)).filter(Boolean)
    }
  }

  // 3. 首次加载或用户显式点「🔄 刷新额度」：并行请求所有账号，并写入缓存
  const results = await Promise.all(
    files.map(async (fileName) => {
      const filePath = join(authDir, fileName)
      const data = await fetchSingleAccountQuota(filePath)
      if (data) {
        cacheMap.set(fileName, { timestamp: Date.now(), data })
      }
      return data
    })
  )

  return results.map((data) => applySignals(data)).filter(Boolean)
}
