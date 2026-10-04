/**
 * prompt-seed / 信号与短指令推断
 * ---------------------------------------------------------------------------
 * 两类输入在"补全契约"之外有专门的语义：
 *
 *   纯信号（数字、"继续"、"好"）——自身不携带任务内容，唯一的含义是"接着上文"。
 *   它要么能从上下文找到明确的未决锚点（选项 / 待答问题 / 待续动作），
 *   推断成用户想说的下一句话；要么上下文不足以支撑，明确说无法推断——
 *   绝不硬猜（42 不匹配任何选项时，"继续"就是谎）。
 *
 *   短指令（"改一下"、"不对"）——动词明确、宾语空缺，指向靠上下文消解。
 *   发散只允许发生在用户自身词语的自然子部件与隐含后续之内，
 *   不允许引入新目标 / 新技术栈 / 新数值 / 新范围。
 *
 * 本模块全部是确定性纯函数（正则 + 集合运算），零模型调用、零依赖。
 * 推断锚点由 host 半区在调用改写前完成；"度"的判定同样在这里，
 * 模型只在锚点与上限围出的栅栏里做一次定向展开。
 */

/** 信号类输出的软上限（字符）。 */
export const SIGNAL_MAX_CHARS = 120;

/** 短指令类输出的硬上限（字符）。 */
export const DEICTIC_MAX_CHARS = 180;

/** 模型端指代消解失败时的回执标记（host 检测后转为 cannot_infer）。 */
export const DEICTIC_FALLBACK_MARKER = "[无法确定指代对象]";

/** 模型端锚点不足时的回执标记。 */
export const SIGNAL_FALLBACK_MARKER = "[无法推断]";

/** 纯信号词：自身无任务内容，只有"接着上文"一种含义。 */
const SIGNAL_WORDS = /^(继续|接着|往下|go\s*on|continue|ok|okay|yes|好|好的|行|嗯|对|是|可以)$/i;

/** 短指令动词表（出现即认为是有明确指向的短指令）。 */
const DEICTIC_VERBS = /(改|修|删|去掉|换|重做|重来|重启|再来|撤销|撤回|回退|退回|跳过|停|不对|错了|不行|重试|fix|change|redo|retry|wrong)/i;

/** 短指令的长度上限（码点数）：超过则视为普通草稿走既有流程。 */
const DEICTIC_MAX_INPUT = 6;

/** 判定"问句"的形态：句尾问号，或句尾"吗/么"。 */
function isQuestion(s) {
  return /[？?]\s*$/.test(s) || /(吗|么)[。.?？]?\s*$/.test(s);
}

/** 判定"待续提议"：助手在问/提议要不要继续做某事。 */
const CONTINUATION_OFFER = /(要不要|要不要继续|需不需要|是否(要|继续|需要)|继续吗|往下吗|shall\s+i|want\s+me|should\s+i|proceed|go\s+ahead)/i;

/**
 * 分类输入：纯数字 / 纯信号词 / 短指令 / 其他。
 * @param {string} text 输入草稿。
 * @returns {{kind: 'number'|'signal'|'deictic'|'none', token: string}} 分类结果。
 */
export function classifySignalInput(text) {
  const s = typeof text === "string" ? text.trim() : "";
  if (s === "") return { kind: "none", token: s };
  if (/^[0-9]{1,4}(\.[0-9]+)?$/.test(s)) return { kind: "number", token: s };
  if (SIGNAL_WORDS.test(s)) return { kind: "signal", token: s };
  const points = Array.from(s).length;
  const hasAnchor = /[0-9/\\:@#_]/.test(s);
  if (points <= DEICTIC_MAX_INPUT && !hasAnchor && !isQuestion(s) && DEICTIC_VERBS.test(s)) {
    return { kind: "deictic", token: s };
  }
  return { kind: "none", token: s };
}

/**
 * 日志 mode 字段的对应描述。
 * @param {string} text 输入草稿。
 * @returns {'signal'|'deictic'|null} 命中信号/短指令时返回 mode 名。
 */
export function describeMode(text) {
  const { kind } = classifySignalInput(text);
  if (kind === "number" || kind === "signal") return "signal";
  if (kind === "deictic") return "deictic";
  return null;
}

/**
 * 从 surface 事件里提取最近一条**助手文本话轮**（用户话轮由
 * extractRecentContext 负责）。与既有模块同构：防御式读取，形状漂移
 * 一律降级为 undefined，绝不阻塞优化。
 * @param {{events?: unknown[]} | null | undefined} surface readSurface 的返回值。
 * @returns {{role: 'assistant', text: string} | undefined} 最近助手话轮。
 */
export function extractAssistantTail(surface) {
  if (surface === null || typeof surface !== "object") return undefined;
  const events = Array.isArray(surface.events) ? surface.events : [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === null || typeof event !== "object") continue;
    if (event.type !== "assistant/message") continue;
    const data = event.data;
    if (data === null || typeof data !== "object") continue;
    if (data.role !== undefined && data.role !== "assistant") continue;
    const text = assistantTextOf(data.content).replace(/\s+/g, " ").trim();
    if (text === "") continue;
    return { role: "assistant", text: text.length > 300 ? text.slice(0, 300) + "…" : text };
  }
  return undefined;
}

