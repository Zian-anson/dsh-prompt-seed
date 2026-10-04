/**
 * prompt-seed / Host 核心编排模块
 * ---------------------------------------------------------------------------
 * 职责：把"一段用户文本"变成"一段优化后的用户文本"，
 *       不持有任何 UI 状态，不依赖 Cordis Context（llm 服务以参数注入）。
 *
 * 这一层是可单测的纯逻辑层；Cordis 只在 `plugin/host.js` 里做接线。
 *
 * 构建约定：`tools/build.mjs` 会把本文件原样复制到 lib/，由 Node 解析其相对 import。
 * 保持**零外部依赖**——只 import prompt-templates.js——这样这一层始终能被
 * `node --test` 直接加载，也让打包产物保持自包含。
 *
 * 编排流程（v0.6 起闸门用**失真标尺**，补全是产品本体）：
 *
 *   输入校验 → 改写调用（契约：补全中间细节、禁止曲解）→ 清洗
 *        → 补全闸（纯代码判定：isSubstantivelyUnchanged，抓"原样返回"）
 *             └─ 命中 → 补全重试（温度 0.4 → 0.7，最多两次）
 *        → 审判调用（独立 llm 调用，失真标尺：只记 DISTORTED / SCOPE_ADDED /
 *          CONTRADICTED / TONE_SHIFTED 四类曲解，外加一条"太薄"的失职报告）
 *             ├─ OK（无失真）      → 回填
 *             ├─ 无法解析/调用失败  → fail-open 回填（闸门是纵深防御，不是唯一机制）
 *             ├─ THIN（只改措辞）   → 补全重试一次 → 二次审判
 *             │                        ├─ 无失真 → 回填补全稿
 *             │                        └─ 有失真 → 回填第一稿（薄但忠实，好过拒绝）
 *             └─ 失真（曲解）       → 定向修复一次（保留已补细节，只摘越线处）→ 二次审判
 *                                      ├─ 无失真 → 回填修复稿
 *                                      └─ 仍失真 → fidelity_rejected，输入框保持原样
 *
 * 为什么把"膨胀比"从判据降级为日志：补全就是要把 10 个字的种子长成一段具体细节，
 * 长度比在本契约下不再指示越线（v0.3–v0.5 用它当闸门，正是"过度收敛"的机制成因）。
 * 真伪由审判的语义标尺判定，长度只用于日志与失控保护。
 *
 * 为什么审判用独立调用而不是同次输出里自检：同一上下文里的自我批评倾向报喜，
 * 且会污染输出协议需要更脆的解析；独立调用 + 极窄协议（"OK"/"KIND: …"）最稳。
 */

import {
  AUDIT_MAX_OUTPUT_TOKENS,
  AUDIT_TEMPERATURE,
  MAX_OUTPUT_TOKENS,
  TEMPERATURE,
  UNFOLD_RETRY_TEMPERATURE,
  buildAuditSystemPrompt,
  buildDeicticSystemPrompt,
  buildElaborateSystemPrompt,
  buildPreciseSystemPrompt,
  buildRepairSystemPrompt,
  buildSignalSystemPrompt,
  buildSystemPromptFor,
  depthSuffix,
  normalizeResult,
  renderAuditUserPrompt,
  renderDeicticUserPrompt,
  renderElaborateUserPrompt,
  renderPreciseUserPrompt,
  renderRepairUserPrompt,
  renderSignalUserPrompt,
  renderUserPrompt,
  validateInput,
} from "./prompt-templates.js";
import {
  DEICTIC_FALLBACK_MARKER,
  SIGNAL_FALLBACK_MARKER,
  checkDeicticDegree,
  checkSignalOutput,
  classifySignalInput,
  inferPendingItem,
} from "./signal-inference.js";

/**
 * 归一化错误码。覆盖输入校验、依赖缺席、模型调用失败、输出异常与保真拒绝五类，
 * 每个错误码都对应一句可直接展示给用户的文案。
 */
export const ERROR_CODES = Object.freeze({
  EMPTY_INPUT: "empty_input",
  INPUT_TOO_LONG: "input_too_long",
  NOTHING_TO_OPTIMIZE: "nothing_to_optimize",
  LLM_UNAVAILABLE: "llm_unavailable",
  MODEL_UNAVAILABLE: "model_unavailable",
  LLM_ERROR: "llm_error",
  EMPTY_RESULT: "empty_result",
  TRUNCATED: "truncated",
  FIDELITY_REJECTED: "fidelity_rejected",
  CANNOT_INFER: "cannot_infer",
  STALE: "stale",
  UNKNOWN: "unknown",
});

/** 面向用户的中文错误文案（前端 tooltip 直接展示）。 */
export const ERROR_MESSAGES = Object.freeze({
  empty_input: "请先输入内容",
  input_too_long: "内容过长，请精简后再优化",
  nothing_to_optimize: "内容太短，没有可优化的信息",
  llm_unavailable: "模型服务不可用",
  model_unavailable: "未找到可用的默认模型",
  llm_error: "模型调用失败",
  empty_result: "模型没有返回有效内容",
  truncated: "结果被截断，请缩短输入后重试",
  fidelity_rejected: "优化会改变原意，已保留原文",
  cannot_infer: "上下文不足以推断这个输入的含义，请直接写出想说的内容",
  stale: "输入已变化，结果已丢弃",
  unknown: "优化失败",
});

