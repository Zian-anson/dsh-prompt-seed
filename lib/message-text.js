/**
 * prompt-seed / 消息内容 → 纯文本
 * ---------------------------------------------------------------------------
 * 会话两处（用户话轮提取、助手话轮提取）需要同一条转换：DSH 的消息 content
 * 既可能是字符串，也可能是块数组（只取 text 块，其余类型忽略）。
 *
 * 这份逻辑此前在两个模块里各写了一遍（session-context.textOfBlocks 与
 * signal-inference.assistantTextOf），逐字节相同——两处独立演进意味着
 * 一边支持了新块类型、另一边静默丢掉正文，而这种不一致只在特定消息形态下
 * 才会显形。抽到一处，两半共用。
 *
 * 纯函数、零依赖、防御式：任何形状漂移都降级为空串，绝不抛。
 */

/**
 * 从消息 content（字符串或块数组）里提取纯文本。
 * @param {unknown} content 消息内容。
 * @returns {string} 拼接后的文本（多个 text 块以空格连接）。
 */
/**
 * 取一条会话事件的**消息载荷**（把两种真实形状归一）。
 *
 * 为什么需要它（0.9.6 实测定位）：host 的助手事件把消息嵌在 `data.message` 里
 *   { type: "assistant/message", data: { turn, step, message: { role, content } } }
 * 而用户事件是平铺的
 *   { type: "user/message",      data: { content, source } }
 * 早先两处提取都按平铺读助手事件（`data.role` / `data.content`），于是
 * **助手尾部永远是空的**且不报错——预测分支因此每次都中性拒绝，信号分支的
 * "锚点"也只剩用户话轮。直接从线上会话日志确认了形状之后补上归一。
 * 两种形状都认；读不到就返回 undefined，绝不抛。
 * @param {unknown} event 会话事件。
 * @returns {{role?: unknown, content?: unknown, source?: unknown} | undefined} 归一后的载荷。
 */
export function eventMessageOf(event) {
  if (event === null || typeof event !== "object") return undefined;
  const data = event.data;
  if (data === null || typeof data !== "object") return undefined;
  const nested = data.message;
  if (nested !== null && typeof nested === "object") {
    return {
      role: nested.role !== undefined ? nested.role : data.role,
      content: nested.content !== undefined ? nested.content : data.content,
      source: data.source,
    };
  }
  return { role: data.role, content: data.content, source: data.source };
}

/**
 * 从消息 content（字符串或块数组）里提取纯文本。
 * @param {unknown} content 消息内容。
 * @returns {string} 拼接后的文本（多个 text 块以空格连接）。
 */
export function messageTextOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join(" ");
}

/**
 * 代理对安全的 String.prototype.slice（T-debug-F6）。
 *
 * 定长截断（上下文窗口、预测预算、日志预览）此前直接用 slice，切点落在
 * 代理对中间时产出的孤立代理会一路漏进 LLM prompt、预测结果甚至用户输入框
 * （预测校验不查 UTF-16 合法性，照样放行）。emoji（U+1F300+）与 CJK 扩展 B
 * 在 UTF-16 里都是代理对，中文输入撞上是常态而非边角。
 *
 * 规则：切完之后，首字符若是孤立的低位代理（切点落在对中间，取到了后半），
 * 或末字符若是孤立的高位代理（取到了前半），丢掉那半个——两边都不会把非法
 * UTF-16 交给下游。参数语义与 slice 相同（支持负数起始），只实现本包用到的
 * 两种形态：slice(0, n) 与 slice(-n)。
 * @param {unknown} text 待截断文本。
 * @param {number} start 起始下标（可为负：从尾部数）。
 * @param {number} [end] 结束下标（缺省到末尾）。
 * @returns {string} 截断结果，绝不以半个代理对开头或结尾。
 */
export function safeSlice(text, start, end) {
  const s = String(text ?? "");
  const out = end === undefined ? s.slice(start) : s.slice(start, end);
  if (out === "") return out;
  const first = out.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) return out.slice(1);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) return out.slice(0, -1);
  return out;
}

// ---------------------------------------------------------------------------
// 句子与字符集工具（0.10.0 去重）：此前 cjkChars / latinWords / lastSentence 在
// signal-inference 与 prediction 里各写一份、逐字节相同——两处独立演进意味着
// 一边修了切句 bug、另一边静默保留（messageTextOf 抽取时同样的教训）。
// ---------------------------------------------------------------------------

/**
 * 文本里的 CJK 字符集合（接地校验用）。
 * @param {unknown} s 文本。
 * @returns {Set<string>} 出现过的 CJK 字符。
 */
export function cjkCharSet(s) {
  return new Set(String(s ?? "").match(/[\u4e00-\u9fff]/g) ?? []);
}

/**
 * 文本里的拉丁词集合（小写化；接地校验用）。
 * @param {unknown} s 文本。
 * @returns {Set<string>} 出现过的 ≥3 字符拉丁词。
 */
export function latinWordSet(s) {
  return new Set(String(s ?? "").toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
}

/** 句读边界（中英句号/问叹/分号/省略）。切句保持句尾标点。 */
const SENTENCE_BOUNDARY = /(?<=[。！？!?；;…])/;

/**
 * 取文本里最后一个完整句子；没有边界时返回整段 trim。
 * @param {unknown} s 文本。
 * @returns {string} 最后一句。
 */
export function lastSentenceOf(s) {
  const parts = String(s ?? "")
    .split(SENTENCE_BOUNDARY)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : String(s ?? "").trim();
}

/**
 * 取文本里最后一个命中样式的完整句子（从后往前扫）。
 *
 * 用途：锚点不一定在末句——「要不要继续？1. … 2. …」的提议在倒数第二句，
 * 末句是选项行。只看 lastSentenceOf 会把这类标准锚点判成"无锚点"。
 * @param {unknown} s 文本。
 * @param {RegExp} pattern 句子级样式。
 * @returns {string | undefined} 最后一个命中句子；没有则 undefined。
 */
export function lastMatchingSentenceOf(s, pattern) {
  const parts = String(s ?? "")
    .split(SENTENCE_BOUNDARY)
    .map((part) => part.trim())
    .filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (pattern.test(parts[i])) return parts[i];
  }
  return undefined;
}
