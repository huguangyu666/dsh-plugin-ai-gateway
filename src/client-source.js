/**
 * dsh-plugin-agy-gateway — client 端（阶段 1+2：状态面板 + 启停/登录 + 额度监控看板）
 *
 * 往 dsh 设置界面注册「反重力网关」分区；所有数据经 host 的 /agy-gateway/api/*。
 * 样式全部使用 dsh 设计系统变量（--dsw-alias-*），自动适配明暗主题。
 */
const React = require("react");
const { useState, useEffect, useCallback, useRef } = React;
const h = React.createElement;

/**
 * dsh 设计系统变量。
 * ⚠ 必须带兜底色：实测部分 token 名在产物里并不存在（例如 label-success），
 * 解析失败会让颜色变透明 —— 进度条就会看起来是白的。真实存在的语义色是
 * state-success-primary / state-warn-primary / state-error-primary。
 */
const DSW = (v, fallback) => (fallback ? `var(--dsw-alias-${v}, ${fallback})` : `var(--dsw-alias-${v})`);
/** 主按钮填充色上的前景色：dsh 未提供对应 token，与官方 UI 包同样取纯白 */
const ON_FILL = "#fff";
/** 语义色（真实 token + 兜底），以高饱和鲜艳亮绿为主，明暗主题下都极为清晰 */
const C_OK = DSW("state-success-primary", "#00c853");
const C_WARN = DSW("state-warn-primary", "#f59e0b");
const C_BAD = DSW("state-error-primary", "#ef4444");

const S = {
  wrap: { fontSize: "13px", color: DSW("label-primary") },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "10px", margin: "10px 0 14px" },
  card: { background: DSW("bg-module-platform"), border: "1px solid " + DSW("border-l2"), borderRadius: "10px", padding: "10px 12px" },
  cardLabel: { color: DSW("label-tertiary"), fontSize: "11.5px", marginBottom: "4px" },
  cardValue: { fontSize: "15px", fontWeight: 600 },
  row: { display: "flex", alignItems: "center", gap: "8px", margin: "7px 0", fontSize: "12.5px" },
  label: { color: DSW("label-secondary"), width: "120px", flex: "none" },
  mono: { fontFamily: "ui-monospace, Consolas, monospace", fontSize: "12px", color: DSW("label-primary"), wordBreak: "break-all" },
  btn: { background: DSW("button-primary-fill", "#2f6feb"), border: "none", color: ON_FILL, borderRadius: "8px", padding: "7px 16px", fontSize: "12.5px", cursor: "pointer", fontWeight: 500 },
  btnGhost: { background: "transparent", border: "1px solid " + DSW("border-l2"), color: DSW("label-primary"), borderRadius: "8px", padding: "7px 16px", fontSize: "12.5px", cursor: "pointer" },
  btnDisabled: { opacity: 0.5, cursor: "default" },
  hint: { color: DSW("label-tertiary"), fontSize: "11.5px", marginTop: "8px", lineHeight: 1.6 },
  ok: { color: C_OK },
  bad: { color: C_BAD },
  warn: { color: C_WARN },
  banner: { border: "1px solid " + DSW("border-l2"), borderRadius: "10px", padding: "10px 12px", margin: "10px 0", background: DSW("bg-module-platform") },
  link: { color: DSW("brand-primary", "#2f6feb"), wordBreak: "break-all" },
  pre: { fontFamily: "ui-monospace, Consolas, monospace", fontSize: "11.5px", color: DSW("label-secondary"), whiteSpace: "pre-wrap", margin: "6px 0 0" },
  input: { flex: "1", minWidth: "180px", background: DSW("bg-module-platform"), border: "1px solid " + DSW("border-l2"), color: DSW("label-primary"), borderRadius: "8px", padding: "6px 9px", fontSize: "12.5px", outline: "none" },
};

/** 配置表单里的文本字段 */
function Field({ label, value, onChange, mono }) {
  return h("div", { style: S.row },
    h("span", { style: S.label }, label),
    h("input", {
      style: { ...S.input, ...(mono ? { fontFamily: "ui-monospace, Consolas, monospace", fontSize: "12px" } : {}) },
      value: value === undefined || value === null ? "" : String(value),
      onChange: (e) => onChange(e.target.value),
    }));
}

/** 配置表单里的布尔字段 */
function BoolField({ label, value, onChange }) {
  return h("div", { style: S.row },
    h("span", { style: S.label }, label),
    h("input", { type: "checkbox", checked: !!value, onChange: (e) => onChange(e.target.checked) }),
    h("span", { style: { color: DSW("label-tertiary"), fontSize: "11.5px" } }, value ? "已允许" : "已禁止（默认）"));
}

function Dot({ on }) {
  return h("span", {
    style: {
      display: "inline-block", width: "8px", height: "8px", borderRadius: "50%",
      background: on ? C_OK : C_BAD, marginRight: "6px", flex: "none",
    },
  });
}

function StatCard({ label, value, tone }) {
  return h("div", { style: S.card },
    h("div", { style: S.cardLabel }, label),
    h("div", { style: { ...S.cardValue, ...(tone ? { color: tone } : {}) } }, value));
}

function Btn({ children, onClick, disabled, ghost }) {
  return h("button", {
    style: { ...(ghost ? S.btnGhost : S.btn), ...(disabled ? S.btnDisabled : {}) },
    onClick: disabled ? undefined : onClick,
    disabled: !!disabled,
  }, children);
}

const API_PREFIX = "/ai-gateway/api";