/**
 * 失控保护阈值：短输入的极端膨胀比。**不再是判据，只用于日志与告警**——
 * 补全契约下 10 字种子长成一段具体细节（5–8 倍）完全正常，用长度当闸门会把
 * 产品本体误杀（v0.3–v0.5 的过度收敛即由此而来）。真伪由审判的语义标尺判定。
 */
const BLOAT_INPUT_LIMIT = 200;
const BLOAT_RATIO = 3.0;

/**
 * 审判报"太薄"时的补全重试温度。第一稿并未原样返回（否则走的是补全闸），
 * 零温度重跑只会得到同样薄的稿子，必须引入受控扰动才有第二次机会。
 */
const THIN_RETRY_TEMPERATURE = 0.5;

/** 审判判决的违规类型 → 归一化标识。ADDED 保留为历史别名，映射到 scope_added。 */
const VIOLATION_KINDS = Object.freeze({
  DISTORTED: "distorted",
  SCOPE_ADDED: "scope_added",
  CONTRADICTED: "contradicted",
  TONE_SHIFTED: "tone_shifted",
  PADDED: "padded",
  ADDED: "scope_added",
});

/** 违规类型 → 面向用户的中文说明（拒绝时展示，也让日志可读）。 */
export const VIOLATION_LABELS = Object.freeze({
  distorted: "改变了原始目标",
  scope_added: "增加了原本没有的要求",
  contradicted: "覆盖了你已指定的选择",
  tone_shifted: "改变了原有语气",
  padded: "给已明确的指令补了多余步骤",
});

/** 开放式意图的标记：这些词出现时，模糊是意图本身。 */
const OPEN_ENDED_PATTERN =
  /(看看|看一下|了解|调研|研究一?下|探索|评估一?下|梳理一?下|摸底|look into|look at|check\b|research|explore|investigate)/i;

/** 改写里常见的"发明交付物"标记：开放式输入 + 这些词 = 可疑闭合。 */
const DELIVERABLE_PATTERN =
  /(并给出|并输出|并附上|输出一份|整理成|列成|对比表|对比表格|选型建议|实施计划|排期|验收标准|成功标准|交付物|rank(ed|ing)?\b|trade-?offs?|deliverables?)/i;

/**
 * 判定改写是否"实质未变"。
 * 两级判定：剥掉标点/空白/敬语词并归一大小写后骨架相等；或骨架很短且编辑距离
 * 极小（"怎么→如何"这类近义替换）。只抓标点级/敬语级/近义替换级微调——真正的
 * 蕴含展开（追加"如果有，指出是什么"）骨架必然显著变长，不会命中。
 * @param {string} input 用户原始输入。
 * @param {string} rewrite 改写结果。
 * @returns {boolean} 是否实质未变。
 */
export function isSubstantivelyUnchanged(input, rewrite) {
  const a = skeletonText(input);
  if (a === "") return false;
  const b = skeletonText(rewrite);
  if (a === b) return true;
  if (a.length > 200 || b.length > 200) return false;
  const tolerance = Math.max(2, Math.floor(a.length * 0.15));
  return b.length >= a.length - tolerance && b.length <= a.length + tolerance && levenshtein(a, b) <= tolerance;
}

/**
 * 判定输入是否开放式/模糊（值得展开蕴含的输入形态）。
 * 三类命中：开放式动词、问句形态、短祈使式且无事实锚定（路径/数字/符号——
 * "make the dashboard faster" 这类英文祈使式没有问号也没有开放式动词，
 * 但同样是模糊输入）。已明确的长指令不命中，避免画蛇添足。
 * @param {string} input 用户原始输入。
 * @returns {boolean} 是否开放式。
 */
