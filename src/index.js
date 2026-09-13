/**
 * dsh-plugin-agy-gateway — host 端
 *
 * 阶段 1（只读）：状态探测、模型清单、账号统计。
 * 阶段 2（写操作）：网关启停、OAuth 登录、额度与日志读取。
 *
 * 设计分工：模型那一列与协议翻译归 DSH 原生（llm-pi-ai + 自定义 provider）；
 * 本插件只做「网关的管家」——进程、登录、额度、日志、配置。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import Schema from '@deepseek-ai/schemastery'
import { defaultPaths, inspectTextFile, writeHardenedConfig, resolveProxyUrlSync, syncProxyUrlInConfigFile } from './config-writer.js'
import { summarizeUsage } from './usage-summary.js'
import { fetchAllAccountsQuota, consumeCodexResetCredit } from './quota-service.js'

export const name = 'ai-gateway'

/** 需要 webServer 提供路由席位；其余服务均为可选。 */
export const inject = ['webServer']

const HOME = homedir()
const IS_WIN = process.platform === 'win32'
const PATHS = defaultPaths(HOME, process.platform)

export const Config = Schema.object({
  host: Schema.string().default('127.0.0.1').description('网关监听地址（加固默认：仅本机）'),
  port: Schema.number().default(PATHS.port).description('网关端口'),
  binPath: Schema.string().default(PATHS.binPath).description('cli-proxy-api 可执行文件路径'),
  statePath: Schema.string().default(PATHS.statePath).description('状态文件（含数据面与管理面密钥）'),
  runtimePath: Schema.string().default(PATHS.runtimePath).description('插件自己记录的运行状态（pid 等）'),
  authDir: Schema.string().default(PATHS.authDir).description('网关凭据目录（auth-dir）'),
  configPath: Schema.string().default(PATHS.configPath).description('网关配置文件'),
  downloadDir: Schema.string().default(PATHS.downloadDir).description('发行包缓存目录'),
  releaseVersion: Schema.string().default('7.2.158').description('要安装的 CLIProxyAPI 版本'),
  routePrefix: Schema.string().default('/ai-gateway').description('面板接口挂载前缀'),
  dshProviderId: Schema.string().default('agy-gateway').description('接入 DSH 时使用的 provider 路由 id（永久，改了要重接一次）'),
  dshProviderApi: Schema.union(['openai-completions', 'openai-responses'])
    .default('openai-completions')
    .description('接入 DSH 时使用的协议'),
  allowRemoteControl: Schema.boolean()
    .default(false)
    .description('DSH 绑定到非本机地址时，是否仍允许启停/登录等控制操作（默认拒绝）'),
  autoStart: Schema.boolean()
    .default(true)
    .description('插件加载时自动拉起网关，并在它意外退出后自动恢复（面板手动停止后不再自动拉起）'),
  watchdogIntervalMs: Schema.number().default(60000).description('看门狗检查间隔（毫秒）'),
  proxyUrl: Schema.string()
    .default('auto')
    .description('出海代理地址（auto 自动对齐系统代理/Clash/v2rayN，可手动填写如 http://127.0.0.1:7890，填 direct 为直连/TUN）'),
  probeTimeoutMs: Schema.number().default(3000).description('单次探测超时'),
  startTimeoutMs: Schema.number().default(20000).description('等待网关进入就绪的最长时间'),
})

// ---------------------------------------------------------------- 基础读取

function readJSON(path) {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function fileInfo(path) {
  try {
    if (!existsSync(path)) return { path, exists: false }
    const st = statSync(path)
    return { path, exists: true, size: st.size, mtime: st.mtime.toISOString() }
  } catch {
    return { path, exists: false }
  }
}

/** auth-dir 里除配置/面板之外的 JSON 文件即账号凭据。 */
function listAccounts(authDir) {
  try {
    if (!existsSync(authDir)) return []
    return readdirSync(authDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'))
      .map((e) => {
        const full = join(authDir, e.name)
        const st = statSync(full)
        let email = null
        try {
          const parsed = JSON.parse(readFileSync(full, 'utf8'))
          email = parsed.email ?? parsed.account ?? null
        } catch {
          /* 内容不可解析也不影响计数 */
        }
        return { name: e.name, email, size: st.size, mtime: st.mtime.toISOString() }
      })
  } catch {
    return []
  }
}

async function probeJSON(url, headers, timeoutMs) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    const text = await res.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      body = text.slice(0, 400)
    }
    return { ok: res.ok, status: res.status, body }
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const LOOPBACK_HOSTS = new Set(['', '127.0.0.1', 'localhost', '::1', '[::1]'])
const isLoopbackHost = (h) => LOOPBACK_HOSTS.has(String(h ?? '').trim().toLowerCase())

/**
 * 同源判定：浏览器跨站请求一定带 Origin，非浏览器客户端（curl / 插件自身）通常不带。
 * 只拒绝「带了 Origin 且与 Host 不符」的请求 —— 挡掉跨站 CSRF，不误伤本机工具。
 */
function isSameOrigin(req) {
  const origin = req?.headers?.origin
  if (!origin) return true
  const host = req?.headers?.host
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** 跑一条命令并收集输出（用于查端口占用者/进程名）。 */
function execCapture(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let out = ''
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true })
    } catch {
      resolve('')
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      resolve(out)
    }, timeoutMs)
    child.stdout?.on('data', (d) => (out += d))
    child.stderr?.on('data', (d) => (out += d))
    child.on('error', () => {
      clearTimeout(timer)
      resolve('')
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(out)
    })
  })
}

