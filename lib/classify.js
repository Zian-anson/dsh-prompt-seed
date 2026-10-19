/**
 * 0.19.0 最小分析：只判断“要不要优化”。
 * 不再有 seed/clarify/precise/chat 路由、shape、ambiguity、targetRatio。
 */

export const ROUTES = Object.freeze({
  PASSTHROUGH: "passthrough",
  OPTIMIZE: "optimize",
});

const MAX_TEXT_LENGTH = 8000;
const ACK_ONLY = /^(好了|好|好的|好嘞|好呀|行|可以|可以了|嗯|嗯嗯|哦|噢|收到|谢谢|多谢|感谢|ok|okay|sure|thanks|thank you|got it)[。.!！?？~～\s]*$/i;
const GREETING = /^(hi|hello|hey|yo|你好|您好|在吗|在么|嗨|哈喽|早上好|晚上好)[。.!！?？~～\s]*$/i;
const QUESTION = /[？?]|(吗|么|呢)[。.!！?？]?\s*$/;

/**
 * 去掉标点/空白/emoji 后是否为空，或只是招呼/确认。
 * @param {string} text 输入。
 * @returns {boolean} 是否没有可优化内容。
 */
export function isContentFree(text) {
  const s = typeof text === "string" ? text.trim() : "";
  if (s === "") return true;
  if (ACK_ONLY.test(s) || GREETING.test(s)) return true;
  if (/^(?:(?:好|好的|可以|行|ok|okay|sure)[，,、\s]*)?(?:继续吧|继续|开始吧|就这样|go ahead|please continue)[。.!！\s]*$/i.test(s)) return true;
  const stripped = s
    .replace(/[\s\u3000]/g, "")
    .replace(/[，。！？；：、,.!?;:~～…—\-_+=*&^%$#@/\\|<>()[\]{}"'“”‘’「」『』【】]/g, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/[\p{Cf}\p{Cc}]/gu, "");
  return stripped === "";
}

export function isQuestion(text) {
  return QUESTION.test(String(text ?? ""));
}

export function needsContext(text) {
  const s = String(text ?? "").trim();
  if (s === "") return false;
  if (Array.from(s).length <= 40) return true;
  return /(它|他|她|这个|那个|这些|那些|上面|上述|刚才|之前|前面|该|此|这里|那里|\bit\b|\bthis\b|\bthat\b|\bthese\b|\bthose\b|\bthe above\b|\bprevious\b|\bsame\b)/i.test(s);
}

/**
 * 只做“空/招呼/超长”判断；其余都走优化。
 * @param {string} text 输入。
 * @returns {{route: string, reasons: string[], code?: string, error?: string}} 分析结果。
 */
export function analyzeInput(text) {
  const s = typeof text === "string" ? text.trim() : "";
  if (s === "") return { route: ROUTES.PASSTHROUGH, reasons: ["empty"], code: "empty_input", error: "请先输入内容" };
  if (Array.from(s).length > MAX_TEXT_LENGTH) return { route: ROUTES.PASSTHROUGH, reasons: ["too_long"], code: "input_too_long", error: "内容过长，请精简后再优化" };
  if (isContentFree(s)) return { route: ROUTES.PASSTHROUGH, reasons: ["ack_or_greeting"] };
  return { route: ROUTES.OPTIMIZE, reasons: [] };
}

export function classify(text) {
  return analyzeInput(text);
}
