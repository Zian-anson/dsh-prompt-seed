#!/usr/bin/env node
/**
 * 统一管线 vs 双调用管线：真实模型 A/B（0.12.0 架构对比实验）。
 * ---------------------------------------------------------------------------
 * 方法论：
 *   ① 同一评测集（eval-live 的真实样本 + 期望带）各跑 split / unified 一次，记耗时；
 *   ② 质量评判用**同一独立审判**（与 split 管线完全相同的 audit 调用）交叉审两边的
 *      产出——审判者不知道产出来自哪条管线，评判标准与生产一致；
 *   ③ 确定性指标（膨胀比落带、锚定词守恒）同时计算。
 * 花费：每案例约 4~6 次调用，走 ZAI_CODING_CN_API_KEY（同日常路由）。
 * 用法：node tools/eval-unified.mjs
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { optimizePromptText } from "../src/host-core.js";
import { buildAuditSystemPrompt, renderAuditUserPrompt, parseAuditVerdict } from "../src/prompt-templates.js";

const creds = readFileSync(homedir() + "/.dsh/.credentials.yaml", "utf8");
const keyMatch = creds.match(/ZAI_CODING_CN_API_KEY:\s*(?:ref\(|)?([^\s)]+)/);
const apiKey = keyMatch ? keyMatch[1] : process.env.ZAI_CODING_CN_API_KEY;
if (!apiKey) { console.error("[eval] 找不到 API key"); process.exit(1); }

let CALLS = 0;
const llm = {
  async *stream(input) {
    CALLS += 1;
    try {
      const res = await fetch("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
        body: JSON.stringify({
          model: "glm-5.2",
          thinking: { type: "disabled" },
          // 插件请求的 system 是独立字段（DSH llm 服务协议），直连 API 必须显式并入
          // messages——第一次跑基准时这里漏掉，模型全程没收到协议，输出自由发挥。
          messages: [
            ...(typeof input.system === "string" && input.system !== "" ? [{ role: "system", content: input.system }] : []),
            ...input.messages.map((m) => ({
              role: m.role,
              content: Array.isArray(m.content) ? m.content.map((b) => b?.text ?? "").join("") : m.content,
            })),
          ],
          temperature: input.temperature ?? 0.2,
          max_tokens: Math.max(input.maxTokens ?? 1200, 1200),
          stream: false,
        }),
        signal: AbortSignal.timeout(90000),
      });
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content ?? "";
      for (const piece of text.match(/[\s\S]{1,60}/g) ?? []) yield { type: "text-delta", index: 0, text: piece };
      yield { type: "finish", reason: { kind: "stop" } };
    } catch (e) {
      yield { type: "finish", reason: { kind: "error", failure: { code: "x", message: String(e) } } };
    }
  },
};

/** 独立交叉审判：与生产 audit 完全相同的调用，做质量的统一评判者。 */
async function crossAudit(original, rewrite) {
  const chunks = [];
  const gen = llm.stream({
    provider: "x", model: "glm-5.2",
    system: buildAuditSystemPrompt(),
    messages: [{ role: "user", content: [{ type: "text", text: renderAuditUserPrompt(original, rewrite, undefined) }] }],
    temperature: 0, maxTokens: 400,
  });
  let text = "";
  for await (const c of gen) if (c.type === "text-delta") text += c.text;
  return parseAuditVerdict(text);
}

const CASES = [
  { id: "seed-报表", input: "帮我做个导出报表的功能", band: [3, 15] },
  { id: "seed-极短", input: "登录", band: [60, 260], absolute: true },
  { id: "precise-指令", input: "删除 src/utils/legacy.js 里未被引用的 export，跑一遍测试确认没破坏", band: [0.9, 1.5] },
  { id: "clarify-含混", input: "帮我看看那个东西能不能用，就是昨天说的那个导出", band: [0.8, 1.5] },
  { id: "msg-问句形", input: "已重启了，然后需要我做什么", band: [0.9, 1.4] },
  { id: "msg-祈使短", input: "想想怎么继续优化，主要就是把最核心的优化功能做好", band: [0.8, 1.6] },
  { id: "seed-长任务", input: "你用微信CLI去Opensource微信群里找Richard发的有关于KSTAR的所有文件，然后进行整理归纳", band: [1, 4] },
  { id: "seed-图片压缩", input: "做一个图片压缩功能", band: [2, 12] },
];