async function api(path, method, body) {
  const opts = { method: method || "GET" };
  if (body !== undefined) {
    opts.headers = { "content-type": "application/json" };
    opts.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  let r = await fetch(API_PREFIX + path, opts);
  if (r.status === 404) {
    // 兼容可能尚未热重载的 legacy 前缀
    r = await fetch("/agy-gateway/api" + path, opts);
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
  return d;
}

/** 5h / 周额度进度条（醒目鲜亮翠绿胶囊，低于阈值转黄/红） */
function QuotaBar({ label, bucket }) {
  const pct = bucket && typeof bucket.percent === "number" ? bucket.percent : null;
  const countdown = bucket?.countdown || "—";
  const measured = bucket?.source === "rate-limit-signal";
  const tone = pct === null ? DSW("label-tertiary", "#9ca3af") : pct < 15 ? C_BAD : pct < 40 ? C_WARN : C_OK;
  const width = pct === null ? "0%" : Math.min(Math.max(pct, 0), 100) + "%";

  return h("div", { style: { margin: "8px 0 12px" } },
    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: "13px" } },
      h("span", { style: { color: DSW("label-secondary"), fontWeight: 600 } },
        label,
        measured ? h("span", {
          style: {
            marginLeft: "6px",
            fontSize: "10px",
            padding: "1px 5px",
            borderRadius: "4px",
            background: C_BAD,
            color: "#fff",
            fontWeight: 600,
            verticalAlign: "middle"
          }
        }, "实测") : null),
      h("span", { style: { color: tone, fontWeight: 700, fontSize: "14px" } }, pct !== null ? pct + "%" : "—")),
    h("div", { style: { height: "8px", background: DSW("border-l2", "#eef2f6"), borderRadius: "999px", overflow: "hidden", margin: "6px 0 5px" } },
      h("div", { style: { width, height: "100%", background: tone, borderRadius: "999px", transition: "width 0.3s ease" } })),
    h("div", { style: { fontSize: "11.5px", color: DSW("label-tertiary"), fontFamily: "ui-monospace, Consolas, monospace" } }, countdown),
    measured ? h("div", { style: { fontSize: "11px", color: C_BAD, marginTop: "3px", lineHeight: 1.5 } },
      "该桶来自请求实测 429，比官方账本更可信；官方账本同步后会自动回到官方值。") : null);
}

/** 从上游报错文本里挖出关键链接（账号验证 / 了解更多），供面板直接点。 */
function extractLinks(text) {
  if (typeof text !== "string") return { validation: null, learnMore: null, message: null };
  const val = text.match(/"validation_url"\s*:\s*"([^"]+)"/);
  const learn = text.match(/"validation_learn_more_url"\s*:\s*"([^"]+)"/);
  const reason = text.match(/"validation_error_message"\s*:\s*"([^"]+)"/);
  return {
    validation: val ? val[1].replace(/\\\//g, "/") : null,
    learnMore: learn ? learn[1].replace(/\\\//g, "/") : null,
    message: reason ? reason[1] : null,
  };
}

/** 单账号额度卡片（支持 Google Antigravity 与 OpenAI Codex 账号） */
function AccountQuotaCard({ acc, mgmt, onReset, onDelete, onConsumeReset, busy }) {
  const isCodex = acc.provider === "codex" || acc.fileName?.toLowerCase().includes("codex");
  if (isCodex) {
    const codex = acc.codex || {};
    const resetCredits = acc.resetCredits ?? 0;
    const canReset = resetCredits > 0;

    return h("div", { style: { ...S.card, margin: "10px 0", padding: "14px 16px", border: "1px solid " + DSW("border-l2") } },
      // 头部：邮箱 + 状态标签 + PLUS 会员徽章
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid " + DSW("border-l2"), paddingBottom: "10px", marginBottom: "10px", flexWrap: "wrap", gap: "8px" } },
        h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
          h("span", { style: { fontWeight: 700, fontSize: "14px", fontFamily: "ui-monospace, Consolas, monospace" } }, acc.email || acc.fileName),
          h("span", { style: { fontSize: "11px", padding: "2px 8px", borderRadius: "999px", background: C_OK, color: ON_FILL, fontWeight: 600 } }, "当前"),
          h("span", { style: { fontSize: "11px", padding: "2px 8px", borderRadius: "999px", background: "rgba(0, 200, 83, 0.15)", color: C_OK, fontWeight: 700, border: "1px solid " + C_OK } }, acc.tier || "PLUS")),
        h("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
          h(Btn, {
            ghost: true,
            disabled: busy,
            onClick: () => onConsumeReset(acc.fileName, resetCredits),
            style: canReset ? { borderColor: C_OK, color: C_OK, fontWeight: 600 } : {}
          }, `🔄 重置 ${resetCredits}`),
          h(Btn, { ghost: true, disabled: busy, onClick: () => onDelete(acc.fileName, acc.email) }, "删除账号"))),

      // 第二行：Team Name 与登录信息
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "12px", color: DSW("label-secondary"), margin: "6px 0 10px", flexWrap: "wrap", gap: "4px" } },
        h("span", null, "Team Name: ", h("strong", { style: { color: DSW("label-primary") } }, acc.teamName || "个人账户")),
        acc.userId ? h("span", { style: { fontSize: "11.5px", color: DSW("label-tertiary"), fontFamily: "ui-monospace, Consolas, monospace" } }, "用户 ID: " + String(acc.userId).slice(0, 18) + "…") : null),

      // 进度条：5h 滚动额度 + Weekly 周额度
      h("div", { style: { margin: "10px 0" } },
        h(QuotaBar, { label: "5h", bucket: codex.h5 }),
        h(QuotaBar, { label: "Weekly", bucket: codex.weekly })),

      // 订阅有效期区块
      acc.subscriptionExpiry
        ? h("div", {
            style: {
              background: "rgba(0, 200, 83, 0.08)",
              border: "1px solid rgba(0, 200, 83, 0.25)",
              borderRadius: "8px",
              padding: "8px 12px",
              marginTop: "10px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: "12px",
              color: DSW("label-primary"),
              flexWrap: "wrap",
              gap: "6px"
            }
          },
          h("span", { style: { fontWeight: 600, color: C_OK } }, "📅 订阅有效期 " + acc.subscriptionExpiry.split("  ")[0]),
          h("span", { style: { fontFamily: "ui-monospace, Consolas, monospace", color: DSW("label-secondary") } }, acc.subscriptionExpiry.split("  ")[1] || ""))
        : null);
  }

  const gemini = acc.gemini || {};
  const claude = acc.claude || {};
  const links = extractLinks(mgmt?.statusMessage);
  const runtimeBad = mgmt && (mgmt.unavailable || (mgmt.status && mgmt.status !== 'active' && mgmt.status !== 'ready'));
  return h("div", { style: { ...S.card, margin: "10px 0", padding: "14px 16px" } },
    acc.rateLimitSignal
      ? h("div", {
          style: {
            marginBottom: "12px",
            padding: "9px 12px",
            borderRadius: "8px",
            border: "1px solid " + C_BAD,
            background: "rgba(239,68,68,0.08)",
            fontSize: "12px",
            lineHeight: 1.6,
            color: DSW("label-primary")
          }
        },
        h("b", { style: { color: C_BAD } }, "⚠ 实测额度已耗尽（官方账本滞后）"),
        h("div", { style: { marginTop: "3px", color: DSW("label-secondary") } },
          "触发模型 " + (acc.rateLimitSignal.model || "未知") +
          "；" + (acc.rateLimitSignal.bucket === "h5" ? "5 小时额度" : "周额度") +
          "将于 " + (acc.rateLimitSignal.resetAt ? acc.rateLimitSignal.resetAt.replace("T", " ").slice(0, 16) + " UTC" : "—") + " 恢复。"))
      : null,
    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid " + DSW("border-l2"), paddingBottom: "10px", marginBottom: "12px", flexWrap: "wrap", gap: "8px" } },
      h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
        h("span", { style: { fontWeight: 600, fontSize: "13.5px" } }, acc.email || acc.fileName),
        h("span", { style: { fontSize: "11px", padding: "2px 7px", borderRadius: "5px", background: DSW("border-l2"), color: DSW("brand-primary", "#2f6feb"), fontWeight: 500 } }, acc.tier || "Antigravity"),
        runtimeBad ? h("span", { style: { ...S.warn, fontSize: "11.5px" } }, "⚠ 运行时状态异常" + (mgmt.status ? "（" + mgmt.status + "）" : "")) : null,
        acc.error ? h("span", { style: { ...S.bad, fontSize: "11.5px" } }, "⚠ " + acc.error) : null),
      h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
        links.validation
          ? h("a", { href: links.validation, target: "_blank", rel: "noreferrer", style: { ...S.link, fontSize: "12px", alignSelf: "center" } },
              "→ 去验证账号")
          : null,
        links.learnMore
          ? h("a", { href: links.learnMore, target: "_blank", rel: "noreferrer", style: { ...S.link, fontSize: "11.5px", alignSelf: "center" } }, "了解更多")
          : null,
        mgmt?.authIndex ? h(Btn, { ghost: true, disabled: busy, onClick: () => onReset(mgmt.authIndex, acc.email) }, "重置额度") : null,
        h(Btn, { ghost: true, disabled: busy, onClick: () => onDelete(acc.fileName, acc.email) }, "删除账号"))),
    h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "20px" } },
      h("div", null,
        h("div", { style: { fontWeight: 600, fontSize: "13.5px", marginBottom: "6px", color: DSW("label-primary") } }, "Claude"),
        h(QuotaBar, { label: "5h", bucket: claude.h5 }),
        h(QuotaBar, { label: "Weekly", bucket: claude.weekly })),
      h("div", null,
        h("div", { style: { fontWeight: 600, fontSize: "13.5px", marginBottom: "6px", color: DSW("label-primary") } }, "Gemini"),
        h(QuotaBar, { label: "5h", bucket: gemini.h5 }),
        h(QuotaBar, { label: "Weekly", bucket: gemini.weekly }))),
    h("div", { style: { borderTop: "1px solid " + DSW("border-l2"), marginTop: "12px", paddingTop: "8px", fontSize: "11.5px", color: DSW("label-tertiary"), display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "6px" } },
      h("span", null, "可用 AI 积分: 正常使用中 (" + (acc.tier || "免费版") + ")"),
      acc.projectId ? h("span", { style: S.mono }, "Project: " + acc.projectId) : null));
}

