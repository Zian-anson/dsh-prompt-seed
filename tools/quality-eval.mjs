#!/usr/bin/env node
/**
 * 0.19.0 quality output collector (not a judge).
 * Usage: node tools/quality-eval.mjs [--limit N]
 * Writes bench/quality-latest.json for blind human review.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { optimizeOnce } from "../src/optimize.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const limitIndex = argv.indexOf("--limit");
const limit = limitIndex >= 0 ? Number(argv[limitIndex + 1]) : Infinity;
const startIndex = argv.indexOf("--start");
const start = startIndex >= 0 ? Number(argv[startIndex + 1]) : 0;
const outIndex = argv.indexOf("--out");
const outPath = outIndex >= 0 ? argv[outIndex + 1] : join(root, "bench", "quality-latest.json");

function readKey() {
  try {
    const creds = readFileSync(join(homedir(), ".dsh/.credentials.yaml"), "utf8");
    const match = creds.match(/OPENCODE_GO_API_KEY:\s*(?:ref\()?([^\s)]+)/);
    if (match) return match[1];
  } catch { /* ignore */ }
  return process.env.OPENCODE_GO_API_KEY;
}

const apiKey = readKey();
if (!apiKey) { console.error("[quality] OPENCODE_GO_API_KEY not found"); process.exit(1); }

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
          headers: { "content-type": "application/json", authorization: "Bearer " + apiKey, "x-opencode-session": "prompt-seed-quality" },
          body: JSON.stringify({ model: "deepseek-v4.1-flash", messages, temperature: input.temperature ?? 0.2, reasoning_effort: "low" }),
          signal: AbortSignal.timeout(30000),
        });
        const data = await res.json();
        text = data?.choices?.[0]?.message?.content ?? "";
        if (data?.choices?.[0]?.finish_reason === "length") finish = "max-tokens";
      } catch (error) {
        yield { type: "finish", reason: { kind: "error", failure: { code: "quality_error", message: String(error) } } };
        return;
      }
      for (const piece of text.match(/[\s\S]{1,80}/g) ?? []) yield { type: "text-delta", text: piece };
      yield { type: "finish", reason: { kind: finish } };
    },
  };
}

const corpus = JSON.parse(readFileSync(join(root, "bench", "quality-corpus.json"), "utf8")).slice(start, start + limit);
const rows = [];
for (const item of corpus) {
  const llm = makeLlm();
  const started = Date.now();
  const final = await optimizeOnce({ text: item.text, llm, route: { provider: "opencode-go", model: "deepseek-v4.1-flash", reasoningEffort: "low" }, requestId: "quality-" + item.id });
  const row = { ...item, output: final.text, ok: final.ok, code: final.code, reason: final.reason ?? null, calls: llm.calls.length, ms: Date.now() - started };
  rows.push(row);
  console.log((final.ok ? "OK  " : "FAIL") + " " + item.id.padEnd(20) + " " + String(row.ms).padStart(6) + "ms " + (final.ok ? "" : String(final.code) + " " + String(final.reason ?? "")));
}
writeFileSync(outPath, JSON.stringify(rows, null, 2) + "\n", "utf8");
console.log("[quality] wrote " + outPath + " with " + rows.length + " rows");