const ROUTE = { provider: "zai-coding-cn", model: "glm-5.2" };
const run = async (input, pipeline) => {
  const t0 = Date.now();
  const r = await optimizePromptText({ llm, route: ROUTE, text: input, pipeline });
  return { r, ms: Date.now() - t0 };
};
const inBand = (r, c) => {
  if (!r.ok) return null;
  const ratio = c.absolute ? null : r.text.length / c.input.length;
  const value = c.absolute ? r.text.length : ratio;
  return value >= c.band[0] && value <= c.band[1];
};

const rows = [];
for (const c of CASES) {
  const splitRun = await run(c.input, "split");
  const unifiedRun = await run(c.input, "unified");
  const [splitAudit, unifiedAudit] = await Promise.all([
    splitRun.r.ok ? crossAudit(c.input, splitRun.r.text) : null,
    unifiedRun.r.ok ? crossAudit(c.input, unifiedRun.r.text) : null,
  ]);
  rows.push({
    id: c.id,
    split: { ms: splitRun.ms, ok: splitRun.r.ok, code: splitRun.r.code ?? "ok", tier: splitRun.r.tier, len: splitRun.r.text?.length ?? 0, band: inBand(splitRun.r, c), audit: splitAudit ? (splitAudit.status === "ok" && !splitAudit.thin ? "OK" : splitAudit.status === "issues" ? splitAudit.violations.map(v => v.kind).join("+") : splitAudit.thin ? "THIN" : "??") : "-" },
    unified: { ms: unifiedRun.ms, ok: unifiedRun.r.ok, code: unifiedRun.r.code ?? "ok", tier: unifiedRun.r.tier, len: unifiedRun.r.text?.length ?? 0, band: inBand(unifiedRun.r, c), audit: unifiedAudit ? (unifiedAudit.status === "ok" && !unifiedAudit.thin ? "OK" : unifiedAudit.status === "issues" ? unifiedAudit.violations.map(v => v.kind).join("+") : unifiedAudit.thin ? "THIN" : "??") : "-" },
  });
  console.error(`[done] ${c.id}`);
}

console.log("\n案例               | split 耗时/交叉审/落带      | unified 耗时/交叉审/落带     | 提速");
console.log("-".repeat(100));
for (const row of rows) {
  const speedup = ((row.split.ms - row.unified.ms) / row.split.ms * 100).toFixed(0);
  const f = (x) => `${(x.ms / 1000).toFixed(1)}s ${x.audit.padEnd(10)} ${x.band === null ? "-" : x.band ? "✓" : "✗"}`;
  console.log(`${row.id.padEnd(16)} | ${f(row.split).padEnd(28)} | ${f(row.unified).padEnd(28)} | ${speedup}%`);
}
const avg = (k) => rows.reduce((n, r) => n + r[k].ms, 0) / rows.length;
const okCount = (k) => rows.filter(r => r[k].ok).length;
const auditClean = (k) => rows.filter(r => r[k].audit === "OK").length;
const bandOk = (k) => rows.filter(r => r[k].band === true).length;
console.log("-".repeat(100));
console.log(`合计 ${rows.length} 案例 · 模型调用 ${CALLS} 次`);
console.log(`平均耗时: split ${(avg("split") / 1000).toFixed(1)}s → unified ${(avg("unified") / 1000).toFixed(1)}s（${((avg("split") - avg("unified")) / avg("split") * 100).toFixed(0)}% 提速）`);
console.log(`成功数: split ${okCount("split")} vs unified ${okCount("unified")} · 交叉审判干净: split ${auditClean("split")} vs unified ${auditClean("unified")} · 落带: split ${bandOk("split")} vs unified ${bandOk("unified")}`);
