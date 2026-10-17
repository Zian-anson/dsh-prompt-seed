/**
 * 0.19.1 单一改写契约：只改写，不回答、不执行、不审判。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROMPT_VERSION = "0.19.1";

const BASE = [
  "Rewrite the user's message into a clearer version of the same message.",
  "Do not answer it, do not execute it, and do not add requirements.",
  "",
  "Preserve:",
  "- the user's intent and speech act;",
  "- language, polarity and uncertainty;",
  "- every explicit path, file name, URL, identifier and number.",
  "",
  "If it is a question, keep it a question.",
  "If it is an opinion or complaint, make the object and criterion explicit.",
  "If it is a task, add only details directly implied by the request; do not add new features, steps, tests or acceptance criteria. Keep short tasks under 3x. Do not make a simple request more demanding than the user wrote.",
  "For a precise instruction with explicit paths or identifiers, stay near-verbatim; do not add extra steps or acceptance.",
  "Do not use headings or lists unless the input itself is a task or asks for a plan.",
  "",
  "Prefer concise. Keep the original if no improvement is possible.",
  "Output only the rewritten message.",
].join("\n");

const EXAMPLES = [
  "Example input: 现在应该已经更新了，你看看。",
  "Example output: 确认插件是否已经更新，并检查更新后的实际表现是否正常。",
  "",
  "Example input: 以后你每次修改自身插件后直接重启。",
  "Example output: 以后修改自身插件后，直接重启插件，不需要我再提醒。",
  "",
  "Example input: 帮我做个登录页。",
  "Example output: 帮我做一个登录页：包含账号/密码输入、空值校验和登录失败提示。",
].join("\n");

/**
 * 读取模板覆盖文件。
 * @param {string} [home] DSH home。
 * @returns {object} 覆盖映射。
 */
export function loadPromptOverrides(home = process.env.DSH_HOME) {
  const base = typeof home === "string" && home.trim() !== "" ? home : join(homedir(), ".dsh");
  const dir = join(base, "prompt-seed", "prompts");
  const out = {};
  for (const name of ["optimize", "seed", "clarify", "precise", "chat"]) {
    try {
      const text = readFileSync(join(dir, name + ".md"), "utf8").trim();
      if (text !== "") out[name] = text;
    } catch {
      // 缺失即内置契约
    }
  }
  return out;
}

/**
 * 渲染上下文块。
 * @param {{role: string, text: string}[] | undefined} context 上下文。
 * @returns {string} CONTEXT 段。
 */
export function renderContextBlock(context) {
  if (!Array.isArray(context) || context.length === 0) return "";
  const lines = [];
  for (const item of context) {
    if (item === null || typeof item !== "object") continue;
    const role = item.role === "assistant" ? "assistant" : "user";
    const text = typeof item.text === "string" ? item.text.replace(/\s+/g, " ").trim() : "";
    if (text === "") continue;
    lines.push("[" + role + "] " + text);
  }
  if (lines.length === 0) return "";
  return "CONTEXT (recent conversation; use ONLY to resolve references):\n" + lines.join("\n") + "\n\n";
}

/**
 * 构建唯一一次改写调用。
 * @param {string} text 原文。
 * @param {{role: string, text: string}[] | undefined} context 上下文。
 * @param {object} [overrides] 模板覆盖。
 * @returns {{system: string, user: string}} 调用参数。
 */
export function buildMinimalPrompt(text, context, overrides = {}) {
  const override = typeof overrides?.optimize === "string" && overrides.optimize.trim() !== ""
    ? overrides.optimize.trim()
    : (typeof overrides?.seed === "string" && overrides.seed.trim() !== "" ? overrides.seed.trim() : null);
  const system = override ?? (BASE + "\n\n" + EXAMPLES);
  const user = renderContextBlock(context) + [
    "INPUT:",
    String(text),
    "",
    "Rewrite it under the rules above.",
  ].join("\n");
  return { system, user };
}

/**
 * 兼容旧调用：忽略 route，只走唯一契约。
 * @param {object|string} _route 旧 route。
 * @param {string} text 原文。
 * @param {object[]} context 上下文。
 * @param {object} overrides 覆盖。
 * @returns {{system: string, user: string}} 调用参数。
 */
export function buildPrompt(_route, text, context, overrides = {}) {
  return buildMinimalPrompt(text, context, overrides);
}
