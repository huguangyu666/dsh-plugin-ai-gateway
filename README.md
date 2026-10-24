# dsh-plugin-ai-gateway (AI 聚合网关)

DeepSeek Harness 官方生态插件：**本地多渠道 AI 聚合反代网关可视化控制台**。

基于拥有 52k+ Stars 的开源内核 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)，将 **Google Antigravity（Gemini / Claude）** 与 **OpenAI Codex（GPT-5.6 / o1）** 订阅账号统一反代为标准 OpenAI 兼容接口，深度集成至 DeepSeek Harness (DSH)。

提供集 **环境部署、双通道 OAuth 授权、多账号智能轮换池、5h / Weekly 双时间窗额度大盘（0ms 极速 SWR）、自适应出海网络代理与上下文智能调优** 于一体的完整图形化控制中枢。

---

## 核心特性

### Qoder 国内版：直接登录并接入 DSH

在 **设置 → AI 聚合网关 → Qoder 国内版** 点击 **「登录并接入 DSH」**，打开浏览器中的 `qoder.cn` 授权链接。登录页面支持国内版账号，授权有效期为 15 分钟。

完成授权后自动添加 `qoder-gateway`；新会话中可选择 `Qoder · …` 模型。支持流式输出、推理内容、工具调用、令牌自动续期和积分池查询。模型清单、图像能力、上下文窗口和推理档位按账号返回的信息接入。

- 直接在现有 DSH Node 进程中运行，无需安装喜鹊或额外启动 Qoder CLI，也不依赖 CPA 在线。
- 默认反代地址为 `http://127.0.0.1:8327/v1`，对外提供 `/models` 与 `/chat/completions`。使用独立随机网关密钥，可在折叠的账号管理中复制。
- 账号凭据保存在网关 `state.json` 同级的 `qoder.json`；网关密钥自动写入 DSH 凭据服务的 `QODER_GATEWAY_API_KEY`。
- 当前界面接一个国内版账号；国际版、企业 VPC、PAT 导入和自动签到未接入面板。
- 新功能已通过假上游隔离测试；真实账号的登录与推理仍需用户在面板授权后验证。

### WorkBuddy 国内版：直接登录并接入 DSH

在 **设置 → AI 聚合网关 → WorkBuddy 国内版** 点击 **「登录并接入 DSH」**，打开显示的浏览器授权链接。
授权完成后自动添加 `workbuddy-gateway` 提供商；新会话中可选择 `WorkBuddy · …` 模型。
无需安装或运行喜鹊，也不依赖 CLIProxyAPI 在线。复用 Magpie 社区 MIT 许可的 WorkBuddy 适配模块，固定版本为 `0.1.24`。

- 浏览器登录、令牌自动续期、账号可用模型同步、积分查询；当前为一个国内版账号。
- 在 DSH 现有 Node 进程里运行 OpenAI 兼容反代，默认 `http://127.0.0.1:8326/v1`，支持流式、非流式、推理和工具调用。
- 面板展开「反代地址与账号管理」可复制密钥或退出登录。上游令牌不会出现在状态接口中。
- WorkBuddy 凭据独立保存在网关 `state.json` 同级的 `workbuddy.json`。WorkBuddy 5.6+ 的桌面加密凭据不读取，使用浏览器授权。
- 端口可通过插件配置 `workbuddyPort` 调整，修改后重启插件。

这条路径已通过假上游与临时凭据的隔离测试；真实账号的授权和模型调用仍需在本机验证。

### 1. 🌐 双通道顶级模型一网打尽
* **Google Antigravity 通道**：
  * `Gemini 3.8 Flash（262k 互切主力）` & `Gemini 3.8 Flash（1M 巨幕版）`
  * `Gemini 3.7 / 3.6 Flash`、`Gemini 3.1 Pro`、`Gemini 3.1 Flash Lite`、`Gemini Pro Agent`
  * `Claude Sonnet 4.6`、`Claude Opus 4.6 (Thinking)`
* **OpenAI Codex 通道**：
  * `GPT-5.6 Sol（旗舰深度推理）`、`GPT-5.6 Terra（全能平衡主力）`、`GPT-5.6 Luna（极速代码补全）`
  * `GPT-5.5`、`GPT-6 Astra`、`GPT-5.3 Codex Spark`、`Codex Auto Review`
  * `o1`、`o3-mini`、`GPT-4o`
