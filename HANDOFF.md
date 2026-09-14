# 交接说明（HANDOFF）

> 这份文档写给"接手的人"和未来的你：完整记录项目的架构设计、已攻克的硬核实战问题、当前真实运行状态、发布与维护命令。

---

## 一句话状态

**已彻底闭环并在产线稳定运行。**  
项目已从最初的 `dsh-plugin-agy-gateway` 升级蜕变为 **`dsh-plugin-ai-gateway`（AI 聚合网关）**。
不仅跑通了 **Google Antigravity（Gemini / Claude）**，无缝纳管了 **OpenAI Codex（GPT-5.6 / o1 / o3-mini）**，还完整实现了 **ZCode / 智谱 BigModel Coding Plan 的无感解密与官方指纹协议桥接**。支持多账号轮换接力、5h/周高精额度大盘（0ms 极速 SWR）、底栏 ContextMeter 按需注入联动、智能出海代理自适应发现以及 262k 互切与 1M 巨幕双轨架构。全套自动化测试 **163 / 163 项全绿（含 ZCode 31 项与 Edge-Case 17 项）**。针对 ZCode 计费机制完成了深度实测，默认安全禁用本地反代端口，保留 100% 验证代码供随时按需复用。

---

## 实战踩坑与解决手册 (Hard-Won Knowledge)

本项目开发过程中经历了多次极具代表性的跨端/跨协议实战故障，均已彻底定位并固化为长效机制：

### 1. 账号身份验证闸门 `403 VALIDATION_REQUIRED`（2026-09-12）
* **现象**：首次 Google OAuth 登录成功，但发起的首次推理被 Google Cloud Code 网关拒绝，报 `HTTP 403 PERMISSION_DENIED: "Verify your account to continue."`，网关内存将账号置为 `unavailable`。
* **根因与解决**：
  * 该质询与地理位置无关（用户账号地区在台湾，在支持清单内），而是 Google 风险引擎要求完成首次开发者授权核验；
  * **解决方案**：在面板账号卡片提取出的 `validation_url` 中，用**无痕浏览器仅登录该目标账号**打开并确认，授权成功页面提示 Gemini CLI / Antigravity 已授权后，上游瞬间解禁，无需换号。
  * **代码固化**：面板与气泡内嵌 `extractLinks()`，自动挖出上游报错 JSON 里的验证链接，一键直达。

### 2. DSH 窗口超限拦截 `CONTEXT_WINDOW_EXCEEDED`（2026-09-12）
* **现象**：超长会话（累积几十万 Token）下，切换到反代模型直接报 `pi-ai detected context overflow for model "gemini-3.8-flash-high"`。
* **根因**：网关 `/v1/models` 仅返回模型 ID，不包含容量元数据。DSH 默认回退到 256k 兜底限制，超长会话被前端直接挡住。
* **解决**：在 `settings.yaml` 中为 `agy-gateway` 与 `codex-gateway` 显式标注每个模型的真实容量（Gemini 1M，Codex 262k），并在 provider 级提供 `defaultContextWindow` 兜底。

### 3. Google Vertex 不支持 `xhigh` 思考档位 `HTTP 400 INVALID_ARGUMENT`（2026-09-13）
* **现象**：DSH 默认模型或手动切换选 `Xhigh` 档位时，发给 Gemini 报错：
  ```text
  400: Invalid value at 'request.generation_config.thinking_config.thinking_level' ... "xhigh"
  ```
* **根因**：Google Gemini 的 `ThinkingConfig.ThinkingLevel` 枚举只有 `OFF`、`LOW`、`HIGH`，不存在 `xhigh`（`xhigh` 属于 OpenAI/Anthropic 系概念）。
* **解决**：在 `settings.yaml` 的 `reasoningEfforts` 映射中，将 Gemini 系的 `"xhigh"` 平滑映射为上游顶格的 `"high"`（`"xhigh": "high"`），DSH UI 选 `Xhigh` 也能平滑透传合法参数。

