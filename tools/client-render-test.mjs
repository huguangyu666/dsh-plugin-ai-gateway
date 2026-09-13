/**
 * 客户端面板渲染测试：用可控 hooks + 假 React 渲染各组件的多条分支，
 * 确保任何状态组合下都不会抛错（面板抛错会弄坏 dsh 设置页）。
 *
 * 用法: node tools/client-render-test.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`)
}

// ---- 物化 client bundle（每个场景用自己的假 React，隔离 hooks 计数）----
const code = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
let def = null
globalThis.window = { __ModuleLoader__: { load: (d) => { def = d } } }
new Function(code)()

/** 生成一个假 React：useState 依次消费提供的状态序列，useRef 不占位。 */
function makeReact(stateSequence, calls) {
  let i = 0
  const createElement = (type, props, ...children) => {
    const kids = children.length <= 1 ? children[0] : children
    return { type, props: props ? { ...props, children: kids } : { children: kids } }
  }
  return {
    createElement,
    useState: (init) => {
      const v = i < stateSequence.length ? stateSequence[i] : typeof init === 'function' ? init() : init
      i += 1
      calls.push(v)
      return [v, () => {}]
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: () => ({ current: null }),
  }
}

/**
 * 把元素树里的文本收集成一个大字符串，便于断言。
 * 注意：文案既可能在 children 里，也可能在 props 里（例如 StatCard 的 label/value、
 * 授权链接的 href），所以两边都要走；style 跳过以免噪声。
 */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out)
    return out
  }
  if (typeof node === 'object') {
    // 函数组件要真正调用一次才能拿到它内部的文案（假 React 不做 reconcile）
    if (typeof node.type === 'function') {
      if ((node.__depth ?? 0) > 12) return out
      let child
      try {
        child = node.type(node.props ?? {})
      } catch (err) {
        out.push('«组件渲染抛错: ' + err.message + '»')
        return out
      }
      textOf(child, out)
      return out
    }
    for (const [key, value] of Object.entries(node.props ?? {})) {
      if (key === 'style') continue
      textOf(value, out)
    }
    return out
  }
  return out
}

/** 渲染一次组件；返回 { ok, error, text } */
function render(exportsObj, props, states) {
  const calls = []
  const fakeRequire = (spec) => {
    if (spec === 'react') return makeReact(states, calls)
    throw new Error('未预期的依赖: ' + spec)
  }
  let materialized
  try {
    materialized = def.factory(fakeRequire)
  } catch (err) {
    return { ok: false, error: '物化失败: ' + err.message, text: '' }
  }
  const registered = []
  materialized.apply({
    slots: {
      inject: (name, fn) => fn(),
      register: (spec, comp) => registered.push({ spec, comp }),
    },
  })
  const target = registered.find((r) => r.spec.name === props.__slot)?.comp
  if (typeof target !== 'function') return { ok: false, error: '找不到组件 ' + props.__slot, text: '' }
  try {
    const tree = target(props)
    return { ok: true, error: null, text: textOf(tree).join(' | ') }
  } catch (err) {
    return { ok: false, error: err.message, text: '' }
  }
}

const SECTION = 'settings.section'
const CARD = 'settings.models.provider-card'

const baseStatus = {
  generatedAt: '2026-09-12T00:00:00Z',
  gateway: {
    baseURL: 'http://127.0.0.1:8317/v1', managementURL: 'http://127.0.0.1:8317/v0/management',
    host: '127.0.0.1', port: 8317, running: true, models: 3, modelIds: ['gemini-3-pro', 'claude-sonnet', 'gpt-oss'],
    accounts: 1, stateLoaded: true, keysPresent: true, managedByPlugin: true, pid: 1234, error: null,
    management: 'ok', version: '7.2.158',
  },
  login: { status: 'idle', url: null, startedAt: null, finishedAt: null, message: null },
  accounts: [{ name: 'a.json', email: 'me@example.com', size: 2048, mtime: '2026-09-12T00:00:00Z' }],
  files: {
    bin: { path: 'C:/x/cli-proxy-api.exe', exists: true, size: 1, mtime: '' },
    state: { path: 'C:/x/state.json', exists: true, size: 1, mtime: '' },
    config: { path: 'C:/x/config.yaml', exists: true, size: 1, mtime: '' },
    authDir: { path: 'C:/x', exists: true, size: 1, mtime: '' },
  },
}

