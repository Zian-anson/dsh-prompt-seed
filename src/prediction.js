/**
 * prompt-seed / 下一步输入预测（0.9.6）
 * ---------------------------------------------------------------------------
 * 与既有三个分支（补全 / 信号 / 短指令）的关系：那些分支都作用在**用户已经写下的草稿**上，
 * 本模块反过来——输入框是空的，要产出用户"接下来最可能发的那句话"。
 *
 * 为什么按上下文分型而不是固定长度：可预测的东西本身随语境变。助手给了编号选项时，
 * 用户下一句就是选一个；助手停在提问上时，下一句是回答；任务刚交付完时，下一句是
 * 下一个动作。固定长度只有两种结局——把"选 2"撑成一段废话，或把"下一步动作"压成
 * 半句。分型由**确定性规则**判定（编号选项 / 待续提议 / 待答问句 / 失败尾 /
 * 交付痕迹 + 工具活动），零额外模型调用；模型只在选定分型的字数预算里写一句。
 *
 * 找不到锚点时**中性拒绝**（与信号分支的 cannot_infer 同构）：预测不出来的正确反应
 * 是不说话，不是硬猜一句"继续"——那句"继续"在 42 不匹配任何选项时就是谎。
 *
 * 本模块是纯函数层：零模型调用、零依赖（只读 signal-inference 的既有判据），
 * 因此可以被 node --test 直接加载。
 */

import { CONTINUATION_OFFER, isQuestion, parseOptions } from "./signal-inference.js";
import { cjkCharSet, latinWordSet, lastSentenceOf, safeSlice } from "./message-text.js";

/** 模型端"这个语境推不出下一步"的回执标记（host 检测后转为 cannot_predict）。 */
export const PREDICT_FALLBACK_MARKER = "[NO PREDICTION]";

/** 分型 → 字数预算（字符）。预算写进 prompt，并由 checkPredictionOutput 强制。 */
export const PREDICT_BUDGETS = Object.freeze({
  choice: 20,
  answer: 40,
  continue: 20,
  "next-step": 40,
  repair: 40,
});

/** 全局硬上限：任何分型都不允许超过它。 */
export const PREDICT_HARD_LIMIT = 80;

/** 分型 → 面向用户的中文说明（进日志与 detail，不进界面文案）。 */
export const PREDICT_KIND_LABELS = Object.freeze({
  choice: "选择助手给出的选项",
  answer: "回答助手的提问",
  continue: "确认继续",
  "next-step": "对刚交付的工作给出下一步",
  repair: "针对刚发生的失败给出修复/重试",
});

/** 选项线索：助手在问"选哪个"，而不是在列步骤。 */
const CHOICE_CUE = /(选|选择|哪个|哪一种|哪种|方案|选项|版本|你想|你希望|你要|prefer|which|option)/i;

/** 失败线索：助手尾部在报告失败。 */
const FAILURE_CUE =
  /(失败|报错|出错|错误|异常|无法|没能|未能|超时|不存在|未找到|没有找到|不通过|拒绝|failed|failure|error|timeout|not found|missing|cannot|unable)/i;

/** 交付线索：助手尾部在报告"做完了一件事"。 */
const DELIVERY_CUE =
  /(完成|已完成|已改|已加|已修|已更新|已删|已提交|已部署|已实现|改好|加好|修好|实现|搞定|就绪|通过|created|updated|implemented|added|fixed|removed|done|completed|ready|passes|passing)/i;

/** 取文本里最后一个完整句子（共享工具见 message-text.js）。 */

/** 取文本尾部若干字符（锚点几乎总在尾部；头部是铺垫；代理对安全见 safeSlice）。 */
function tailPortion(text, limit) {
  const s = String(text ?? "");
  return s.length > limit ? safeSlice(s, -limit) : s;
}

/**
 * 判定"用户下一句"的锚点类型。
 *
 * 优先级（命中即返回，越靠前越具体）：
 *   ① 编号选项 + 选项线索 → choice（助手在让用户选）
 *   ② 尾句是待续提议       → continue（"要不要继续…"）
 *   ③ 尾句是问句           → answer（直接回答）
 *   ④ 尾部在报失败         → repair
 *   ⑤ 尾部有交付痕迹，或本轮真的调用过工具 → next-step
 *   ⑥ 都不是               → none（中性拒绝，绝不硬猜）
 *
 * 为什么 ⑤ 要求"交付痕迹或工具活动"：仅仅"助手说了一段话"不足以支撑预测——
 * 那时最可能的下一句可以是任何东西。工具活动是"这轮真的干了活"的客观证据
 * （在最后一轮用户话轮之后出现过 tool/* 事件），交付词是它的文本替身。
 *
 * @param {{assistantTail?: string, sawToolActivity?: boolean}} input 会话尾部事实。
 * @returns {{kind: 'choice'|'answer'|'continue'|'next-step'|'repair', anchor: string,
 *            source: string, options?: string[]} | {kind: 'none', reason: string}} 判定结果。
 */