* **ZCode / 智谱 BigModel Coding Plan 通道 (内置驱动)**：
  * 自动解密本机 `~/.zcode/v2/credentials.json` 秘钥，零配置白嫖 Coding Plan 额度；
  * `GLM-5.3` (旗舰深度思考·支持思维链推理与工具调用)；
  * `GLM-5.3-Flash` (极速高并发代码模型·毫秒级流式响应)；
  * `GLM-5.2`、`GLM-5-Turbo`、`GLM-4.7`、`GLM-4.6`；
  * 原生支持 OpenAI 与 Anthropic 协议双向互转，流式 `reasoning_content` 与 `tool_calls`；
  * **官方客户端指纹**：上游请求完整复刻 ZCode 3.12.1 身份头（`User-Agent: ZCode/3.12.1`、`X-Title: Z Code@electron`、`X-Platform`、`X-Os-Category`、`X-Client-Language/Timezone`、`X-Device-Mid` 取自本机真实遥测等）；
  * **计费通道说明**（逆向 app.asar + 实测）：日常消息调用走 `open.bigmodel.cn/api/anthropic` 的裸 API Key 计费通道（`service_tier: standard`，消耗套餐额度）。客户端另有专属免费通道（如"闲时任务"官方文案明示免费不耗额度），但其服务端校验（`zcode.z.ai` 网关 + `zcodejwttoken` + 票据/验证码）无法在纯服务端复刻，本插件不涉足，日常使用请直接用官方 ZCode 客户端。

### 2. 👥 多账号智能轮换池与故障转移 (Failover)
* **负载均衡**：多个 Google 或 OpenAI 账号自动按 `round-robin` 轮流调度，成倍扩充 5 小时内可用并发；
* **无缝接力**：当某一账号触碰 5 小时限流或偶发 429 时，网关在底层毫秒级平滑故障转移至可用账号，前端智能体任务不中断；
* **生命周期管理**：控制台提供一键新增 OAuth 账号、一键重置运行时熔断冷却、一键移除废弃账号。

### 3. 📊 5h 滚动 + 7 天周额度实时看板 (完全对齐官方体系)
* **高精指标**：直连官方后端 API，精确计算 Claude、Gemini、Codex 的 5 小时窗口与 7 天周额度百分比；
* **倒计时预测**：精准计算额度回满时间点（如 `1h 54m (09/13 19:40)`）；
* **高饱和状态胶囊条**：翠绿（充足 >40%）/ 黄色预警（15%~40%）/ 红色危险（<15%），状态一目了然；
* **Codex 额度重置券**：自动同步 *Banked Rate-Limit Resets* 额度券余量，支持一键满血重置；
* **底栏气泡智能联动**：底栏「上下文已用」圆环展开时，**仅在当前会话使用反代模型时自动附带额度面板**，切回原厂模型自动隐藏。

### 4. ⚡ SWR (Stale-While-Revalidate) 毫秒级极速响应
* 摆脱传统查询等待数秒的迟滞感；
* 内存级 SWR 机制，打开面板 **0~1ms 瞬时直出**；
* 后台 45s 定期异步预热对齐，保证数据既极速又新鲜。

### 5. 🔌 智能自适应出海代理 (Smart Egress Proxy)
* **三级自动探测**：标准环境变量 → Windows 注册表系统代理 → 常见本地端口主动嗅探（7890/7891/7892/10808 等）；
* 自动让网关直连本地代理端口，彻底解决大请求体（如多轮带图长对话）在 TUN 虚拟网卡 Fake-IP 模式下的 TCP 握手超时断连问题。

### 6. 🧠 262k 敏捷互切与 1M 巨幕双轨策略
* **日常主力 262k 版**：触发 DSH 自动上下文精炼压缩，在 Gemini ↔ GPT-5.6 ↔ Claude 间平级无缝秒切，不降智、不拖慢；
* **1M 巨幕版**：保留百万 Token 原始吞吐能力，专攻巨型旧工程扫描。

---

## 架构与设计分工

DSH 遵循清晰的微内核与关注点分离规范：