export function looksOpenEnded(input) {
  const s = typeof input === "string" ? input.trim() : "";
  if (s === "") return false;
  if (OPEN_ENDED_PATTERN.test(s)) return true;
  if (/(？|\?|吗[。.]?$|怎么|如何|有没有)/.test(s)) return true;
  return s.length <= 40 && !(/[\\/:]|\d|[_@#]/.test(s));
}

/** 标点、空白、大小写与敬语填充词全部归一后的"骨架"文本。 */
function skeletonText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\s，。！？；：、,.!?;:()（）"'“”「」…—-]/g, "")
    .replace(/(请|帮我|麻烦|麻烦你|能否|可以|一下|能不能|wouldyou|please|kindly|canyou|couldyou|helpme)/g, "");
}

/** 小型编辑距离（骨架 ≤200 时才调用，DP 上限 4 万格）。 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const curr = [i];
    for (let j = 1; j <= n; j += 1) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[n];
}

/**
 * 形态指标：改写相对输入的膨胀比与"开放式被闭合"迹象。
 * 纯函数，**只产出日志与告警**，不参与任何放行/拒绝判定——补全契约下长度比不再
 * 指示越线（见文件头注释）。真伪由审判的语义标尺判定。
 * @param {string} input 用户原始输入。
 * @param {string} rewrite 改写结果。
 * @returns {{ratio: number, bloated: boolean, openEndedClosed: boolean, suspicious: boolean}} 形态指标。
 */
export function assessInflation(input, rewrite) {
  const inTrimmed = typeof input === "string" ? input.trim() : "";
  const outTrimmed = typeof rewrite === "string" ? rewrite.trim() : "";
  const ratio = outTrimmed.length / Math.max(inTrimmed.length, 1);
  const bloated = inTrimmed.length < BLOAT_INPUT_LIMIT && ratio > BLOAT_RATIO;
  const openEndedClosed =
    OPEN_ENDED_PATTERN.test(inTrimmed) && DELIVERABLE_PATTERN.test(outTrimmed);
  return { ratio, bloated, openEndedClosed, suspicious: bloated || openEndedClosed };
}

/**
 * 归一化审判输出。协议极窄，每种问题一行：
 *   "OK"                              → { status: 'ok', violations: [], thin: false }
 *   "THIN: ..."                       → { status: 'ok', violations: [], thin: true }（失职，非失真）
 *   "DISTORTED: a\nSCOPE_ADDED: b"    → { status: 'issues', violations: [{kind,text}...] }
 *   其余（含空）                       → { status: 'unparsable' }（调用方 fail-open）
 *
 * 只有认得出协议行才算判决：夹杂的自然语言行被忽略，避免模型解释性输出被当成判决。
 * @param {string} raw 审判调用的原始输出。
 * @returns {{status: 'ok'|'issues'|'unparsable', violations: {kind: string, text: string}[], thin: boolean}} 归一化判决。
 */
export function parseAuditVerdict(raw) {
  const empty = { status: "unparsable", violations: [], thin: false, detail: "" };
  const cleaned = normalizeResult(raw ?? "").trim();
  if (cleaned === "") return empty;

  const violations = [];
  let thin = false;
  let matched = false;
  let detail = "";
  for (const line of cleaned.split(/\n+/)) {
    const text = line.trim().replace(/^[-*•]\s*/, "");
    if (text === "") continue;
    // DETAIL 是"补了什么"的摘要，不是判决：单独取出，供客户端展示凭证（A 项）。
    const summary = /^DETAIL\s*[:：]\s*(.*)$/i.exec(text);
    if (summary !== null) {
      matched = true;
      const value = summary[1].trim();
      if (value !== "" && !/^no\s*change/i.test(value) && value !== "无") detail = value;
      continue;
    }
    // 裸 "OK" 行同样是判决（改写无越线）。它必须在这里被识别：早先的实现在函数开头
    // 用正则短路 "OK"，改写成逐行解析后漏掉了这一步，"OK" 会掉进 unparsable，
    // 连带把"补全后仍失真"的判定整条打歪（由测试捕获）。
    if (/^ok\b/i.test(text)) {
      matched = true;
      continue;
    }
    const match = /^(DISTORTED|SCOPE_ADDED|CONTRADICTED|TONE_SHIFTED|PADDED|ADDED|THIN)\b\s*[:：]?\s*(.*)$/i.exec(text);
    if (match === null) continue;
    matched = true;
    const key = match[1].toUpperCase();
    if (key === "THIN") {
      thin = true;
      continue;
    }
    const kind = VIOLATION_KINDS[key];
    const value = match[2].trim();
    violations.push({ kind, text: value === "" ? VIOLATION_LABELS[kind] : value });
  }

  if (!matched) return empty;
  return { status: violations.length === 0 ? "ok" : "issues", violations, thin, detail };
}


/**
 * 生成一条符合 DSH `Message` 形状的 user message。
 * 手工构造而非引入 `@deepseek-ai/dsh-llm` 的 helper：本包因此保持零运行时依赖，
 * 且只填运行时会真正读取的字段（id / role / content / source）。
 * @param {string} text 已渲染的 user prompt。
 * @returns {{id: string, role: 'user', content: Array<{type: 'text', text: string}>, source: {kind: 'plugin', plugin: string}}} 消息对象。
 */
export function createOptimizerMessage(text) {
  return {
    id: `po-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "prompt-seed" },
  };
}

/**
 * 从 Host 读取当前默认模型路由。
 * @param {unknown} defaultModelService `ctx.get('agentDefaultModel')` 的结果。
 * @returns {{provider: string, model: string, reasoningEffort?: string} | undefined} 路由，或 undefined。
 */
export function resolveRoute(defaultModelService) {
  if (defaultModelService === undefined || defaultModelService === null) return undefined;
  let selection;
  try {
    selection = defaultModelService.currentSelection();
  } catch {
    return undefined;
  }
  if (!selection || typeof selection.provider !== "string" || typeof selection.model !== "string") return undefined;
  const route = { provider: selection.provider, model: selection.model };
  if (typeof selection.reasoningEffort === "string" && selection.reasoningEffort.trim() !== "") {
    route.reasoningEffort = selection.reasoningEffort;
  }
  return route;
}

/**
 * 消费一次 `llm.stream()`，把 text-delta 拼成完整文本。
 * 同时把 `finish.reason.kind` 原样带出——`max-tokens` 必须能被上层区分，
 * 否则一段被截断的 prompt 会被静默写进用户的输入框（真实模型实测确认过该路径）。
 * @param {AsyncIterable<object>} stream 模型 chunk 流。
 * @returns {Promise<{text: string, failure: {message: string, code: string} | null, finish: string | null}>} 拼接结果、终止失败原因与 finish 种类。
 */
export async function collectStream(stream) {
  let text = "";
  let failure = null;
  let finish = null;
  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== "object") continue;
    if (chunk.type === "text-delta" && typeof chunk.text === "string") {
      text += chunk.text;
      continue;
    }
    if (chunk.type === "finish" && chunk.reason && typeof chunk.reason === "object") {
      finish = typeof chunk.reason.kind === "string" ? chunk.reason.kind : "unknown";
      if (chunk.reason.kind === "error" || chunk.reason.kind === "aborted") {
        failure = chunk.reason.failure ?? { code: "llm_error", message: "model call failed" };
      }
      continue;
    }
    if (chunk.type === "error") {
      failure = chunk.error ?? { code: "llm_error", message: "model call failed" };
    }
  }
  return { text, failure, finish };
}

/**
 * 执行一次模型调用并归一化结果（抛错/终止失败/max-tokens/清洗统一处理）。
 * @param {object} llm llm 服务。
 * @param {object} route 模型路由。
 * @param {object} options 调用参数（system/user/temperature/maxTokens/reasoningEffort/signal/log）。
 * @returns {Promise<{ok: true, text: string} | {ok: false, code: string, error: string}>} 归一化调用结果。
 */
async function callModel(llm, route, options) {
  const { system, user, temperature, maxTokens, signal, log } = options;
  const request = {
    provider: route.provider,
    model: route.model,
    system,
    messages: [createOptimizerMessage(user)],
    temperature,
    maxTokens,
  };
  if (options.reasoningEffort !== undefined) request.reasoningEffort = options.reasoningEffort;
  if (signal !== undefined) request.signal = signal;

  let collected;
  try {
    collected = await collectStream(llm.stream(request));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log?.("error", "[prompt-seed] llm.stream threw", { error: message });
    return { ok: false, code: ERROR_CODES.LLM_ERROR, error: message };
  }

  if (collected.failure !== null) {
    const message = collected.failure.message ?? "model call failed";
    log?.("error", "[prompt-seed] llm reported failure", {
      code: collected.failure.code ?? "llm_error",
      error: message,
    });
    return { ok: false, code: ERROR_CODES.LLM_ERROR, error: message };
  }

  // finish=max-tokens 说明模型还想继续说。此时**即便已经有正文也一律拒绝**：
  // 把一段被截断的 prompt 写进输入框，比报错更危险（模板本身禁止"未完成的列表"）。
  if (collected.finish === "max-tokens") {
    log?.("error", "[prompt-seed] output truncated by maxTokens", {
      textLength: collected.text.length,
    });
    return { ok: false, code: ERROR_CODES.TRUNCATED, error: ERROR_MESSAGES.truncated };
  }

  return { ok: true, text: normalizeResult(collected.text) };
}

/**
 * 判定输入是否为"种子"——短、无事实锚定、或开放式。审判报 THIN 时只有种子输入
 * 才值得再花一次调用去补全：已明确输入被报 THIN 往往是审判误报，重跑只会堆砌。
 * @param {string} input 用户原始输入。
 * @returns {boolean} 是否值得补全重试。
 */
export function looksSeedish(input) {
  const s = typeof input === "string" ? input.trim() : "";
  if (s === "") return false;
  if (looksOpenEnded(s)) return true;
  return s.length <= 60 && !(/[\\/:]|\d{2,}|[_@#]/.test(s));
}

/** 事实锚定标记：路径、扩展名、行号/数量、标识符符号。 */
const ANCHOR_PATTERN = /[\\/:]|\d|[_@#`]|\b\w+\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|rb|php|vue|svelte|css|scss|html|json|ya?ml|toml|md|sql|sh)\b/i;

/** 明确的动作动词：出现即说明用户已经说清了"要做什么"。 */
const ACTION_PATTERN =
  /(删除|移除|去掉|改|修改|替换|重命名|添加|新增|实现|修复|更新|升级|迁移|重构|跑|运行|执行|测试|部署|回滚|delete|remove|rename|replace|add|implement|fix|update|upgrade|migrate|refactor|run|test|deploy|revert)/i;

/** 开放意图标记：出现即说明用户没打算要一个精确执行清单。 */
const OPEN_INTENT_PATTERN = /(？|\?|吗[。.]?$|怎么|如何|有没有|看看|看一下|调研|了解|评估|梳理|探索)/;

/**
 * 判定输入是否为"已精确完整的指令"——点名了目标（锚定事实）与动作，
 * 且不是问句/开放式意图。这类输入要切换到精确模式（近原样润色），
 * 否则补全契约会把"教用户怎么做"当成补全，实测膨胀 4–8 倍并塞进操作步骤。
 *
 * 判据刻意保守：锚定 + 动作 + 长度下限三者同时满足才算精确，避免把种子误判成
 * 精确输入而压住该有的补全。
 * @param {string} input 用户原始输入。
 * @returns {boolean} 是否按精确输入处理。
 */
export function isPreciseInstruction(input) {
  const s = typeof input === "string" ? input.trim() : "";
  if (s.length < 16) return false;
  if (OPEN_INTENT_PATTERN.test(s)) return false;
  return ANCHOR_PATTERN.test(s) && ACTION_PATTERN.test(s);
}

/** 纯招呼语/填充词：整条归一化后等于其中之一即视为没有可优化内容。 */
const GREETING_PATTERN =
  /^(hi|hii+|hello|hey|yo|sup|thanks|thankyou|thx|ty|ok|okay|k|test|testing|你好|您好|在吗|在么|嗨|哈喽|哈啰|早上好|晚上好|谢谢|多谢|感谢|好的|好|嗯|哦|噢|哈哈|嘿嘿|测试|试一下)$/i;

/**
 * 判定输入是否"没有可优化的内容"——纯招呼、纯填充词、纯标点/表情。
 *
 * 实测病征（v0.6.1 线上）：`hi` 花 5.4s 走完改写→审判→修复，最终原样返回；
 * `你好` 花 8.5s 被判失真拒绝（模型凭空补出"介绍你自己"）。这类输入没有可执行
 * 意图，补全契约只能硬编一个意图，然后被闸门拦下——两条路都是浪费和挫败。
 * 确定性下限在这里直接短路，不花任何模型调用。
 *
 * 阈值刻意极低：`登录`（2 字）实测能补出高质量方案，绝不能被误杀。
 * @param {string} input 用户原始输入。
 * @returns {boolean} 是否没有可优化的内容。
 */
export function isContentFree(input) {
  const s = typeof input === "string" ? input.trim() : "";
  if (s === "") return true;
  // 去掉空白、中英标点与常见表情符号后，什么都不剩 = 没有语义内容
  const stripped = s
    .replace(/[\s\u3000]/g, "")
    .replace(/[，。！？；：、,.!?;:~～…—\-_+=*&^%$#@/\\|<>()[\]{}"'`“”‘’「」『』【】]/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "");
  if (stripped === "") return true;
  return GREETING_PATTERN.test(stripped);
}

/**
 * 判定改写是否保住了输入里的**锚定词**（拉丁标识符、路径片段、数字）。
 *
 * 为什么需要它：`isSubstantivelyUnchanged` 用的是编辑距离容差，长输入下容差可达
 * 6 个字符——实测"把 formatDate 改成用 dayjs 实现"→"…用 moment 实现"正好落在
 * 容差内被判为"未变"，于是跳过审判的短路会把一次技术栈替换放走。锚定词守恒补上
 * 这个洞：任何标识符/路径片段/数字在改写里找不到，就不允许走短路。
 * @param {string} input 用户原始输入。
 * @param {string} rewrite 改写结果。
 * @returns {boolean} 锚定词是否全部保留。
 */
export function preservesAnchors(input, rewrite) {
  const src = typeof input === "string" ? input : "";
  const out = typeof rewrite === "string" ? rewrite.toLowerCase() : "";
  const tokens = src.match(/[A-Za-z_][A-Za-z0-9_.\-]{2,}|\d+/g) ?? [];
  for (const token of tokens) {
    if (!out.includes(token.toLowerCase())) return false;
  }
  return true;
}

/**
 * 执行一次保真审判。返回 null 表示审判本身不可用（调用失败），
 * 调用方应 fail-open 接受改写——闸门是纵深防御，不是唯一机制。
 * @param {object} params { llm, route, original, rewrite, context, signal, log }。
 * @returns {Promise<{status: string, violations: {kind: string, text: string}[], thin: boolean} | null>} 归一化判决，或 null。
 */
async function runAudit(params) {
  const { llm, route, original, rewrite, context, signal, log } = params;
  // 审判是轻量判定任务：不透传 reasoningEffort，保持便宜与快速。
  const call = await callModel(llm, route, {
    system: buildAuditSystemPrompt(),
    user: renderAuditUserPrompt(original, rewrite, context),
    temperature: AUDIT_TEMPERATURE,
    maxTokens: AUDIT_MAX_OUTPUT_TOKENS,
    signal,
    log,
  });
  if (!call.ok) {
    log?.("warn", "[prompt-seed] audit call failed; failing open", { code: call.code });
    return null;
  }
  return parseAuditVerdict(call.text);
}

/**
 * 优化一段用户输入（含保真闸门）。
 *
 * 错误分支按优先级排列，越靠前越先判定：
 *   空输入       → empty_input
 *   超长         → input_too_long
 *   无 llm       → llm_unavailable
 *   无模型       → model_unavailable
 *   调用抛错     → llm_error
 *   终止为错     → llm_error
 *   截断         → truncated
 *   清洗后为空   → empty_result
 *   失真拒绝     → fidelity_rejected（定向修复后仍被判失真）
 *   成功         → { ok: true, text, tier }
 *
 * tier 记录这一稿的来源，供排障与客户端提示：
 *   'full'       第一稿即通过审判
 *   'elaborated' 太薄 → 补全重试后通过
 *   'repaired'   失真 → 定向修复后通过（细节保留，只摘掉越线处）
 *   'thin'       补全重试又引入失真 → 回退到薄但忠实的第一稿
 *
 * @param {object} options 调用参数。
 * @param {{stream: (o: object) => AsyncIterable<object>} | undefined} options.llm `ctx.get('llm')`。
 * @param {{provider: string, model: string, reasoningEffort?: string} | undefined} options.route 目标模型路由。
 * @param {string} options.text 用户原始输入。
 * @param {AbortSignal} [options.signal] 取消信号。
 * @param {(level: string, message: string, meta?: object) => void} [options.log] 日志回调。
 * @returns {Promise<{ok: true, text: string, tier: string} | {ok: false, code: string, error: string}>} 优化结果。
 */
/**
 * 信号推断分支：纯信号（数字/"继续"）→ 一次定向展开 + 确定性锚定校验。
 *
 * 推断不出就明确说 cannot_infer，绝不硬猜——这是本分支的第一原则，
 * 模型端的 [无法推断] 回执同样被尊重并转成同一个错误码。
 * @param {object} args { llm, route, text, classified, context, assistantTail, signal, log }
 * @returns {Promise<object>} 与主流程同构的结果对象。
 */
async function runSignalInference(args) {
  const { llm, route, text, classified, context, assistantTail, signal, log } = args;
  const userTurns = Array.isArray(context) ? context : undefined;
  const item = inferPendingItem(classified, userTurns, assistantTail);
  if (item.mode === "none") {
    log?.("warn", "[prompt-seed] signal without an inferable pending item; refusing to guess", {
      token: classified.token,
      reason: item.reason,
    });
    return { ok: false, code: ERROR_CODES.CANNOT_INFER, error: ERROR_MESSAGES.cannot_infer };
  }

  const draft = await callModel(llm, route, {
    system: buildSignalSystemPrompt(),
    user: renderSignalUserPrompt(classified.token, item.mode, item.anchor),
    temperature: TEMPERATURE,
    maxTokens: 240,
    signal,
    log,
  });
  if (!draft.ok) return draft;
  if (draft.text === "") {
    return { ok: false, code: ERROR_CODES.EMPTY_RESULT, error: ERROR_MESSAGES.empty_result };
  }
  if (draft.text.includes(SIGNAL_FALLBACK_MARKER)) {
    log?.("warn", "[prompt-seed] model declined the signal expansion; refusing to guess");
    return { ok: false, code: ERROR_CODES.CANNOT_INFER, error: ERROR_MESSAGES.cannot_infer };
  }

  const check = checkSignalOutput(draft.text, classified.token, item.anchor, item.mode);
  if (!check.ok) {
    log?.("warn", "[prompt-seed] signal output failed the grounding check; refusing to guess", {
      reason: check.reason,
    });
    return { ok: false, code: ERROR_CODES.CANNOT_INFER, error: ERROR_MESSAGES.cannot_infer };
  }

  return {
    ok: true,
    text: draft.text,
    tier: "signal",
    mode: "signal",
    gate: { verdict: "ok", repairs: 0, rechecked: false, violations: [] },
    detail: `信号→${item.mode}（锚点：${item.source}）`,
  };
}

/**
 * 短指令分支：动词明确、宾语空缺 → 度契约展开 + 确定性度校验（越界一次收紧重试）。
 * @param {object} args { llm, route, text, context, signal, log }
 * @returns {Promise<object>} 与主流程同构的结果对象。
 */
async function runDeicticExpansion(args) {
  const { llm, route, text, context, signal, log } = args;
  if (!Array.isArray(context) || context.length === 0) {
    log?.("warn", "[prompt-seed] deictic directive without conversation context; refusing to guess");
    return { ok: false, code: ERROR_CODES.CANNOT_INFER, error: ERROR_MESSAGES.cannot_infer };
  }

  let draft = await callModel(llm, route, {
    system: buildDeicticSystemPrompt(),
    user: renderDeicticUserPrompt(text, context),
    temperature: 0.2,
    maxTokens: 280,
    signal,
    log,
  });
  if (!draft.ok) return draft;
  if (draft.text === "") {
    return { ok: false, code: ERROR_CODES.EMPTY_RESULT, error: ERROR_MESSAGES.empty_result };
  }
  if (draft.text.includes(DEICTIC_FALLBACK_MARKER)) {
    log?.("warn", "[prompt-seed] model could not resolve the referent; refusing to guess");
    return { ok: false, code: ERROR_CODES.CANNOT_INFER, error: ERROR_MESSAGES.cannot_infer };
  }

  let check = checkDeicticDegree(draft.text, text);
  if (!check.ok && (check.reason === "overlong" || check.reason === "verb_missing")) {
    log?.("warn", "[prompt-seed] deictic draft broke the degree rules; one tightened retry", {
      reason: check.reason,
    });
    const retry = await callModel(llm, route, {
      system: buildDeicticSystemPrompt({ tightened: true }),
      user: renderDeicticUserPrompt(text, context),
      temperature: 0.4,
      maxTokens: 240,
      signal,
      log,
    });
    if (retry.ok && retry.text !== "" && !retry.text.includes(DEICTIC_FALLBACK_MARKER)) {
      const recheck = checkDeicticDegree(retry.text, text);
      if (recheck.ok) {
        return {
          ok: true,
          text: retry.text,
          tier: "deictic",
          mode: "deictic",
          gate: { verdict: "ok", repairs: 1, rechecked: true, violations: [] },
          detail: "短指令→按度展开（一次收紧）",
        };
      }
    }
    return {
      ok: false,
      code: ERROR_CODES.FIDELITY_REJECTED,
      error: ERROR_MESSAGES.fidelity_rejected,
      violations: [{ kind: "scope_added", text: "短指令发散越界（超出用户词语的自然子部件）" }],
    };
  }
  if (!check.ok) {
    log?.("warn", "[prompt-seed] deictic draft failed the degree check", { reason: check.reason });
    return { ok: false, code: ERROR_CODES.CANNOT_INFER, error: ERROR_MESSAGES.cannot_infer };
  }

  return {
    ok: true,
    text: draft.text,
    tier: "deictic",
    mode: "deictic",
    gate: { verdict: "ok", repairs: 0, rechecked: false, violations: [] },
    detail: "短指令→按度展开",
  };
}

export async function optimizePromptText(options) {
  const { llm, route, text, context, signal, log } = options ?? {};

  const invalid = validateInput(text);
  if (invalid !== null) {
    return { ok: false, code: invalid, error: ERROR_MESSAGES[invalid] ?? invalid };
  }

  // ---- 内容下限（确定性短路，零模型调用）----
  // 纯招呼/纯标点没有可执行意图，任何契约都只能硬编一个意图再被闸门拦下。
  // 实测：hi 空转 5.4s、你好 被拒 8.5s。这里直接给出中性结论，用户不白等。
  if (isContentFree(text)) {
    log?.("warn", "[prompt-seed] input has no actionable content; skipping model calls");
    return { ok: false, code: ERROR_CODES.NOTHING_TO_OPTIMIZE, error: ERROR_MESSAGES.nothing_to_optimize };
  }

  if (llm === undefined || llm === null || typeof llm.stream !== "function") {
    log?.("error", "[prompt-seed] llm service unavailable");
    return { ok: false, code: ERROR_CODES.LLM_UNAVAILABLE, error: ERROR_MESSAGES.llm_unavailable };
  }
  if (route === undefined || route === null) {
    log?.("error", "[prompt-seed] default model route unavailable");
    return { ok: false, code: ERROR_CODES.MODEL_UNAVAILABLE, error: ERROR_MESSAGES.model_unavailable };
  }

  const trimmed = text.trim();

  // ---- 信号/短指令分支（0.9.0，确定性分类，不花调用）----
  // 纯信号（数字/"继续"）自身无任务内容：要么从上下文锚点推断成下一句话，
  // 要么明确 cannot_infer——绝不硬猜。焦点短指令（"改一下"/"不对"）走度契约，
  // 发散只限用户词语的自然子部件与隐含后续之内。
  const signalClass = classifySignalInput(trimmed);
  if (signalClass.kind === "number" || signalClass.kind === "signal") {
    return await runSignalInference({
      llm, route, text: trimmed, classified: signalClass,
      context, assistantTail: options.assistantTail, signal, log,
    });
  }
  if (signalClass.kind === "deictic") {
    return await runDeicticExpansion({ llm, route, text: trimmed, context, signal, log });
  }

  // ---- 模式选择（确定性，不花调用）----
  // 已精确完整的指令走"精确模式"：补全契约对它是有害激励——用户写得出目标+动作+
  // 验证方式，说明他会做，再补"具体做法"就是加戏。实测线上把 47 字的完整指令吹到
  // 187–369 字并塞进操作步骤与失败回退条款（4–8 倍），所以按输入形态整段切换契约。
  const precise = isPreciseInstruction(trimmed);
  const depth = options.depth === "deep" || options.depth === "light" ? options.depth : "standard";

  // 精确模式跳审时的凭证：没有审判可报，如实标 unverified，不伪装成"保真通过"。
  const unverifiedGate = { verdict: "unverified", repairs: 0, rechecked: false, violations: [] };

  // ---- 第一稿：补全式改写（精确输入走润色式改写）----
  // 不透传 reasoningEffort：改写是轻任务，max 档深推理让输出路径发散
  // （同一输入时而补全时而原样的实测方差来源）且拖慢数秒。
  const baseSystem = precise
    ? buildPreciseSystemPrompt(trimmed)
    : buildSystemPromptFor(trimmed) + depthSuffix(depth);
  let rewrite = await callModel(llm, route, {
    system: baseSystem,
    user: precise ? renderPreciseUserPrompt(trimmed, context) : renderUserPrompt(trimmed, context),
    temperature: TEMPERATURE,
    maxTokens: MAX_OUTPUT_TOKENS,
    signal,
    log,
  });
  if (!rewrite.ok) return rewrite;
  if (rewrite.text === "") {
    log?.("error", "[prompt-seed] model returned empty text after normalization");
    return { ok: false, code: ERROR_CODES.EMPTY_RESULT, error: ERROR_MESSAGES.empty_result };
  }

  // ---- 补全闸（纯代码判定，不加 LLM 判断）----
  // 服务端在 temperature=0 下仍有方差：种子型输入的第一稿约半数只做标点级微调就
  // 返回。这里用确定性检查抓出"实质未变"，用强化指令最多重试两次（温度 0.4 → 0.7
  // 递增扰动；零温度重试实测与第一稿采样相同，等于白跑）。精确输入不走此闸——
  // 它本来就该接近原样，再"补全"正好是上面要治的加戏。
  if (!precise && isSubstantivelyUnchanged(trimmed, rewrite.text) && looksOpenEnded(trimmed)) {
    for (const temperature of [UNFOLD_RETRY_TEMPERATURE, UNFOLD_RETRY_TEMPERATURE + 0.3]) {
      log?.("warn", "[prompt-seed] rewrite is substantively unchanged; retrying with elaboration", { temperature });
      const elaborated = await callModel(llm, route, {
        system: buildElaborateSystemPrompt(trimmed) + depthSuffix(depth),
        user: renderElaborateUserPrompt(trimmed, context),
        temperature,
        maxTokens: MAX_OUTPUT_TOKENS,
        signal,
        log,
      });
      if (!elaborated.ok || elaborated.text === "") break;
      rewrite = elaborated;
      if (!isSubstantivelyUnchanged(trimmed, rewrite.text)) break;
    }
  }

  // ---- 失真审判 ----
  const metrics = assessInflation(trimmed, rewrite.text);

  // 精确模式 + 输出实质未变 → 跳过审判（省一次调用，精确输入实测 1.7s → 约 0.9s）。
  // 安全性依据：三条确定性判据同时成立才短路——①精确模式；②骨架相等或编辑距离在
  // 容差内；③**锚定词守恒**（标识符/路径/数字一个不少）。第③条是关键：只靠编辑距离
  // 会放走"dayjs→moment"这类内容词替换（实测容差 6 字符正好覆盖），锚定词守恒把它
  // 挡住。审判的价值在于拦"补出来的东西"，近原样且锚定词未动的稿子没有可拦的东西。
  if (precise && isSubstantivelyUnchanged(trimmed, rewrite.text) && preservesAnchors(trimmed, rewrite.text)) {
    log?.("warn", "[prompt-seed] precise input kept near-identical; skipping the audit call", {
      ratio: Number(metrics.ratio.toFixed(2)),
    });
    return { ok: true, text: rewrite.text, tier: "full", gate: unverifiedGate, detail: "" };
  }

  const audit = await runAudit({ llm, route, original: trimmed, rewrite: rewrite.text, context, signal, log });
  const auditDetail = typeof audit?.detail === "string" ? audit.detail : "";

  if (audit === null || audit.status === "unparsable" || audit.status === "ok") {
    if (audit?.status === "unparsable") {
      log?.("warn", "[prompt-seed] audit output unparsable; failing open");
    }

    // 审判报"太薄"：只对种子输入再补一次。补全稿必须重新过审判——补全最容易
    // 越线成曲解，不能因为"只是加细节"就免检。补全后仍失真则回退第一稿：
    // 薄但忠实，比直接拒绝更有用（用户点这个按钮就是想要东西）。
    if (audit?.thin === true && looksSeedish(trimmed)) {
      log?.("warn", "[prompt-seed] audit reports a thin rewrite; elaborating once more", {
        ratio: Number(metrics.ratio.toFixed(2)),
      });
      const elaborated = await callModel(llm, route, {
        system: buildElaborateSystemPrompt(trimmed) + depthSuffix(depth),
        user: renderElaborateUserPrompt(trimmed, context),
        temperature: THIN_RETRY_TEMPERATURE,
        maxTokens: MAX_OUTPUT_TOKENS,
        signal,
        log,
      });
      if (elaborated.ok && elaborated.text !== "") {
        const secondAudit = await runAudit({ llm, route, original: trimmed, rewrite: elaborated.text, context, signal, log });
        if (secondAudit === null || secondAudit.status === "ok") {
          return {
            ok: true,
            text: elaborated.text,
            tier: "elaborated",
            gate: { verdict: "ok", repairs: 0, rechecked: true, violations: [] },
            detail: typeof secondAudit?.detail === "string" ? secondAudit.detail : "",
          };
        }
        log?.("warn", "[prompt-seed] elaboration introduced distortion; keeping the thin but faithful draft", {
          violations: secondAudit.violations,
        });
      }
      return {
        ok: true,
        text: rewrite.text,
        tier: "thin",
        gate: { verdict: "thin", repairs: 0, rechecked: false, violations: [] },
        detail: "",
      };
    }

    return {
      ok: true,
      text: rewrite.text,
      tier: "full",
      gate: { verdict: "ok", repairs: 0, rechecked: false, violations: [] },
      detail: auditDetail,
    };
  }

  // ---- 失真：定向修复（保留已补细节，只摘越线处）----
  log?.("warn", "[prompt-seed] rewrite distorts the request; repairing", {
    ratio: Number(metrics.ratio.toFixed(2)),
    mode: precise ? "precise" : "elaborate",
    openEndedClosed: metrics.openEndedClosed,
    violations: audit.violations,
  });

  const violationTexts = audit.violations.map((item) => item.text);
  const repairGate = {
    verdict: "repaired",
    repairs: 1,
    rechecked: false,
    violations: audit.violations,
  };
  const repaired = await callModel(llm, route, {
    system: buildRepairSystemPrompt(trimmed, { precise }),
    user: renderRepairUserPrompt(trimmed, violationTexts, context),
    temperature: TEMPERATURE,
    maxTokens: MAX_OUTPUT_TOKENS,
    signal,
    log,
  });
  if (!repaired.ok) return repaired;
  if (repaired.text === "") {
    log?.("error", "[prompt-seed] repair retry returned empty text");
    return {
      ok: false,
      code: ERROR_CODES.FIDELITY_REJECTED,
      error: ERROR_MESSAGES.fidelity_rejected,
      added: violationTexts,
      violations: audit.violations.map((item) => ({
        kind: item.kind,
        label: VIOLATION_LABELS[item.kind] ?? item.kind,
        text: item.text,
      })),
    };
  }

  // ---- 二次审判：修复稿一律复核（回退 0.8.0 的"结构型免复核"捷径）----
  // 那次优化为了省一次调用（4 → 3），对 padded / scope_added / tone_shifted 直接采纳修复稿。
  // 实测代价：线上一次 `scope_added`（范围被扩宽，即"过度发散"）的修复稿未经复核就被交付，
  // 而旧版本在这里会复核、仍越线则**拒绝并保留原文**。省下的那一次调用，恰好省在了唯一
  // 拦住"越修越发散"的环节上——延迟优化不能吃掉发散控制。
  const repairedAudit = await runAudit({ llm, route, original: trimmed, rewrite: repaired.text, context, signal, log });
  if (repairedAudit === null || repairedAudit.status === "ok") {
    return {
      ok: true,
      text: repaired.text,
      tier: "repaired",
      gate: { ...repairGate, rechecked: true },
      detail: typeof repairedAudit?.detail === "string" && repairedAudit.detail !== "" ? repairedAudit.detail : auditDetail,
    };
  }

  log?.("error", "[prompt-seed] fidelity rejected after repair", {
    firstRatio: Number(metrics.ratio.toFixed(2)),
    violations: repairedAudit.violations,
  });
  // 被拒版本随结果回传（字段名 rejected，绝不用 text）：客户端只在用户**显式点击**
  // "查看被拒版本"时才写回，闸门的不变量 I1（失败绝不自动改写输入框）保持不变。
  return {
    ok: false,
    code: ERROR_CODES.FIDELITY_REJECTED,
    error: ERROR_MESSAGES.fidelity_rejected,
    added: repairedAudit.violations.map((item) => item.text),
    // 结构化违规：客户端用 kind 渲染中文类别（"增加了原本没有的要求"），
    // 而不是把模型的原句直接糊到界面上——后者读起来像内部日志。
    violations: repairedAudit.violations.map((item) => ({
      kind: item.kind,
      label: VIOLATION_LABELS[item.kind] ?? item.kind,
      text: item.text,
    })),
    rejected: repaired.text,
  };
}
