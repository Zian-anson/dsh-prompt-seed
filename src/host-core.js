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
  VIOLATION_KINDS,
  VIOLATION_LABELS,
  parseAuditVerdict,
  AUDIT_TEMPERATURE,
  CLARIFY_ONLY_SYSTEM,
  MAX_OUTPUT_TOKENS,
  MAX_TEXT_LENGTH,
  PREDICT_MAX_OUTPUT_TOKENS,
  PREDICT_RETRY_TEMPERATURE,
  PREDICT_TEMPERATURE,
  SEED_TIGHTEN_SYSTEM,
  TEMPERATURE,
  UNFOLD_RETRY_TEMPERATURE,
  buildAdaptiveSystemPrompt,
  buildAuditSystemPrompt,
  buildConversationalSystemPrompt,
  buildDeicticSystemPrompt,
  buildElaborateSystemPrompt,
  buildPredictSystemPrompt,
  buildRepairSystemPrompt,
  buildSignalSystemPrompt,
  buildUnifiedSystemPrompt,
  parseUnifiedResult,
  depthSuffix,
  normalizeResult,
  parseAdaptiveResult,
  renderAuditUserPrompt,
  renderConversationalUserPrompt,
  renderDeicticUserPrompt,
  renderElaborateUserPrompt,
  renderPredictUserPrompt,
  renderRepairUserPrompt,
  renderSeedTightenUserPrompt,
  renderSignalUserPrompt,
  renderUserPrompt,
  validateInput,
} from "./prompt-templates.js";
import {
  PREDICT_BUDGETS,
  PREDICT_FALLBACK_MARKER,
  PREDICT_KIND_LABELS,
  checkPredictionOutput,
  trimPredictionToBudget,
} from "./prediction.js";
import {
  DEICTIC_FALLBACK_MARKER,
  SIGNAL_FALLBACK_MARKER,
  checkDeicticDegree,
  checkSignalOutput,
  classifySignalInput,
  conversationalRuleOf,
  inferPendingItem,
  isConversationalMessage,
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
  // 预测分支的中性拒绝：语境里没有可预测的下一步。与 cannot_infer 同构——
  // 这是系统"拒绝硬猜"，不是故障，界面用中性色而不是红色。
  CANNOT_PREDICT: "cannot_predict",
  // 传输层错误码：请求体超过路由缓冲上限。它不属于"业务结果"，所以走 HTTP 413
  // 而不是 200+code；放进这张表是为了守住"每个码都有一句可展示文案"的不变量
  // （此前这条路径只会在真实 socket 上表现为连接被重置，客户端连码都拿不到）。
  PAYLOAD_TOO_LARGE: "payload_too_large",
  // 输出体量失控（T-debug-L5）：截断防护只认 finish=max-tokens，一个 finish=stop
  // 却吐 1MB 正文的失控 provider 会把整段塞进 composer 输入框。这是确定性拒绝，
  // 不是可重试的截断——重试同样失控的 provider 没有意义。
  OUTPUT_TOO_LARGE: "output_too_large",
  // 整条路由的墙钟超时（T-debug-M4）：deadlineMs 只预算可选调用，必发调用挂起时
  // 由路由层的中止兜底转成这个码。可重试——provider 慢通常是暂态。
  REQUEST_TIMEOUT: "request_timeout",
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
  cannot_predict: "这段上下文里没有可预测的下一步",
  payload_too_large: "请求体过大，请精简后再优化",
  output_too_large: "模型输出异常偏大，已保留原文",
  request_timeout: "模型调用超时，请稍后重试",
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

/**
 * 单次模型输出的体量硬上限（字符，T-debug-L5）。输入侧有 MAX_TEXT_LENGTH=8000，
 * 输出侧此前只认 finish=max-tokens——失控 provider 用 finish=stop 吐 1MB 会被
 * ok 透传。合法改写不会超过输入上限的 4 倍（补全契约实测 2~3.5×）。
 */
const MAX_OUTPUT_CHARS = MAX_TEXT_LENGTH * 4;

/**
 * 可选调用（补全重试 / 收紧重试 / 定向修复）的整体墙钟预算，毫秒。
 *
 * 为什么需要它：主路径最坏要花 4 次调用（改写→审判→修复→复审），provider 一慢就会
 * 叠成十几秒甚至更久，而**第 3、4 次调用是可选的**——它们只在"第一稿越线"时才发生。
 * 预算用尽即跳过剩余可选调用，直接给出与"修复后仍失真"完全相同的诚实结论。
 *
 * 默认值刻意保守（20s）：它**不是**给普通拒绝路径提速的旋钮——那件事的杠杆是
 * `auditProvider`/`auditModel`（把两次审判挪到更便宜的模型上），见 README。
 * 这条预算只负责兜住"provider 卡住 / 异常慢"这类失控情形，因此在实测过的所有
 * 正常耗时（最慢 17.8s 的拒绝）之下都不会触发，不会牺牲任何一次可能成功的修复。
 * 想更激进地压延迟，把它调小即可（代价是放弃更多修复机会）。
 */
export const DEFAULT_DEADLINE_MS = 20000;


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
  // 改写骨架为空 = 内容被删光（纯标点/纯敬语稿）。容差判据对超短骨架本来就宽
  // （tolerance≥2），不在这里挡下的话，"登录"→"。"会判"未变"并触发精确跳审，
  // 把一个掏空的稿子直接回填给用户（T-debug-01 实测复现）。
  if (b === "") return false;
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
 * 生成一条符合 DSH `Message` 形状的 user message。
 * 手工构造而非引入 `@deepseek-ai/dsh-llm` 的 helper：本包因此保持零运行时依赖，
 * 且只填运行时会真正读取的字段（id / role / content / source）。
 * @param {string} text 已渲染的 user prompt。
 * @returns {{id: string, role: 'user', content: Array<{type: 'text', text: string}>, source: {kind: 'plugin', plugin: string}}} 消息对象。
 */
// 违规归一化三件套已下沉到 prompt-templates（统一管线在那边复用同一套归一化）；
// 此处再导出维持既有导入面不变。
export { VIOLATION_KINDS, VIOLATION_LABELS, parseAuditVerdict };

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

  const text = normalizeResult(collected.text);
  // 输出体量硬上限（T-debug-L5）：finish=stop 不代表体量合理——实测失控 provider
  // 能吐 1MB 正文并被 ok 透传进输入框。上限取 4×MAX_TEXT_LENGTH：合法改写在
  // 补全契约下不会超过输入上限的数倍，超过它只可能是 provider 失控。
  if (text.length > MAX_OUTPUT_CHARS) {
    log?.("error", "[prompt-seed] output exceeds the hard size cap", {
      textLength: text.length,
      cap: MAX_OUTPUT_CHARS,
    });
    return { ok: false, code: ERROR_CODES.OUTPUT_TOO_LARGE, error: ERROR_MESSAGES.output_too_large };
  }

  return { ok: true, text };
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
  /(删除|移除|去掉|改|修改|替换|换成|换|重命名|添加|新增|实现|修复|更新|升级|迁移|重构|跑|运行|执行|测试|部署|回滚|delete|remove|rename|replace|add|implement|fix|update|upgrade|migrate|refactor|run|test|deploy|revert)/i;

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
 *
 * `auditRoute` 允许把审判单独路由到另一个模型（README 的已知限制 5）：
 * 审判是四次调用里最轻的两次，把它挪到更便宜/更快的模型上是压延迟最直接的杠杆。
 * 缺省即沿用主路由，行为与从前完全一致。
 * @param {object} params { llm, route, auditRoute, original, rewrite, context, signal, log }。
 * @returns {Promise<{status: string, violations: {kind: string, text: string}[], thin: boolean} | null>} 归一化判决，或 null。
 */
async function runAudit(params) {
  const { llm, route, auditRoute, original, rewrite, context, signal, log } = params;
  // 审判是轻量判定任务：不透传 reasoningEffort，保持便宜与快速。
  const call = await callModel(llm, auditRoute ?? route, {
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
 * 审判通过/不可用时的结果处理（0.12.0 从 optimizePromptText 抽出；行为不变）。
 * split 与 unified 两条管线共用：unified 的自审 OK 在这里合成 verdict 对象进入。
 * THIN 补全链保持原语义——补全稿必须重新过**独立**审判（自审报"薄"的稿子
 * 恰恰说明自检没把握，不能再用自检兜底）。
 * @param {object} args 见调用点。
 * @returns {Promise<object>} 结果对象。
 */
async function resolveAuditedOutcome(args) {
  const { llm, route, auditRoute, original, rewrite, op, routingTag, depth, context, metrics, effort, signal, log, maySpendMore, audit } = args;
  if (audit?.status === "unparsable") {
    log?.("warn", "[prompt-seed] audit output unparsable; failing open");
  }

  // 审判报"太薄"：只对种子输入再补一次。补全稿必须重新过审判——补全最容易
  // 越线成曲解，不能因为"只是加细节"就免检。补全后仍失真则回退第一稿：
  // 薄但忠实，比直接拒绝更有用（用户点这个按钮就是想要东西）。
  // 预算用尽时不做这次补全，直接落到"薄但忠实"的结论——语义完全一致，只是少花一次。
  if (audit?.thin === true && looksSeedish(original) && maySpendMore("thin-elaboration")) {
    log?.("warn", "[prompt-seed] audit reports a thin rewrite; elaborating once more", {
      ratio: Number(metrics.ratio.toFixed(2)),
    });
    const elaborated = await callModel(llm, route, {
      system: buildElaborateSystemPrompt(original) + depthSuffix(depth),
      user: renderElaborateUserPrompt(original, context),
      temperature: THIN_RETRY_TEMPERATURE,
      maxTokens: MAX_OUTPUT_TOKENS,
      reasoningEffort: effort,
      signal,
      log,
    });
    if (elaborated.ok && elaborated.text !== "") {
      // 同上：THIN 补全稿也要剥协议行（T-debug-F5）。
      const thinElaboratedText = parseAdaptiveResult(elaborated.text).text;
      if (thinElaboratedText !== "") {
        const secondAudit = await runAudit({ llm, route, auditRoute, original, rewrite: thinElaboratedText, context, signal, log });
        if (secondAudit === null || secondAudit.status === "ok") {
          return {
            ok: true,
            text: thinElaboratedText,
            tier: "elaborated",
            mode: op,
            classificationSource: routingTag,
            gate: { verdict: "ok", repairs: 0, rechecked: true, violations: [] },
            detail: typeof secondAudit?.detail === "string" ? secondAudit.detail : "",
          };
        }
        log?.("warn", "[prompt-seed] elaboration introduced distortion; keeping the thin but faithful draft", {
          violations: secondAudit.violations,
        });
      }
    }
    return {
      ok: true,
      text: rewrite.text,
      tier: "thin",
      mode: op,
      classificationSource: routingTag,
      gate: { verdict: "thin", repairs: 0, rechecked: false, violations: [] },
      detail: "",
    };
  }

  return {
    ok: true,
    text: rewrite.text,
    tier: "full",
    mode: op,
    classificationSource: routingTag,
    gate: { verdict: "ok", repairs: 0, rechecked: false, violations: [] },
    detail: typeof audit?.detail === "string" ? audit.detail : "",
  };
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
  // 归因标签：数字信号（含多选）与词信号分开统计——两者的锚点判定路径不同。
  const classificationSource = "signal-" + (classified.kind === "number" ? "number" : "word");
  const userTurns = Array.isArray(context) ? context : undefined;
  const item = inferPendingItem(classified, userTurns, assistantTail);
  if (item.mode === "none") {
    log?.("warn", "[prompt-seed] signal without an inferable pending item; refusing to guess", {
      token: classified.token,
      reason: item.reason,
    });
    return { ok: false, code: ERROR_CODES.CANNOT_INFER, error: ERROR_MESSAGES.cannot_infer, mode: "signal", classificationSource };
  }

  const draft = await callModel(llm, route, {
    system: buildSignalSystemPrompt(),
    user: renderSignalUserPrompt(classified.token, item.mode, item.anchor),
    temperature: TEMPERATURE,
    maxTokens: 240,
    signal,
    log,
  });
  if (!draft.ok) return { ...draft, mode: "signal", classificationSource };
  if (draft.text === "") {
    return { ok: false, code: ERROR_CODES.EMPTY_RESULT, error: ERROR_MESSAGES.empty_result, mode: "signal", classificationSource };
  }
  if (draft.text.includes(SIGNAL_FALLBACK_MARKER)) {
    log?.("warn", "[prompt-seed] model declined the signal expansion; refusing to guess");
    return { ok: false, code: ERROR_CODES.CANNOT_INFER, error: ERROR_MESSAGES.cannot_infer, mode: "signal", classificationSource };
  }

  const check = checkSignalOutput(draft.text, classified.token, item.anchor, item.mode);
  if (!check.ok) {
    log?.("warn", "[prompt-seed] signal output failed the grounding check; refusing to guess", {
      reason: check.reason,
    });
    return { ok: false, code: ERROR_CODES.CANNOT_INFER, error: ERROR_MESSAGES.cannot_infer, mode: "signal", classificationSource };
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
 *
 * 0.9.7 起 accept 助手尾部作为锚点来源（T-debug-F3）：指代词最常指向的正是助手
 * 刚交付/刚陈述的内容——此前只认用户话轮，"改一下"在助手刚说完话的会话里必然
 * cannot_infer，尽管锚点近在手边。inferPendingItem 的 deictic 分支（assistant-tail
 * 优先）写的正是这个语义，这里对齐它：用户话轮与助手尾部任一存在即可展开。
 * @param {object} args { llm, route, text, context, assistantTail, signal, log }
 * @returns {Promise<object>} 与主流程同构的结果对象。
 */
async function runDeicticExpansion(args) {
  const { llm, route, text, context, assistantTail, signal, log } = args;
  const classificationSource = "deictic";
  const userTurns = Array.isArray(context) ? context.filter((item) => item && typeof item.text === "string" && item.text.trim() !== "") : [];
  const assistantText =
    typeof assistantTail?.text === "string" && assistantTail.text.trim() !== "" ? assistantTail.text : undefined;
  if (userTurns.length === 0 && assistantText === undefined) {
    log?.("warn", "[prompt-seed] deictic directive without conversation context; refusing to guess");
    return { ok: false, code: ERROR_CODES.CANNOT_INFER, error: ERROR_MESSAGES.cannot_infer, mode: "deictic", classificationSource };
  }
  // 助手尾部是时间上最近的一条消息，排在用户话轮之后；度契约的 CONTEXT 块按
  // 时间正序渲染，模型才能把"刚才"对到正确的指代物上。
  const promptContext =
    assistantText === undefined
      ? userTurns
      : userTurns.concat([{ role: "assistant", text: assistantText }]);

  let draft = await callModel(llm, route, {
    system: buildDeicticSystemPrompt(),
    user: renderDeicticUserPrompt(text, promptContext),
    temperature: 0.2,
    maxTokens: 280,
    signal,
    log,
  });
  if (!draft.ok) return { ...draft, mode: "deictic", classificationSource };
  if (draft.text === "") {
    return { ok: false, code: ERROR_CODES.EMPTY_RESULT, error: ERROR_MESSAGES.empty_result, mode: "deictic", classificationSource };
  }
  if (draft.text.includes(DEICTIC_FALLBACK_MARKER)) {
    log?.("warn", "[prompt-seed] model could not resolve the referent; refusing to guess");
    return { ok: false, code: ERROR_CODES.CANNOT_INFER, error: ERROR_MESSAGES.cannot_infer, mode: "deictic", classificationSource };
  }

  let check = checkDeicticDegree(draft.text, text);
  if (!check.ok && (check.reason === "overlong" || check.reason === "verb_missing")) {
    log?.("warn", "[prompt-seed] deictic draft broke the degree rules; one tightened retry", {
      reason: check.reason,
    });
    const retry = await callModel(llm, route, {
      system: buildDeicticSystemPrompt({ tightened: true }),
      user: renderDeicticUserPrompt(text, promptContext),
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
          classificationSource,
          gate: { verdict: "ok", repairs: 1, rechecked: true, violations: [] },
          detail: "短指令→按度展开（一次收紧）",
        };
      }
    }
    return {
      ok: false,
      code: ERROR_CODES.FIDELITY_REJECTED,
      error: ERROR_MESSAGES.fidelity_rejected,
      mode: "deictic",
      classificationSource,
      violations: [{ kind: "scope_added", text: "短指令发散越界（超出用户词语的自然子部件）" }],
    };
  }
  if (!check.ok) {
    log?.("warn", "[prompt-seed] deictic draft failed the degree check", { reason: check.reason });
    return { ok: false, code: ERROR_CODES.CANNOT_INFER, error: ERROR_MESSAGES.cannot_infer, mode: "deictic", classificationSource };
  }

  return {
    ok: true,
    text: draft.text,
    tier: "deictic",
    mode: "deictic",
    classificationSource,
    gate: { verdict: "ok", repairs: 0, rechecked: false, violations: [] },
    detail: "短指令→按度展开",
  };
}

/**
 * 会话消息分支（0.9.1）：对助手的提问/观点/接续只做轻润色。
 *
 * 病灶是方向性失真：问句被补全契约改写成任务书。本分支的失败兜底是
 * **原文**——轻润色模式永远不拒绝、不重试越改越大：改不好就还原文，
 * 宁可没干活，不可干错活。确定性上限（输入 +35%）之外一次收紧重试，
 * 仍越限直接回退原文。
 * @param {object} args { llm, route, text, signal, log }
 * @returns {Promise<object>} 与主流程同构的结果对象。
 */
async function runConversationalTouchup(args) {
  const { llm, route, text, source, signal, log } = args;
  // 归因标签由调用方给：会话分支五条规则、助手问句划界、澄清兜底各不相同。
  const classificationSource = typeof source === "string" && source !== "" ? source : "conversational";
  const cap = Math.ceil(text.length * 1.35) + 6;
  const maxTokens = Math.min(480, Math.max(160, text.length * 2));
  // 轻润色的稿子也剥协议行：模型偶发带 MODE 头时，"MODE: clarify"会整行漏进
  // 输入框（T-debug-F5 实测 clarify 兜底路径）。轻润色契约本身无 MODE，剥掉
  // 不影响合法输出。
  const parse = (raw) => parseAdaptiveResult(raw).text;

  const draft = await callModel(llm, route, {
    system: buildConversationalSystemPrompt(),
    user: renderConversationalUserPrompt(text),
    temperature: 0,
    maxTokens,
    signal,
    log,
  });
  if (!draft.ok) {
    log?.("warn", "[prompt-seed] conversational touchup failed; returning the original");
    return { ok: true, text, tier: "conversational", mode: "conversational", classificationSource,
      gate: { verdict: "unverified", repairs: 0, rechecked: false, violations: [] }, detail: "会话消息→原文返回" };
  }
  const draftText = parse(draft.text);
  if (draftText === "" ) {
    return { ok: true, text, tier: "conversational", mode: "conversational", classificationSource,
      gate: { verdict: "unverified", repairs: 0, rechecked: false, violations: [] }, detail: "会话消息→原文返回" };
  }

  if (draftText.length > cap) {
    log?.("warn", "[prompt-seed] conversational draft exceeded the cap; one tightened retry", {
      inputChars: text.length, outputChars: draftText.length, cap,
    });
    const retry = await callModel(llm, route, {
      system: buildConversationalSystemPrompt({ tightened: true }),
      user: renderConversationalUserPrompt(text),
      temperature: 0,
      maxTokens,
      signal,
      log,
    });
    if (retry.ok) {
      const retryText = parse(retry.text);
      if (retryText !== "" && retryText.length <= cap) {
        return { ok: true, text: retryText, tier: "conversational", mode: "conversational", classificationSource,
          gate: { verdict: "unverified", repairs: 1, rechecked: false, violations: [] }, detail: "会话消息→轻润色（一次收紧）" };
      }
    }
    return { ok: true, text, tier: "conversational", mode: "conversational", classificationSource,
      gate: { verdict: "unverified", repairs: 0, rechecked: false, violations: [] }, detail: "会话消息→原文返回" };
  }

  // 上限内的稿子一律采纳：轻润色的"实质未变"是常态而非失败（补全闸的
  // 语义在这里恰好相反），它只决定凭证文案，不决定取舍。
  const unchanged = isSubstantivelyUnchanged(text, draftText);
  return { ok: true, text: draftText, tier: "conversational", mode: "conversational", classificationSource,
    gate: { verdict: "unverified", repairs: 0, rechecked: false, violations: [] },
    detail: unchanged ? "会话消息→未改动" : "会话消息→轻润色" };
}
/** seed 收紧带的倍率上限（0.10.0 从 optimizePromptText 移出为模块常量）。 */
const SEED_TIGHTEN_RATIO = 3.5;

/**
 * seed 收紧带（0.10.0 从 optimizePromptText 抽出；行为不变）。
 *
 * samples.jsonl 实测：≥15 字的输入补到 2.0~2.6× 被采纳发送；5.4×/5.8× 两次被
 * 撤销或手动重跑。真·微种子（登录、帮我做个X，<15 字）不受此带约束——它们
 * 本来就该大幅展开。超带 → 一次收紧重试（不带深度后缀，避免催长），取更短者，
 * 保证结果不会比第一稿更胖；不因仍超带而拒绝（种子宁可厚，不可空手）。
 * @param {object} args { llm, route, trimmed, rewrite, signal, log }。
 * @returns {Promise<{ok: boolean, text: string}>} 收紧后的稿子（失败时原样返回）。
 */
/**
 * 剥掉可能混入的统一协议段（0.12.0 防御）：后置调用（收紧/补全）用的不是统一
 * 契约，但格式漂移时模型可能仍按 DRAFT/AUDIT/FINAL 排版——先按统一协议解析取
 * FINAL，不行再走自适应解析。任何路径都不得把协议字样写回输入框。
 * @param {string} raw 模型输出。
 * @returns {string} 剥净的正文。
 */
function stripUnifiedProtocol(raw) {
  const unified = parseUnifiedResult(raw);
  if (!unified.malformed) return unified.final;
  return parseAdaptiveResult(raw).text;
}

async function tightenSeedDraft(args) {
  const { llm, route, trimmed, rewrite, op, signal, log } = args;
  if (op !== "seed" || trimmed.length < 15 || rewrite.text.length <= trimmed.length * SEED_TIGHTEN_RATIO) {
    return rewrite;
  }
  log?.("warn", "[prompt-seed] seed draft far exceeds the input's weight; tightening once", {
    inputChars: trimmed.length, outputChars: rewrite.text.length,
  });
  const tightened = await callModel(llm, route, {
    system: SEED_TIGHTEN_SYSTEM,
    user: renderSeedTightenUserPrompt(trimmed, rewrite.text),
    temperature: 0,
    maxTokens: MAX_OUTPUT_TOKENS,
    signal,
    log,
  });
  if (!tightened.ok) return rewrite;
  const tightenedText = stripUnifiedProtocol(tightened.text);
  if (tightenedText === "" || tightenedText.length >= rewrite.text.length) return rewrite;
  return { ...tightened, text: tightenedText };
}

/**
 * 补全闸（0.10.0 从 optimizePromptText 抽出；行为不变）。
 *
 * 服务端在 temperature=0 下仍有方差：种子型输入的第一稿约半数只做标点级微调就
 * 返回。这里用确定性检查抓出"实质未变"，用强化指令最多重试两次（温度 0.4 → 0.7
 * 递增扰动；零温度重试实测与第一稿采样相同，等于白跑）。精确输入不走此闸——
 * 它本来就该接近原样，再"补全"正好是要治的加戏。
 * @param {object} args { llm, route, trimmed, rewrite, op, depth, context, signal, log, maySpendMore }。
 * @returns {Promise<{ok: boolean, text: string}>} 补全后的稿子（不适用/失败时原样返回）。
 */
async function unfoldRetryIfNeeded(args) {
  const { llm, route, trimmed, op, depth, context, reasoningEffort, signal, log, maySpendMore, holdDraft } = args;
  let rewrite = args.rewrite;
  // holdDraft：自审已修过的终稿不再进补全闸——修复把越线处摘掉后落回贴近原文
  // 是修复的正确结局；补全闸的职责是抓"第一稿什么都没干"，不是推翻修复。
  if (holdDraft === true) return rewrite;
  if (!(op === "seed" && isSubstantivelyUnchanged(trimmed, rewrite.text) && looksOpenEnded(trimmed))) {
    return rewrite;
  }
  for (const temperature of [UNFOLD_RETRY_TEMPERATURE, UNFOLD_RETRY_TEMPERATURE + 0.3]) {
    if (!maySpendMore("unfold-retry")) break;
    log?.("warn", "[prompt-seed] rewrite is substantively unchanged; retrying with elaboration", { temperature });
    const elaborated = await callModel(llm, route, {
      system: buildElaborateSystemPrompt(trimmed) + depthSuffix(depth),
      user: renderElaborateUserPrompt(trimmed, context),
      temperature,
      maxTokens: MAX_OUTPUT_TOKENS,
      reasoningEffort: reasoningEffort,
      signal,
      log,
    });
    if (!elaborated.ok || elaborated.text === "") break;
    // 协议行必须剥：补全契约的输出若带 MODE 头或统一协议段（格式漂移），
    // 原样写回会把协议文本漏进输入框（T-debug-F5/T-uni，与首稿同一处理）。
    const elaboratedText = stripUnifiedProtocol(elaborated.text);
    if (elaboratedText === "") break;
    // 与原实现一致：每次尝试都采纳为当前稿（哪怕骨架仍未变——措辞可能更接近
    // 可用），直到某一稿骨架真正展开才停。
    rewrite = { ...elaborated, text: elaboratedText };
    if (!isSubstantivelyUnchanged(trimmed, rewrite.text)) break;
  }
  return rewrite;
}
export async function optimizePromptText(options) {
  const { llm, route, auditRoute, text, context, signal, log } = options ?? {};
  // 推理力度透传（0.10.1）：inheritReasoningEffort 为真时，生成型改写调用跟随
  // 路由自带的 reasoningEffort；缺省 undefined = callModel 不下发该字段（旧行为）。
  // 审判与 seed 压缩永远不带——它们的职责是快与稳，不是深思。
  const effort =
    options?.inheritReasoningEffort === true && typeof route?.reasoningEffort === "string"
      ? route.reasoningEffort
      : undefined;
  // 可选调用（补全重试 / 收紧重试 / 定向修复）的墙钟预算起点。第 3、4 次调用只在
  // 第一稿越线时才发生，是唯一可以"跳过而不改变诚实结论"的开销，见 DEFAULT_DEADLINE_MS。
  const startedAt = Date.now();
  const deadlineMs =
    Number.isFinite(options?.deadlineMs) && options.deadlineMs > 0 ? options.deadlineMs : DEFAULT_DEADLINE_MS;
  /**
   * 现在还能不能再花一次可选调用。
   * @param {string} step 步骤名（进日志，用于回答"这次为什么没修复"）。
   * @returns {boolean} 是否仍可继续。
   */
  const maySpendMore = (step) => {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs < deadlineMs) return true;
    log?.("warn", "[prompt-seed] past the optional-call deadline; skipping the remaining retry/repair", {
      step,
      elapsedMs,
      deadlineMs,
    });
    return false;
  };

  const invalid = validateInput(text);
  if (invalid !== null) {
    return { ok: false, code: invalid, error: ERROR_MESSAGES[invalid] ?? invalid };
  }

  // ---- 内容下限（确定性短路，零模型调用）----
  // 纯招呼/纯标点没有可执行意图，任何契约都只能硬编一个意图再被闸门拦下。
  // 实测：hi 空转 5.4s、你好 被拒 8.5s。这里直接给出中性结论，用户不白等。
  if (isContentFree(text)) {
    log?.("warn", "[prompt-seed] input has no actionable content; skipping model calls");
    return { ok: false, code: ERROR_CODES.NOTHING_TO_OPTIMIZE, error: ERROR_MESSAGES.nothing_to_optimize, classificationSource: "content-free" };
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
    return await runDeicticExpansion({
      llm, route, text: trimmed, context,
      assistantTail: options.assistantTail, signal, log,
    });
  }

  // ---- 会话消息分支（0.9.1，确定性分类，不花调用）----
  // 对助手的提问/追问/观点/接续不是需求种子：补全契约会把问句改写成任务书
  // （方向性失真，SCOPE_ADDED 按任务种子定义拦不住）。命中即只做轻润色，
  // 失败兜底是原文——本分支永不拒绝。
  if (isConversationalMessage(trimmed)) {
    return await runConversationalTouchup({
      llm, route, text: trimmed, signal, log,
      source: "conversational-" + (conversationalRuleOf(trimmed) ?? "unknown"),
    });
  }

  // ---- 模式选择（自适应契约：模型判意图，代码管约束）----
  // 旧版用确定性启发式把"其余一切"默认成扩展契约——真实使用数据（samples.jsonl，
  // 22 次点击）证明这是错的：多数输入是"完整但含混"的诉求，用户要约 1× 的澄清
  // 梳理，不是 2~8× 的扩写；两次完整指令因此被扩成越线稿（闸门拒绝、一无所获），
  // 一次 45 字完整提问被放行为 339 字。现在一次调用先声明 MODE（seed / clarify /
  // precise）再改写；模板要求拿不准时偏向 clarify——保守侧错误的代价只是"没补"，
  // 激进侧的代价是"编造"。度约束仍由代码强制（下方 clarify 检查），失真闸门不变。
  const depth = options.depth === "deep" || options.depth === "light" ? options.depth : "standard";

  // 问句形短消息（向助手提问/问下一步）本来就该由会话分支轻润色，是分类器漏放行到
  // 了中间分支——真实数据：glm-5.2 对「已重启了，然后需要我做什么」在自适应契约下
  // 连续三稿执意扩成 90~130 字清单（含专用澄清契约也拦不住）。界由代码划：
  // ≤60 字、无代码锚定、含问号或下一步类措辞 → 会话分支，1.0× 轻润色。
  const assistantQuestionMessage =
    trimmed.length <= 60 &&
    !/[\\/:]/.test(trimmed) &&
    /[\uFF1F?]|做什么|怎么办|怎么弄|干什么|干啥|下一步|接下来|要不要|\bwhat\s+(should|do)\s+i\b|\bwhat'?s\s+next\b|\bnext\s+step\b|\bshall\s+i\b|\bdo\s+you\s+want\b/i.test(trimmed);
  if (assistantQuestionMessage && !isPreciseInstruction(trimmed)) {
    log?.("warn", "[prompt-seed] assistant-question shaped input routed to conversational touch-up");
    return await runConversationalTouchup({ llm, route, text: trimmed, signal, log, source: "assistant-question" });
  }

  // 精确模式跳审时的凭证：没有审判可报，如实标 unverified，不伪装成"保真通过"。
  const unverifiedGate = { verdict: "unverified", repairs: 0, rechecked: false, violations: [] };

  // ---- 第一稿：自适应改写（先声明缺什么，再做对应操作）----
  // 不透传 reasoningEffort：改写是轻任务，max 档深推理让输出路径发散
  // （同一输入时而补全时而原样的实测方差来源）且拖慢数秒。
  //
  // 0.12.0 起有两条管线（options.pipeline，缺省 split 维持旧行为）：
  //   split   —— 改写与审判两次独立调用（历史默认：同上下文自检倾向报喜）。
  //   unified —— 同一次调用内 DRAFT→AUDIT→FINAL（自审契约见 prompt-templates）。
  //              协议残缺时自动降级为 split 语义（用同一段文本走独立审判），
  //              因此 unified 的质量下界就是 split，上界省一整次调用。
  const pipeline = options.pipeline === "unified" ? "unified" : "split";
  /** 统一管线的自审结果（split 恒为 null）；审判段的消费逻辑见下方。 */
  let selfAudit = null;
  /** 统一管线的原始 DRAFT（区分"没修"与"修了"的判据）。 */
  let unifiedDraft = "";
  let rewrite = await callModel(llm, route, {
    system: (pipeline === "unified" ? buildUnifiedSystemPrompt(trimmed) : buildAdaptiveSystemPrompt(trimmed)) + depthSuffix(depth),
    user: renderUserPrompt(trimmed, context),
    temperature: TEMPERATURE,
    maxTokens: MAX_OUTPUT_TOKENS,
    reasoningEffort: effort,
    signal,
    log,
  });
  if (!rewrite.ok) return rewrite;
  let parsed;
  if (pipeline === "unified") {
    const unified = parseUnifiedResult(rewrite.text);
    if (unified.malformed) {
      // 协议没成形不是用户的问题：降级为 split 语义，让独立审判接管同一段文本。
      log?.("warn", "[prompt-seed] unified protocol malformed; degrading to the split audit", {
        hasMode: unified.declared,
      });
      parsed = parseAdaptiveResult(rewrite.text);
      rewrite = { ...rewrite, text: parsed.text };
    } else {
      selfAudit = unified.audit;
      unifiedDraft = unified.draft;
      parsed = { op: unified.op, text: unified.final, declared: unified.declared };
      rewrite = { ...rewrite, text: unified.final };
      if (selfAudit !== null && selfAudit.status === "issues") {
        log?.("warn", "[prompt-seed] unified self-audit reported violations", {
          violations: selfAudit.violations,
        });
      }
    }
  } else {
    parsed = parseAdaptiveResult(rewrite.text);
    rewrite = { ...rewrite, text: parsed.text };
  }
  if (!parsed.declared) {
    log?.("warn", "[prompt-seed] adaptive output missing the MODE line; defaulting to seed");
  }
  // 检查型请求划界（真实回归）："看看X能不能用"类输入是完整诉求，模型却连判 seed
  // （实测 5.70×/5.26×）。含「能不能/行不行/是不是/好不好」且 ≥15 字 → 一律按
  // clarify 校验；胖稿自然落入收紧重试与会话兜底，用户拿到的永远是 ≤1.5× 或 1.0×。
  const checkShaped = parsed.op === "seed" && /能不能|行不行|是不是|好不好/.test(trimmed) && trimmed.length >= 15;
  const op = checkShaped ? "clarify" : parsed.op;
  // 路由归因：管线（unified/adaptive）× 档位 × 是否确定性层强制改判，分开统计。
  const routingTag =
    (selfAudit !== null ? "unified-" : "adaptive-") + (checkShaped ? "clarify-forced" : op);
  if (checkShaped) {
    log?.("warn", "[prompt-seed] check-shaped input; enforcing clarify regardless of declaration");
  }
  const precise = op === "precise";
  if (rewrite.text === "") {
    log?.("error", "[prompt-seed] model returned empty text after normalization");
    return { ok: false, code: ERROR_CODES.EMPTY_RESULT, error: ERROR_MESSAGES.empty_result, mode: op, classificationSource: routingTag };
  }

  // ---- 澄清度约束（纯代码，不劳模型判断）----
  // 声明 clarify 却超长 = 违反自己声明的操作，这正是要堵的"不请自来的扩展"。
  // 一次收紧重试；仍超限则确定性拒绝——宁可不写回，不把 3 倍的"澄清"塞给用户。
  const clarifyBudget = Math.ceil(trimmed.length * 1.5);
  if (op === "clarify" && rewrite.text.length > clarifyBudget) {
    log?.("warn", "[prompt-seed] clarify draft exceeds its length budget; retrying tighter", {
      inputChars: trimmed.length, outputChars: rewrite.text.length, budget: clarifyBudget,
    });
    const retried = await callModel(llm, route, {
      // 收紧重试用澄清专用契约：重试仍可自选模式 = 让模型推翻自己刚做的错误
      // 判断（实测它真的会）。确定性层已裁定 clarify，重试只执行。
      system: CLARIFY_ONLY_SYSTEM,
      user: renderUserPrompt(trimmed, context),
      temperature: 0.3,
      maxTokens: MAX_OUTPUT_TOKENS,
      reasoningEffort: effort,
      signal,
      log,
    });
    if (retried.ok && parseAdaptiveResult(retried.text).text !== "") {
      rewrite = { ...retried, text: parseAdaptiveResult(retried.text).text };
    }
    if (rewrite.text.length > clarifyBudget) {
      // 不再把用户晾在空手而归上：澄清两次都收不住 → 会话级轻润色兜底（1.0×，
      // 必有产出）。真实数据里两条祈使消息撞进这条路，硬拒绝的体验是"点了没用"。
      log?.("warn", "[prompt-seed] clarify still over budget; falling back to conversational touch-up");
      return await runConversationalTouchup({ llm, route, text: trimmed, signal, log, source: "clarify-fallback" });
    }
  }
  // 澄清不得丢失锚定词：指代理顺不能顺手改掉路径/标识符/数字。同样走会话兜底
  //（轻润色以原文为底，锚定词天然保全），不空手而归。
  if (op === "clarify" && !preservesAnchors(trimmed, rewrite.text)) {
    log?.("warn", "[prompt-seed] clarify lost anchors; falling back to conversational touch-up");
    return await runConversationalTouchup({ llm, route, text: trimmed, signal, log, source: "clarify-fallback" });
  }

  // ---- 澄清确定性短路（0.10.0，延迟优化）----
  // 走到这里的一定是 clarify 且已过 1.5× 预算与锚定词守恒（上方两块保证）；
  // 再加 0.7× 下限（防丢内容）后，剩余的语义级失真风险与 conversational 分支的
  // unverified 交付同级——真实使用分布（samples.jsonl）里 conversational 的
  // 0.94–1.06× 稿全部被 submitted 接受。省下的是最重的一次审判调用（实测占
  // 整条路径约四成延迟），clarify 点击从约 8s 降到约 4s。
  // 顺带的正确性收益：带内近原样的澄清稿不再进 THIN→补全链——那条链会把
  // 检查型完整请求（"看看X能不能用"）扩成清单，正是真实撤销样本的形态。
  if (op === "clarify" && rewrite.text.length >= Math.floor(trimmed.length * 0.7)) {
    log?.("warn", "[prompt-seed] clarify draft inside the deterministic band; skipping the audit call", {
      inputChars: trimmed.length,
      outputChars: rewrite.text.length,
    });
    return { ok: true, text: rewrite.text, tier: "full", mode: op, gate: unverifiedGate, detail: "", classificationSource: routingTag };
  }


  // ---- seed 收紧带 / 补全闸（实现见同名模块级函数）----
  rewrite = await tightenSeedDraft({ llm, route, trimmed, rewrite, op, signal, log });
  rewrite = await unfoldRetryIfNeeded({
    llm, route, trimmed, rewrite, op, depth, context, reasoningEffort: effort, signal, log, maySpendMore,
    // 修复稿或自审报薄时都由后续专责路径处理（修复交付 / THIN 补全链），
    // 补全闸不再重复展开——实测两者叠加会把一次自审 THIN 变成三次补全调用。
    holdDraft: selfAudit !== null && (selfAudit.status === "issues" || selfAudit.thin === true),
  });

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
    return { ok: true, text: rewrite.text, tier: "full", mode: op, gate: unverifiedGate, detail: "", classificationSource: routingTag };
  }

  // ---- 统一管线的自审消费（0.12.0）----
  // 约束力四层中的后两层在这里兑现：终稿已过上方全部确定性校验（预算带/锚定词/
  // 收紧带/实质未变），现在按自审结果分流——
  //   自审 OK（含 THIN）→ 合成一个 verdict 对象，走既有返回/补全链，省掉独立审判调用；
  //   自审有违规 → FINAL 必须是真修（与 DRAFT 实质不同）才交付；假修直接按自报违规
  //   拒绝，绝不接受"报了但没修"。降级路径（malformed）的 selfAudit 为 null，
  //   自然落进下方独立审判——质量下界即 split。
  if (selfAudit !== null && op !== "precise") {
    // precise 例外：实测统一协议下模型对精确输入倾向扩写且自审放行（自检报喜
    // 的失效模式）——precise 且非近原样的稿子不信任自审，照走独立审判。
    if (selfAudit.status === "ok") {
      // THIN 语义与独立审判一致：种子输入走既有补全链（那次补全会再过独立审判）。
      const synthesized = { status: "ok", violations: [], thin: selfAudit.thin, detail: selfAudit.detail ?? "" };
      return await resolveAuditedOutcome({
        llm, route, auditRoute, original: trimmed, rewrite, op, routingTag, depth, context,
        metrics, effort, signal, log, maySpendMore,
        audit: synthesized,
      });
    }
    // 自审报违规：FINAL 与 DRAFT 逐字相同 = 没修，按违规拒绝（绑定力）。
    // 刻意不用骨架级比较：小稿删一个从句（真修）可能仍在编辑距离容差内，
    // 骨架判据会把真修误杀成假修。逐字判据只拦"原样抄一遍"这种明确没修的。
    const fixedForReal = normalizeResult(unifiedDraft).trim() !== rewrite.text.trim();
    if (!fixedForReal) {
      log?.("warn", "[prompt-seed] unified final did not fix the self-reported violations; rejecting", {
        violations: selfAudit.violations,
      });
      return {
        ok: false,
        code: ERROR_CODES.FIDELITY_REJECTED,
        error: ERROR_MESSAGES.fidelity_rejected,
        mode: op,
        classificationSource: routingTag,
        added: selfAudit.violations.map((item) => item.text),
        violations: selfAudit.violations.map((item) => ({
          kind: item.kind,
          label: VIOLATION_LABELS[item.kind] ?? item.kind,
          text: item.text,
        })),
        rejected: rewrite.text,
      };
    }
    // 真修：交付修复稿，凭证如实标 repaired（自审修复，无独立复核）。
    return {
      ok: true,
      text: rewrite.text,
      tier: "repaired",
      mode: op,
      classificationSource: routingTag,
      gate: { verdict: "repaired", repairs: 1, rechecked: false, violations: selfAudit.violations },
      detail: typeof selfAudit.detail === "string" ? selfAudit.detail : "",
    };
  }

  const audit = await runAudit({ llm, route, auditRoute, original: trimmed, rewrite: rewrite.text, context, signal, log });
  const auditDetail = typeof audit?.detail === "string" ? audit.detail : "";

  if (audit === null || audit.status === "unparsable" || audit.status === "ok") {
    return await resolveAuditedOutcome({
      llm, route, auditRoute, original: trimmed, rewrite, op, routingTag, depth, context,
      metrics, effort, signal, log, maySpendMore, audit,
    });
  }

  // ---- 失真：定向修复（保留已补细节，只摘越线处）----
  log?.("warn", "[prompt-seed] rewrite distorts the request; repairing", {
    ratio: Number(metrics.ratio.toFixed(2)),
    mode: op,
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
  /**
   * 拒绝结果：与"修复后仍失真"完全同构，客户端不需要为任何一条新路径做区分。
   * @param {string} rejectedDraft 随结果回传的被拒草稿（字段名 rejected，绝不占用 text）。
   * @param {object} [extra] 附加字段（如 deadlineExceeded）。
   * @returns {object} 结果对象。
   */
  const rejectForFidelity = (rejectedDraft, extra = {}) => ({
    ok: false,
    code: ERROR_CODES.FIDELITY_REJECTED,
    error: ERROR_MESSAGES.fidelity_rejected,
    mode: op,
    classificationSource: routingTag,
    added: violationTexts,
    violations: audit.violations.map((item) => ({
      kind: item.kind,
      label: VIOLATION_LABELS[item.kind] ?? item.kind,
      text: item.text,
    })),
    rejected: rejectedDraft,
    ...extra,
  });

  // 预算用尽 → 跳过修复。修复之后还有一次**强制**复核（见下方二次审判），
  // 所以这条可选路径的真实代价是两次调用；把它换成与"修复后仍失真"逐字相同的诚实
  // 结论，用户不必为了同一句"已保留原文"再多等十几秒。
  if (!maySpendMore("repair")) {
    return rejectForFidelity(rewrite.text, { deadlineExceeded: true });
  }

  const repaired = await callModel(llm, route, {
    system: buildRepairSystemPrompt(trimmed, { precise }),
    user: renderRepairUserPrompt(trimmed, violationTexts, context),
    temperature: TEMPERATURE,
    maxTokens: MAX_OUTPUT_TOKENS,
    reasoningEffort: effort,
    signal,
    log,
  });
  if (!repaired.ok) return { ...repaired, mode: op, classificationSource: routingTag };
  if (repaired.text === "") {
    log?.("error", "[prompt-seed] repair retry returned empty text");
    return rejectForFidelity(rewrite.text);
  }

  // ---- 二次审判：修复稿一律复核（回退 0.8.0 的"结构型免复核"捷径）----
  // 那次优化为了省一次调用（4 → 3），对 padded / scope_added / tone_shifted 直接采纳修复稿。
  // 实测代价：线上一次 `scope_added`（范围被扩宽，即"过度发散"）的修复稿未经复核就被交付，
  // 而旧版本在这里会复核、仍越线则**拒绝并保留原文**。省下的那一次调用，恰好省在了唯一
  // 拦住"越修越发散"的环节上——延迟优化不能吃掉发散控制。
  const repairedAudit = await runAudit({ llm, route, auditRoute, original: trimmed, rewrite: repaired.text, context, signal, log });
  if (repairedAudit === null || repairedAudit.status === "ok") {
    return {
      ok: true,
      text: repaired.text,
      tier: "repaired",
      mode: op,
      classificationSource: routingTag,
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
  // 违规清单以**复核稿**的判决为准（它反映的是最终要交付的那一稿）。
  const repairedTexts = repairedAudit.violations.map((item) => item.text);
  return {
    ok: false,
    code: ERROR_CODES.FIDELITY_REJECTED,
    error: ERROR_MESSAGES.fidelity_rejected,
    mode: op,
    classificationSource: routingTag,
    added: repairedTexts,
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

/**
 * 预测用户的下一步输入（0.9.6）。
 *
 * 与 optimizePromptText 的关系：那条管线作用在**用户已经写下的草稿**上（改写、审判、
 * 修复），本函数没有输入文本——它读会话尾部，产出用户接下来最可能发的那一句话。
 * 因此这里不需要审判闸门（没有被改写的原文可以失真），需要的是另一件事：**不硬猜**。
 * 语境支撑不了就返回 cannot_predict（中性拒绝），界面据此显示灰图标 + 提示，
 * 而不是让模型随手编一句"继续"填进输入框。
 *
 * 分型与字数预算由 prediction.js 的确定性规则判定（零额外调用），本函数只负责：
 * 一次调用 → 一次收紧重试 → 确定性校验/收尾 → 结果归一化。
 * @param {{llm?: object, route?: object, kind: string, anchor?: string, choiceOptions?: string[],
 *          turns?: {role: string, text: string}[], signal?: AbortSignal,
 *          log?: (level: string, message: string, meta?: object) => void}} options 调用参数。
 * @returns {Promise<object>} { ok: true, text, mode: 'predict', kind, tier, gate, detail }
 *          或 { ok: false, code, error, mode: 'predict' }。
 */
export async function predictNextPrompt(options) {
  const { llm, route, kind, anchor, choiceOptions, turns, signal, log } = options ?? {};
  const predictKind = typeof kind === "string" && kind !== "" ? kind : "next-step";

  if (llm === undefined || llm === null || typeof llm.stream !== "function") {
    log?.("error", "[prompt-seed] llm service unavailable; prediction disabled");
    return { ok: false, code: ERROR_CODES.LLM_UNAVAILABLE, error: ERROR_MESSAGES.llm_unavailable, mode: "predict", kind: predictKind };
  }
  if (route === undefined || route === null) {
    log?.("error", "[prompt-seed] default model route unavailable; prediction disabled");
    return { ok: false, code: ERROR_CODES.MODEL_UNAVAILABLE, error: ERROR_MESSAGES.model_unavailable, mode: "predict", kind: predictKind };
  }

  /**
   * 中性拒绝：预测不出来时不产出任何文本（界面显示灰图标 + 提示）。
   * @param {string} reason 拒绝原因（进日志，用于回答"为什么这次没预测"）。
   * @returns {object} 归一化失败结果。
   */
  const refuse = (reason) => {
    log?.("warn", "[prompt-seed] prediction refused; not guessing the next input", { kind: predictKind, reason });
    return { ok: false, code: ERROR_CODES.CANNOT_PREDICT, error: ERROR_MESSAGES.cannot_predict, mode: "predict", kind: predictKind };
  };

  let latest = await callModel(llm, route, {
    system: buildPredictSystemPrompt(predictKind),
    user: renderPredictUserPrompt(predictKind, anchor, turns),
    temperature: PREDICT_TEMPERATURE,
    maxTokens: PREDICT_MAX_OUTPUT_TOKENS,
    signal,
    log,
  });
  if (!latest.ok) return { ...latest, mode: "predict", kind: predictKind };
  if (latest.text === "") {
    log?.("error", "[prompt-seed] prediction returned empty text");
    return { ok: false, code: ERROR_CODES.EMPTY_RESULT, error: ERROR_MESSAGES.empty_result, mode: "predict", kind: predictKind };
  }
  if (latest.text.includes(PREDICT_FALLBACK_MARKER)) return refuse("model_fallback");

  let check = checkPredictionOutput(latest.text, predictKind, choiceOptions);
  if (!check.ok && check.reason === "overlong") {
    // 收紧重试一次，温度归零：上一稿超长时，随机性只会让它更长。
    log?.("warn", "[prompt-seed] prediction draft over budget; one tightened retry", {
      kind: predictKind,
      chars: latest.text.length,
      budget: PREDICT_BUDGETS[predictKind] ?? null,
    });
    const retry = await callModel(llm, route, {
      system: buildPredictSystemPrompt(predictKind, { tightened: true }),
      user: renderPredictUserPrompt(predictKind, anchor, turns),
      temperature: PREDICT_RETRY_TEMPERATURE,
      maxTokens: PREDICT_MAX_OUTPUT_TOKENS,
      signal,
      log,
    });
    if (retry.ok && retry.text !== "" && !retry.text.includes(PREDICT_FALLBACK_MARKER)) {
      latest = retry;
      check = checkPredictionOutput(retry.text, predictKind, choiceOptions);
    }
  }

  if (!check.ok && check.reason === "overlong") {
    // 确定性收尾：切到预算内最后一个句读边界。宁可给一句稍短但完整的话，也不报一个
    // 用户无法理解的"预测过长"——语言级拒绝只留给"推不出来"这一种情况。
    const trimmed = trimPredictionToBudget(latest.text, predictKind);
    const recheck = checkPredictionOutput(trimmed, predictKind, choiceOptions);
    if (recheck.ok) {
      log?.("warn", "[prompt-seed] prediction trimmed to its budget", {
        kind: predictKind,
        from: latest.text.length,
        to: trimmed.length,
      });
      check = recheck;
    }
  }
  if (!check.ok) return refuse(check.reason);

  return {
    ok: true,
    text: check.text,
    tier: "predict",
    mode: "predict",
    kind: predictKind,
    // 预测没有被改写的原文，也就没有"保真"可言——如实返回 null，不借用一个
    // 未运行过的闸门凭证（凭证必须可核对，这是本插件的既有约定）。
    gate: null,
    detail: "预测→" + (PREDICT_KIND_LABELS[predictKind] ?? predictKind),
  };
}