function AgyGatewaySection() {
  const [st, setSt] = useState(null);
  const [cfgState, setCfgState] = useState(null);
  const [draft, setDraft] = useState(null);
  const [logs, setLogs] = useState(null);
  const [plan, setPlan] = useState(null);
  const [usage, setUsage] = useState(null);
  const [accounts, setAccounts] = useState(null);
  const [quotas, setQuotas] = useState(null);
  const [err, setErr] = useState("");
  const [act, setAct] = useState("");
  const [note, setNote] = useState("");
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      const d = await api("/status");
      setSt(d);
      setErr("");
      try { setPlan(await api("/provider-plan")); } catch { /* 指引非关键路径 */ }
      try {
        const c = await api("/plugin-config");
        setCfgState(c);
        setDraft((prev) => prev ?? { ...c.values });
      } catch { /* 配置面板非关键路径 */ }
    } catch (e) {
      setErr(e.message || String(e));
    }
  }, []);

  const loadLogs = useCallback(async () => {
    try {
      const d = await api("/logs");
      setLogs(Array.isArray(d?.lines) ? d.lines : null);
    } catch {
      setLogs(null);
    }
  }, []);

  const loadUsage = useCallback(async () => {
    try {
      const d = await api("/usage-summary?count=200");
      setUsage(d && typeof d === "object" ? d : null);
    } catch {
      setUsage(null);
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const d = await api("/accounts");
      setAccounts(d);
    } catch {
      setAccounts(null);
    }
  }, []);

  const loadQuotas = useCallback(async (fresh = false) => {
    try {
      const d = await api("/quotas" + (fresh ? "?fresh=1" : ""));
      if (d?.accounts) setQuotas(d.accounts);
    } catch {
      /* ignore */
    }
  }, []);

  const deleteAccount = useCallback(async (fileName, email) => {
    if (!window.confirm("确认删除账号「" + (email || fileName) + "」？\n这将从本地 auth-dir 中彻底移除该凭据文件。")) return;
    setAct("删除账号");
    setNote("");
    try {
      const d = await api("/accounts/delete", "POST", { fileName });
      setNote("已删除账号：" + (email || fileName));
    } catch (e) {
      setNote("删除账号失败：❌ " + (e.message || String(e)));
    }
    setAct("");
    await load();
    await loadAccounts();
    await loadQuotas(true);
  }, [load, loadAccounts, loadQuotas]);

  const resetQuota = useCallback(async (authIndex, label) => {
    if (!window.confirm("确认重置「" + label + "」的运行时额度/冷却状态？该凭据会立即重新参与路由。")) return;
    setAct("重置额度");
    setNote("");
    try {
      const d = await api("/accounts/reset-quota", "POST", { authIndex });
      setNote("已重置额度：" + label);
    } catch (e) {
      setNote("重置额度：❌ " + (e.message || String(e)));
    }
    setAct("");
    await loadAccounts();
    await loadQuotas(true);
  }, [loadAccounts, loadQuotas]);

  const consumeResetCredit = useCallback(async (fileName, availableCount) => {
    if (availableCount <= 0) {
      alert("该账号当前可用的「重置额度券」为 0 次。\n\n说明：OpenAI 官方会不定期给部分 Plus / Pro 账号赠送 Banked Rate-Limit Resets，或通过邀请好友获得。当有可用重置额度券时，点击此按钮可立即将 5h 与周额度完全回满。");
      return;
    }
    if (!window.confirm("确认消耗 1 次额度券重置当前账号的限流额度？\n（当前可用：" + availableCount + " 次）")) return;
    setAct("消耗重置券");
    setNote("");
    try {
      const d = await api("/codex/consume-reset-credit", "POST", { fileName });
      setNote("✅ " + (d.message || "重置成功！"));
    } catch (e) {
      setNote("重置额度失败：❌ " + (e.message || String(e)));
    }
    setAct("");
    await loadQuotas(true);
  }, [loadQuotas]);

  useEffect(() => {
    load();
    loadUsage();
    loadAccounts();
    loadQuotas();
    loadLogs();
    timer.current = setInterval(() => { load(); loadQuotas(); }, 10000);
    return () => clearInterval(timer.current);
  }, [load, loadUsage, loadAccounts, loadQuotas, loadLogs]);

  const saveCfg = useCallback(async () => {
    if (!draft) return;
    setAct("保存配置");
    setNote("");
    try {
      const payload = {};
      for (const k of cfgState?.editable || []) payload[k] = draft[k];
      const d = await api("/plugin-config", "POST", payload);
      setNote("配置已保存：" + Object.keys(d.applied || {}).join("、") + (d.rejected?.length ? "（忽略：" + d.rejected.join("、") + "）" : ""));
      setDraft({ ...(d.values || draft) });
      await load();
    } catch (e) {
      setNote("保存配置：❌ " + (e.message || String(e)));
    }
    setAct("");
  }, [draft, cfgState, load]);

  const run = useCallback(async (path, label) => {
    setAct(label);
    setNote("");
    try {
      const d = await api(path, "POST");
      setNote(label + "：" + (d.error ? "❌ " + d.error : d.message || (d.ok === false ? "❌ 失败" : "完成")));
    } catch (e) {
      setNote(label + "：❌ " + (e.message || String(e)));
    }
    setAct("");
    await load();
  }, [load]);

  const runLogin = useCallback(async (provider = "antigravity") => {
    const isCodex = provider === "codex";
    setAct(isCodex ? "发起 Codex 登录" : "发起 Google 登录");
    setNote("");
    try {
      const d = await api("/login", "POST", { provider });
      setNote(d.alreadyWaiting ? "正在等待浏览器授权中…" : (isCodex ? "OpenAI 登录进程已启动（本地端口 1455 回调）" : "Google 登录进程已启动（本地端口 51121 回调）"));
    } catch (e) {
      setNote("登录启动失败：❌ " + (e.message || String(e)));
    }
    setAct("");
    await load();
  }, [load]);

  const copy = useCallback(async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      setNote("已复制" + label);
    } catch (e) {
      setNote("复制失败：" + (e.message || String(e)));
    }
  }, []);

  const copyKey = useCallback(async () => {
    try {
      const d = await api("/provider-plan?revealKey=1");
      await navigator.clipboard.writeText(d.apiKey || "");
      setNote("已复制 API 密钥（粘贴到 DSH 模型设置里即可）");
    } catch (e) {
      setNote("复制密钥失败：" + (e.message || String(e)));
    }
  }, []);

  /** 一键接入：插件在 host 侧把 provider 写进 DSH 设置，并把网关密钥存进凭据库。 */
  const applyProvider = useCallback(async () => {
    const n = (plan && plan.models ? plan.models.length : 0);
    if (!window.confirm("将把网关写成一个 DSH 模型 provider（含 " + n + " 个模型），并把网关密钥存入 DSH 凭据库。\n只会写入 providers." + (plan?.providerId || "agy-gateway") + " 一项，不会改动你已有的 provider。继续？")) return;
    setAct("一键接入");
    setNote("");
    try {
      const d = await api("/provider/apply", "POST", {});
      setNote("✅ 已接入：" + d.providerId + " · " + d.models + " 个模型 · 协议 " + d.api + " · 密钥引用 " + d.apiKeyEnv);
    } catch (e) {
      setNote("一键接入：❌ " + (e.message || String(e)));
    }
    setAct("");
    await load();
  }, [plan, load]);

  /** 一键接入 ZCode / 智谱 BigModel Coding Plan */
  const applyZCodeProvider = useCallback(async () => {
    if (!window.confirm("将把 ZCode / 智谱 BigModel 写入 DSH 模型提供商（zcode-gateway，含 GLM-5.3、GLM-5.3-Flash 等）。\n不会改动你已有的其它 provider。继续？")) return;
    setAct("接入 ZCode");
    setNote("");
    try {
      const d = await api("/provider/apply", "POST", { target: "zcode" });
      setNote("✅ 已接入 ZCode：" + d.providerId + " · " + d.models + " 个模型（GLM-5.3 / GLM-5.3-Flash 等已就绪）");
    } catch (e) {
      setNote("接入 ZCode：❌ " + (e.message || String(e)));
    }
    setAct("");
    await load();
  }, [load]);

  if (err) {
    return h("div", { style: S.wrap },
      h("div", { style: { ...S.row, ...S.bad } }, "读取网关状态失败：" + err),
      h(Btn, { onClick: load }, "重试"));
  }
  if (!st) return h("div", { style: { color: DSW("label-tertiary"), fontSize: "13px", padding: "12px 0" } }, "加载中…");

  const g = st.gateway;
  const f = st.files;
  const lg = st.login || {};
  const busy = !!act;

  const missing = [];
  if (!f.bin.exists) missing.push("可执行文件");
  if (!f.config.exists) missing.push("网关配置 config.yaml");
  if (!f.state.exists) missing.push("状态文件（密钥）");

  const modelIds = g.modelIds || [];

  return h("div", { style: S.wrap },
    h("div", { style: S.grid },
      h(StatCard, { label: "网关状态", value: h("span", null, h(Dot, { on: g.running }), g.running ? "运行中" : "未运行"), tone: g.running ? C_OK : C_BAD }),
      h(StatCard, { label: "可用模型", value: g.models === null ? "—" : String(g.models) }),
      h(StatCard, { label: "已登录账号", value: String(g.accounts) }),
      h(StatCard, { label: "管理面", value: g.management || "—", tone: g.management === "ok" ? C_OK : C_BAD })),

    // —— 操作区 ——
    h("div", { style: { display: "flex", flexWrap: "wrap", gap: "8px", margin: "4px 0 10px" } },
      h(Btn, { onClick: () => run("/gateway/start", "启动网关"), disabled: busy || g.running }, busy === "启动网关" ? "启动中…" : "启动网关"),
      h(Btn, { ghost: true, onClick: () => run("/gateway/stop", "停止网关"), disabled: busy || !g.running }, busy === "停止网关" ? "停止中…" : "停止网关"),
      h(Btn, { ghost: true, onClick: () => run("/gateway/restart", "重启网关"), disabled: busy }, "重启"),
      h(Btn, { ghost: true, onClick: () => runLogin("antigravity"), disabled: busy || lg.status === "waiting" }, "登录 Google"),
      h(Btn, { ghost: true, onClick: () => runLogin("codex"), disabled: busy || lg.status === "waiting" }, "登录 Codex"),
      h(Btn, { ghost: true, onClick: () => run("/config/regenerate", "重生成配置"), disabled: busy }, "重生成配置"),
      h(Btn, { ghost: true, onClick: () => { if (window.confirm("将从缓存的发行包重新校验并解压覆盖二进制（会先停网关，装完自动拉起）。继续？")) run("/binary/install", "安装/更新二进制"); }, disabled: busy }, "校验并安装二进制"),
      h(Btn, { ghost: true, onClick: () => { load(); loadUsage(); loadQuotas(true); }, disabled: busy }, "刷新")),

    note ? h("div", { style: { ...S.row, ...(note.includes("❌") ? S.bad : S.ok) } }, note) : null,

    // —— 登录状态 ——
    lg.status && lg.status !== "idle"
      ? (() => {
          const isCodexLogin = lg.provider === "codex" || (typeof lg.url === "string" && lg.url.includes("openai.com"));
          return h("div", { style: S.banner },
            lg.status === "waiting"
              ? h("div", null,
                  h("div", { style: S.warn }, "⏳ 等待浏览器授权（约 5 分钟内有效，" + (isCodexLogin ? "OpenAI Codex" : "Google Antigravity") + "）"),
                  lg.url
                    ? h("div", { style: { marginTop: "6px" } },
                        h("a", { href: lg.url, target: "_blank", rel: "noreferrer", style: S.link }, "→ 点此打开 " + (isCodexLogin ? "OpenAI" : "Google") + " 授权页面"))
                    : h("div", { style: S.hint }, "正在获取授权链接…"),
                  h("div", { style: S.hint }, "授权完成后浏览器会跳回本机 localhost:" + (isCodexLogin ? "1455" : "51121") + "，插件会自动接住，无需粘贴任何东西。"))
              : h("div", { style: lg.status === "success" ? S.ok : S.bad },
                  (lg.status === "success" ? "✅ " : "❌ ") + (lg.message || lg.status)));
        })()
      : null,

    // —— 详情 ——
    h("div", { style: S.row }, h("span", { style: S.label }, "网关版本"), h("span", { style: S.mono }, (g.version || "未检测到") + (g.version ? "（目标 " + (plan?.releaseVersion || "") + "）" : ""))),
    h("div", { style: S.row }, h("span", { style: S.label }, "数据面地址"), h("span", { style: S.mono }, g.baseURL)),
    h("div", { style: S.row }, h("span", { style: S.label }, "出海代理"), h("span", { style: S.mono }, g.proxyUrl || "未配置（直连/TUN）")),
    h("div", { style: S.row }, h("span", { style: S.label }, "可执行文件"), h("span", { style: { ...S.mono, ...(f.bin.exists ? {} : S.bad) } }, f.bin.path)),
    h("div", { style: S.row }, h("span", { style: S.label }, "进程归属"), h("span", { style: g.managedByPlugin ? S.ok : S.hint }, g.managedByPlugin ? "由本插件启动（pid " + g.pid + "，DSH 退出时自动回收）" : "非本插件启动（停止按钮不会误杀它）")),
    h("div", { style: S.row }, h("span", { style: S.label }, "密钥"), h("span", { style: g.keysPresent ? S.ok : S.warn }, g.keysPresent ? "已就绪（数据面 + 管理面分离）" : "缺失")),

    modelIds.length > 0
      ? h("div", { style: { marginTop: "10px" } },
          h("div", { style: S.cardLabel }, "模型清单（" + modelIds.length + "）"),
          h("div", { style: { ...S.mono, marginTop: "4px" } }, modelIds.slice(0, 16).join("、") + (modelIds.length > 16 ? " …" : "")))
      : null,

    // —— 多账号额度池 & 5h/周 额度看板（完全匹配官方 Claude/Gemini 5h + Weekly 绿条）——
    h("div", { style: { marginTop: "16px" } },
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px", flexWrap: "wrap", gap: "8px" } },
        h("div", null,
          h("span", { style: { ...S.cardLabel, fontSize: "12.5px", fontWeight: 600, color: DSW("label-primary") } },
            "👥 多账号额度池（共 " + (quotas ? quotas.length : (st?.accounts?.length || 0)) + " 个账号）"),
          h("div", { style: { ...S.hint, marginTop: "2px" } },
            "多账号机制：额度耗尽或遇到 429 限流时，网关将自动顺延平滑故障转移至下一个可用账号")),
        h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
          h(Btn, { onClick: () => runLogin("antigravity"), disabled: busy || lg.status === "waiting" },
            lg.status === "waiting" && lg.provider !== "codex" ? "等待授权中…" : "➕ 登录 Google 账号"),
          h(Btn, { onClick: () => runLogin("codex"), disabled: busy || lg.status === "waiting" },
            lg.status === "waiting" && lg.provider === "codex" ? "等待授权中…" : "➕ 登录 Codex 账号"),
          h(Btn, { ghost: true, onClick: () => loadQuotas(true), disabled: busy }, "🔄 刷新额度"))),
      quotas && quotas.length > 0
        ? h("div", null, ...quotas.map((acc, i) => {
            const mgmt = (accounts?.files || []).find((f) => f.email && acc.email && f.email === acc.email)
              || (accounts?.files || []).find((f) => f.name && f.name === acc.fileName)
              || null;
            return h(AccountQuotaCard, { key: acc.fileName || i, acc, mgmt, onReset: resetQuota, onDelete: deleteAccount, onConsumeReset: consumeResetCredit, busy });
          }))
        : (accounts && accounts.source === 'gateway' && accounts.files.length > 0
            ? h("div", null, ...accounts.files.map((f, i) => h("div", { key: i, style: { ...S.row, ...S.mono } }, f.email || f.name)))
            : h("div", { style: { ...S.banner, color: DSW("label-tertiary"), textAlign: "center", padding: "14px" } },
                "暂无已连接账号。点击右上角按钮添加 Google 或 OpenAI 账号"))),

    // —— 用量汇总 ——
    usage && usage.total
      ? h("div", { style: { marginTop: "12px" } },
          h("div", { style: { display: "flex", alignItems: "center", gap: "10px" } },
            h("span", { style: S.cardLabel }, "用量汇总（管理面 usage-queue，最近 " + usage.records + " 条）"),
            h(Btn, { ghost: true, onClick: loadUsage, disabled: busy }, "刷新用量")),
          usage.records === 0
            ? h("div", { style: S.hint }, "暂无用量记录。若刚开启请求统计，需要产生新的请求才会有数据。")
            : h("div", null,
                h("div", { style: { ...S.mono, marginTop: "4px" } },
                  "请求 " + usage.total.requests + "（成功 " + usage.total.success + " / 失败 " + usage.total.failed + "）"
                  + " · token 合计 " + usage.total.totalTokens
                  + "（输入 " + usage.total.inputTokens + " / 输出 " + usage.total.outputTokens
                  + (usage.total.reasoningTokens ? " / 思考 " + usage.total.reasoningTokens : "")
                  + (usage.total.cachedTokens ? " / 缓存命中 " + usage.total.cachedTokens : "") + "）"
                  + (usage.total.avgLatencyMs ? " · 平均延迟 " + usage.total.avgLatencyMs + "ms" : "")),
                h("pre", { style: S.pre }, usage.byModel.slice(0, 8).map((m) =>
                  [m.model, "请求 " + m.requests, "token " + m.totalTokens, m.failed ? "失败 " + m.failed : "", m.avgLatencyMs ? m.avgLatencyMs + "ms" : ""].filter(Boolean).join("  ")
                ).join("\n"))))
      : null,

    // —— 运行日志 ——
    logs && logs.length > 0
      ? h("div", { style: { marginTop: "12px" } },
          h("div", { style: { display: "flex", alignItems: "center", gap: "10px" } },
            h("span", { style: S.cardLabel }, "网关运行日志（最近 " + logs.length + " 条）"),
            h(Btn, { ghost: true, onClick: loadLogs, disabled: busy }, "刷新日志"),
            h(Btn, { ghost: true, onClick: () => copy(logs.join("\n"), "日志"), disabled: busy }, "复制日志")),
          h("pre", { style: { ...S.pre, maxHeight: "160px", overflow: "auto" } }, logs.slice(-30).join("\n")))
      : null,

    // —— 插件配置（GUI 设置，写回 dsh 用户层）——
    cfgState && cfgState.values && cfgState.settingsAttached
      ? h("div", { style: { marginTop: "12px" } },
          h("div", { style: S.cardLabel }, "插件配置（保存后即时生效，写入 dsh 用户设置层）"),
          h(Field, { label: "网关端口", value: draft?.port, onChange: (v) => setDraft((p) => ({ ...p, port: v })), mono: true }),
          h(Field, { label: "目标版本", value: draft?.releaseVersion, onChange: (v) => setDraft((p) => ({ ...p, releaseVersion: v })), mono: true }),
          h(Field, { label: "可执行文件", value: draft?.binPath, onChange: (v) => setDraft((p) => ({ ...p, binPath: v })), mono: true }),
          h(Field, { label: "网关配置", value: draft?.configPath, onChange: (v) => setDraft((p) => ({ ...p, configPath: v })), mono: true }),
          h(Field, { label: "凭据目录", value: draft?.authDir, onChange: (v) => setDraft((p) => ({ ...p, authDir: v })), mono: true }),
          h(Field, { label: "出海代理", value: draft?.proxyUrl, onChange: (v) => setDraft((p) => ({ ...p, proxyUrl: v })), mono: true }),
          h(BoolField, { label: "允许远程控制", value: draft?.allowRemoteControl, onChange: (v) => setDraft((p) => ({ ...p, allowRemoteControl: v })) }),
          h(BoolField, { label: "开机自动拉起", value: draft?.autoStart, onChange: (v) => setDraft((p) => ({ ...p, autoStart: v })) }),
          h("div", { style: { marginTop: "6px" } },
            h(Btn, { onClick: saveCfg, disabled: busy }, busy === "保存配置" ? "保存中…" : "保存配置")))
      : h("div", { style: { ...S.row, ...S.hint } }, "设置服务未挂载：插件配置以 cordis.patch.yml 与默认值为准"),

    // —— DSH 接入引导 / 一键接入 ——
    plan
      ? h("div", { style: { ...S.card, marginTop: "14px" } },
          h("div", { style: S.cardLabel }, "DSH 模型接入方案"),
          h("div", { style: S.row }, h("span", { style: S.label }, "Provider ID"), h("span", { style: S.mono }, plan.providerId)),
          h("div", { style: S.row }, h("span", { style: S.label }, "Base URL"), h("span", { style: S.mono }, plan.baseURL)),
          h("div", { style: S.row }, h("span", { style: S.label }, "API 协议"),
            h("span", { style: S.mono }, plan.api + "（亦可 " + plan.alternativeApi + "，两个端点都已验证）")),
          h("div", { style: S.row }, h("span", { style: S.label }, "API 密钥"),
            h("span", { style: S.mono }, plan.apiKey || "—"),
            h(Btn, { ghost: true, onClick: copyKey }, "复制密钥")),
          h("div", { style: S.hint }, "路径：" + (plan.steps || []).join(" → ")),
          (plan.models || []).length === 0
            ? h("div", { style: { ...S.row, ...S.warn } }, "模型清单为空：先在网关侧登录账号，再回来刷新")
            : h("div", { style: { marginTop: "10px" } },
                h(Btn, { onClick: applyProvider, disabled: busy }, busy === "一键接入" ? "写入中…" : "一键接入（自动写 provider + 密钥）"),
                h("div", { style: S.hint }, "会用上面的参数与 " + (plan.models || []).length + " 个模型写入 DSH 设置（深合并，不动其它 provider），网关密钥存入 DSH 凭据库。")))
      : null,

    // —— ZCode / 智谱 BigModel Coding Plan 接入卡片 ——
    st.zcode && st.zcode.enabled
      ? h("div", { style: { ...S.card, marginTop: "14px" } },
          h("div", { style: S.cardLabel }, "ZCode / 智谱 BigModel Coding Plan (内置支持)"),
          h("div", { style: S.row },
            h("span", { style: S.label }, "凭据状态"),
            h("span", { style: S.mono }, st.zcode.ready ? ("✅ 已自动解密 (" + (st.zcode.keyMasked || "") + ")") : "❌ 未检测到本机凭据（先在 ZCode 客户端登录）")),
          h("div", { style: S.row },
            h("span", { style: S.label }, "独立服务地址"),
            h("span", { style: S.mono }, st.zcode.url || "—")),
          h("div", { style: S.row },
            h("span", { style: S.label }, "可用模型"),
            h("span", { style: S.mono }, (st.zcode.models || []).join("、"))),
          st.zcode.ready
            ? h("div", { style: { marginTop: "10px" } },
                h(Btn, { onClick: applyZCodeProvider, disabled: busy }, busy === "接入 ZCode" ? "写入中…" : "一键接入 DSH（添加 zcode-gateway）"),
                h("div", { style: S.hint }, "写入后 DSH 模型列表将出现 zcode-gateway，支持 GLM-5.3、GLM-5.3-Flash 思维链推理与工具调用；外部工具（Cursor/NextChat）亦可直连独立服务地址。"))
            : null)
      : null,

    h("div", { style: S.hint },
      "分工：模型那一列与协议翻译由 DSH 原生负责；本面板只管网关进程、登录、额度与日志。"));
}

