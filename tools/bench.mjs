#!/usr/bin/env node
/**
 * 0.19.0 real-model bench: one call, no maxTokens, no fake route gates.
 * Quality still needs human review; this script only measures behavior/latency.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { optimizeOnce } from "../src/optimize.js";
import { preservesAnchors } from "../src/validate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const valueOf = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
};
const outPath = valueOf("--out") ?? join(root, "bench", "latest.json");
const quick = argv.includes("--quick");

function readKey() {
  try {
    const creds = readFileSync(join(homedir(), ".dsh/.credentials.yaml"), "utf8");
    const match = creds.match(/OPENCODE_GO_API_KEY:\s*(?:ref\()?([^\s)]+)/);
    if (match) return match[1];
  } catch { /* fall through */ }
  return process.env.OPENCODE_GO_API_KEY;
}

const apiKey = readKey();
if (!apiKey) {
  console.error("[bench] OPENCODE_GO_API_KEY not found");
  process.exit(1);
}

function makeLlm() {
  const calls = [];
  return {
    calls,
    async *stream(input) {
      calls.push(input);
      let text = "";
      let finish = "stop";
      try {
        const messages = input.system ? [{ role: "system", content: input.system }, ...input.messages] : input.messages;
        const res = await fetch("https://opencode.ai/zen/go/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + apiKey,
            "x-opencode-session": "prompt-seed-bench",
          },
          body: JSON.stringify({
            model: "deepseek-v4.1-flash",
            messages,
            temperature: input.temperature ?? 0.2,
            reasoning_effort: "low",
          }),
          signal: AbortSignal.timeout(30000),
        });
        const data = await res.json();
        text = data?.choices?.[0]?.message?.content ?? "";
        if (data?.choices?.[0]?.finish_reason === "length") finish = "max-tokens";
      } catch (error) {
        yield { type: "finish", reason: { kind: "error", failure: { code: "bench_error", message: String(error) } } };
        return;
      }
      for (const piece of text.match(/[\s\S]{1,80}/g) ?? []) yield { type: "text-delta", text: piece };
      yield { type: "finish", reason: { kind: finish } };
    },
  };
}

const corpus = JSON.parse(readFileSync(join(root, "bench", "corpus.json"), "utf8"));
const cases = quick ? corpus.slice(0, 6) : corpus;
const rows = [];

for (const item of cases) {
  const llm = makeLlm();
  const started = Date.now();
  const final = await optimizeOnce({
    text: item.text,
    llm,
    route: { provider: "opencode-go", model: "deepseek-v4.1-flash", reasoningEffort: "low" },
    requestId: "bench-" + item.id + "-" + Date.now().toString(36),
  });
  const row = {
    id: item.id,
    category: item.category,
    expect: item.expect,
    route: final.route,
    ok: final.ok,
    code: final.code,
    reason: final.reason ?? null,
    changed: final.changed,
    calls: llm.calls.length,
    ms: Date.now() - started,
    chars: final.text?.length ?? 0,
    anchorOk: preservesAnchors(item.text, final.text ?? ""),
    text: final.text ?? "",
  };
  rows.push(row);
  const routeOk = row.route === item.expect;
  console.log(
    (routeOk ? "PASS" : "FAIL") + "  " + item.id.padEnd(18) +
    " route=" + row.route.padEnd(11) +
    " calls=" + row.calls +
    " " + String(row.ms).padStart(6) + "ms" +
    " chars=" + String(row.chars).padStart(4) +
    (row.ok ? "" : "  code=" + row.code + (row.reason ? " reason=" + row.reason : ""))
  );
}

const latencies = rows.map((row) => row.ms).sort((a, b) => a - b);
const percentile = (p) => latencies[Math.min(latencies.length - 1, Math.floor((latencies.length - 1) * p))];
const expectMismatch = rows.filter((row) => row.route !== row.expect);
const badCalls = rows.filter((row) => row.expect === "passthrough" ? row.calls !== 0 : row.calls !== 1);
const failures = rows.filter((row) => row.expect !== "passthrough" && row.ok !== true);
const anchorLost = rows.filter((row) => row.anchorOk !== true);
const summary = {
  cases: rows.length,
  expectMismatch: expectMismatch.length,
  badCalls: badCalls.length,
  failures: failures.length,
  anchorLost: anchorLost.length,
  p50: percentile(0.5),
  p95: percentile(0.95),
  max: latencies.at(-1) ?? 0,
  rows,
};
writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
console.log("");
console.log("[bench] p50=" + summary.p50 + "ms p95=" + summary.p95 + "ms max=" + summary.max + "ms");
console.log("[bench] expectMismatch=" + summary.expectMismatch + " badCalls=" + summary.badCalls + " failures=" + summary.failures + " anchorLost=" + summary.anchorLost);
console.log("[bench] written " + outPath);
process.exit(expectMismatch.length > 0 || badCalls.length > 0 || failures.length > 0 || anchorLost.length > 0 || summary.p95 > 8000 ? 1 : 0);
