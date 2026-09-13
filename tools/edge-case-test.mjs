/**
 * 边界 / 首跑健壮性测试：全部在隔离的夹具目录里跑，不碰用户的真实配置与凭据。
 *
 * 覆盖：缺文件、状态文件损坏、陈旧 pid、二进制不可执行、发行包哈希不符、端口无人监听。
 * 断言重点不是"不报错"，而是**报错信息足够清楚**（首跑时用户只看得到面板上的那行字）。
 *
 * 用法: node tools/edge-case-test.mjs
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`)
}

const mod = await import(new URL('../src/index.js', import.meta.url).href)

/** 为一份夹具建一个插件实例，返回 { call, dir, config } */
function mount(fixtureName, buildFixture) {
  const dir = join(tmpdir(), `agy-gateway-fixture-${fixtureName}-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const paths = {
    dir,
    binPath: join(dir, 'cli-proxy-api.exe'),
    statePath: join(dir, 'state.json'),
    runtimePath: join(dir, 'runtime.json'),
    configPath: join(dir, 'config.yaml'),
    authDir: join(dir, 'auth'),
    downloadDir: join(dir, 'download'),
  }
  mkdirSync(paths.authDir, { recursive: true })
  buildFixture?.(paths)

  const routes = []
  const config = { ...mod.Config({}), ...paths, port: 8399, host: '127.0.0.1', startTimeoutMs: 2500, probeTimeoutMs: 800 }
  mod.apply({ effect: (fn) => fn(), webServer: { register: (r) => routes.push(r) } }, config)

  const call = (path, method = 'GET', body) => new Promise((resolvePromise) => {
    const req = new EventEmitter()
    req.url = path
    req.method = method
    req.headers = {}
    req.destroy = () => {}
    const res = { statusCode: 0, writeHead(c) { this.statusCode = c }, end(b) { resolvePromise({ status: this.statusCode, body: b ? JSON.parse(b) : null }) } }
    routes[0].handler(req, res)
    process.nextTick(() => {
      if (body) req.emit('data', JSON.stringify(body))
      req.emit('end')
    })
  })
  return { call, paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------- 夹具 A：全新机器（什么都没装）
{
  const f = mount('empty')
  const st = await f.call('/agy-gateway/api/status')
  check('A 全新：/status 仍返回 200（面板不会白屏）', st.status === 200, `status=${st.status}`)
  check('A 全新：明确报告缺文件与缺密钥',
    st.body?.gateway?.keysPresent === false && st.body?.files?.bin?.exists === false && st.body?.files?.config?.exists === false,
    `keysPresent=${st.body?.gateway?.keysPresent} bin=${st.body?.files?.bin?.exists}`)
  const start = await f.call('/agy-gateway/api/gateway/start', 'POST')
  check('A 全新：启动报「可执行文件不存在」而不是静默失败',
    start.body?.started === false && /可执行文件不存在/.test(String(start.body?.error)), JSON.stringify(start.body?.error))
  const login = await f.call('/agy-gateway/api/login', 'POST')
  check('A 全新：登录同样明确报错', login.body?.started === false && /可执行文件不存在/.test(String(login.body?.error)), JSON.stringify(login.body?.error))
  const cfg = await f.call('/agy-gateway/api/plugin-config')
  check('A 全新：配置接口可用（可据此在界面上改路径）', cfg.status === 200 && cfg.body?.values?.binPath === f.paths.binPath)
  const acct = await f.call('/agy-gateway/api/accounts')
  check('A 全新：账号接口降级为文件系统视角并给出原因', acct.status === 200 && acct.body?.source === 'filesystem' && Boolean(acct.body?.error), String(acct.body?.error).slice(0, 60))
  f.cleanup()
}

// ---------------------------------------------------------------- 夹具 B：state.json 损坏
{
  const f = mount('corrupt-state', (p) => {
    writeFileSync(p.statePath, '{ this is not json', 'utf8')
    writeFileSync(p.configPath, 'host: "127.0.0.1"\n', 'utf8')
  })
  const st = await f.call('/agy-gateway/api/status')
  check('B 状态文件损坏：/status 不抛错、报告未读到状态',
    st.status === 200 && st.body?.gateway?.stateLoaded === false && st.body?.gateway?.keysPresent === false,
    `stateLoaded=${st.body?.gateway?.stateLoaded}`)
  const models = await f.call('/agy-gateway/api/models')
  check('B 状态文件损坏：模型接口返回明确失败而非崩溃', models.status !== 200 && Boolean(models.body), `status=${models.status}`)
  f.cleanup()
}

// ---------------------------------------------------------------- 夹具 C：陈旧 pid + 端口无人监听
{
  const f = mount('stale-pid', (p) => {
    writeFileSync(p.statePath, JSON.stringify({ apiKey: 'sk-agy-test', managementKey: 'mgmt-test', port: 8399 }), 'utf8')
    writeFileSync(p.runtimePath, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString(), startedBy: 'plugin' }), 'utf8')
    writeFileSync(p.binPath, 'not a real executable', 'utf8')
    writeFileSync(p.configPath, 'host: "127.0.0.1"\n', 'utf8')
  })
  const st = await f.call('/agy-gateway/api/status')
  check('C 陈旧 pid：不被误判为"插件在管"', st.body?.gateway?.managedByPlugin === false && st.body?.gateway?.pid === null,
    `managed=${st.body?.gateway?.managedByPlugin} pid=${st.body?.gateway?.pid}`)
  const stop = await f.call('/agy-gateway/api/gateway/stop', 'POST')
  check('C 陈旧 pid：停止返回"没有发现运行中的网关"', stop.body?.stopped === false && /没有发现运行中的网关/.test(String(stop.body?.message)), JSON.stringify(stop.body))
  check('C 陈旧 pid：停止后 runtime.json 被清理', !existsSync(f.paths.runtimePath))
  const start = await f.call('/agy-gateway/api/gateway/start', 'POST')
  check('C 二进制是假文件：启动失败并给出带路径的可诊断信息',
    start.body?.started === false && /无法启动网关进程/.test(String(start.body?.error)) && String(start.body?.error).includes(f.paths.binPath),
    JSON.stringify(start.body?.error)?.slice(0, 130))
  f.cleanup()
}

// ---------------------------------------------------------------- 夹具 D：发行包哈希不符 → 拒绝安装
{
  const f = mount('bad-hash', (p) => {
    mkdirSync(p.downloadDir, { recursive: true })
    // 名字必须与默认 releaseVersion 对应，否则走的是"发行包不存在"分支而非校验分支
    writeFileSync(join(p.downloadDir, 'CLIProxyAPI_7.2.158_windows_amd64.zip'), 'pretend zip', 'utf8')
    writeFileSync(join(p.downloadDir, 'CLIProxyAPI_8.8.8_windows_amd64.zip'), 'pretend zip 2', 'utf8')
    writeFileSync(join(p.downloadDir, 'checksums.txt'), 'deadbeef'.repeat(8) + '  CLIProxyAPI_7.2.158_windows_amd64.zip\n', 'utf8')
    writeFileSync(p.binPath, 'existing binary', 'utf8')
  })
  const bin = await f.call('/agy-gateway/api/binary')
  check('D 哈希不符：/binary 如实报告 verified=false',
    bin.body?.archive?.exists === true && bin.body?.archive?.verified === false,
    `exists=${bin.body?.archive?.exists} verified=${bin.body?.archive?.verified}`)
  const install = await f.call('/agy-gateway/api/binary/install', 'POST', { version: '7.2.158' })
  check('D 哈希不符：安装被拒绝且不覆盖已有二进制',
    install.status === 400 && /SHA-256 校验失败/.test(String(install.body?.error)) && existsSync(f.paths.binPath),
    JSON.stringify(install.body)?.slice(0, 110))
  const missingChecksum = await f.call('/agy-gateway/api/binary/install', 'POST', { version: '8.8.8' })
  check('D 无对应校验记录：同样拒绝安装', missingChecksum.status === 400 && /期望哈希/.test(String(missingChecksum.body?.error)),
    JSON.stringify(missingChecksum.body)?.slice(0, 110))
  f.cleanup()
}

// ---------------------------------------------------------------- 夹具 E：只缺配置 / 只缺二进制
{
  const f = mount('no-config', (p) => {
    writeFileSync(p.binPath, 'fake', 'utf8')
  })
  const start = await f.call('/agy-gateway/api/gateway/start', 'POST')
  check('E 缺配置：提示配置文件不存在并指出路径',
    start.body?.started === false && /配置文件不存在/.test(String(start.body?.error)) && String(start.body?.error).includes(f.paths.configPath),
    JSON.stringify(start.body?.error)?.slice(0, 130))
  f.cleanup()
}

// ---------------------------------------------------------------- 夹具 F：插件配置被写到非法值
{
  const f = mount('bad-config', (p) => {
    writeFileSync(p.binPath, 'fake', 'utf8')
    writeFileSync(p.configPath, 'host: "127.0.0.1"\n', 'utf8')
  })
  const bad = await f.call('/agy-gateway/api/plugin-config', 'POST', { binPath: '' })
  check('F 配置写入空路径被拒（503/400 均可，但不能静默）', bad.status >= 400 && Boolean(bad.body?.error), `status=${bad.status} ${JSON.stringify(bad.body)?.slice(0, 80)}`)
  f.cleanup()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) console.log('失败项：' + failed.map((f) => f.label).join(' / '))
process.exitCode = failed.length === 0 ? 0 : 1