```
┌─────────────────────────────────────────────────────────────┐
│                      DSH 浏览器前端                          │
│  ┌───────────────────────┐       ┌───────────────────────┐  │
│  │ DSH 原生模型选择器     │       │ 本插件控制台 & 气泡    │  │
│  │ (设置 → 模型 / 底栏)  │       │ (设置 → AI 聚合网关)  │  │
│  └───────────┬───────────┘       └───────────┬───────────┘  │
└──────────────┼───────────────────────────────┼──────────────┘
               │ (标准 LLM 请求)                 │ (管理面 RPC)
┌──────────────▼───────────────────────────────▼──────────────┐
│                    DSH Node.js 宿主端                       │
│  ┌───────────────────────┐       ┌───────────────────────┐  │
│  │ @deepseek-ai/         │       │ dsh-plugin-ai-gateway │  │
│  │ dsh-llm-pi-ai         │       │ (守护管理/看门狗/SWR) │  │
│  └───────────┬───────────┘       └───────────┬───────────┘  │
└──────────────┼───────────────────────────────┼──────────────┘
               │ (127.0.0.1:8317/v1)           │ (管理端口/本地鉴权)
┌──────────────▼───────────────────────────────▼──────────────┐
│            本地加固网关进程 (CLIProxyAPI Daemon)            │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 负载均衡池 (Round-Robin) · 凭据管理器 · 代理隧道出口   │  │
│  └───────────┬───────────────────────────────┬───────────┘  │
└──────────────┼───────────────────────────────┼──────────────┘
               │                               │
┌──────────────▼────────────┐     ┌────────────▼──────────────┐
│  Google Cloud Code 后端   │     │      OpenAI Codex 后端    │
│  (Antigravity / Gemini)   │     │    (ChatGPT Plus / Team)  │
└───────────────────────────┘     └───────────────────────────┘
```

* **模型路由与协议转换**：完全归属 DSH 原生 `llm-pi-ai` 适配器（声明于 `$DSH_HOME/settings.yaml`）；
* **网关与环境治理**：归属本插件（进程保活、双向鉴权、多账号、配额采集、界面注入）。

---

## 快速上手

### 1. 安装插件
在插件工程根目录下，执行内置安装工具将其装入指定的 DSH profile：

```bash
node tools/install-into-profile.mjs --profile web
```
*或在发布到 npm 后使用官方 CLI 安装：*
```bash
dsh plugin --profile web add dsh-plugin-ai-gateway
```

### 2. 启动与重启
使用自带的幂等安全重启工具（自动验证端口、进程名与环境参数）：
```bash
node tools/restart-web.mjs --yes
```

### 3. 连接账号
1. 浏览器打开 DSH Web（`http://127.0.0.1:3080`）；
2. 导航至左侧 **「设置 → AI 聚合网关」**；
3. 点击 **`➕ 登录 Google 账号`** 或 **`➕ 登录 Codex 账号`**，在弹出链接中完成一次性 OAuth 授权；
4. 授权成功后，点击下方 **「一键接入」**，插件将自动把 `agy-gateway` 与 `codex-gateway` 配置及安全密钥写入 DSH。

---

## 安全设计

1. **绝对本地回环**：网关默认严格绑定 `127.0.0.1`，拒绝一切局域网暴露；
2. **密钥分离与凭据库隔离**：
   * 数据面 `apiKey` 与管理面 `managementKey` 完全独立生成；
   * API Key 持久化存储于 DSH 专属的 `~/.dsh/.credentials.yaml` 凭据隔离区，主配置文件仅保留引用；
3. **同源防护与远程控制阻断**：
   * 前端管理接口强制校验 `Origin`，拦截任何跨站 CSRF 请求；
   * 当 DSH 宿主绑定在非本机 IP 时，启停、删除、登录等破坏性写操作默认强制 403 拒绝；
4. **孤儿进程防护与自愈看门狗**：
   * DSH 退出或重载时，插件内置 Disposer 会精准清退底层子进程；
   * 运行时内置 60 秒轻量看门狗，意外断线自动拉起，手动停止则尊重意图保持静默。

---

## 排障手册 (Troubleshooting)