/**
 * 模型设置页里、本网关 provider 卡片内部的内嵌状态条。
 */
function AgyProviderCardStrip(props) {
  if (!isOurs(props)) return null;

  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setSt(await api("/status")); } catch { setSt(null); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  const g = st?.gateway;
  const act = async (path) => {
    setBusy(true);
    try { await api(path, "POST"); await load(); } catch { /* ignore */ }
    setBusy(false);
  };

  return h("div", { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginTop: "8px", paddingTop: "8px", borderTop: "1px solid " + DSW("border-l2"), fontSize: "12px" } },
    h("span", { style: g?.running ? S.ok : S.warn },
      h(Dot, { on: !!g?.running }), g?.running ? "网关运行中" : st ? "网关未运行" : "读取中…"),
    g ? h("span", { style: S.label }, `${g.models ?? 0} 个模型 · ${g.accounts} 个账号 · ${g.version || "版本未知"}`) : null,
    g?.running
      ? h(Btn, { ghost: true, disabled: busy, onClick: () => act("/gateway/stop") }, "停止")
      : h(Btn, { disabled: busy, onClick: () => act("/gateway/start") }, "启动网关"),
    h("span", { style: { color: DSW("label-tertiary") } }, "完整控制台见 设置 → 反重力网关"));
}

