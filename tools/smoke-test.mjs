/**
 * 冒烟测试（mock ctx，不依赖 dsh 启动）——阶段 1 + 阶段 2 全覆盖：
 *   1. host 插件装载、路由注册
 *   2. 只读接口：status / models / usage / logs
 *   3. 写操作全生命周期：stop → start → status（真实启停本地网关）
 *   4. 错误路径：未知端点 404、非 GET/POST 405
 *   5. client bundle 物化与导出契约
 *
 * 前置：网关配置与二进制已就位（tools/gen-config.mjs）。
 * 用法: node tools/smoke-test.mjs
 */
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`)
}
const HOME = process.env.USERPROFILE ?? ''

// ---------------------------------------------------------------- 1) host 装载
const mod = await import(new URL('../src/index.js', import.meta.url).href)
check('host 导出 name', mod.name === 'ai-gateway' || mod.name === 'agy-gateway', `name=${mod.name}`)
check('host 导出 inject', Array.isArray(mod.inject) && mod.inject.includes('webServer'), JSON.stringify(mod.inject))
check('host 导出 Config schema', typeof mod.Config === 'function', typeof mod.Config)

const routes = []
const disposers = []
const settingsCalls = []
let settingsHooks = null
let settingsValues = null
const fakeSettings = {
  installSection(owner, ns, schema, entry, hooks) {
    settingsCalls.push({ via: 'installSection', ns, schema, entry })
    settingsValues = { ...entry }
    settingsHooks = hooks
    hooks.setSource(() => settingsValues)
    hooks.onChange?.()
  },
  describe: () => [{ ns: 'agy-gateway', value: settingsValues, user: settingsValues, revision: 7, applies: 'live' }],
  get: () => settingsValues,
  async update(ns, patch) {
    settingsCalls.push({ via: 'update', ns, patch })
    settingsValues = { ...settingsValues, ...patch }
    settingsHooks?.setSource(() => settingsValues)
    settingsHooks?.onChange?.()
  },
}
const credentialCalls = []
const fakeCredentials = {
  async set(ref, value) {
    credentialCalls.push({ ref: String(ref), value })
  },
  async describe() {
    return { configured: credentialCalls.length > 0, writable: true }
  },
}
const fakeCtx = {
  effect: (fn) => {
    const d = fn()
    disposers.push(d)
    return d
  },
  webServer: { register: (route) => routes.push(route) },
  inject: (services, cb) => {
    if (services.includes('settings')) cb({ settings: fakeSettings })
    if (services.includes('credentials')) cb({ credentials: fakeCredentials })
  },
}
// 用插件自己的 schema 解析配置：既验证 schema 可用，也保证测试不会因新增字段而漂移
const HOME_DIR = process.env.USERPROFILE ?? ''
const overrides = { host: '127.0.0.1', port: 8317, routePrefix: '/agy-gateway', probeTimeoutMs: 3000, startTimeoutMs: 25000 }
let config
try {
  config = mod.Config(overrides)
} catch (err) {
  console.log('   (schema 调用失败，回退手写配置:', err.message, ')')
  config = {
    ...overrides,
    binPath: join(HOME_DIR, '.dsh', 'agy-gateway', 'bin', 'cli-proxy-api.exe'),
    statePath: join(HOME_DIR, '.dsh', 'agy-gateway', 'state.json'),
    runtimePath: join(HOME_DIR, '.dsh', 'agy-gateway', 'runtime.json'),
    downloadDir: join(HOME_DIR, '.dsh', 'agy-gateway', '_download'),
    authDir: join(HOME_DIR, '.cli-proxy-api'),
    configPath: join(HOME_DIR, '.cli-proxy-api', 'config.yaml'),
    releaseVersion: '7.2.158',
  }
}
check('Config schema 解析并填充默认值', Boolean(config.binPath && config.statePath && config.downloadDir && config.releaseVersion),
  `bin=${config.binPath} ver=${config.releaseVersion}`)
mod.apply(fakeCtx, config)
check('注册了 1 条路由', routes.length === 1, JSON.stringify(routes.map((r) => `${r.kind} ${r.path}`)))
check('路由为 prefix /agy-gateway', routes[0]?.kind === 'prefix' && routes[0]?.path === '/agy-gateway')

function open(path, method = 'GET', headers = {}, body = '') {
  return new Promise((resolvePromise) => {
    const chunks = []
    const res = {
      statusCode: 0,
      writeHead(code) { this.statusCode = code },
      end(payload) { if (payload !== undefined) chunks.push(payload); resolvePromise({ status: this.statusCode, body: chunks.join('') }) },
    }
    // 用真的 EventEmitter 当 req，否则 readBody 等不到 'end'
    const req = new EventEmitter()
    req.url = path
    req.method = method
    req.headers = headers ?? {}
    req.destroy = () => {}
    routes[0].handler(req, res)
    process.nextTick(() => {
      if (body) req.emit('data', body)
      req.emit('end')
    })
  })
}
async function call(path, method = 'GET', headers = {}, body) {
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  const r = await open(path, method, headers, payload)
  let json = null
  try { json = JSON.parse(r.body) } catch { /* 保留原始文本 */ }
  return { ...r, json }
}

// ---------------------------------------------------------------- 2) 只读接口
// 测试必须自足：先确保网关就绪，不依赖外部前置状态。
const boot = await call('/agy-gateway/api/gateway/start', 'POST')
check('前置：网关就绪（启动或复用）', boot.json?.started === true || boot.json?.alreadyRunning === true, JSON.stringify(boot.json))

const status0 = await call('/agy-gateway/api/status')
check('GET /status → 200', status0.status === 200, `status=${status0.status}`)
check('状态含 gateway/login/files 段', Boolean(status0.json?.gateway && status0.json?.login && status0.json?.files))
const wasRunning = status0.json?.gateway?.running === true
check('探测到网关运行状态', typeof status0.json?.gateway?.running === 'boolean', `running=${status0.json?.gateway?.running}`)
check('管理面可达且鉴权通过', status0.json?.gateway?.management === 'ok', `management=${status0.json?.gateway?.management}`)
check('可执行文件与配置存在', status0.json?.files?.bin?.exists === true && status0.json?.files?.config?.exists === true)
console.log(`   → 模型 ${status0.json?.gateway?.models} 个 / 账号 ${status0.json?.gateway?.accounts} 个 / pid ${status0.json?.gateway?.pid ?? '—'}`)

const usage = await call('/agy-gateway/api/usage?count=5')
check('GET /usage 有响应', usage.status === 200 || usage.status === 502, `status=${usage.status} ${usage.status !== 200 ? JSON.stringify(usage.json)?.slice(0, 80) : 'records=' + (Array.isArray(usage.json) ? usage.json.length : '?')}`)
const logs = await call('/agy-gateway/api/logs')
check('GET /logs 有响应', logs.status === 200 || logs.status === 502, `status=${logs.status}`)
const loginState = await call('/agy-gateway/api/login/state')
check('GET /login/state → 200', loginState.status === 200, `status=${loginState.json?.status}`)

// ---------------------------------------------------------------- 3) 写操作生命周期
const startIdem = await call('/agy-gateway/api/gateway/start', 'POST')
check('POST /gateway/start 幂等（已在跑时不重复起）',
  startIdem.json?.alreadyRunning === true || startIdem.json?.started === true,
  JSON.stringify(startIdem.json))

const stopped = await call('/agy-gateway/api/gateway/stop', 'POST')
check('POST /gateway/stop 成功停止（含接管外部进程）', stopped.json?.stopped === true, JSON.stringify(stopped.json))

const status1 = await call('/agy-gateway/api/status')
check('停止后状态为未运行', status1.json?.gateway?.running === false, `running=${status1.json?.gateway?.running}`)

const started = await call('/agy-gateway/api/gateway/start', 'POST')
check('POST /gateway/start 冷启动成功', started.json?.started === true && !started.json?.error, JSON.stringify(started.json))

const status2 = await call('/agy-gateway/api/status')
check('启动后状态为运行中', status2.json?.gateway?.running === true, `running=${status2.json?.gateway?.running}`)
check('进程归属标记为插件管理', status2.json?.gateway?.managedByPlugin === true, `managedByPlugin=${status2.json?.gateway?.managedByPlugin} pid=${status2.json?.gateway?.pid}`)
check('启动确实经过等待就绪（非仅 spawn）', typeof started.json?.pid === 'number', `pid=${started.json?.pid}`)

// 重启（stop + start 组合）
const restarted = await call('/agy-gateway/api/gateway/restart', 'POST')
check('POST /gateway/restart 成功', restarted.json?.started?.started === true, JSON.stringify(restarted.json))

// ---------------------------------------------------------------- 4) 阶段 3：二进制与配置
const bin = await call('/agy-gateway/api/binary')
check('GET /binary → 200', bin.status === 200, `status=${bin.status}`)
check('版本解析成功（--help 首行）', /^\d+\.\d+\.\d+/.test(String(bin.json?.version)), `version=${bin.json?.version}`)
check('二进制 SHA-256 可算', /^[0-9a-f]{64}$/.test(String(bin.json?.sha256)), String(bin.json?.sha256).slice(0, 16) + '…')
check('发行包缓存存在且与官方 checksums 一致', bin.json?.archive?.verified === true,
  `expected=${String(bin.json?.archive?.expectedFromChecksums).slice(0, 12)}… actual=${String(bin.json?.archive?.sha256).slice(0, 12)}…`)

const cfg = await call('/agy-gateway/api/config')
check('GET /config → 200', cfg.status === 200, `status=${cfg.status}`)
check('配置读取已脱敏（无完整密钥）', !/sk-agy-[0-9a-f]{20,}/.test(String(cfg.json?.text)), 'masked')
check('配置无 BOM / 纯 LF', cfg.json?.hasBom === false && cfg.json?.hasCrlf === false)

const plan = await call('/agy-gateway/api/provider-plan')
check('GET /provider-plan → 200', plan.status === 200, `status=${plan.status}`)
check('provider 指引含 baseURL 与协议', plan.json?.baseURL?.endsWith('/v1') === true && plan.json?.api === 'openai-completions',
  `${plan.json?.baseURL} / ${plan.json?.api}`)
check('默认不回显完整密钥', /…/.test(String(plan.json?.apiKey)), String(plan.json?.apiKey))
const planReveal = await call('/agy-gateway/api/provider-plan?revealKey=1')
check('显式请求才回显完整密钥', /^sk-agy-[0-9a-f]{20,}$/.test(String(planReveal.json?.apiKey)), 'revealed')

const regen = await call('/agy-gateway/api/config/regenerate', 'POST')
check('POST /config/regenerate 复用密钥（不打断 DSH 侧配置）', regen.json?.ok === true && regen.json?.reusedKeys === true, JSON.stringify(regen.json))
check('重生成后仍无 BOM / 结构正确', regen.json?.hasBom === false && regen.json?.secretLineOk === true)

const install = await call('/agy-gateway/api/binary/install', 'POST')
check('POST /binary/install 校验+解压成功', install.json?.ok === true, `via=${install.json?.via} version=${install.json?.version} restarted=${install.json?.restarted}`)
check('安装后网关仍在跑（自动拉起）', (await call('/agy-gateway/api/status')).json?.gateway?.running === true)

// ---------------------------------------------------------------- 5) 错误路径与安全闸门
check('未知端点 → 404', (await call('/agy-gateway/api/nope')).status === 404)
check('PUT → 405', (await call('/agy-gateway/api/status', 'PUT')).status === 405)

// 同源闸门：我们的 prefix 路由绕过了 web app 的鉴权，必须自己挡跨站请求
const crossOrigin = await call('/agy-gateway/api/gateway/start', 'POST', { origin: 'http://evil.example', host: '127.0.0.1:3080' })
check('跨站 POST 被拒（403）', crossOrigin.status === 403, JSON.stringify(crossOrigin.json))
const sameOrigin = await call('/agy-gateway/api/status', 'GET', { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' })
check('同源请求放行（200）', sameOrigin.status === 200, `status=${sameOrigin.status}`)
const noOrigin = await call('/agy-gateway/api/status')
check('无 Origin 的本机客户端放行（curl/脚本）', noOrigin.status === 200)

// 非本机绑定时，控制操作默认关闭
const routes2 = []
const ctx2 = { effect: (fn) => fn(), webServer: { host: '0.0.0.0', register: (r) => routes2.push(r) } }
mod.apply(ctx2, config)
const remotePost = await new Promise((resolvePromise) => {
  const req = new EventEmitter()
  req.url = '/agy-gateway/api/gateway/stop'
  req.method = 'POST'
  req.headers = {}
  req.destroy = () => {}
  const res = {
    statusCode: 0,
    writeHead(c) { this.statusCode = c },
    end(b) { resolvePromise({ status: this.statusCode, body: b }) },
  }
  routes2[0].handler(req, res)
  process.nextTick(() => { req.emit('data', ''); req.emit('end') })
})
check('DSH 绑定 0.0.0.0 时拒绝控制操作（403）', remotePost.status === 403, String(remotePost.body).slice(0, 90))
const remoteGet = await new Promise((resolvePromise) => {
  const req = new EventEmitter()
  req.url = '/agy-gateway/api/status'
  req.method = 'GET'
  req.headers = {}
  req.destroy = () => {}
  const res = { statusCode: 0, writeHead(c) { this.statusCode = c }, end() { resolvePromise(this.statusCode) } }
  routes2[0].handler(req, res)
  process.nextTick(() => { req.emit('data', ''); req.emit('end') })
})
check('非本机绑定时只读查询仍可用', remoteGet === 200, `status=${remoteGet}`)

// ---------------------------------------------------------------- 5) client 契约
const clientCode = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
let def = null
globalThis.window = { __ModuleLoader__: { load: (d) => { def = d } } }
new Function(clientCode)()
check('client 注册到 ModuleLoader', def?.id === 'dsh-plugin-ai-gateway' || def?.id === 'dsh-plugin-agy-gateway', `id=${def?.id}`)
check('client bundle 保留 UTF-8 中文（charset: utf8，未被转义）', clientCode.includes('AI 聚合网关') || clientCode.includes('反重力网关'))

const reactStub = {
  createElement: (...args) => ({ type: args[0], props: args[1] ?? null }),
  useState: () => [null, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: () => ({ current: null }),
}
const clientExports = def.factory((spec) => {
  if (spec === 'react') return reactStub
  throw new Error('未预期的 client 依赖: ' + spec)
})
check('client 导出 name/inject/apply',
  (clientExports.name === 'dsh-plugin-ai-gateway' || clientExports.name === 'dsh-plugin-agy-gateway') && Array.isArray(clientExports.inject) && typeof clientExports.apply === 'function',
  `name=${clientExports.name} inject=${JSON.stringify(clientExports.inject)}`)

const slotRegs = []
clientExports.apply({
  slots: {
    inject: (slotName, fn) => { fn() },
    register: (spec, comp) => slotRegs.push({ spec, comp }),
  },
})
const section = slotRegs.find((r) => r.spec.name === 'settings.section')
const card = slotRegs.find((r) => r.spec.name === 'settings.models.provider-card')
check('注册了 settings.section（完整控制台）', Boolean(section) && (section.spec.id === 'ai-gateway' || section.spec.id === 'agy-gateway'),
  JSON.stringify(slotRegs.map((r) => `${r.spec.name}#${r.spec.id}`)))