### 1. 上游返回 `403 VALIDATION_REQUIRED`
* **现象**：刚登录 Google 账号后推理报 `Verify your account to continue`；
* **原因**：Google 触发了针对新设备/新节点的安全质询；
* **解决**：点击面板账号卡片右侧的 **`→ 去验证账号`** 链接，在无痕浏览器中登录该账号并确认授权，完成后瞬间自动解禁。

### 2. 模型请求报错 `Invalid value ... thinking_level: "xhigh"` (400)
* **原因**：Google Gemini 官方枚举仅支持 `low` 与 `high`，不接受 `xhigh`；
* **解决**：在 DSH 设置中，插件已预置平滑映射：UI 上的 `xhigh` 会自动向下转换为 Google 顶格的 `high`，避免 400 报错。

### 3. 上游返回 `503 dial tcp ... i/o timeout`
* **原因**：本地代理软件开启 TUN 模式时，虚拟网卡的 Fake-IP 在转发几兆级的多轮长对话请求体时发生握手超时；
* **解决**：插件已内置 `proxy-url: "auto"` 机制，会自动直连本地代理 HTTP 端口（如 7892/7890），绕过虚拟网卡直通出海。

### 4. 上游返回 `api_error: The service is temporarily unavailable`
* **原因**：上游服务瞬时不可用、过载或网关连接抖动，不等同于请求内容错误；
* **解决**：当前插件会把这类 `api_error` 纳入请求级自愈，自动解冻受临时错误影响的账号并按 1s / 2s / 3s 退避重试，最多 3 次；重试耗尽后才把错误交给 DSH 显示。已经开始输出模型内容的半截流不会重复重跑，避免答案重复。

---

## 自动化测试集

运行不触碰真实账号的检查（构建、规范、边界、WorkBuddy / Qoder 协议与界面渲染）：

```bash
npm run test:isolated
```

单独检查 WorkBuddy：

```bash
npm run test:workbuddy
```

原有完整集成测试会启停本机 CLIProxyAPI，并在存在 ZCode 凭据时调用真实上游：

```bash
npm test
```
* **红线规范检查 (`redline-check`)**：21/21 项（编码格式、无 BOM、导出契约、产物完整性）
* **极端边界测试 (`edge-case-test`)**：17/17 项（冷启、破坏性配置、陈旧 PID、哈希不符、降级回退）
* **全功能冒烟测试 (`smoke-test`)**：84/84 项（真实网关全链路、写操作幂等、跨域拦截、凭据注入）
* **界面渲染测试 (`client-render-test`)**：含 WorkBuddy 未登录、授权等待、积分为零等分支。
* **WorkBuddy 测试 (`workbuddy-test`)**：临时凭据、假上游；验证登录、续期、鉴权、流式与非流式工具调用、错误、DSH 接入和卸载回收。
* **Qoder 测试 (`npm run test:qoder`)**：国内版浏览器授权、设备令牌回退、真实适配模块的 COSY 请求和 SSE 转换、上下文与推理档位、会话和任务保持、工具调用、排队恢复、令牌续期、错误脱敏及 DSH 一键接入。仅使用临时凭据与假上游。

---

## 开源许可

[MIT License](LICENSE)

## 鸣谢与开源致敬 (Acknowledgements & Credits)

- **Qoder 国内版适配**：复用 [yetone / Magpie 社区的 Qoder 登录插件](https://github.com/magpie-community/plugins/tree/main/packages/qoder)，固定 npm 版本 `0.2.33` 并校验 SHA-512。协议继承自 [ufec/CLIProxyAPI](https://github.com/ufec/CLIProxyAPI)，均采用 MIT 许可；本地仅对适配模块增加实例级网络与取消信号注入。完整版权、许可、校验值与改动见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

- **WorkBuddy 适配**：复用 [yetone / Magpie 社区的 WorkBuddy 登录插件](https://github.com/magpie-community/plugins/tree/main/packages/workbuddy)，采用 MIT 许可，固定 npm 版本 `0.1.24`，并校验 npm SHA-512 完整性。保留其登录、续期、模型、额度与请求适配；本地仅增加实例级网络注入及可取消的登录轮询。完整许可和校验值见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- **原有聚合反代内核**：感谢 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 提供原有 Google / Codex 多账号网关能力。
