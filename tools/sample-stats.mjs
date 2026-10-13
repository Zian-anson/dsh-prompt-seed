/**
 * prompt-seed / 样本统计（0.10.1）
 * ---------------------------------------------------------------------------
 * 一条命令回答三个迭代问题（数据说话的入口）：
 *   ① 每条路由规则（classificationSource）的量级与成败分布；
 *   ② UI 点击的延迟分位数（p50/p75/p90）——按路由规则分组；
 *   ③ 撤销率：applied 之后被 reverted 的比例（runId join）。
 *
 * 用法：npm run stats [samples.jsonl 路径]（缺省 ~/.dsh/prompt-seed/samples.jsonl）
 * 只读本地文件，不上报任何地方。
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const file =
  argv[0] !== undefined
    ? argv[0]
    : join(homedir(), ".dsh", "prompt-seed", "samples.jsonl");

const raw = await readFile(file, "utf8");
const rows = raw
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const optimizes = rows.filter((r) => r.event === "optimize");
const ui = optimizes.filter((r) => r.from === "ui");
const feedbacks = rows.filter((r) => r.event === "feedback");

// ---- ① 路由规则 × 结果分布 ----
const bySource = new Map();
for (const r of optimizes) {
  const key = r.classificationSource ?? `(未记录/${r.codeVersion ?? "?"})`;
  const cell = bySource.get(key) ?? { n: 0, ok: 0, rejected: 0, other: 0, ms: [] };
  cell.n += 1;
  if (r.code === "ok") cell.ok += 1;
  else if (r.code === "fidelity_rejected") cell.rejected += 1;
  else cell.other += 1;
  if (typeof r.ms === "number") cell.ms.push(r.ms);
  bySource.set(key, cell);
}

// ---- ② UI 延迟分位 ----
const percentile = (sorted, p) =>
  sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const fmtMs = (ms) => (ms === null ? "-" : (ms / 1000).toFixed(1) + "s");

// ---- ③ 撤销率（runId join：applied 优化 → reverted 反馈）----
const revertedRuns = new Set(
  feedbacks.filter((r) => r.kind === "reverted" && typeof r.runId === "string").map((r) => r.runId),
);
const appliedUi = ui.filter((r) => r.code === "ok" && typeof r.runId === "string");
const revertedApplied = appliedUi.filter((r) => revertedRuns.has(r.runId));

console.log(`样本文件：${file}`);
console.log(`optimize ${optimizes.length} 条（UI ${ui.length} / 脚本 ${optimizes.length - ui.length}）· feedback ${feedbacks.length} 条\n`);

console.log("① 路由规则分布（全部来源，含脚本探针）");
console.log("  classificationSource            总数   ok   拒绝   其他   p50/p90 延迟");
for (const [key, cell] of [...bySource.entries()].sort((a, b) => b[1].n - a[1].n)) {
  const ms = cell.ms.sort((a, b) => a - b);
  console.log(
    `  ${key.padEnd(30)} ${String(cell.n).padStart(4)}  ${String(cell.ok).padStart(4)}  ${String(cell.rejected).padStart(4)}  ${String(cell.other).padStart(4)}   ${fmtMs(percentile(ms, 0.5))} / ${fmtMs(percentile(ms, 0.9))}`,
  );
}

const uiMs = ui.map((r) => r.ms).filter((v) => typeof v === "number").sort((a, b) => a - b);
console.log(`\n② UI 点击延迟：p50=${fmtMs(percentile(uiMs, 0.5))} p75=${fmtMs(percentile(uiMs, 0.75))} p90=${fmtMs(percentile(uiMs, 0.9))} 最大=${fmtMs(uiMs[uiMs.length - 1] ?? null)}（n=${uiMs.length}）`);

console.log(
  `\n③ 撤销率（UI 成功写回 → 立刻撤销）：${revertedApplied.length}/${appliedUi.length}${appliedUi.length === 0 ? "" : " = " + ((revertedApplied.length / appliedUi.length) * 100).toFixed(0) + "%"}`,
);
if (revertedApplied.length > 0) {
  console.log("   被撤销的路由规则：");
  const bySrc = {};
  for (const r of revertedApplied) {
    const k = r.classificationSource ?? "(未记录)";
    bySrc[k] = (bySrc[k] ?? 0) + 1;
  }
  for (const [k, n] of Object.entries(bySrc).sort((a, b) => b[1] - a[1])) console.log(`   ${k}: ${n}`);
}
