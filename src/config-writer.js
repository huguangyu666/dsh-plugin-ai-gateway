/**
 * 网关配置与状态文件的生成逻辑（host 与 tools/gen-config.mjs 共用）。
 *
 * 加固要点：
 *   - 仅监听 127.0.0.1
 *   - 数据面 api-keys 与管理面 secret-key 分离且随机
 *   - 关闭远程管理与动态库插件加载
 *   - 文件日志开启但带容量上限（控制台要读 /v0/management/logs）
 *   - 一律 UTF-8 无 BOM + LF（DEVELOPMENT.md 坑 27）
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { execSync } from 'node:child_process'

export const DEFAULT_PORT = 8317

export function defaultPaths(home = homedir(), platform = process.platform) {
  const dshHome = join(home, '.dsh', 'ai-gateway')
  const legacyHome = join(home, '.dsh', 'agy-gateway')
  const actualHome = existsSync(dshHome) ? dshHome : (existsSync(legacyHome) ? legacyHome : dshHome)
  const authDir = join(home, '.cli-proxy-api')
  return {
    dshHome: actualHome,
    binPath: join(actualHome, 'bin', platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api'),
    statePath: join(actualHome, 'state.json'),
    runtimePath: join(actualHome, 'runtime.json'),
    downloadDir: join(actualHome, '_download'),
    authDir,
    configPath: join(authDir, 'config.yaml'),
    port: DEFAULT_PORT,
  }
}

const makeKey = (prefix, bytes) => prefix + randomBytes(bytes).toString('hex')

export function loadState(statePath) {
  try {
    if (!existsSync(statePath)) return null
    return JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    return null
  }
}

/** 读取已有密钥（不重新生成，保证 DSH 侧已填的 key 不失效）。 */
export function loadOrCreateState(statePath, { force = false, port = DEFAULT_PORT } = {}) {
  const existing = force ? null : loadState(statePath)
  if (existing?.apiKey && existing?.managementKey) {
    existing.port = port
    return existing
  }
  return {
    createdAt: new Date().toISOString(),
    port,
    host: '127.0.0.1',
    apiKey: makeKey('sk-agy-', 12),
    managementKey: makeKey('mgmt-', 14),
  }
}

export function detectSystemProxySync() {
  // 1. 优先读取标准环境变量
  const envProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY
  if (envProxy) return envProxy

  if (process.platform === 'win32') {
    // 2. Windows 注册表：Clash / v2rayN / Sing-box 打开「系统代理」时会自动写入这里
    try {
      const out = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"', {
        encoding: 'utf8',
        timeout: 1500,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const enabledMatch = out.match(/ProxyEnable\s+REG_DWORD\s+(0x[0-9a-fA-F]+|\d+)/)
      const isEnabled = enabledMatch && parseInt(enabledMatch[1], 16) === 1
      if (isEnabled) {
        const serverMatch = out.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/)
        if (serverMatch && serverMatch[1]) {
          const raw = serverMatch[1].trim()
          const matchHttp = raw.match(/(?:https?=|socks=)?([^;]+)/)
          const addr = matchHttp ? matchHttp[1] : raw
          return addr.startsWith('http://') || addr.startsWith('https://') || addr.startsWith('socks') ? addr : `http://${addr}`
        }
      }
    } catch {
      /* ignore */
    }

    // 3. 常见本地代理端口主动探测（Clash 7890/7891/7892, v2rayN 10808/10809, Sing-box 2080, Shadowsocks 1080）
    try {
      const portOut = execSync('powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 7890,7891,7892,10808,10809,2080,1080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).LocalPort"', {
        encoding: 'utf8',
        timeout: 2000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (portOut && /^\d+$/.test(portOut)) {
        return `http://127.0.0.1:${portOut}`
      }
    } catch {
      /* ignore */
    }
  }

  return ''
}

export function resolveProxyUrlSync(setting = 'auto') {
  const trimmed = typeof setting === 'string' ? setting.trim() : ''
  if (!trimmed || trimmed === 'direct' || trimmed === 'none' || trimmed === 'off' || trimmed === 'false') {
    return ''
  }
  if (trimmed !== 'auto') {
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('socks5://') || trimmed.startsWith('socks5h://')) {
      return trimmed
    }
    return `http://${trimmed}`
  }
  return detectSystemProxySync()
}