### 4. 4.4MB 超大请求体导致 TUN 虚拟网卡 `503 / 504 Connectex Timeout`（2026-09-13）
* **现象**：长会话（60多轮带图，请求体达 4.4 MB）下，模型请求报 `503 auth_unavailable: dial tcp 198.18.0.95:443 timeout`。
* **根因**：本地科学上网软件（如 Clash / Sing-box / KuaijiasuCore）开启 TUN 模式时，虚拟网卡的 Fake-IP（`198.18.0.x`）在持续转发数兆级大包时发生 TCP 握手超时，导致网关熔断。
* **解决**：在网关配置中引入 **智能自适应出海代理（`proxy-url: "auto"`）**，自动嗅探系统代理或常见端口（如 `7892`），让网关以标准 HTTP 代理隧道直通出海，绕过脆弱的 TUN 虚拟网卡大包转发，延迟直接从超时暴降至 150ms。

### 5. 60万 Token 喂入贵模型导致额度瞬间蒸发（2026-09-13）
* **现象**：从 Gemini 3.8 切到 Claude Opus 4.6，仅发一句话，Claude 的 5 小时额度直接被清空（100% → 0%），周额度跌去 51%。
* **根因**：会话长达 618,701 Token，Google 严格按照 Token 实际计算成本扣减额度。Opus 成本极高，单次请求吞掉 61.8 万 Token 相当于平时数千次交互。
* **解决**：确立 **262k 敏捷互切 + 1M 巨幕双轨架构**。平时使用 262k 规格，触发 DSH 自动上下文压缩机制，将对话控制在安全线内，避免误伤额度。

### 6. ZCode / 智谱 BigModel Coding Plan 逆向、官方指纹与计费通道实测（2026-09-14 ~ 2026-09-15）
* **背景**：为纳管国产旗舰代码模型（GLM-5.3 / GLM-5.3-Flash / GLM-5.2），对本地 ZCode 客户端进行逆向接入，实现免人工配置白嫖 Coding Plan。
* **技术攻关与长效机制**：
  * **凭据自动解密**：逆向确认 `~/.zcode/v2/credentials.json` 采用 AES-256-GCM（`enc:v1:` 标识），密钥基于平台、用户名和家目录动态派生（`zcode-credential-fallback:${platform}:${homedir}:${username}` 的 SHA-256 32 字节摘要），实现零配置解密。
  * **官方 3.12.1 全套客户端指纹**：逆向 `app.asar` 提取完整身份头，并在 `zcode-service.js` 中完整复刻：
    * `User-Agent: ZCode/3.12.1`、`X-ZCode-App-Version: 3.12.1`、`X-Title: Z Code@electron`
    * `X-Platform: win32-x64`、`X-Os-Category: windows`
    * `X-Client-Language: zh-CN`、`X-Client-Timezone: Asia/Shanghai`
    * `X-Device-Mid`: 动态对齐真实遥测文件 `~/.zcode/v2/telemetry-state.json`，无真实遥测时不伪造。
    * `HTTP-Referer`: 纠正为官方内部默认端点常量 `https://zcode.z.ai`。
  * **计费通道 vs 免费通道实测矩阵**：
    * **日常计费通道**：请求直接发往 `open.bigmodel.cn/api/anthropic/v1/messages`，使用裸 API Key（`x-api-key` + `Bearer`），服务端严格计费（返回 `service_tier: "standard"`），扣减 Coding Plan 订阅额度池；
    * **官方免费通道**：逆向证实客户端内置专属免费活动（如 `offPeak` 闲时任务，官方文案明确说明“免费在算力富余时段为你完成指派任务、不消耗订阅用户套餐额度”）。该通道需走 `zcode.z.ai` 网关，依赖 `zcodejwttoken` 鉴权与票据排队调度（`/api/v1/off-peak/ticket`）；
    * **隔离防线**：`zcodejwttoken` 在 `zcode.z.ai` 域有效（领票排队 200 通过），但在 `open.bigmodel.cn` 域被拒（`401 令牌已过期`）；网关消息调用存在阿里无痕验证码（`3007`）与严格上下文绑定（`3001`），纯服务端反代无法无损伪装。
  * **策略决断与安全关闭**：
    * 为彻底杜绝额度损耗风险并防范客户端账号封禁，将配置 `enableZCode: false` 与 `zcodeStandalone: false` 默认停用（提交 `f9af17b`），彻底释放 `8325` 端口；
    * `settings.yaml` 中将 `zcode-gateway` 注释关闭，提示日常享受官方免费权益请直接使用 ZCode 官方客户端；
    * 核心代码完整保留在 `src/zcode-service.js` 与 `tools/zcode-test.mjs` 中（31/31 测试全绿），日后需要时可随时开箱即用。

