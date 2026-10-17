/**
 * 0.15.0 会话上下文：只取最近一条助手话轮 + 最近一条用户话轮，
 * 只在短草稿/指代时读取。不再注入 3 条用户话轮。
 */

import { eventMessageOf, messageTextOf, safeSlice } from "./message-text.js";

const ASSISTANT_LIMIT = 300;
const USER_LIMIT = 200;

/**
 * 判断是否需要读取上下文（短草稿或指代）。
 * @param {string} text 草稿。
 * @returns {boolean} 是否需要。
 */
export function hasAnaphora(text) {
  return /(它|他|她|这个|那个|这些|那些|上面|上述|刚才|之前|前面|该|此|这里|那里|\bit\b|\bthis\b|\bthat\b|\bthese\b|\bthose\b|\bthe above\b|\bprevious\b|\bsame\b)/i.test(String(text ?? ""));
}

export function needsContext(text) {
  const s = typeof text === "string" ? text.trim() : "";
  if (s === "") return false;
  if (Array.from(s).length <= 40) return true;
  return /(它|他|她|这个|那个|这些|那些|上面|上述|刚才|之前|前面|该|此|这里|那里|\bit\b|\bthis\b|\bthat\b|\bthese\b|\bthose\b|\bthe above\b|\bprevious\b|\bsame\b)/i.test(s);
}

/**
 * 从 surface 中取最近一条助手话轮和最近一条用户话轮（时间正序）。
 * @param {unknown} surface readSurface 返回值。
 * @returns {{role: string, text: string}[] | undefined} 上下文。
 */
export function extractContext(surface) {
  if (surface === null || typeof surface !== "object") return undefined;
  const events = Array.isArray(surface.events) ? surface.events : [];
  let assistant;
  let user;
  for (let i = events.length - 1; i >= 0 && (assistant === undefined || user === undefined); i -= 1) {
    const event = events[i];
    if (event === null || typeof event !== "object") continue;
    if (event.type !== "assistant/message" && event.type !== "user/message") continue;
    const message = eventMessageOf(event);
    if (message === undefined) continue;
    if (event.type === "user/message") {
      if (user !== undefined || message.role !== "user") continue;
      const kind = message.source?.kind;
      if (kind !== undefined && kind !== "user") continue;
      const text = messageTextOf(message.content).replace(/\s+/g, " ").trim();
      if (text === "") continue;
      user = { role: "user", text: text.length > USER_LIMIT ? safeSlice(text, 0, USER_LIMIT) + "…" : text };
    } else {
      if (assistant !== undefined) continue;
      if (message.role !== undefined && message.role !== "assistant") continue;
      const text = messageTextOf(message.content).replace(/[ \t]+/g, " ").trim();
      if (text === "") continue;
      assistant = { role: "assistant", text: text.length > ASSISTANT_LIMIT ? "…" + safeSlice(text, -ASSISTANT_LIMIT) : text };
    }
  }
  const out = [];
  if (user !== undefined) out.push(user);
  if (assistant !== undefined) out.push(assistant);
  return out.length > 0 ? out : undefined;
}

/**
 * 读取上下文；失败静默降级为无上下文。
 * @param {{sessionQuery?: object, sessionId?: string, text: string, log?: Function}} args 参数。
 * @returns {Promise<{role: string, text: string}[] | undefined>} 上下文。
 */