/** 助手消息 content（字符串或块数组）→ 纯文本。 */
function assistantTextOf(content) {
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

/** 选项标记：行首或分段开头的 1. / 1、/ (1) / ① 等。 */
const OPTION_MARKER = /(?:^|[\n（(\s；;，,？！!：:])\s*([0-9]{1,2})[.、)）]|([①②③④⑤⑥⑦⑧⑨⑩])/g;

/**
 * 从一段文本里解析编号选项（数字 → 选项文本）。
 * @param {string} text 助手话轮文本。
 * @returns {Map<string, string>} 选项号 → 选项内容（≤80 字）。
 */
export function parseOptions(text) {
  const map = new Map();
  if (typeof text !== "string" || text === "") return map;
  const circled = { "①": "1", "②": "2", "③": "3", "④": "4", "⑤": "5", "⑥": "6", "⑦": "7", "⑧": "8", "⑨": "9", "⑩": "10" };
  const re = new RegExp(OPTION_MARKER.source, "g");
  let m;
  while ((m = re.exec(text)) !== null) {
    const num = m[1] ?? circled[m[2]];
    if (num === undefined) continue;
    // 行内的下一个选项标记（" 2."）同样是边界，不切会把选项 2 的文本混进选项 1。
    const rest = text
      .slice(m.index + m[0].length)
      .split(/\n|；|;|\s+[0-9]{1,2}[.、)）]|\s+[①②③④⑤⑥⑦⑧⑨⑩]/)[0]
      .trim();
    if (rest === "") continue;
    map.set(num, rest.slice(0, 80));
  }
  return map;
}

