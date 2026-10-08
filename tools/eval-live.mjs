#!/usr/bin/env node
/**
 * 核心功能在线评测：用真实使用样本跑完整管线，给改写质量打分。
 *
 * 为什么需要它：v0.9.4 上线后真实数据暴露了三个此前无法度量的问题——
 *   ① 同一输入两次运行的膨胀比差 2.4 倍（5.46x vs 2.27x，用户手动重跑纠正）；
 *   ② 对助手的祈使指令（"想想怎么继续优化…"）被当任务展开 5.79x，用户立即撤销；
 *   ③ 而 conversational 分支每次都被采纳发送。
 * "把核心功能做好"的前提是能量化"好"：操作判定准确率、膨胀比落带率、
 * 调用预算、锚定词保全，每项来自真实点击的期望标注。
 *
 * 用法：node tools/eval-live.mjs [--quick]     （--quick 每案例只跑 1 次，不测方差）
 * 花费：每案例 2~4 次模型调用；走 ZAI_CODING_CN_API_KEY（同日常使用路由）。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { optimizePromptText } from "../src/host-core.js";

const creds = readFileSync(join(homedir(), ".dsh/.credentials.yaml"), "utf8");
function join(...parts) { return parts.join("/").replace("\/+/g", "/"); }
const keyMatch = creds.match(/ZAI_CODING_CN_API_KEY:\s*(?:ref\(|)?([^\s)]+)/);
const apiKey = keyMatch ? keyMatch[1] : process.env.ZAI_CODING_CN_API_KEY;
if (!apiKey) { console.error("[eval] 找不到 API key"); process.exit(1); }

const llm = {
  async *stream(input) {
    let text = "";
    try {
      const res = await fetch("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
        body: JSON.stringify({ model: "glm-5.2", messages: input.messages, temperature: input.temperature ?? 0.2, max_tokens: input.maxTokens ?? 1200, stream: false }),
        signal: AbortSignal.timeout(60000), // 一次挂起拖死整条评测链（实测 412s）
      });
      const data = await res.json();
      text = data?.choices?.[0]?.message?.content ?? "";
    } catch (e) {
      yield { type: "finish", reason: { kind: "error", failure: { code: "x", message: String(e) } } };
      return;
    }
    for (const piece of text.match(/[\s\S]{1,60}/g) ?? []) yield { type: "text-delta", index: 0, text: piece };
    yield { type: "finish", reason: { kind: "stop" } };
  },
};

/** 评测集：全部来自 samples.jsonl 的真实点击（或其变形），期望来自用户实际行为（采纳/撤销/重跑）。 */
const CASES = [
  { id: "seed-真种子", input: "帮我做个导出报表的功能", wantOps: ["seed"], band: [3, 15], depth: "standard" },
  { id: "seed-极短(按绝对字数)", input: "登录", wantOps: ["seed"], band: [60, 260], depth: "standard", absolute: true },
  { id: "precise-完整指令", input: "删除 src/utils/legacy.js 里未被引用的 export，跑一遍测试确认没破坏", wantOps: ["precise", "seed"], band: [0.9, 1.5], depth: "standard" },
  { id: "clarify-完整但含混", input: "帮我看看那个东西能不能用，就是昨天说的那个导出", wantOps: ["clarify", "conversational"], band: [0.8, 1.5], depth: "standard" },
  { id: "msg-问句形", input: "已重启了，然后需要我做什么", wantOps: ["conversational"], band: [0.9, 1.4], depth: "standard" },
  { id: "msg-祈使-短(今晨被撤销的)", input: "想想怎么继续优化，主要就是把最核心的优化功能做好", wantOps: ["clarify", "conversational"], band: [0.8, 1.6], depth: "standard" },
  { id: "msg-祈使-长(昨晚被重跑的)", input: "我现在核心目的是让你了解KSTAR的权威文件以及底层逻辑。然后告诉我，Harness运行的底层逻辑到底是什么，这两者之间有什么具体的关联", wantOps: ["clarify", "precise"], band: [0.8, 1.6], depth: "standard" },
  { id: "seed-长任务(可接受先例)", input: "你用微信CLI去Opensource微信群里找Richard发的有关于KSTAR的所有文件，然后进行整理归纳", wantOps: ["seed", "clarify"], band: [1, 4], depth: "standard" },
];

const quick = process.argv.includes("--quick");
// 调用数计数：延迟诊断的关键维度（一次点击拖到 80s 通常是链路层叠，不是单次慢）
let callCount = 0;
const countingLlm = { stream(input) { callCount += 1; return llm.stream(input); } };
const route = { provider: "zai-coding-cn", model: "glm-5.2" };
let passed = 0, failed = 0;
const rows = [];
for (const c of CASES) {
  const runs = [];
  const n = quick ? 1 : 2;
  for (let i = 0; i < n; i += 1) {
    const callsBefore = callCount;
    const started = Date.now();
    const r = await optimizePromptText({ llm: countingLlm, route, text: c.input, depth: c.depth });
    runs.push({ mode: r.mode ?? "-", ok: r.ok, code: r.ok ? "ok" : r.code, chars: (r.text ?? "").length, ms: Date.now() - started, calls: callCount - callsBefore });
  }
  const ratio = runs[0].chars / Math.max(1, c.input.length);
  // absolute: 案例按绝对字数判带（极短输入的倍率没有意义）
  const measured = c.absolute ? runs[0].chars : ratio;
  const variance = runs.length === 2 ? Math.abs(runs[1].chars - runs[0].chars) / Math.max(1, runs[0].chars) : 0;
  const opOk = runs.every((r) => c.wantOps.includes(r.mode));
  const bandOk = measured >= c.band[0] && measured <= c.band[1];
  const varOk = quick || variance <= 0.6;
  const allOk = opOk && bandOk && runs[0].ok && varOk;
  if (allOk) passed += 1; else failed += 1;
  rows.push({ id: c.id, ops: runs.map((r) => r.mode).join("/"), ratio: ratio.toFixed(2), band: c.band.join("-"), ok: runs[0].code, ms: runs[0].ms, calls: runs[0].calls, variance: variance.toFixed(2), verdict: allOk ? "PASS" : "FAIL " + [!opOk && "op", !bandOk && "band", !runs[0].ok && "code", !varOk && "var"].filter(Boolean).join("+") });
  console.log((allOk ? "PASS" : "FAIL") + "  " + c.id + "  op=" + rows.at(-1).ops + "  ratio=" + rows.at(-1).ratio + "  band=" + rows.at(-1).band + "  code=" + rows.at(-1).ok + "  calls=" + rows.at(-1).calls + "  " + rows.at(-1).ms + "ms" + (runs.length === 2 ? "  var=" + rows.at(-1).variance : ""));
}
console.log("\n[eval] " + passed + "/" + (passed + failed) + " 通过");
process.exit(failed === 0 ? 0 : 1);