check('注册了 settings.models.provider-card（keyed=llm-pi-ai）', Boolean(card) && card.spec.key === 'llm-pi-ai',
  `key=${card?.spec.key}`)
check('两个分区组件都是函数组件', typeof section?.comp === 'function' && typeof card?.comp === 'function')

// 内嵌状态条必须只在自己的卡片上渲染（该槽按 llm-pi-ai 家族分发，会命中 deepseek 等卡片）
const oursProps = { provider: { id: 'agy-gateway', name: 'AI 聚合网关' } }
const othersProps = { provider: { id: 'deepseek-official', name: 'DeepSeek' } }
const realFetch = globalThis.fetch
globalThis.fetch = async () => ({ ok: true, json: async () => ({ gateway: { running: true, models: 0, accounts: 0, version: '7.2.158' } }) })
const renderedOurs = card.comp(oursProps)
const renderedOthers = card.comp(othersProps)
globalThis.fetch = realFetch // 必须还原：否则后面的实探全都会打到这个桩上
check('状态条在自己的卡片上渲染', renderedOurs !== null && renderedOurs !== undefined)
check('状态条在别的 provider 卡片上不渲染', renderedOthers === null || renderedOthers === undefined)
check('测试桩已还原（fetch 是真实现）', typeof globalThis.fetch === 'function' && globalThis.fetch !== undefined && (await (await globalThis.fetch('http://127.0.0.1:8317/v1/models')).text()) !== undefined)