/** 只在自己那张卡片上渲染（槽按 llm-pi-ai 家族分发，会命中 deepseek 等卡片）。 */
function isOurs(props) {
  const p = props?.provider ?? props ?? {};
  const candidates = [p.id, p.routeId, p.provider, p.settingsNs, p.name, props?.providerId, props?.routeId];
  return candidates.some((v) => typeof v === "string" && /agy-gateway|codex-gateway/i.test(v));
}

/**
 * 联动 ContextMeter 弹出气泡（底栏圆环「上下文已用」对话框）：
 * 仅当当前处于反代模型（Gemini / Claude / Codex / GPT-5 等）时，
 * 在弹出气泡底部无缝嵌入 5h 与 Weekly 反代额度条。
 * 选非反代模型（如官方 DeepSeek）时绝对不显示。
 */
function setupContextMeterQuotaInjection() {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  if (window.__dsh_agy_context_meter_injected) return;
  window.__dsh_agy_context_meter_injected = true;

  let cachedQuotas = null;
  let lastFetch = 0;

  async function getQuotas() {
    const now = Date.now();
    if (cachedQuotas && now - lastFetch < 15000) return cachedQuotas;
    try {
      const d = await api("/quotas");
      if (Array.isArray(d?.accounts) && d.accounts.length > 0) {
        cachedQuotas = d.accounts;
        lastFetch = now;
        return d.accounts;
      }
    } catch {
      /* ignore */
    }
    return cachedQuotas || [];
  }

  function isProxyActive() {
    // 检查底栏模型选择器 trigger 按钮文案或标题
    const trigger = document.querySelector('[class*="ModelSelect"][class*="trigger"], [class*="_7KE1Ra_trigger"], button[title*="Gemini"], button[title*="Claude"], button[title*="GPT-OSS"], button[title*="GPT-5"], button[title*="Codex"], button[title*="agy-"], button[title*="ai-"], button[title*="codex-"]')
      || document.querySelector('[class*="triggerLabel"]')?.closest("button");
    const text = (trigger?.getAttribute("title") || trigger?.textContent || "").toLowerCase();
    if (!text) return false;
    return text.includes("gemini")
      || text.includes("claude")
      || text.includes("gpt-oss")
      || text.includes("codex")
      || text.includes("gpt-5")
      || text.includes("gpt-6")
      || text.includes("agy-gateway")
      || text.includes("ai-gateway")
      || text.includes("codex-gateway");
  }

  const observer = new MutationObserver(() => {
    // 查找 ContextMeter 打开的 dialog panel
    const panel = document.querySelector('div[role="dialog"][aria-label*="上下文"], div[role="dialog"][aria-label*="Context"], [class*="ContextMeter_module_css_default_panel"], .JObwrW_panel');
    if (!panel) return;

    const existing = panel.querySelector("#dsh-ai-context-meter-quota") || panel.querySelector("#dsh-agy-context-meter-quota");
    if (!isProxyActive()) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;

    const container = document.createElement("div");
    container.id = "dsh-ai-context-meter-quota";
    container.style.cssText = `border-top: 1px solid ${DSW("border-l2", "#e5e7eb")}; margin-top: 10px; padding-top: 8px;`;
    container.innerHTML = `<div style="font-size:11.5px; color:${DSW("label-tertiary", "#9ca3af")}; text-align:center; padding:4px 0;">⚡ 正在加载反代额度…</div>`;
    panel.appendChild(container);

    getQuotas().then((accounts) => {
      if (!document.body.contains(container)) return;
      if (!accounts || accounts.length === 0) {
        container.innerHTML = `<div style="font-size:11.5px; color:${DSW("label-tertiary", "#9ca3af")}; text-align:center; padding:4px 0;">暂无反代账号</div>`;
        return;
      }
      const activeText = (document.querySelector('[class*="ModelSelect"][class*="trigger"], [class*="_7KE1Ra_trigger"], button[title*="Gemini"], button[title*="Claude"], button[title*="GPT"], button[title*="Codex"]')?.getAttribute("title") || "").toLowerCase();
      const preferCodex = activeText.includes("gpt-5") || activeText.includes("gpt-6") || activeText.includes("codex") || activeText.includes("o1") || activeText.includes("o3");

      const targetAcc = preferCodex
        ? (accounts.find((a) => a.provider === "codex" || a.fileName?.includes("codex")) || accounts[0])
        : (accounts.find((a) => a.provider !== "codex" && !a.fileName?.includes("codex")) || accounts[0]);

      const isCodexAcc = targetAcc.provider === "codex" || targetAcc.fileName?.includes("codex");

      const renderBar = (lbl, b) => {
        const pct = b && typeof b.percent === "number" ? b.percent : null;
        const tone = pct === null ? DSW("label-tertiary", "#9ca3af") : pct < 15 ? C_BAD : pct < 40 ? C_WARN : C_OK;
        const w = pct === null ? "0%" : Math.min(Math.max(pct, 0), 100) + "%";
        const cd = b?.countdown || "—";
        return `
          <div style="margin: 3px 0 5px;">
            <div style="display:flex; justify-content:space-between; align-items:baseline; font-size:11.5px;">
              <span style="color:${DSW("label-secondary", "#64748b")}; font-weight:600;">${lbl}</span>
              <span style="color:${tone}; font-weight:700; font-size:12px;">${pct !== null ? pct + "%" : "—"}</span>
            </div>
            <div style="height:6px; background:${DSW("border-l2", "#eef2f6")}; border-radius:999px; overflow:hidden; margin:2px 0;">
              <div style="width:${w}; height:100%; background:${tone}; border-radius:999px;"></div>
            </div>
            <div style="font-size:10.5px; color:${DSW("label-tertiary", "#9ca3af")}; font-family:ui-monospace, Consolas, monospace;">${cd}</div>
          </div>
        `;
      };

      if (isCodexAcc) {
        const codex = targetAcc.codex || {};
        container.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 6px;">
            <span style="font-size:12px; font-weight:600; color:${DSW("label-primary", "#0f1115")};">⚡ OpenAI Codex (${targetAcc.tier || "PLUS"})</span>
            <span style="font-size:11px; color:${C_OK}; font-weight:600;">🔄 重置 ${targetAcc.resetCredits ?? 0}</span>
          </div>
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div>
              <div style="font-weight:600; font-size:12px; color:${DSW("label-primary", "#0f1115")}; margin-bottom:2px;">5h 滚动额度</div>
              ${renderBar("5h", codex.h5)}
            </div>
            <div>
              <div style="font-weight:600; font-size:12px; color:${DSW("label-primary", "#0f1115")}; margin-bottom:2px;">Weekly 周额度</div>
              ${renderBar("周", codex.weekly)}
            </div>
          </div>
          ${targetAcc.subscriptionExpiry ? `<div style="font-size:10.5px; color:${DSW("label-tertiary", "#9ca3af")}; margin-top:4px; text-align:right;">📅 订阅有效至 ${targetAcc.subscriptionExpiry.split("  ")[1] || ""}</div>` : ""}
        `;
      } else {
        const gemini = targetAcc.gemini || {};
        const claude = targetAcc.claude || {};
        container.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 6px;">
            <span style="font-size:12px; font-weight:600; color:${DSW("label-primary", "#0f1115")};">⚡ 反重力额度 (${targetAcc.tier || "Google AI Pro"})</span>
            <span style="font-size:10.5px; color:${C_OK}; font-weight:600;">正常</span>
          </div>
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div>
              <div style="font-weight:600; font-size:12px; color:${DSW("label-primary", "#0f1115")}; margin-bottom:2px;">Claude</div>
              ${renderBar("5h", claude.h5)}
              ${renderBar("周", claude.weekly)}
            </div>
            <div>
              <div style="font-weight:600; font-size:12px; color:${DSW("label-primary", "#0f1115")}; margin-bottom:2px;">Gemini</div>
              ${renderBar("5h", gemini.h5)}
              ${renderBar("周", gemini.weekly)}
            </div>
          </div>
        `;
      }
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

const name = "dsh-plugin-ai-gateway";
const inject = ["slots"];

function apply(ctx) {
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      { name: "settings.section", id: "ai-gateway", order: 120, label: "AI 聚合网关" },
      AgyGatewaySection,
    ));
  // keyed 槽：键为 settingsNs（llm-pi-ai），在网关那张 provider 卡片里内嵌状态条
  ctx.slots.inject("settings.models.provider-card", () =>
    ctx.slots.register(
      { name: "settings.models.provider-card", id: "ai-gateway", key: "llm-pi-ai" },
      AgyProviderCardStrip,
    ));

  // 启动底层上下文弹出气泡的额度联动注入（仅在选反代模型时挂载）
  setupContextMeterQuotaInjection();
}

module.exports = { name, inject, apply };
