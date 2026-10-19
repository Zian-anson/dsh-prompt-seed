/**
 * 0.19.0 最小校验：只保护空结果和明确的代码锚点。
 * 不再判断语义、语气、任务化、长度或“是否足够清楚”。
 */

// Match the entire technical token, not only the /basename suffix. Chinese prose
// adjacent to an ASCII path is not part of that path; quoted paths can contain spaces.
const EXPLICIT_ANCHOR = /https?:\/\/[^\s<>"'`，。！？；：、（）\u3400-\u9fff]+|(?:\b[A-Za-z]:[\\/]|\.{0,2}[\\/]|\b[\w.@~-]+[\\/])[\w.@~+%/\\-]+|\b[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|rb|php|vue|svelte|css|scss|html|json|ya?ml|toml|md|sql|sh)\b|\b[A-Za-z_][A-Za-z0-9]*_[A-Za-z0-9_]+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b/g;


function skeleton(text) {
  return String(text ?? "").toLowerCase().replace(/[\s，。！？；：、,.!?;:()（）"'“”「」…—-]/g, "");
}

export function isUnchanged(input, output) {
  const a = skeleton(input);
  const b = skeleton(output);
  return a !== "" && a === b;
}

export function languageDrifts(input, output) {
  const cjk = (s) => (String(s ?? "").match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length;
  const inCjk = cjk(input);
  const outCjk = cjk(output);
  if (inCjk >= 3 && outCjk === 0) return true;
  if (inCjk === 0 && outCjk >= 3) return true;
  return false;
}

/**
 * 原文中明确写出的路径/文件名/URL/camelCase/snake_case 是否仍在输出中。
 * 不检查裸数字，避免把版本号当锚点误杀。
 * @param {string} input 原文。
 * @param {string} output 结果。
 * @returns {boolean} 是否保留。
 */
export function preservesAnchors(input, output) {
  const out = String(output ?? "");
  const source = String(input ?? "");
  const tokens = (source.match(EXPLICIT_ANCHOR) ?? []).map((token) => token.replace(/[.,;:!?]+$/, ""));
  for (const match of source.matchAll(/`([^`\n]+)`/g)) tokens.push(match[1]);
  for (const token of tokens) {
    if (token.length < 2) continue;
    if (!out.includes(token)) return false;
  }
  return true;
}

/**
 * 最小校验。
 * @param {{input: string, output: string}} args 参数。
 * @returns {{ok: true, text: string, changed: boolean} | {ok: false, reason: string}} 结果。
 */
export function validateResult(args) {
  const input = typeof args?.input === "string" ? args.input : "";
  const output = typeof args?.output === "string" ? args.output.trim() : "";
  if (output === "") return { ok: false, reason: "empty_result" };
  if (languageDrifts(input, output)) return { ok: false, reason: "language_drift" };
  if (!preservesAnchors(input, output)) return { ok: false, reason: "anchor_lost" };
  return { ok: true, text: output, changed: !isUnchanged(input, output) };
}