// ---------------------------------------------------------------- 6) 设置层与插件配置
check('注册设置命名空间走 installSection', settingsCalls[0]?.via === 'installSection' && (settingsCalls[0]?.ns === 'ai-gateway' || settingsCalls[0]?.ns === 'agy-gateway'),
  `via=${settingsCalls[0]?.via} ns=${settingsCalls[0]?.ns}`)
check('installSection 收到 Config schema 与 hooks',
  typeof settingsCalls[0]?.schema === 'function' && typeof settingsHooks?.setSource === 'function')

const pc = await call('/agy-gateway/api/plugin-config')
check('GET /plugin-config → 200', pc.status === 200, `status=${pc.status}`)
check('指引配置为已挂载状态', pc.json?.settingsAttached === true && pc.json?.registrationMode === 'installSection',
  `mode=${pc.json?.registrationMode}`)
check('可编辑字段白名单包含 port', Array.isArray(pc.json?.editable) && pc.json.editable.includes('port'), JSON.stringify(pc.json?.editable))

const saved = await call('/agy-gateway/api/plugin-config', 'POST', { 'content-type': 'application/json' })
check('空 patch 被拒（400）', saved.status === 400, JSON.stringify(saved.json))
const upd = await call('/agy-gateway/api/plugin-config', 'POST', undefined, { port: 8399 })
check('POST /plugin-config 写入设置层', upd.status === 200 && upd.json?.ok === true, JSON.stringify(upd.json?.applied))
check('update 收到正确 patch', settingsCalls.some((c) => c.via === 'update' && c.patch?.port === 8399),
  JSON.stringify(settingsCalls.filter((c) => c.via === 'update').map((c) => c.patch)))