/** 找出监听某端口的进程 pid（停止按钮「接管」外部启动的网关时用）。 */
async function findPortOwnerPid(port) {
  if (!IS_WIN) {
    const out = await execCapture('sh', ['-c', `lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null | head -1`])
    const pid = Number(out.trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  }
  const out = await execCapture('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
  ])
  const pid = Number(out.trim())
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/** 取进程名，用于杀死前确认目标确实是 cli-proxy-api（防误杀）。 */
async function processNameOf(pid) {
  if (!IS_WIN) return (await execCapture('ps', ['-p', String(pid), '-o', 'comm='])).trim()
  const out = await execCapture('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
  const m = out.match(/^"([^"]+)"/m)
  return m ? m[1] : ''
}

// ------------------------------------------------------- 二进制与配置（阶段 3）

/** 文件 SHA-256（按 mtime+size 缓存，避免每次探测都重算 67 MB）。 */
const hashCache = new Map()
function sha256OfFile(path) {
  try {
    const st = statSync(path)
    const key = `${st.size}:${st.mtimeMs}`
    const hit = hashCache.get(path)
    if (hit && hit.key === key) return hit.value
    const value = createHash('sha256').update(readFileSync(path)).digest('hex')
    hashCache.set(path, { key, value })
    return value
  } catch {
    return null
  }
}

/** 解析官方 checksums.txt，取出指定文件名的期望哈希。 */
function expectedHashFrom(checksumsPath, assetName) {
  try {
    const line = readFileSync(checksumsPath, 'utf8')
      .split('\n')
      .find((l) => l.trim().endsWith(assetName))
    return line ? line.trim().split(/\s+/)[0].toLowerCase() : null
  } catch {
    return null
  }
}

/** 二进制版本：`--help` 的首行带 Version（该 CLI 没有 --version 标志）。 */
async function detectVersion(binPath) {
  const out = await execCapture(binPath, ['--help'], 8000)
  const m = out.match(/Version:\s*([0-9][\w.\-]*)/)
  return m ? m[1] : null
}

const ASSET_NAME = (version) => `CLIProxyAPI_${version}_windows_amd64.zip`

/** 版本探测带缓存（按二进制 mtime 失效），避免每次状态轮询都 spawn 一次。 */
let versionCache = { key: '', value: null }
async function versionOf(binPath) {
  const st = existsSync(binPath) ? statSync(binPath) : null
  const key = st ? `${st.size}:${st.mtimeMs}` : ''
  if (versionCache.key === key) return versionCache.value
  const value = st ? await detectVersion(binPath) : null
  versionCache = { key, value }
  return value
}

/** 解压发行包到 bin 目录（Windows 自带 bsdtar / PowerShell 兜底）。 */
async function extractZip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true })
  const tar = await execCapture('tar', ['-xf', zipPath, '-C', destDir], 120000)
  if (existsSync(join(destDir, basename(zipPath).replace(/\.zip$/i, ''))) || readdirSync(destDir).some((f) => f.endsWith('.exe'))) {
    return { ok: true, via: 'tar', output: tar.trim().slice(0, 200) }
  }
  const ps = await execCapture(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`],
    120000,
  )
  const ok = readdirSync(destDir).some((f) => f.endsWith('.exe'))
  return { ok, via: 'Expand-Archive', output: ps.trim().slice(0, 200) }
}

// ---------------------------------------------------------------- 插件本体

/** 设置命名空间（与客户端面板共用；用户层覆盖 composition 层）。 */
export const SETTINGS_NS = 'ai-gateway'
export const LEGACY_SETTINGS_NS = 'agy-gateway'

/** DSH 里模型 provider 所在的命名空间（由 dsh-llm-pi-ai 拥有，我们只按官方模型页的写法写它）。 */
const LLM_NAMESPACE = 'llm-pi-ai'

/** 可由界面编辑的字段白名单（routePrefix 改动需要重启，故只读）。 */
const EDITABLE_FIELDS = ['port', 'releaseVersion', 'allowRemoteControl', 'autoStart', 'proxyUrl', 'probeTimeoutMs', 'startTimeoutMs', 'binPath', 'configPath', 'statePath', 'authDir', 'downloadDir']

// Gemini 上游（Vertex thinking_level）没有 xhigh 档，CLIProxyAPI 会原样透传并被 400 拒绝：
// 选择器里保留 Xhigh 档但发送值一律钳到 high；没配档位表的 gemini 模型补一份安全默认。
const GEMINI_SAFE_EFFORTS = { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high' }
function sanitizeEfforts(model) {
  if (!/^gemini/i.test(String(model?.id ?? ''))) return model
  const efforts = model?.reasoningEfforts
  if (efforts && typeof efforts === 'object' && !Array.isArray(efforts)) {
    const next = { ...efforts }
    for (const [pick, wire] of Object.entries(next)) {
      if (String(wire).toLowerCase() === 'xhigh') next[pick] = 'high'
    }
    return { ...model, reasoningEfforts: next }
  }
  return { ...model, reasoningEfforts: { ...GEMINI_SAFE_EFFORTS } }
}

/** 跨字段校验：schema 表达不了的约束在这里拒绝写入（而不是等下次使用才炸）。 */
function validateResolvedConfig(value) {
  const port = Number(value?.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port 必须是 1..65535 的整数')
  for (const key of ['binPath', 'configPath', 'statePath', 'authDir', 'downloadDir']) {
    if (typeof value?.[key] !== 'string' || value[key].trim() === '') throw new Error(`${key} 不能为空`)
  }
  if (typeof value?.releaseVersion !== 'string' || !/^[0-9][\w.\-]*$/.test(value.releaseVersion)) {
    throw new Error('releaseVersion 格式应为类似 7.2.158 的版本号')
  }
  if (value?.proxyUrl !== undefined && typeof value.proxyUrl !== 'string') {
    throw new Error('proxyUrl 必须为字符串')
  }
}

export function apply(ctx, initialConfig) {
  // 用 let + 重绑定：设置层挂上后 setSource 会把权威值换过来，所有闭包自动跟随。
  let config = initialConfig
  let settingsHandle = null
  let settingsService = null
  /** 设置服务：优先用 inject 回调里拿到的那个，退回 ctx.settings（不同 cordis 版本挂载方式略有差异）。 */
  const settingsOf = () => settingsService ?? ctx.settings ?? null
  let credentialsService = null
  const credentialsOf = () => credentialsService ?? ctx.credentials ?? null

  const prefix = (config.routePrefix ?? '/agy-gateway').replace(/\/+$/, '')
  const downloadDirOf = () => config.downloadDir ?? PATHS.downloadDir
  const releaseVersionOf = () => config.releaseVersion ?? '7.2.158'
  const base = () => `http://${config.host}:${config.port}`

  // 设置层：把配置交给 dsh 的设置命名空间，用户层可覆盖 composition 层（GUI 才能改配置）。
  // 全程 feature detection：installSection 优先，退回 register，服务缺失就静默降级。
  ctx.inject?.(['settings'], (settingsCtx) => {
    const settings = settingsCtx?.settings ?? ctx.settings
    if (!settings) return
    settingsService = settings
    try {
      if (typeof settings.installSection === 'function') {
        settings.installSection(ctx, SETTINGS_NS, Config, initialConfig, {
          validate: validateResolvedConfig,
          setSource: (current) => { config = current() },
          onChange: () => { versionCache = { key: '', value: null } },
        })
        settingsHandle = 'installSection'
      } else if (typeof settings.register === 'function') {
        const scope = settings.register(SETTINGS_NS, Config, { base: initialConfig, validate: validateResolvedConfig })
        const watch = scope?.watch ?? scope?.onChange ?? scope?.subscribe
        if (typeof scope?.get === 'function') config = scope.get()
        if (typeof watch === 'function') watch.call(scope, (value) => { config = value })
        settingsHandle = 'register'
      }
    } catch (err) {
      settingsHandle = `failed: ${err instanceof Error ? err.message : String(err)}`
    }
  })

  // 凭据服务：单独 inject（不与 settings 绑在一起），这样缺凭据服务时设置层照样能用。
  ctx.inject?.(['credentials'], (credentialsCtx) => {
    const credentials = credentialsCtx?.credentials ?? ctx.credentials
    if (credentials) credentialsService = credentials
  })

  /**
   * 用户在面板上主动「停止网关」后，本进程内不再自动把它拉起来（尊重意图）；
   * 下次「启动网关」或 DSH 重启后恢复自动管理。
   */
  let userStopped = false

  /**
   * 自动拉起 + 看门狗。
   * 必要性：DSH 重启时插件会回收网关子进程（防孤儿），若不自动拉起，
   * 重启后模型请求会以 "Connection error" 失败，而用户并不知道要去点「启动网关」。
   * 判据：autoStart 为真、用户没手动停过、且当前探测不到网关。
   */
  async function ensureRunningQuietly(reason) {
    try {
      if (config.autoStart === false || userStopped) return
      if (await isReady()) return
      const r = await ensureRunning()
      if (r?.error) {
        ctx.logger?.warn?.(`[agy-gateway] 自动拉起失败（${reason}）：${r.error}`)
      } else if (r?.started) {
        ctx.logger?.info?.(`[agy-gateway] 已自动拉起网关（${reason}，pid ${r.pid}）`)
      }
    } catch (err) {
      ctx.logger?.warn?.(`[agy-gateway] 自动拉起异常（${reason}）：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 把网关数据面密钥存进 dsh 的凭据库，ref 名与 provider 路由对应（与模型页派生规则一致）。 */
  const credentialRefNameOf = () => String(config.dshProviderId ?? 'agy-gateway').toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY'

  /** credentialRef 只是校验+打品牌；动态引入，包缺失时退回原样字符串，不让插件加载失败。 */
  async function toCredentialRef(name) {
    try {
      const mod = await import('@deepseek-ai/dsh-credentials')
      if (typeof mod?.credentialRef === 'function') return mod.credentialRef(name)
    } catch {
      /* 退回字符串 */
    }
    return name
  }

  /** 拉取网关真实模型清单（用于写入 provider）。 */
  async function gatewayModelIds() {
    const st = readState()
    const r = await probeJSON(`${base()}/v1/models`, st?.apiKey ? { authorization: `Bearer ${st.apiKey}` } : {}, config.probeTimeoutMs)
    if (!r.ok || !Array.isArray(r.body?.data)) return null
    return r.body.data.map((m) => m?.id).filter(Boolean)
  }
  const mgmtHeaders = () => {
    const st = readState()
    return st?.managementKey ? { authorization: `Bearer ${st.managementKey}` } : {}
  }
  const readState = () => readJSON(config.statePath)

  /** 登录流程状态（内存态，进程重启后回到 idle）。 */
  const login = { status: 'idle', url: null, startedAt: null, finishedAt: null, message: null, accountsBefore: 0, child: null }

  /** 插件是否管理着该进程（由我们启动并记录了 pid）。 */
  const runtime = () => readJSON(config.runtimePath) ?? {}
  const writeRuntime = (value) => {
    try {
      mkdirSync(dirname(config.runtimePath), { recursive: true })
      writeFileSync(config.runtimePath, JSON.stringify(value, null, 2) + '\n', 'utf8')
    } catch {
      /* 记录失败不影响功能 */
    }
  }
  /** 没有在管的进程时删掉记录文件，别留空壳误导下一次启动。 */
  const clearRuntime = () => {
    try {
      if (existsSync(config.runtimePath)) unlinkSync(config.runtimePath)
    } catch {
      /* ignore */
    }
  }

  async function isReady() {
    const st = readState()
    const r = await probeJSON(`${base()}/v1/models`, st?.apiKey ? { authorization: `Bearer ${st.apiKey}` } : {}, config.probeTimeoutMs)
    return r.ok
  }

  async function ensureRunning() {
    if (await isReady()) {
      const rt = runtime()
      return { started: false, alreadyRunning: true, pid: pidAlive(rt.pid) ? rt.pid : null }
    }
    if (!existsSync(config.binPath)) {
      return { started: false, error: `可执行文件不存在：${config.binPath}` }
    }
    if (!existsSync(config.configPath)) {
      return { started: false, error: `配置文件不存在：${config.configPath}（可先用 tools/gen-config.mjs 生成）` }
    }
    try {
      syncProxyUrlInConfigFile(config.configPath, config.proxyUrl)
    } catch {
      /* ignore */
    }
    let child
    try {
      child = spawn(config.binPath, ['-config', config.configPath], {
        windowsHide: true,
        detached: false,
        stdio: 'ignore',
      })
    } catch (err) {
      // 非可执行文件 / 被安全软件拦截等：spawn 会同步抛（Windows 上是 "spawn UNKNOWN"），
      // 直接把它翻译成用户看得懂的话，别让面板只显示一句 UNKNOWN。
      return {
        started: false,
        error: `无法启动网关进程（${config.binPath}）：${err instanceof Error ? err.message : String(err)}；请确认它是可执行文件且未被安全软件拦截`,
      }
    }
    child.on('error', () => {})
    // 常驻守护进程：unref 让宿主（DSH / 测试脚本）不被它拖住事件循环；
    // 生命周期由 ctx.effect 的 disposer 负责回收。
    child.unref()
    if (child.pid === undefined) {
      clearRuntime()
      return { started: false, error: `无法启动网关进程（${config.binPath}）：系统未返回进程号，通常意味着该文件不可执行或被杀软拦截` }
    }
    writeRuntime({ pid: child.pid, startedAt: new Date().toISOString(), startedBy: 'plugin' })

    const deadline = Date.now() + config.startTimeoutMs
    while (Date.now() < deadline) {
      if (await isReady()) return { started: true, pid: child.pid }
      if (!pidAlive(child.pid)) {
        clearRuntime()
        return {
          started: false,
          error: `网关进程启动后立即退出（${config.binPath}）：请检查 config.yaml 是否合法、端口 ${config.port} 是否被占用`,
        }
      }
      await sleep(400)
    }
    return { started: true, pid: child.pid, warning: '进程已起，但未在超时内通过 /v1/models 就绪探测' }
  }

  async function stopGateway() {
    const rt = runtime()
    let pid = pidAlive(rt.pid) ? rt.pid : null
    const owned = Boolean(pid)
    let adopted = false
    if (!pid) {
      // 插件没记录 pid（例如网关是用户手工起的）→ 按端口找占用者，校验进程名后再停。
      pid = await findPortOwnerPid(config.port)
      if (pid) {
        const procName = await processNameOf(pid)
        if (!/cli-proxy-api/i.test(procName)) {
          return { stopped: false, error: `端口 ${config.port} 被 ${procName || '未知进程'}(pid ${pid}) 占用，且不是 cli-proxy-api，已放弃` }
        }
        adopted = true
      }
    }
    if (!pid) {
      clearRuntime()
      return { stopped: false, message: '没有发现运行中的网关' }
    }
    try {
      if (IS_WIN) {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        process.kill(pid, 'SIGTERM')
      }
    } catch (err) {
      return { stopped: false, error: err instanceof Error ? err.message : String(err) }
    }
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && pidAlive(pid)) await sleep(200)
    clearRuntime()
    return { stopped: !pidAlive(pid), pid, adoptedExternal: adopted, stillAlive: pidAlive(pid) }
  }

  function startLogin(targetProvider = 'antigravity') {
    const isCodex = targetProvider === 'codex'
    const loginFlag = isCodex ? '-codex-login' : '-antigravity-login'
    if (login.status === 'waiting' && login.child && pidAlive(login.child.pid)) {
      return { started: false, alreadyWaiting: true, url: login.url, provider: login.provider }
    }
    if (!existsSync(config.binPath)) return { started: false, error: `可执行文件不存在：${config.binPath}` }
    if (!existsSync(config.configPath)) return { started: false, error: `配置文件不存在：${config.configPath}（可先用 tools/gen-config.mjs 生成）` }
    const accountsBefore = listAccounts(config.authDir).length
    let child
    try {
      child = spawn(config.binPath, ['-config', config.configPath, loginFlag, '-no-browser'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      return {
        started: false,
        error: `无法启动登录进程（${config.binPath}）：${err instanceof Error ? err.message : String(err)}；请确认它是可执行文件且未被安全软件拦截`,
      }
    }
    Object.assign(login, {
      status: 'waiting',
      url: null,
      provider: isCodex ? 'codex' : 'antigravity',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      message: null,
      accountsBefore,
      child,
    })

    let buf = ''
    const onChunk = (chunk) => {
      buf += chunk.toString()
      const googleMatch = buf.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?[^\s"']+/)
      const openaiMatch = buf.match(/https:\/\/auth\.openai\.com\/oauth\/authorize\?[^\s"']+/)
      const targetUrl = isCodex ? (openaiMatch?.[0] || googleMatch?.[0]) : (googleMatch?.[0] || openaiMatch?.[0])
      if (targetUrl && !login.url) login.url = targetUrl
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    child.on('error', (err) => {
      login.status = 'failed'
      login.message = err instanceof Error ? err.message : String(err)
      login.finishedAt = new Date().toISOString()
    })
    child.on('exit', (code) => {
      const after = listAccounts(config.authDir).length
      login.child = null
      login.finishedAt = new Date().toISOString()
      if (after > accountsBefore) {
        login.status = 'success'
        login.message = `已成功新增 ${isCodex ? 'Codex (OpenAI)' : 'Antigravity (Google)'} 账号凭据`
      } else {
        login.status = code === 0 ? 'timeout' : 'failed'
        login.message = `未获得凭据（${isCodex ? 'Codex 端口 1455' : 'Antigravity 端口 51121'} 授权需在 5 分钟内完成）`
      }
    })
    return { started: true, accountsBefore, provider: login.provider }
  }

  // ---------------------------------------------------------------- 状态聚合

  async function collect() {
    const state = readState()
    const rt = runtime()
    const models = await probeJSON(
      `${base()}/v1/models`,
      state?.apiKey ? { authorization: `Bearer ${state.apiKey}` } : {},
      config.probeTimeoutMs,
    )
    const out = {
      generatedAt: new Date().toISOString(),
      gateway: {
        baseURL: `${base()}/v1`,
        managementURL: `${base()}/v0/management`,
        host: config.host,
        port: config.port,
        running: false,
        models: null,
        modelIds: [],
        accounts: 0,
        stateLoaded: state !== null,
        keysPresent: Boolean(state?.apiKey) && Boolean(state?.managementKey),
        managedByPlugin: pidAlive(rt.pid),
        pid: pidAlive(rt.pid) ? rt.pid : null,
        proxyUrl: resolveProxyUrlSync(config.proxyUrl) || '直连 / TUN',
        error: null,
      },
      login: {
        status: login.status,
        url: login.url,
        provider: login.provider || 'antigravity',
        startedAt: login.startedAt,
        finishedAt: login.finishedAt,
        message: login.message,
      },
      accounts: listAccounts(config.authDir),
      files: {
        bin: fileInfo(config.binPath),
        state: fileInfo(config.statePath),
        config: fileInfo(config.configPath),
        authDir: fileInfo(config.authDir),
      },
    }
    out.gateway.accounts = out.accounts.length

    if (models.ok && models.body && Array.isArray(models.body.data)) {
      out.gateway.running = true
      out.gateway.modelIds = models.body.data.map((m) => m?.id).filter(Boolean)
      out.gateway.models = out.gateway.modelIds.length
    } else if (models.status === 401 || models.status === 403) {
      out.gateway.running = true
      out.gateway.error = `数据面鉴权失败（HTTP ${models.status}）：state.json 的 apiKey 与网关配置不一致`
    } else {
      out.gateway.error = models.error ?? `数据面无响应（HTTP ${models.status}）`
    }

    const mgmt = await probeJSON(`${base()}/v0/management/config`, mgmtHeaders(), config.probeTimeoutMs)
    out.gateway.management = mgmt.ok ? 'ok' : mgmt.status === 401 ? 'unauthorized' : 'unreachable'
    out.gateway.version = await versionOf(config.binPath)
    return out
  }

  // ---------------------------------------------------------------- HTTP 路由

  const sendJSON = (res, code, body) => {
    const payload = JSON.stringify(body)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  }

  const readBody = (req) =>
    new Promise((resolve) => {
      let data = ''
      req.on?.('data', (c) => {
        data += c
        if (data.length > 64 * 1024) req.destroy?.()
      })
      req.on?.('end', () => resolve(data))
      req.on?.('error', () => resolve(''))
    })

  const handler = async (req, res) => {
    try {
      // 我们的 prefix 路由由 webserver 直接匹配，**不经过 web app 自己的鉴权闸门**，
      // 所以这里必须自己守：跨站请求一律拒绝；DSH 绑到非本机时默认关掉控制操作。
      if (!isSameOrigin(req)) {
        return sendJSON(res, 403, { error: 'cross-origin request rejected' })
      }
      const boundHost = ctx.webServer?.host ?? '127.0.0.1'
      const controlAllowed = config.allowRemoteControl === true || isLoopbackHost(boundHost)

      const url = new URL(req.url ?? '/', 'http://ai-gateway.local')
      const pathname = url.pathname
      const matchedPrefix = pathname.startsWith(prefix) ? prefix : (pathname.startsWith('/agy-gateway') ? '/agy-gateway' : '')
      const sub = (matchedPrefix ? pathname.slice(matchedPrefix.length) : pathname)
        .replace(/^\/api(?=\/|$)/, '')
        .replace(/\/+$/, '') || '/'
      const method = req.method ?? 'GET'

      // —— 只读 ——
      if (method === 'GET') {
        if (sub === '/' || sub === '/status') return sendJSON(res, 200, await collect())
        if (sub === '/models') {
          const st = readState()
          const r = await probeJSON(`${base()}/v1/models`, st?.apiKey ? { authorization: `Bearer ${st.apiKey}` } : {}, config.probeTimeoutMs)
          if (!r.ok) return sendJSON(res, r.status || 502, r.body ?? { error: r.error })
          return sendJSON(res, 200, r.body)
        }
        if (sub === '/usage') {
          const count = Math.min(Math.max(Number(url.searchParams.get('count') ?? 20) || 20, 1), 200)
          const r = await probeJSON(`${base()}/v0/management/usage-queue?count=${count}`, mgmtHeaders(), config.probeTimeoutMs)
          if (!r.ok) return sendJSON(res, r.status || 502, r.body ?? { error: r.error })
          return sendJSON(res, 200, r.body)
        }
        if (sub === '/usage-summary') {
          const count = Math.min(Math.max(Number(url.searchParams.get('count') ?? 200) || 200, 1), 500)
          const r = await probeJSON(`${base()}/v0/management/usage-queue?count=${count}`, mgmtHeaders(), config.probeTimeoutMs)
          if (!r.ok) return sendJSON(res, r.status || 502, r.body ?? { error: r.error })
          return sendJSON(res, 200, summarizeUsage(r.body))
        }
        if (sub === '/accounts') {
          const r = await probeJSON(`${base()}/v0/management/auth-files`, mgmtHeaders(), config.probeTimeoutMs)
          if (r.ok && r.body && Array.isArray(r.body.files)) {
            return sendJSON(res, 200, {
              source: 'gateway',
              files: r.body.files.map((f) => ({
                id: f.id ?? f.name ?? null,
                authIndex: f.auth_index ?? f.authIndex ?? null,
                name: f.name ?? null,
                provider: f.provider ?? null,
                label: f.label ?? null,
                email: f.email ?? null,
                status: f.status ?? null,
                statusMessage: f.status_message ?? null,
                disabled: Boolean(f.disabled),
                unavailable: Boolean(f.unavailable),
                runtimeOnly: Boolean(f.runtime_only),
                success: Number(f.success ?? 0),
                failed: Number(f.failed ?? 0),
                lastRefresh: f.last_refresh ?? null,
                createdAt: f.created_at ?? null,
                size: f.size ?? null,
              })),
            })
          }
          // 管理面不可用时退回文件系统视角（只有文件，没有运行时状态），并说明原因
          return sendJSON(res, 200, {
            source: 'filesystem',
            files: listAccounts(config.authDir),
            error: r.error ?? `管理面返回 HTTP ${r.status}${r.body && typeof r.body === 'object' && r.body.error ? '：' + r.body.error : ''}`,
          })
        }
        if (sub === '/error-logs') {
          const r = await probeJSON(`${base()}/v0/management/request-error-logs`, mgmtHeaders(), config.probeTimeoutMs)
          if (!r.ok) return sendJSON(res, r.status || 502, r.body ?? { error: r.error })
          return sendJSON(res, 200, r.body)
        }
        if (sub === '/logs') {
          const after = Number(url.searchParams.get('after') ?? 0) || 0
          const r = await probeJSON(`${base()}/v0/management/logs?after=${after}`, mgmtHeaders(), config.probeTimeoutMs)
          if (!r.ok) return sendJSON(res, r.status || 502, r.body ?? { error: r.error })
          return sendJSON(res, 200, r.body)
        }
        if (sub === '/login/state') return sendJSON(res, 200, { ...login, child: undefined })
        if (sub === '/quotas') {
          const fresh = url.searchParams.get('fresh') === '1'
          const list = await fetchAllAccountsQuota(config.authDir, fresh)
          return sendJSON(res, 200, { ok: true, accounts: list })
        }
        if (sub === '/binary') {
          const info = fileInfo(config.binPath)
          const zipName = ASSET_NAME(releaseVersionOf())
          const zipPath = join(downloadDirOf(), zipName)
          const checksumsPath = join(downloadDirOf(), 'checksums.txt')
          const expected = expectedHashFrom(checksumsPath, zipName)
          const archiveSha = existsSync(zipPath) ? sha256OfFile(zipPath) : null
          return sendJSON(res, 200, {
            bin: info,
            version: info.exists ? await detectVersion(config.binPath) : null,
            releaseVersion: releaseVersionOf(),
            sha256: info.exists ? sha256OfFile(config.binPath) : null,
            archive: {
              name: zipName,
              path: zipPath,
              exists: existsSync(zipPath),
              sha256: archiveSha,
              expectedFromChecksums: expected,
              verified: Boolean(expected && archiveSha === expected),
            },
          })
        }
        if (sub === '/config') {
          if (!existsSync(config.configPath)) return sendJSON(res, 404, { error: `配置文件不存在：${config.configPath}` })
          const masked = readFileSync(config.configPath, 'utf8')
            .replace(/(sk-agy-)[0-9a-f]+/g, '$1********')
            .replace(/(secret-key:\s*")[^"]+/g, '$1********')
          return sendJSON(res, 200, { path: config.configPath, text: masked, ...inspectTextFile(config.configPath) })
        }
        if (sub === '/plugin-config') {
          const settings = settingsOf()
          let descriptor = null
          try {
            descriptor = settings?.describe?.({ redactSecrets: false })?.find?.((d) => String(d.ns) === SETTINGS_NS) ?? null
          } catch {
            descriptor = null
          }
          return sendJSON(res, 200, {
            values: { ...config },
            editable: EDITABLE_FIELDS,
            readOnly: ['routePrefix'],
            settingsAttached: Boolean(settings) && settingsHandle !== null,
            registrationMode: settingsHandle,
            userOverrides: descriptor?.user ?? null,
            revision: descriptor?.revision ?? null,
            applies: descriptor?.applies ?? 'live',
          })
        }
        if (sub === '/provider-plan') {          const st = readState()
          const reveal = url.searchParams.get('revealKey') === '1'
          const r = await probeJSON(`${base()}/v1/models`, st?.apiKey ? { authorization: `Bearer ${st.apiKey}` } : {}, config.probeTimeoutMs)
          const ids = r.ok && Array.isArray(r.body?.data) ? r.body.data.map((m) => m?.id).filter(Boolean) : []
          return sendJSON(res, 200, {
            providerId: 'agy-gateway',
            displayName: '反重力网关',
            baseURL: `${base()}/v1`,
            api: 'openai-completions',
            alternativeApi: 'openai-responses',
            apiKey: st?.apiKey ? (reveal ? st.apiKey : st.apiKey.slice(0, 10) + '…' + st.apiKey.slice(-4)) : null,
            models: ids,
            ready: Boolean(st?.apiKey) && r.ok,
            steps: [
              '设置 → 模型 → 添加自定义提供方',
              `Provider ID 填 agy-gateway（永久，不可改），显示名随意`,
              `base URL 填 ${base()}/v1`,
              'API 协议选 openai-completions（或 openai-responses，端点均已验证存在）',
              'API 密钥粘贴本面板复制的值，再至少添加一个模型 id',
            ],
            notes: [
              '自定义 provider 默认按纯文本处理；视觉模型需在 settings.yaml 给该模型加 input: [text, image]',
              '模型列表可通过「获取可用模型」自动发现，也可手填；网关未启动时先启动再发现',
            ],
          })
        }
        return sendJSON(res, 404, { error: `unknown endpoint: ${sub}` })
      }

      // —— 写操作 ——
      if (method === 'POST') {
        if (!controlAllowed) {
          return sendJSON(res, 403, {
            error: `DSH 绑定在 ${boundHost}（非本机），已拒绝控制操作；确需远程控制请在插件配置里设 allowRemoteControl: true`,
          })
        }
        const raw = await readBody(req)
        const body = (() => {
          try {
            return raw ? JSON.parse(raw) : {}
          } catch {
            return {}
          }
        })()
        if (sub === '/gateway/start') {
          userStopped = false
          return sendJSON(res, 200, await ensureRunning())
        }
        if (sub === '/gateway/stop') {
          userStopped = true // 尊重用户意图：手动停掉后，看门狗不再自动拉起
          return sendJSON(res, 200, await stopGateway())
        }
        if (sub === '/gateway/restart') {
          userStopped = false
          const stopped = await stopGateway()
          const started = await ensureRunning()
          return sendJSON(res, 200, { stopped, started })
        }
        if (sub === '/login') return sendJSON(res, 200, startLogin(body?.provider))
        if (sub === '/codex/consume-reset-credit') {
          const fileName = String(body?.fileName ?? '').trim()
          if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\') || !fileName.endsWith('.json')) {
            return sendJSON(res, 400, { error: '无效的文件名' })
          }
          const resCredit = await consumeCodexResetCredit(config.authDir, fileName)
          if (!resCredit.ok) {
            return sendJSON(res, 400, { error: resCredit.error })
          }
          return sendJSON(res, 200, { ok: true, message: '成功消耗 1 次额度券，已满血重置！', result: resCredit.result })
        }
        if (sub === '/accounts/delete') {
          const fileName = String(body?.fileName ?? '').trim()
          if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\') || !fileName.endsWith('.json')) {
            return sendJSON(res, 400, { error: '无效的文件名' })
          }
          const targetPath = join(config.authDir, fileName)
          if (!existsSync(targetPath)) {
            return sendJSON(res, 404, { error: `指定账号文件不存在: ${fileName}` })
          }
          try {
            unlinkSync(targetPath)
            return sendJSON(res, 200, { ok: true, deleted: fileName })
          } catch (err) {
            return sendJSON(res, 500, { error: `删除失败: ${err.message}` })
          }
        }
        if (sub === '/plugin-config') {
          const settings = settingsOf()
          if (typeof settings?.update !== 'function') {
            return sendJSON(res, 503, {
              error: '设置服务未挂载或不可写：请在 profile 的 cordis.patch.yml 里改配置，或换用带设置服务的 profile',
            })
          }
          const patch = {}
          const rejected = []
          for (const [key, value] of Object.entries(body ?? {})) {
            if (!EDITABLE_FIELDS.includes(key)) {
              rejected.push(key)
              continue
            }
            patch[key] = ['port', 'probeTimeoutMs', 'startTimeoutMs'].includes(key) ? Number(value) : value
          }
          if (Object.keys(patch).length === 0) {
            return sendJSON(res, 400, { error: `没有可写字段（允许：${EDITABLE_FIELDS.join(', ')}）`, rejected })
          }
          try {
            validateResolvedConfig({ ...config, ...patch })
            await settings.update(SETTINGS_NS, patch)
          } catch (err) {
            return sendJSON(res, 400, { error: err instanceof Error ? err.message : String(err), rejected })
          }
          let resolved = config
          try {
            resolved = settings.get?.(SETTINGS_NS) ?? config
          } catch {
            resolved = config
          }
          return sendJSON(res, 200, { ok: true, applied: patch, rejected, values: { ...resolved }, note: '已写入用户设置层，端口/路径等即时生效' })
        }
        if (sub === '/accounts/reset-quota') {
          const authIndex = body?.authIndex ?? body?.auth_index
          if (typeof authIndex !== 'string' || authIndex.trim() === '') {
            return sendJSON(res, 400, { error: '缺少 authIndex（先 GET /accounts 取 auth_index）' })
          }
          try {
            const res2 = await fetch(`${base()}/v0/management/reset-quota`, {
              method: 'POST',
              headers: { ...mgmtHeaders(), 'content-type': 'application/json' },
              body: JSON.stringify({ auth_index: authIndex }),
              signal: AbortSignal.timeout(15000),
            })
            const text = await res2.text()
            let parsed = null
            try {
              parsed = JSON.parse(text)
            } catch {
              parsed = { raw: text.slice(0, 200) }
            }
            return sendJSON(res, res2.ok ? 200 : res2.status, parsed)
          } catch (err) {
            return sendJSON(res, 502, { error: `重置额度失败：${err instanceof Error ? err.message : String(err)}` })
          }
        }
        if (sub === '/provider/apply') {
          const settings = settingsOf()
          if (typeof settings?.update !== 'function' || typeof settings?.get !== 'function') {
            return sendJSON(res, 503, { error: '设置服务未挂载或不可写，无法写 provider' })
          }
          const credentials = credentialsOf()
          if (typeof credentials?.set !== 'function') {
            return sendJSON(res, 503, { error: '凭据服务未挂载，无法安全存放网关密钥（不提供该服务的部署请手填密钥）' })
          }
          const state = readState()
          if (!state?.apiKey) {
            return sendJSON(res, 400, { error: `未读到网关密钥：${config.statePath}（可先点「重生成配置」）` })
          }
          const override = Array.isArray(body?.models) && body.models.length > 0 ? body.models.map(String) : null
          const modelIds = override ?? (await gatewayModelIds())
          if (!modelIds) {
            return sendJSON(res, 502, { error: '网关无响应或未登录，拿不到模型清单（先「启动网关」并完成登录）' })
          }
          if (modelIds.length === 0) {
            return sendJSON(res, 400, { error: '网关没有可用模型：先在面板点「登录账号」完成授权' })
          }

          const providerId = String(config.dshProviderId ?? 'agy-gateway')
          const api = String(config.dshProviderApi ?? 'openai-completions')
          const refName = credentialRefNameOf()
          try {
            await credentials.set(await toCredentialRef(refName), state.apiKey)
          } catch (err) {
            return sendJSON(res, 400, { error: `写入凭据失败（${refName}）：${err instanceof Error ? err.message : String(err)}` })
          }

          // settings.update 是深合并，但 models 数组会整体替换：这里按 id 保留用户已有的
          // 模型条目（名称/上下文窗口/档位映射等手工配置），清单里新增的模型才落裸 { id }；
          // gemini 条目统一过档位钳制，避免重装/重应用后 xhigh 再次原样透传。
          let existingModels = []
          try {
            existingModels = settings.get(LLM_NAMESPACE)?.providers?.[providerId]?.models ?? []
          } catch {}
          const byId = new Map((Array.isArray(existingModels) ? existingModels : []).map((m) => [String(m?.id), m]))
          const provider = {
            api,
            baseURL: `${base()}/v1`,
            apiKeyEnv: refName,
            models: modelIds.map((id) => sanitizeEfforts(byId.get(id) ?? { id })),
          }
          try {
            // update 是深合并：只动 providers.<id>，其它 provider 与字段不受影响；合并后过 schema 校验，形状不对存不进去
            await settings.update(LLM_NAMESPACE, { providers: { [providerId]: provider } })
          } catch (err) {
            return sendJSON(res, 400, { error: `写入设置失败：${err instanceof Error ? err.message : String(err)}` })
          }

          let resolved = null
          try {
            resolved = settings.get(LLM_NAMESPACE)?.providers?.[providerId] ?? null
          } catch {
            resolved = null
          }
          return sendJSON(res, 200, {
            ok: true,
            providerId,
            api,
            baseURL: provider.baseURL,
            apiKeyEnv: refName,
            models: modelIds.length,
            credentialStored: true,
            resolved,
            usedModels: modelIds,
            note: override
              ? '已按请求指定的模型子集写入 DSH 设置（深合并）'
              : '已写入 DSH 设置（深合并，不影响其它 provider）；新建会话即可在模型选择器里看到该分组',
          })
        }
        if (sub === '/config/regenerate') {
          const r = writeHardenedConfig({
            statePath: config.statePath,
            configPath: config.configPath,
            authDir: config.authDir,
            port: config.port,
            proxyUrl: config.proxyUrl,
          })
          return sendJSON(res, 200, {
            ok: true,
            path: r.configPath,
            hasBom: r.hasBom,
            hasCrlf: r.hasCrlf,
            secretLineOk: r.secretLineOk,
            reusedKeys: r.reusedKeys,
            note: '配置已重写；若网关正在运行，需重启后生效',
          })
        }
        if (sub === '/binary/install') {
          const version = body.version || releaseVersionOf()
          const zipName = ASSET_NAME(version)
          const zipPath = body.zipPath || join(downloadDirOf(), zipName)
          const checksumsPath = body.checksumsPath || join(downloadDirOf(), 'checksums.txt')
          if (!existsSync(zipPath)) {
            return sendJSON(res, 400, { error: `发行包不存在：${zipPath}（先 POST /binary/download，或手工放到该目录）` })
          }
          const expected = expectedHashFrom(checksumsPath, zipName)
          const actual = sha256OfFile(zipPath)
          if (!expected) return sendJSON(res, 400, { error: `未在 ${checksumsPath} 找到 ${zipName} 的期望哈希，拒绝安装` })
          if (expected !== actual) return sendJSON(res, 400, { error: 'SHA-256 校验失败，拒绝解压', expected, actual })
          const wasRunning = await isReady()
          if (wasRunning) await stopGateway()
          const ex = await extractZip(zipPath, dirname(config.binPath))
          // 安装前在跑 → 装完自动拉起来，别把用户的服务留在停摆状态
          const restarted = ex.ok && wasRunning ? await ensureRunning() : null
          return sendJSON(res, ex.ok ? 200 : 500, {
            ok: ex.ok,
            via: ex.via,
            sha256: expected,
            version: ex.ok ? await detectVersion(config.binPath) : null,
            stoppedBeforeInstall: wasRunning,
            restarted: restarted ? restarted.started || restarted.alreadyRunning : false,
            output: ex.output,
          })
        }
        if (sub === '/binary/download') {
          const version = body.version || releaseVersionOf()
          const zipName = ASSET_NAME(version)
          const baseUrl = `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${version}`
          mkdirSync(downloadDirOf(), { recursive: true })
          try {
            const zipRes = await fetch(`${baseUrl}/${zipName}`, { signal: AbortSignal.timeout(180000) })
            if (!zipRes.ok) return sendJSON(res, 502, { error: `下载失败 HTTP ${zipRes.status}：${baseUrl}/${zipName}` })
            writeFileSync(join(downloadDirOf(), zipName), Buffer.from(await zipRes.arrayBuffer()))
            const sumRes = await fetch(`${baseUrl}/checksums.txt`, { signal: AbortSignal.timeout(30000) })
            if (sumRes.ok) writeFileSync(join(downloadDirOf(), 'checksums.txt'), Buffer.from(await sumRes.arrayBuffer()))
          } catch (err) {
            return sendJSON(res, 502, { error: `下载异常：${err instanceof Error ? err.message : String(err)}` })
          }
          const zipPath = join(downloadDirOf(), zipName)
          const expected = expectedHashFrom(join(downloadDirOf(), 'checksums.txt'), zipName)
          const actual = sha256OfFile(zipPath)
          return sendJSON(res, 200, { downloaded: true, zipPath, sha256: actual, expectedFromChecksums: expected, verified: Boolean(expected && expected === actual) })
        }
        return sendJSON(res, 404, { error: `unknown endpoint: ${sub}` })
      }

      return sendJSON(res, 405, { error: `method not allowed: ${method}` })
    } catch (err) {
      sendJSON(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: prefix, handler })
    const legacyDispose = prefix !== '/agy-gateway'
      ? ctx.webServer.register({ kind: 'prefix', path: '/agy-gateway', handler })
      : null

    // ---- 智能自愈 1：事前防御（在每一个 Agent 步骤开始前，保证反代网关端口在线）
    const disposePreStep = ctx.on?.('agent/pre-step', async ({ agent, signal }, next) => {
      try {
        if (config.autoStart !== false && !userStopped) {
          if (!(await isReady())) {
            await ensureRunningQuietly('pre-step')
          }
        }
      } catch {
        /* ignore */
      }
      return next ? next() : Promise.resolve(void 0)
    })

    // ---- 智能自愈 2：事中兜底（遇到 Connection error / 503 / 504 / i/o timeout 自动拉起 + 重试）
    const recoveryAttempts = new Map()
    const disposeRequestError = ctx.on?.('agent/request-error', async (payload, next) => {
      const { provider, failure, turn, step, signal } = payload || {}
      const isOurProvider = provider === config.dshProviderId
        || provider === 'agy-gateway'
        || provider === 'ai-gateway'
        || provider === 'codex-gateway'

      if (!isOurProvider || signal?.aborted) {
        return next ? next() : Promise.resolve(void 0)
      }

      const msg = String(failure?.message || '')
      const isConnectionError = msg.includes('Connection error')
        || msg.includes('ECONNREFUSED')
        || msg.includes('connectex')
        || msg.includes('i/o timeout')
        || msg.includes('503')
        || msg.includes('504')

      if (!isConnectionError) {
        return next ? next() : Promise.resolve(void 0)
      }

      const key = `${turn}:${step}`
      const attempts = recoveryAttempts.get(key) ?? 0
      if (attempts >= 2) {
        return next ? next() : Promise.resolve(void 0)
      }
      recoveryAttempts.set(key, attempts + 1)

      ctx.logger?.warn?.(`[ai-gateway] 检测到模型请求异常 (${msg.slice(0, 100)})，正在自动拉起/自愈重试 (${attempts + 1}/2)...`)

      // 1. 如果端口离线，立刻拉起网关
      if (!(await isReady())) {
        await ensureRunningQuietly('request-error-recovery')
      }

      // 2. 如果网关在线但上游报 503 / 冷却中，向管理面清除运行时冷却标记
      try {
        const st = readState()
        if (st?.managementKey) {
          const afRes = await probeJSON(`${base()}/v0/management/auth-files`, mgmtHeaders(), 2000)
          for (const f of afRes.body?.files || []) {
            if (f.auth_index && (f.unavailable || f.status !== 'active')) {
              await fetch(`${base()}/v0/management/reset-quota`, {
                method: 'POST',
                headers: { ...mgmtHeaders(), 'content-type': 'application/json' },
                body: JSON.stringify({ auth_index: f.auth_index }),
                signal: AbortSignal.timeout(3000),
              }).catch(() => {})
            }
          }
        }
      } catch {
        /* ignore */
      }

      // 等待 800ms 让连接稳定
      await sleep(800)

      // 返回 { kind: 'retry' }，触发 DSH 内部自动重跑该步骤！
      return { kind: 'retry' }
    })

    // 插件加载后稍等再拉网关（别和 DSH 自己的启动抢资源），之后由看门狗兜底
    const bootTimer = setTimeout(() => { void ensureRunningQuietly('plugin-load') }, 2500)
    if (typeof bootTimer.unref === 'function') bootTimer.unref()

    // 异步后台预热与定期对齐额度缓存，保证用户打开设置面板或底栏气泡时永远是 0ms 瞬时直出
    const quotaPreheat = setTimeout(() => { void fetchAllAccountsQuota(config.authDir, true) }, 3000)
    if (typeof quotaPreheat.unref === 'function') quotaPreheat.unref()
    const quotaTimer = setInterval(() => { void fetchAllAccountsQuota(config.authDir, true) }, 45000)
    if (typeof quotaTimer.unref === 'function') quotaTimer.unref()

    const watchdogMs = Math.max(Number(config.watchdogIntervalMs) || 60000, 15000)
    const watchdog = setInterval(() => { void ensureRunningQuietly('watchdog') }, watchdogMs)
    if (typeof watchdog.unref === 'function') watchdog.unref()

    return () => {
      try {
        clearTimeout(bootTimer)
        clearTimeout(quotaPreheat)
        clearInterval(quotaTimer)
        clearInterval(watchdog)
        disposePreStep?.()
        disposeRequestError?.()
      } catch {
        /* ignore */
      }
      try {
        dispose?.()
        legacyDispose?.()
      } finally {
        // DSH 退出时不要留下孤儿网关进程（对应 DEVELOPMENT.md 坑 15）
        const rt = runtime()
        if (pidAlive(rt.pid)) {
          try {
            if (IS_WIN) spawn('taskkill', ['/PID', String(rt.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
            else process.kill(rt.pid, 'SIGTERM')
          } catch {
            /* 尽力而为 */
          }
        }
        try {
          if (existsSync(config.runtimePath)) unlinkSync(config.runtimePath)
        } catch {
          /* ignore */
        }
      }
    }
  })
}