const scenarios = [
  {
    label: '加载中（全部为 null）',
    slot: SECTION,
    states: [null, null, null, null, null, null, null, null, '', '', null],
    expect: ['加载中'],
  },
  {
    label: '读取失败（error 分支）',
    slot: SECTION,
    states: [null, null, null, null, null, null, null, null, 'fetch failed', '', null],
    expect: ['读取网关状态失败', '重试'],
  },
  {
    label: '网关运行中 + 账号额度池 + 用量 + 配置已挂载',
    slot: SECTION,
    states: [
      baseStatus,
      { values: { port: 8317, releaseVersion: '7.2.158', binPath: 'C:/x/a.exe', configPath: 'C:/x/c.yaml', authDir: 'C:/x', allowRemoteControl: false }, editable: ['port'], readOnly: ['routePrefix'], settingsAttached: true, registrationMode: 'installSection' },
      { port: 8317, releaseVersion: '7.2.158', binPath: 'C:/x/a.exe', configPath: 'C:/x/c.yaml', authDir: 'C:/x', allowRemoteControl: false },
      ['line-1', 'line-2'],
      { providerId: 'agy-gateway', baseURL: 'http://127.0.0.1:8317/v1', api: 'openai-completions', alternativeApi: 'openai-responses', apiKey: 'sk-agy-aaaa…bbbb', models: ['gemini-3-pro'], steps: ['设置 → 模型'], ready: true },
      { records: 2, total: { requests: 2, success: 2, failed: 0, inputTokens: 10, outputTokens: 20, reasoningTokens: 0, cachedTokens: 0, totalTokens: 30, avgLatencyMs: 150 }, byModel: [{ model: 'gemini-3-pro', requests: 2, totalTokens: 30, failed: 0, avgLatencyMs: 150 }], byAccount: [] },
      { source: 'gateway', files: [{ id: 'me@example.com', authIndex: 'a1b2', name: 'a.json', provider: 'antigravity', label: 'Prod', email: 'me@example.com', status: 'active', statusMessage: '', success: 12, failed: 1, disabled: false, unavailable: false, runtimeOnly: false, lastRefresh: null }] },
      [{
        email: 'me@example.com', fileName: 'a.json', tier: 'Google AI Pro', projectId: 'aicode-consumers',
        gemini: { h5: { percent: 75, countdown: '1h 54m (09/13 04:26)' }, weekly: { percent: 96, countdown: '6d 20h (09/19 23:26)' } },
        claude: { h5: { percent: 100, countdown: '2h 1m (09/13 04:33)' }, weekly: { percent: 99, countdown: '6d 21h (09/19 23:33)' } },
      }],
      '', '', '',
    ],
    expect: ['运行中', '多账号额度池', 'Google AI Pro', 'Claude', 'Gemini', '75%', '重置额度', '删除账号', 'aicode-consumers', '用量汇总', 'gemini-3-pro', '保存配置'],
  },
  {
    label: '网关未运行 + 无账号 + 无用量（空态）',
    slot: SECTION,
    states: [
      { ...baseStatus, gateway: { ...baseStatus.gateway, running: false, models: null, modelIds: [], accounts: 0, managedByPlugin: false, pid: null, error: 'fetch failed', management: 'unreachable' }, accounts: [] },
      { values: { port: 8317 }, editable: ['port'], readOnly: [], settingsAttached: false, registrationMode: 'failed: no settings' },
      { port: 8317 },
      [],
      { providerId: 'agy-gateway', baseURL: 'http://127.0.0.1:8317/v1', api: 'openai-completions', alternativeApi: 'openai-responses', apiKey: null, models: [], steps: [], ready: false },
      { records: 0, total: { requests: 0, success: 0, failed: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, totalTokens: 0, avgLatencyMs: null }, byModel: [], byAccount: [] },
      { source: 'gateway', files: [] },
      [],
      '', '', '',
    ],
    expect: ['未运行', '暂无已连接账号', '设置服务未挂载', '模型清单为空', '暂无用量记录'],
  },
  {
    label: '账号报错带验证链接（应渲染可点的「去验证账号」）',
    slot: SECTION,
    states: [
      { ...baseStatus, gateway: { ...baseStatus.gateway, running: false, models: null, modelIds: [] } },
      null, null, null, null, null,
      {
        source: 'gateway',
        files: [{
          id: 'x', authIndex: 'd99399785790b575', name: 'a.json', provider: 'antigravity', label: 'Prod',
          email: 'me@example.com', status: 'error', success: 0, failed: 1, disabled: false, unavailable: true,
          statusMessage: JSON.stringify({
            error: {
              code: 403,
              message: 'Verify your account to continue.',
              details: [{
                reason: 'VALIDATION_REQUIRED',
                metadata: {
                  validation_url_link_text: 'Verify your account',
                  validation_url: 'https://accounts.google.com/signin/continue?sarp=1&continue=https://developers.google.com/gemini-code-assist/auth/auth_success_gemini',
                  validation_learn_more_url: 'https://support.google.com/accounts?p=al_alert',
                  validation_error_message: 'Verify your account to continue.',
                },
              }],
            },
          }),
        }],
      },
      [{
        email: 'me@example.com', fileName: 'a.json', tier: 'Google AI Pro', projectId: 'x',
        gemini: { h5: { percent: 0, countdown: '已重置' }, weekly: null },
        claude: { h5: null, weekly: null },
      }],
      '', '', '',
    ],
    expect: ['去验证账号', 'accounts.google.com/signin/continue', '了解更多', '运行时状态异常', '重置额度'],
  },
  {
    label: '登录等待中（应显示授权链接）',
    slot: SECTION,
    states: [
      { ...baseStatus, login: { status: 'waiting', url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', startedAt: null, finishedAt: null, message: null } },
      null, null, null, null, null, null, null, '', '', 'note-here',
    ],
    expect: ['等待浏览器授权', 'accounts.google.com'],
  },
  {
    label: '登录失败',
    slot: SECTION,
    states: [
      { ...baseStatus, login: { status: 'timeout', url: null, startedAt: null, finishedAt: null, message: '未获得凭据' } },
      null, null, null, null, null, null, null, '', '', '',
    ],
    expect: ['未获得凭据'],
  },
  {
    label: '状态条：自己的卡片（运行中）',
    slot: CARD,
    props: { provider: { id: 'agy-gateway' } },
    states: [baseStatus, false],
    expect: ['网关运行中', '停止'],
  },
  {
    label: '状态条：自己的卡片（未运行）',
    slot: CARD,
    props: { provider: { id: 'agy-gateway' } },
    states: [{ ...baseStatus, gateway: { ...baseStatus.gateway, running: false } }, false],
    expect: ['网关未运行', '启动网关'],
  },
  {
    label: '状态条：别人的卡片（必须什么都不渲染）',
    slot: CARD,
    props: { provider: { id: 'deepseek-official' } },
    states: [null, false],
    expect: [],
    expectEmpty: true,
  },
]

for (const s of scenarios) {
  const props = { ...(s.props ?? {}), __slot: s.slot }
  const r = render(null, props, s.states)
  if (!r.ok) {
    check(`渲染：${s.label}`, false, '抛错：' + r.error)
    continue
  }
  if (s.expectEmpty) {
    check(`渲染：${s.label}`, r.text.trim() === '', r.text.trim() === '' ? '' : '意外渲染出：' + r.text.slice(0, 80))
    continue
  }
  const missing = s.expect.filter((needle) => !r.text.includes(needle))
  check(`渲染：${s.label}`, missing.length === 0, missing.length ? '缺少文案：' + missing.join('、') : '')
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exitCode = failed.length === 0 ? 0 : 1