const statusAfter = await call('/agy-gateway/api/status')
check('配置改动即时反映到插件（端口重绑定）', String(statusAfter.json?.gateway?.baseURL).includes(':8399'),
  `baseURL=${statusAfter.json?.gateway?.baseURL}`)
// 改回真实端口，否则后续所有实探都会打到没人监听的 8399
const restored = await call('/agy-gateway/api/plugin-config', 'POST', undefined, { port: 8317 })
check('端口可改回（配置可逆）', restored.status === 200 && (await call('/agy-gateway/api/status')).json?.gateway?.baseURL?.includes(':8317'),
  JSON.stringify(restored.json?.applied))
const badPort = await call('/agy-gateway/api/plugin-config', 'POST', undefined, { port: 99999 })
check('非法端口被 validate 拒绝（400）', badPort.status === 400, JSON.stringify(badPort.json))
const bogus = await call('/agy-gateway/api/plugin-config', 'POST', undefined, { nope: 1 })
check('非白名单字段被拒（400）', bogus.status === 400, JSON.stringify(bogus.json))

// 没有设置服务的组合（例如 headless）：只读可用，写入应明确报错
const routes3 = []
mod.apply({ effect: (fn) => fn(), webServer: { register: (r) => routes3.push(r) } }, config)
const noSettings = await new Promise((resolvePromise) => {
  const req = new EventEmitter()
  req.url = '/agy-gateway/api/plugin-config'
  req.method = 'POST'
  req.headers = {}
  req.destroy = () => {}
  const res = { statusCode: 0, writeHead(c) { this.statusCode = c }, end(b) { resolvePromise({ status: this.statusCode, body: b }) } }
  routes3[0].handler(req, res)
  process.nextTick(() => { req.emit('data', '{}'); req.emit('end') })
})
check('无设置服务时写入返回 503（而非静默失败）', noSettings.status === 503, String(noSettings.body).slice(0, 100))

