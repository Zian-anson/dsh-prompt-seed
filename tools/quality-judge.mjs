#!/usr/bin/env node
/**
 * 0.19.0 model-based blind pre-screen. This is NOT a human review.
 * It sees only input + candidate rewrite, never the plugin version.
 * Usage: node tools/quality-judge.mjs [--start N] [--limit N]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const num = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? Number(argv[i + 1]) : fallback; };
const start = num("--start", 0);
const limit = num("--limit", 10);
function readKey() {
  try {
    const creds = readFileSync(join(homedir(), ".dsh/.credentials.yaml"), "utf8");
    const match = creds.match(/OPENCODE_GO_API_KEY:\s*(?:ref\()?([^\s)]+)/);
    if (match) return match[1];
  } catch { /* ignore */ }
  return process.env.OPENCODE_GO_API_KEY;
}
const apiKey = readKey();
const rows = JSON.parse(readFileSync(join(root, "bench", "quality-latest.json"), "utf8")).slice(start, start + limit);
const payload = rows.map((row) => ({ id: row.id, input: row.text, candidate: row.output }));
const system = "You are a strict blind evaluator of prompt rewrites. You do not know how the candidate was produced. Score each candidate from 1-5 on: fidelity (same intent/speech act, no added requirements), clarity (less ambiguity), restraint (no inflation/taskification/invention), usability (can be sent as-is). Also verdict: better/same/worse than input. Return ONLY a JSON array: [{id, fidelity, clarity, restraint, usability, verdict, note}].";
const user = "Evaluate these pairs:\n" + JSON.stringify(payload, null, 2);
const res = await fetch("https://opencode.ai/zen/go/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer " + apiKey, "x-opencode-session": "prompt-seed-judge" },
  body: JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0, reasoning_effort: "low" }),
  signal: AbortSignal.timeout(60000),
});
const data = await res.json();
const text = data?.choices?.[0]?.message?.content ?? "";
const match = text.match(/\[[\s\S]*\]/);
if (!match) { console.error(text); process.exit(1); }
const scores = JSON.parse(match[0]);
const out = join(root, "bench", "quality-judge-" + start + ".json");
writeFileSync(out, JSON.stringify(scores, null, 2) + "\n", "utf8");
console.log("wrote " + out + " (" + scores.length + " rows)");
for (const s of scores) console.log(JSON.stringify(s));
