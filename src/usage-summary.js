/**
 * 用量聚合（纯函数，便于单测）。
 *
 * 输入是管理面 /usage-queue 的记录数组，每条形如：
 *   { timestamp, latency_ms, source, auth_index, failed, provider, model, alias,
 *     tokens: { input_tokens, output_tokens, reasoning_tokens, cached_tokens, total_tokens } }
 * 输出总量与按模型的排行，供面板直接渲染。
 */

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

function emptyBucket() {
  return {
    requests: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    latencySum: 0,
    latencyCount: 0,
  }
}

function accumulate(bucket, record) {
  bucket.requests += 1
  if (record?.failed) bucket.failed += 1
  const t = record?.tokens ?? {}
  bucket.inputTokens += num(t.input_tokens)
  bucket.outputTokens += num(t.output_tokens)
  bucket.reasoningTokens += num(t.reasoning_tokens)
  bucket.cachedTokens += num(t.cached_tokens)
  bucket.totalTokens += num(t.total_tokens)
  const latency = num(record?.latency_ms)
  if (latency > 0) {
    bucket.latencySum += latency
    bucket.latencyCount += 1
  }
  return bucket
}

const finish = (bucket) => ({
  requests: bucket.requests,
  failed: bucket.failed,
  success: bucket.requests - bucket.failed,
  inputTokens: bucket.inputTokens,
  outputTokens: bucket.outputTokens,
  reasoningTokens: bucket.reasoningTokens,
  cachedTokens: bucket.cachedTokens,
  totalTokens: bucket.totalTokens,
  avgLatencyMs: bucket.latencyCount ? Math.round(bucket.latencySum / bucket.latencyCount) : null,
})

export function summarizeUsage(records) {
  const list = Array.isArray(records) ? records : []
  const total = emptyBucket()
  const perModel = new Map()
  const perAccount = new Map()

  for (const record of list) {
    accumulate(total, record)
    const modelKey = record?.model ?? record?.alias ?? '未知模型'
    if (!perModel.has(modelKey)) perModel.set(modelKey, emptyBucket())
    accumulate(perModel.get(modelKey), record)

    const accountKey = record?.source ?? record?.auth_index ?? null
    if (accountKey) {
      if (!perAccount.has(accountKey)) perAccount.set(accountKey, emptyBucket())
      accumulate(perAccount.get(accountKey), record)
    }
  }

  const sortByTokens = (a, b) => b.totalTokens - a.totalTokens
  return {
    records: list.length,
    total: finish(total),
    byModel: [...perModel.entries()]
      .map(([model, bucket]) => ({ model, ...finish(bucket) }))
      .sort(sortByTokens),
    byAccount: [...perAccount.entries()]
      .map(([account, bucket]) => ({ account, ...finish(bucket) }))
      .sort(sortByTokens),
  }
}