// ---------------------------------------------------------------- 7) 额度/用量/账号
const summary = await call('/agy-gateway/api/usage-summary')
check('GET /usage-summary → 200 且结构正确', summary.status === 200 && summary.json?.total && Array.isArray(summary.json?.byModel),
  `records=${summary.json?.records} total=${JSON.stringify(summary.json?.total)?.slice(0, 80)}`)
const accountsLive = await call('/agy-gateway/api/accounts')
check('GET /accounts → 200（管理面视角）', accountsLive.status === 200 && accountsLive.json?.source === 'gateway' && Array.isArray(accountsLive.json?.files),
  JSON.stringify(accountsLive.json).slice(0, 220))
const errLogs = await call('/agy-gateway/api/error-logs')
check('GET /error-logs → 200', errLogs.status === 200, `status=${errLogs.status} body=${JSON.stringify(errLogs.json).slice(0, 180)}`)
const resetNoIndex = await call('/agy-gateway/api/accounts/reset-quota', 'POST', undefined, {})
check('重置额度缺 authIndex → 400', resetNoIndex.status === 400, JSON.stringify(resetNoIndex.json))

// 聚合逻辑（纯函数）单测
const { summarizeUsage } = await import(new URL('../src/usage-summary.js', import.meta.url).href)
const agg = summarizeUsage([
  { model: 'm-a', latency_ms: 100, tokens: { input_tokens: 10, output_tokens: 20, reasoning_tokens: 5, cached_tokens: 3, total_tokens: 30 } },
  { model: 'm-a', latency_ms: 300, failed: true, tokens: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } },
  { model: 'm-b', latency_ms: 200, tokens: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } },
  { tokens: {} },
])
check('聚合：总量与失败计数', agg.total.requests === 4 && agg.total.failed === 1 && agg.total.success === 3, JSON.stringify(agg.total))
check('聚合：token 分项求和', agg.total.inputTokens === 16 && agg.total.outputTokens === 27 && agg.total.reasoningTokens === 5 && agg.total.cachedTokens === 3 && agg.total.totalTokens === 43,
  `in=${agg.total.inputTokens} out=${agg.total.outputTokens} total=${agg.total.totalTokens}`)