export function classifyPredictionAnchor(input) {
  const raw = input !== null && typeof input === "object" ? input : {};
  const tail = typeof raw.assistantTail === "string" ? raw.assistantTail.replace(/\s+/g, " ").trim() : "";
  if (tail === "") return { kind: "none", reason: "no_assistant_tail" };
  const sentence = lastSentenceOf(tail);

  const options = parseOptions(tail);
  // 选项线索二选一（T-debug-M2）：显式的"选哪个"措辞，或"要不要继续？1. … 2. …"
  // 形态——提议 + 编号选项同样是让用户挑，用户下一句就是选一个。只认 CHOICE_CUE
  // 时这个标准句式（插件自己模板里的示范锚点）会漏成 none，预测按钮表现为
  // "永远推不出来"。
  if (options.size >= 2 && (CHOICE_CUE.test(tail) || CONTINUATION_OFFER.test(tail))) {
    return {
      kind: "choice",
      anchor: sentence,
      source: "assistant-options",
      options: Array.from(options.values()),
    };
  }
  if (CONTINUATION_OFFER.test(sentence)) {
    return { kind: "continue", anchor: sentence, source: "assistant-offer" };
  }
  if (isQuestion(sentence)) {
    return { kind: "answer", anchor: sentence, source: "assistant-question" };
  }
  const failing = tailPortion(tail, 240);
  if (FAILURE_CUE.test(failing)) {
    return { kind: "repair", anchor: failing, source: "assistant-failure" };
  }
  if (raw.sawToolActivity === true) {
    return { kind: "next-step", anchor: tailPortion(tail, 240), source: "tool-activity" };
  }
  if (DELIVERY_CUE.test(tail)) {
    return { kind: "next-step", anchor: tailPortion(tail, 240), source: "delivery-markers" };
  }
  return { kind: "none", reason: "no_anchor" };
}

/**
 * 预测结果是否与锚点共享内容。
 * 中文按字重叠（≥2 字），拉丁按词重叠（≥1 词）；两者都没有时判为不接地。
 * @param {string} output 模型输出。
 * @param {string} anchor 锚点文本。
 * @returns {boolean} 是否有重叠。
 */
export function sharesAnchor(output, anchor) {
  const needCjk = cjkCharSet(anchor);
  if (needCjk.size > 0) {
    const outCjk = cjkCharSet(output);
    let shared = 0;
    for (const ch of needCjk) if (outCjk.has(ch)) shared += 1;
    if (shared >= (needCjk.size >= 4 ? 2 : 1)) return true;
  }
  const needWords = latinWordSet(anchor);
  if (needWords.size > 0) {
    const outWords = latinWordSet(output);
    for (const word of needWords) if (outWords.has(word)) return true;
  }
  return false;
}

/** 清单/多步标记：预测必须是一句话，不能是清单。 */
const LIST_SHAPE = /(^|\n)\s*(?:[0-9]{1,2}[.、)）]|[-*•·])\s+/;

/**
 * 预测输出的确定性校验（不花模型调用）。
 * @param {string} raw 模型输出。
 * @param {string} kind 分型。
 * @param {string[]} [options] choice 分型下解析出的选项文本。
 * @returns {{ok: true, text: string} | {ok: false, reason: string}} 校验结果。
 */
export function checkPredictionOutput(raw, kind, options) {
  const out = String(raw ?? "").trim();
  if (out === "") return { ok: false, reason: "empty" };
  if (out.includes(PREDICT_FALLBACK_MARKER)) return { ok: false, reason: "model_fallback" };
  if (LIST_SHAPE.test(out)) return { ok: false, reason: "list_shape" };
  if (/^\s*[0-9]{1,2}\s*[.、)）]?\s*$/.test(out)) return { ok: false, reason: "bare_number" };
  const budget = PREDICT_BUDGETS[kind] ?? 40;
  if (out.length > Math.min(Math.ceil(budget * 1.5), PREDICT_HARD_LIMIT)) {
    return { ok: false, reason: "overlong" };
  }
  if (kind === "choice" && Array.isArray(options) && options.length > 0) {
    const restates = options.some((option) => sharesAnchor(out, option));
    if (!restates) return { ok: false, reason: "option_missing" };
  }
  return { ok: true, text: out };
}

/**
 * 超预算时的确定性收尾：切到最后一个句读边界内，切不动就按字数硬切。
 * 只在"重试一次仍然过长"时使用——宁可给用户一句稍短但完整的话，也不报一个
 * 用户无法理解的"预测过长"错误。
 * @param {string} raw 模型输出。
 * @param {string} kind 分型。
 * @returns {string} 收尾后的文本（可能为空，调用方据此决定是否中性拒绝）。
 */
export function trimPredictionToBudget(raw, kind) {
  const out = String(raw ?? "").trim();
  const budget = PREDICT_BUDGETS[kind] ?? 40;
  if (out.length <= budget) return out;
  const head = safeSlice(out, 0, budget);
  const boundary = Math.max(
    head.lastIndexOf("。"),
    head.lastIndexOf("！"),
    head.lastIndexOf("？"),
    head.lastIndexOf("；"),
    head.lastIndexOf("."),
    head.lastIndexOf("!"),
    head.lastIndexOf("?"),
    head.lastIndexOf(";"),
    head.lastIndexOf("，"),
    head.lastIndexOf(","),
  );
  if (boundary >= Math.floor(budget * 0.5)) {
    const cut = head.slice(0, boundary + 1).trim();
    // 句读本身留在句尾会让它读起来像断句错误，中文句号保留、其余去掉。
    return cut.replace(/[，,、]+$/, "").trim();
  }
  return head.trim();
}