/** 取文本里最后一个完整句子（按 。？！；… 切）。 */
function lastSentence(text) {
  const parts = String(text ?? "").split(/(?<=[。！？!?；;…])/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : String(text ?? "").trim();
}

/**
 * 推断未决锚点：这个信号指代的到底是上下文里的什么。
 *
 * 优先级（数字信号）：
 *   ① 助手尾部消息里的编号选项，且数字能对上 → 选项选择；
 *   ② 助手尾部消息停在待答问题上 → 数字即回答；
 *   ③ 用户自己的上一条话轮是未答问题 → 信号 = 催答/继续该问题；
 *   ④ 都不是 → 无法推断（no_pending）。
 *
 * 优先级（信号词"继续"）：
 *   ① 助手尾部是待续提议（"要不要继续…"）→ 放行该提议；
 *   ② 用户自己的未答问题 → 继续等该问题的答案；
 *   ③ 否则无法推断。
 *
 * @param {{kind: string, token: string}} classified classifySignalInput 的结果。
 * @param {{role: string, text: string}[] | undefined} userTurns 最近用户话轮。
 * @param {{role: 'assistant', text: string} | undefined} assistantTail 最近助手话轮。
 * @returns {{mode: 'choice'|'answer'|'continue'|'deictic', anchor: string, source: string}
 *         | {mode: 'none', reason: string}} 推断结果。
 */
export function inferPendingItem(classified, userTurns, assistantTail) {
  const hasUser = Array.isArray(userTurns) && userTurns.length > 0;
  const hasAssistant = assistantTail !== undefined && typeof assistantTail.text === "string" && assistantTail.text !== "";
  if (!hasUser && !hasAssistant) return { mode: "none", reason: "no_context" };
  const lastUser = hasUser ? userTurns[userTurns.length - 1].text : undefined;

  if (classified.kind === "number") {
    if (hasAssistant) {
      const options = parseOptions(assistantTail.text);
      const hit = options.get(classified.token);
      if (hit !== undefined) return { mode: "choice", anchor: hit, source: "assistant-options" };
      const sent = lastSentence(assistantTail.text);
      if (isQuestion(sent)) return { mode: "answer", anchor: sent, source: "assistant-question" };
    }
    if (lastUser !== undefined && isQuestion(lastUser)) {
      return { mode: "continue", anchor: lastUser, source: "user-question" };
    }
    return { mode: "none", reason: "no_pending" };
  }

  if (classified.kind === "signal") {
    if (hasAssistant) {
      const sent = lastSentence(assistantTail.text);
      if (CONTINUATION_OFFER.test(sent)) return { mode: "continue", anchor: sent, source: "assistant-offer" };
      if (isQuestion(sent)) return { mode: "answer", anchor: sent, source: "assistant-question" };
    }
    if (lastUser !== undefined && isQuestion(lastUser)) {
      return { mode: "continue", anchor: lastUser, source: "user-question" };
    }
    return { mode: "none", reason: "no_pending" };
  }

  // 短指令：上下文存在即可（消解交给模型端的度契约）；无上下文则无法消解。
  if (classified.kind === "deictic") {
    const anchor = hasAssistant ? assistantTail.text : lastUser;
    if (anchor !== undefined && String(anchor).trim() !== "") {
      return { mode: "deictic", anchor: String(anchor), source: hasAssistant ? "assistant-tail" : "user-tail" };
    }
    return { mode: "none", reason: "no_context" };
  }

  return { mode: "none", reason: "unclassified" };
}

/** CJK 字符集合（用于接地校验）。 */
function cjkChars(s) {
  return new Set(String(s ?? "").match(/[\u4e00-\u9fff]/g) ?? []);
}

/** 去掉软化词后，短指令的实义字（用于"动词逐字保留"校验）。 */
const SOFTENERS = /(一下|点儿|点|个|吗|吧|呢|了)/g;

/**
 * 信号展开结果的确定性校验：锚定且不越幅。
 *
 * token 的出现只在 answer 模式强制——数字本身就是答案内容；choice 模式
 * 的正确输出是"把选中选项复述成一句话"，可以不含序号本身（契约示例即如此），
 * 此时锚定校验才是真判据。
 * @param {string} output 模型输出。
 * @param {string} token 信号原词（数字/信号词）。
 * @param {string} anchor 推断锚点。
 * @param {string} [mode] 推断角色（choice/answer/continue）。
 * @returns {{ok: boolean, reason?: string}} 校验结果。
 */
export function checkSignalOutput(output, token, anchor, mode) {
  const out = String(output ?? "").trim();
  if (out === "") return { ok: false, reason: "empty" };
  if (out.includes(SIGNAL_FALLBACK_MARKER)) return { ok: false, reason: "model_fallback" };
  if (out.length > SIGNAL_MAX_CHARS * 1.6) return { ok: false, reason: "overlong" };
  if (mode === "answer" && !out.includes(token)) return { ok: false, reason: "token_missing" };
  const anchorChars = cjkChars(anchor);
  if (anchorChars.size === 0) return { ok: true };
  const outChars = cjkChars(out);
  let shared = 0;
  for (const ch of anchorChars) if (outChars.has(ch)) shared += 1;
  const need = anchorChars.size >= 4 ? 2 : 1;
  if (shared < need) return { ok: false, reason: "ungrounded" };
  return { ok: true };
}

/**
 * 短指令发散的"度"校验：动词逐字保留 + 硬上限。
 * @param {string} output 模型输出。
 * @param {string} input 用户短指令。
 * @returns {{ok: boolean, reason?: string}} 校验结果。
 */
export function checkDeicticDegree(output, input) {
  const out = String(output ?? "").trim();
  if (out === "") return { ok: false, reason: "empty" };
  if (out.includes(DEICTIC_FALLBACK_MARKER)) return { ok: false, reason: "model_fallback" };
  if (out.length > DEICTIC_MAX_CHARS) return { ok: false, reason: "overlong" };
  const content = String(input ?? "").replace(SOFTENERS, "");
  const chars = new Set(Array.from(content).filter((ch) => /[\u4e00-\u9fff a-z]/i.test(ch)));
  if (chars.size === 0) return { ok: true };
  for (const ch of chars) {
    if (!out.toLowerCase().includes(ch.toLowerCase())) return { ok: false, reason: "verb_missing" };
  }
  return { ok: true };
}