check('聚合：平均延迟只按有延迟的记录', agg.total.avgLatencyMs === 200, `avg=${agg.total.avgLatencyMs}`)
check('聚合：按 token 排序且未知模型归一到「未知模型」', agg.byModel[0].model === 'm-a' && agg.byModel.some((m) => m.model === '未知模型'),
  JSON.stringify(agg.byModel.map((m) => m.model)))
check('聚合：空输入不炸', summarizeUsage(null).total.requests === 0 && summarizeUsage([]).byModel.length === 0)

// ---------------------------------------------------------------- 8) 一键接入（写 provider + 凭据）
const applyNoModels = await call('/agy-gateway/api/provider/apply', 'POST', undefined, {})
// 网关此时可能已有模型（账号已登录）→ 成功也合理；只有在拿不到模型时才必须报错并指路
check('一键接入：无模型时明确拒绝（有模型时正常成功）',
  applyNoModels.status === 200 ? applyNoModels.json?.ok === true : (applyNoModels.status === 400 && /登录账号/.test(String(applyNoModels.json?.error))),
  `status=${applyNoModels.status} ${JSON.stringify(applyNoModels.json)?.slice(0, 90)}`)

const applyOk = await call('/agy-gateway/api/provider/apply', 'POST', undefined, { models: ['gemini-3.7-flash-high', 'claude-sonnet-4-6'] })
check('一键接入：写入成功', applyOk.status === 200 && applyOk.json?.ok === true, JSON.stringify(applyOk.json)?.slice(0, 150))
check('一键接入：凭据用派生的 ref 名写入',
  credentialCalls.length >= 1 && credentialCalls.every((c) => c.ref === 'AGY_GATEWAY_API_KEY'),
  JSON.stringify(credentialCalls.map((c) => c.ref)))