export function syncProxyUrlInConfigFile(configPath, proxyUrlSetting = 'auto') {
  if (!existsSync(configPath)) return ''
  const resolved = resolveProxyUrlSync(proxyUrlSetting)
  const content = readFileSync(configPath, 'utf8')
  let next
  if (/^proxy-url:\s*.*$/m.test(content)) {
    next = content.replace(/^proxy-url:\s*.*$/m, resolved ? `proxy-url: "${resolved}"` : 'proxy-url: ""')
  } else {
    next = content.trimEnd() + `\n\nproxy-url: "${resolved}"\n`
  }
  if (next !== content) {
    writeFileSync(configPath, next, 'utf8')
  }
  return resolved
}

export function renderConfig(state, { port = DEFAULT_PORT, authDir, proxyUrl = 'auto' }) {
  const resolvedProxy = resolveProxyUrlSync(proxyUrl)
  const lines = [
    '# CLIProxyAPI 配置 —— 由 DSH ai-gateway 插件管理，请勿手工编辑（会被覆盖）',
    '# 加固要点：仅本机监听 / 数据面与管理面密钥分离 / 关闭远程管理与动态插件加载',
    'host: "127.0.0.1"',
    `port: ${port}`,
    '',
    'tls:',
    '  enable: false',
    '',
    'remote-management:',
    '  allow-remote: false',
    `  secret-key: "${state.managementKey}"`,
    '',
    `auth-dir: "${String(authDir).replace(/\\/g, '/')}"`,
    '',
    'api-keys:',
    `  - "${state.apiKey}"`,
    '',
    'debug: false',
    '',
    'pprof:',
    '  enable: false',
    '',
    'plugins:',
    '  enabled: false',
    '',
    '# 控制台要读 /v0/management/logs，必须开启文件日志；用容量上限兜底磁盘占用。',
    'logging-to-file: true',
    'logs-max-total-size-mb: 20',
    'error-logs-max-files: 5',
    '',
    '# 控制台的用量面板要读 /v0/management/usage-queue，必须开启请求统计（该 CLI 默认关闭）。',
    'usage-statistics-enabled: true',
    '',
    '# 多账号自动轮换与额度耗尽故障转移（多个账号时自动平滑接力，单账号额度耗尽不中断）',
    'quota-exceeded:',
    '  switch-project: true',
    '  switch-preview-model: true',
    '  antigravity-credits: true',
    '',
    'routing:',
    '  strategy: "round-robin"',
    '  session-affinity: false',
    '',
    '# 智能出海代理（auto 自动对齐系统代理/Clash/v2rayN，或手动指定；留空则直连/TUN）',
    resolvedProxy ? `proxy-url: "${resolvedProxy}"` : 'proxy-url: ""',
    '',
  ]
  return lines.join('\n')
}

export function inspectTextFile(path) {
  const bytes = readFileSync(path).subarray(0, 3)
  const body = readFileSync(path, 'utf8')
  return {
    hasBom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
    hasCrlf: body.includes('\r\n'),
  }
}

/** 写配置 + 状态；返回落盘结果与自检信息。 */
export function writeHardenedConfig({ statePath, configPath, authDir, port = DEFAULT_PORT, force = false, proxyUrl = 'auto' }) {
  mkdirSync(dirname(configPath), { recursive: true })
  mkdirSync(dirname(statePath), { recursive: true })
  const state = loadOrCreateState(statePath, { force, port })
  state.port = port
  state.host = '127.0.0.1'
  state.configPath = configPath
  state.authDir = authDir
  writeFileSync(configPath, renderConfig(state, { port, authDir, proxyUrl }), 'utf8')
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8')
  const check = inspectTextFile(configPath)
  const secretLineOk = /secret-key: "[^"]+"$/.test(
    readFileSync(configPath, 'utf8').split('\n').find((l) => l.includes('secret-key')) ?? '',
  )
  return { state, configPath, statePath, ...check, secretLineOk, reusedKeys: !force }
}