export async function readContext({ sessionQuery, sessionId, text, log }) {
  if (!needsContext(text)) return undefined;
  if (sessionQuery === undefined || sessionQuery === null || typeof sessionQuery.readSurface !== "function") return undefined;
  if (typeof sessionId !== "string" || sessionId === "") return undefined;
  try {
    const surface = await sessionQuery.readSurface(sessionId);
    return extractContext(surface);
  } catch (error) {
    log?.("warn", "[prompt-seed] context read failed; optimizing without it", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}


/**
 * 清晰化上下文：最近 3 条用户 + 2 条助手尾部，总长 ≤1400。
 * @param {unknown} surface readSurface 返回值。
 * @returns {{role: string, text: string}[] | undefined} 时间正序上下文。
 */
export function extractClarifyContext(surface) {
  if (surface === null || typeof surface !== "object") return undefined;
  const events = Array.isArray(surface.events) ? surface.events : [];
  const picked = [];
  let userCount = 0;
  let assistantCount = 0;
  for (let i = events.length - 1; i >= 0 && picked.length < 5; i -= 1) {
    const event = events[i];
    if (event === null || typeof event !== "object") continue;
    if (event.type !== "user/message" && event.type !== "assistant/message") continue;
    const message = eventMessageOf(event);
    if (message === undefined) continue;
    if (event.type === "user/message") {
      if (userCount >= 3 || message.role !== "user") continue;
      const kind = message.source?.kind;
      if (kind !== undefined && kind !== "user") continue;
      const text = messageTextOf(message.content).replace(/\s+/g, " ").trim();
      if (text === "") continue;
      picked.push({ role: "user", text: text.length > 300 ? safeSlice(text, 0, 300) + "…" : text });
      userCount += 1;
    } else {
      if (assistantCount >= 2) continue;
      if (message.role !== undefined && message.role !== "assistant") continue;
      const text = messageTextOf(message.content).replace(/[ \t]+/g, " ").trim();
      if (text === "") continue;
      picked.push({ role: "assistant", text: text.length > 600 ? "…" + safeSlice(text, -600) : text });
      assistantCount += 1;
    }
  }
  if (picked.length === 0) return undefined;
  picked.reverse();
  let total = 0;
  const out = [];
  for (const item of picked) {
    if (total + item.text.length > 1400) break;
    out.push(item);
    total += item.text.length;
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 读取清晰化上下文；失败静默降级。
 * @param {{sessionQuery?: object, sessionId?: string, log?: Function}} args 参数。
 * @returns {Promise<{role: string, text: string}[] | undefined>} 上下文。
 */
export async function readClarifyContext({ sessionQuery, sessionId, log }) {
  if (sessionQuery === undefined || sessionQuery === null || typeof sessionQuery.readSurface !== "function") return undefined;
  if (typeof sessionId !== "string" || sessionId === "") return undefined;
  try {
    return extractClarifyContext(await sessionQuery.readSurface(sessionId));
  } catch (error) {
    log?.("warn", "[prompt-seed] clarify context read failed", { error: String(error) });
    return undefined;
  }
}

/**
 * 预测窗口：最近 6 条 user/assistant 话轮，助手取尾部（待答问题/选项在结尾）。
 * @param {unknown} surface readSurface 返回值。
 * @returns {{turns: {role: string, text: string}[], assistantTail: string | undefined} | undefined} 窗口。
 */
export function extractPredictionContext(surface) {
  if (surface === null || typeof surface !== "object") return undefined;
  const events = Array.isArray(surface.events) ? surface.events : [];
  const picked = [];
  for (let i = events.length - 1; i >= 0 && picked.length < 6; i -= 1) {
    const event = events[i];
    if (event === null || typeof event !== "object") continue;
    if (event.type !== "user/message" && event.type !== "assistant/message") continue;
    const message = eventMessageOf(event);
    if (message === undefined) continue;
    if (event.type === "user/message") {
      if (message.role !== "user") continue;
      const kind = message.source?.kind;
      if (kind !== undefined && kind !== "user") continue;
      const text = messageTextOf(message.content).replace(/\s+/g, " ").trim();
      if (text === "") continue;
      picked.push({ role: "user", text: text.length > 300 ? safeSlice(text, 0, 300) + "…" : text });
    } else {
      if (message.role !== undefined && message.role !== "assistant") continue;
      const text = messageTextOf(message.content).replace(/[ \t]+/g, " ").trim();
      if (text === "") continue;
      picked.push({ role: "assistant", text: text.length > 800 ? "…" + safeSlice(text, -800) : text });
    }
  }
  if (picked.length === 0) return undefined;
  picked.reverse();
  let assistantTail;
  for (let i = picked.length - 1; i >= 0; i -= 1) {
    if (picked[i].role === "assistant") { assistantTail = picked[i].text; break; }
  }
  if (assistantTail === undefined) return undefined;
  return { turns: picked, assistantTail };
}

/**
 * 无条件读取预测窗口（输入框为空，没有草稿可判）。
 * @param {{sessionQuery?: object, sessionId?: string, log?: Function}} args 参数。
 * @returns {Promise<object | undefined>} 窗口。
 */
export async function readPredictionContext({ sessionQuery, sessionId, log }) {
  if (sessionQuery === undefined || sessionQuery === null || typeof sessionQuery.readSurface !== "function") return undefined;
  if (typeof sessionId !== "string" || sessionId === "") return undefined;
  try {
    return extractPredictionContext(await sessionQuery.readSurface(sessionId));
  } catch (error) {
    log?.("warn", "[prompt-seed] prediction context read failed", { error: String(error) });
    return undefined;
  }
}