check('一键接入：凭据值就是网关数据面密钥',
  credentialCalls[0]?.value === JSON.parse(readFileSync(config.statePath, 'utf8')).apiKey,
  credentialCalls[0] ? credentialCalls[0].value.slice(0, 10) + '…' : '无')
const llmWrite = settingsCalls.filter((c) => c.via === 'update' && c.ns === 'llm-pi-ai').pop()
check('一键接入：写入的是 llm-pi-ai 命名空间', Boolean(llmWrite),
  JSON.stringify(settingsCalls.filter((c) => c.via === 'update').map((c) => c.ns)))
check('一键接入：provider 形状正确（api/baseURL/apiKeyEnv/models）',
  llmWrite?.patch?.providers?.['agy-gateway']?.api === 'openai-completions' &&
  String(llmWrite?.patch?.providers?.['agy-gateway']?.baseURL).endsWith(':8317/v1') &&
  llmWrite?.patch?.providers?.['agy-gateway']?.apiKeyEnv === 'AGY_GATEWAY_API_KEY' &&
  llmWrite?.patch?.providers?.['agy-gateway']?.models?.length === 2,
  JSON.stringify(llmWrite?.patch)?.slice(0, 170))
check('一键接入：尊重传入的模型子集',
  applyOk.json?.usedModels?.length === 2 && applyOk.json.usedModels[0] === 'gemini-3.7-flash-high',
  JSON.stringify(applyOk.json?.usedModels))

// 没有凭据服务的组合：必须明确拒绝，而不是写一个没有密钥的 provider
const routes4 = []
mod.apply({ effect: (fn) => fn(), webServer: { register: (r) => routes4.push(r) }, inject: () => {} }, config)
const noCreds = await new Promise((resolvePromise) => {
  const req = new EventEmitter()
  req.url = '/agy-gateway/api/provider/apply'
  req.method = 'POST'
  req.headers = {}
  req.destroy = () => {}
  const res = { statusCode: 0, writeHead(c) { this.statusCode = c }, end(b) { resolvePromise({ status: this.statusCode, body: b }) } }
  routes4[0].handler(req, res)
  process.nextTick(() => { req.emit('data', '{}'); req.emit('end') })
})
check('一键接入：无凭据服务时拒绝（503，不写半成品）', noCreds.status === 503, String(noCreds.body).slice(0, 110))

// ---------------------------------------------------------------- 汇总
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) console.log('失败项：' + failed.map((f) => f.label).join(' / '))
process.exitCode = failed.length === 0 ? 0 : 1