---

## 现在的环境资产清单

| 资产 | 物理路径 | 说明 |
|---|---|---|
| **插件工程根目录** | `~/Documents/AAA项目集/dsh-plugins/dsh-plugin-ai-gateway` | 完整源码、esbuild 构建、测试套件 |
| **已安装 profile** | `~/.dsh/profiles/web` | 已链接 `dsh-plugin-ai-gateway`，包含在 `dsh.profile.bundles` |
| **网关数据主目录** | `~/.dsh/ai-gateway`（兼容旧路径 `~/.dsh/agy-gateway`） | 存放二进制 `bin/`、密钥 `state.json`、守护运行态 `runtime.json` |
| **CLIProxyAPI 凭据区**| `~/.cli-proxy-api/` | 配置文件 `config.yaml`、Google 凭据、OpenAI Codex 凭据 |
| **ZCode 逆向与凭据区**| `~/.zcode/v2/` | 本机 ZCode 凭据 `credentials.json`、遥测 `telemetry-state.json` |
| **DSH 全局设置** | `~/.dsh/settings.yaml` | 声明了 `agy-gateway` 与 `codex-gateway` 双提供商及 23 个模型（ZCode 已注释保护） |
| **DSH 安全凭据库** | `~/.dsh/.credentials.yaml` | 托管 `AGY_GATEWAY_API_KEY`，不暴露明文密钥 |

---

## 常用运维命令速查

```bash
# 1. 自动化质量验证 (132 项门禁全跑)
cd ~/Documents/AAA项目集/dsh-plugins/dsh-plugin-ai-gateway
npm test

# 2. 重新编译 Client 与 Host Bundle (输出至 lib/)
npm run build

# 3. 安全重启 DSH Web 服务 (带端口释放探测与孤儿清理)
node tools/restart-web.mjs --yes

# 4. 重新将插件装入 profile (如切换环境或新建 profile 时)
node tools/install-into-profile.mjs --profile web

# 5. 重新生成加固版网关配置 (自动探测出海代理并保留已有密钥)
node tools/gen-config.mjs
```

---

## 发布至 npm 流程

```bash
cd ~/Documents/AAA项目集/dsh-plugins/dsh-plugin-ai-gateway

# 1. 打包预演检查 (确认仅包含 lib/, tools/, cordis.patch.yml, README 等白名单文件)
npm pack --dry-run

# 2. 运行发布前最终核验 (自动重构并跑通全部 132 项测试)
npm run verify

# 3. 提交 Git 变更
git add -A
git commit -m "feat: release v0.1.0 dsh-plugin-ai-gateway"
git push

# 4. 推送到 npm 官方源 (确保已配置官方 registry)
npm config set registry https://registry.npmjs.org/
npm publish --access public
```

发布完成后，任何 DSH 用户均可通过官方指令一键安装：
```bash
dsh plugin --profile web add dsh-plugin-ai-gateway
```
