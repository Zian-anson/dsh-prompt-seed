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

import { cjkCharSet, eventMessageOf, lastMatchingSentenceOf, lastSentenceOf, messageTextOf, safeSlice } from "./message-text.js";

/** 信号类输出的软上限（字符）。 */
const SIGNAL_MAX_CHARS = 120;

/** 短指令类输出的硬上限（字符）。 */
const DEICTIC_MAX_CHARS = 180;

/** 模型端指代消解失败时的回执标记（host 检测后转为 cannot_infer）。 */
export const DEICTIC_FALLBACK_MARKER = "[无法确定指代对象]";

/** 模型端锚点不足时的回执标记。 */
export const SIGNAL_FALLBACK_MARKER = "[无法推断]";

/** 纯信号词：自身无任务内容，只有"接着上文"一种含义。 */
/**
 * 纯信号词（中英双语，0.10.1）：自身无任务内容，只有"接着上文"一种含义。
 * 英文与中文同表全匹配——尾部标点已在 classifySignalInput 里剥掉。
 */
const SIGNAL_WORDS = /^(继续|接着|往下|go\s*on|continue|ok|okay|yes|好|好的|行|嗯|对|是|可以|keep\s*going|go\s*ahead|proceed|sure|yep|yeah|do\s*it)$/i;

/** 短指令动词表（出现即认为是有明确指向的短指令）。 */
/** 短指令动词表（中英双语）。英文受 6 码点上限约束：单词动词可进，短语进不来。 */
const DEICTIC_VERBS = /(改|修|删|去掉|换|重做|重来|重启|再来|撤销|撤回|回退|退回|跳过|停|不对|错了|不行|重试|fix|change|redo|retry|wrong|undo|revert|skip|stop)/i;

/** 短指令的长度上限（码点数）：超过则视为普通草稿走既有流程。 */
const DEICTIC_MAX_INPUT = 6;

/** 判定"问句"的形态：句尾问号，或句尾"吗/么"。 */
export function isQuestion(s) {
  return /[？?]\s*$/.test(s) || /(吗|么)[。.?？]?\s*$/.test(s);
}

/** 待续提议：助手在问/提议要不要继续做某事。 */
export const CONTINUATION_OFFER = /(要不要|要不要继续|需不需要|是否(要|继续|需要)|继续吗|往下吗|shall\s+i|want\s+me|should\s+i|proceed|go\s+ahead)/i;

/**
 * 分类输入：纯数字 / 纯信号词 / 短指令 / 其他。
 *
 * 尾部标点先剥（T-debug-F7）：信号词全匹配 `^(…)$` 挡不住"继续。""ok!"这类
 * 带一个尾标点的信号——它们漏进自适应管线后，"继续。"被当种子补全，恰好绕开
 * 信号分支"绝不硬猜"的整个设计。数字位数同时放宽到 6：纯数字输入永远不是
 * 有内容的种子，走信号分支 cannot_infer（诚实）好过白烧调用。
 * @param {string} text 输入草稿。
 * @returns {{kind: 'number'|'signal'|'deictic'|'none', token: string}} 分类结果。
 */
export function classifySignalInput(text) {
  const s = typeof text === "string" ? text.trim() : "";
  if (s === "") return { kind: "none", token: s };
  const bare = s.replace(/[。.!！？?～~]+$/, "");
  if (/^[0-9]{1,6}(\.[0-9]+)?$/.test(bare)) return { kind: "number", token: bare };
  // 多选数字（"1，2"/"1、2"/"1 2"/"1,2,3"）：同样是自身无内容的纯信号。真实撤销
  // 样本（samples.jsonl 10-05）：「1，2」被当种子展开 35×/19× 两次，用户连续撤销
  // ——这类输入的唯一含义是"接着上文选这几项"，落进 seed 分支就是产品事故。
  // token 归一为顿号连接，inferPendingItem 按顿号拆开逐一比对选项。
  const parts = bare.split(/[，,、\s]+/).filter(Boolean);
  if (parts.length >= 2 && parts.length <= 4 && parts.every((p) => /^[0-9]{1,6}$/.test(p))) {
    return { kind: "number", token: parts.join("、") };
  }
  if (SIGNAL_WORDS.test(bare)) return { kind: "signal", token: bare };
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
 * @returns {'signal'|'deictic'|'conversational'|null} 命中专用分支时返回 mode 名。
 */
export function describeMode(text) {
  const { kind } = classifySignalInput(text);
  if (kind === "number" || kind === "signal") return "signal";
  if (kind === "deictic") return "deictic";
  if (isConversationalMessage(text)) return "conversational";
  return null;
}

// ---------------------------------------------------------------------------
// 会话消息分支（0.9.1）：对助手说的话不是需求种子。
//
// 实测病灶：用户对助手的提问/追问/观点（"我还是觉得效果不如之前，这是怎么回事？"
// "刚才我想问的准确的是该发到哪？"）被补全契约当种子展开，问句被改写成任务书——
// 方向性失真，闸门的 SCOPE_ADDED 语义（按任务种子定义）拦不住。
// 判据刻意保守：只认明确的元话语/观点/追问/二选一问句/接续指令，
// 带任务动词的输入（帮我做X/实现X/写一个X）一律放行给既有流程。
// ---------------------------------------------------------------------------

/** 元话语（中英双语）：谈论这场对话本身，而不是布置任务。 */
const META_MARKERS = /(我想问|我要问|我的意思|准确地说|准确的是|换个(问法|说法)|刚才(我想|我要问|那个问题)|还有一些问题|还有(一个|几个)问题|顺便问|追问一下|再问(一|个)|\bi\s+want\s+to\s+ask\b|\bmy\s+question\b|\bwhat\s+i\s+mean\b|\bto\s+be\s+(precise|exact)\b|\bone\s+more\s+question\b|\ba\s+few\s+more\s+questions\b|\bfollow[- ]?up\s+question\b)/i;

/** 观点/感受陈述（中英双语）。 */
const OPINION_MARKERS = /(我觉得|我感觉|我认为|好像(不如|变差|有问题|不太对)|\bi\s+(think|feel)\b|\bit\s+seems\b|\bfeels\s+like\b)/i;

/** 追问原因/解释的问句形态（中英双语）。 */
const WHY_QUESTION = /(为什么|怎么回事|怎么会|差在哪|问题出在哪|哪里不对|\bwhy\b|\bhow\s+come\b|\bwhat'?s\s+wrong\b|\bwhat\s+happened\b)/i;

/** 二选一/确认型问句（中英双语）：对着助手要一个判断。 */
const CHOICE_QUESTION = /(该不该|要不要|是不是|需不需要|行不行|可不可以|有没有必要|还是说|\bshould\s+(we|i)\b|\bdo\s+(we|i)\s+(need|want)\b|\bis\s+it\s+(worth|necessary|ok|fine)\b|\bor\s+should\b)/i;

/** 接续指令（中英双语）：让助手继续既有工作，指代靠"这个/刚才/继续"类词。 */
const CONTINUATION = /(继续|接着|再)(看|查|梳理|分析|评估|检查|测试|推进|整理)|(看|梳理|评估|检查)一下(这个|那个|上面|刚才|当前)|\b(continue|keep|go\s+on)\s+(looking|checking|reviewing|analyzing|sorting|testing|digging)\b|\b(look|check|review|dig)\s+into\s+(this|that|it|the\s+above)\b/i;

/** 任务动词（中英双语）：出现即视为需求输入，哪怕带问号或"你"字。 */
const SEED_VERB = /(帮我(做|写|实现|加|创建|开发|弄)|实现一个|写一个|做一个|加一个|创建一个|开发一个|修复|部署|安装|配置一个|\bhelp\s+me\s+(build|write|make|add|create|implement|develop)\b|\b(implement|write|make|build|add|create|develop)\s+a\b|\bfix\b|\bdeploy\b|\binstall\b)/i;

/**
 * 确认-放行消息（0.10.0，真实撤销样本）：以「好/可以/行/对…」开头、后接放行或
 * 接续动作（"好，按照这个路线继续。""可以，你按这个去做吧。"）。samples.jsonl 里
 * 这类输入被 seed 分支展开 18×/27×，用户立刻撤销——它们是对助手说的会话消息，
 * 正确处理是 1.0× 轻润色，不是展开。
 */
/** 确认-放行开头（中英双语）。 */
const GO_AHEAD_HEAD = /^(好|好的|好嘞|好呀|好啊|可以|行|嗯|哦|噢|对|是|ok|okay|sure|fine|good|great|yes|yeah|yep|alright|all\s+right|sounds\s+good)[，,。.!！~～、\s]/i;

/** 放行/接续动作的正文线索。 */
/** 放行/接续动作的正文线索（中英双语）。 */
const GO_AHEAD_BODY =
  /(继续|接着|往下|去做|这么办|这样办|这样做|这么来|这样来|按.{0,10}(做|来|办|执行|推进)|照.{0,10}(做|来|办|执行|推进)|就(这么|这样)|\bgo\s+ahead\b|\bkeep\s+going\b|\bproceed\b|\bdo\s+(it|that)\b|\bas\s+(planned|discussed|proposed)\b)/;

/**
 * 会话消息命中的具体规则（0.10.1，归因用）：meta / opinion / question /
 * continuation / go-ahead，未命中返回 null。isConversationalMessage 由此派生——
 * 单一事实来源，判定与归因永远不会分家。
 * @param {string} text 输入草稿。
 * @returns {string | null} 命中的规则名。
 */
export function conversationalRuleOf(text) {
  const s = typeof text === "string" ? text.trim() : "";
  if (s === "" || s.length > 500) return null;
  if (META_MARKERS.test(s)) return "meta";
  if (OPINION_MARKERS.test(s)) return "opinion";
  const isQuestionShape = /[？?]$/.test(s) || WHY_QUESTION.test(s) || CHOICE_QUESTION.test(s);
  if (isQuestionShape && !SEED_VERB.test(s)) return "question";
  if (CONTINUATION.test(s) && !SEED_VERB.test(s)) return "continuation";
  if (GO_AHEAD_HEAD.test(s) && s.length <= 40 && GO_AHEAD_BODY.test(s) && !SEED_VERB.test(s)) return "go-ahead";
  return null;
}

/**
 * 是否"对着助手说的会话消息"（提问/追问/观点/接续/确认放行），而非需求种子。
 * 判定顺序与规则说明见 conversationalRuleOf；本函数只是它的布尔投影。
 * 不确定的一律放行给既有流程（补全/精确），本分支宁可漏判不可误判：
 * 会话消息被展开是方向性失真，种子被轻润色只是没干活。
 * @param {string} text 输入草稿。
 * @returns {boolean} 是否会话消息。
 */
export function isConversationalMessage(text) {
  return conversationalRuleOf(text) !== null;
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
    // 助手事件的消息嵌在 data.message 下（真实形状见 eventMessageOf）；早先按平铺读，
    // 于是这个函数在本宿主上**从来没有返回过东西**——信号分支的"待答提问/待续提议"
    // 锚点因此一直只靠用户话轮。0.9.6 排查时从线上会话日志确认。
    const message = eventMessageOf(event);
    if (message === undefined) continue;
    if (message.role !== undefined && message.role !== "assistant") continue;
    const text = messageTextOf(message.content).replace(/\s+/g, " ").trim();
    if (text === "") continue;
    // 取**尾部**：待答问句、"要不要继续"、编号选项这些锚点都在结尾，
    // 早先取头部 300 字恰好把它们全截掉（同一类方向性错误，一并修掉）。
    // 截断代理对安全（T-debug-F6）：尾部锚点常有 emoji，切半个代理对会产出
    // 孤立代理并污染信号推断的输入。
    return { role: "assistant", text: text.length > 300 ? "…" + safeSlice(text, -300) : text };
  }
  return undefined;
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
    // 无空白形态（"（2）"/"(2)"）同样是边界（T-debug-F4）："（1）方案A（2）方案B"
    // 此前把选项 2 整段吞进选项 1，信号展开以污染锚点出发。
    const rest = text
      .slice(m.index + m[0].length)
      .split(/\n|；|;|[（(]\s*[0-9]{1,2}\s*[.、)）]|\s+[0-9]{1,2}[.、)）]|\s+[①②③④⑤⑥⑦⑧⑨⑩]/)[0]
      .trim();
    if (rest === "") continue;
    map.set(num, rest.slice(0, 80));
  }
  return map;
}

// 句子切分与 CJK 集合工具见 message-text.js（lastSentenceOf / lastMatchingSentenceOf /
// cjkCharSet）——此前在这里与 prediction.js 各有一份逐字节相同的副本，0.10.0 收拢。

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
    // 多选数字（"1、2"）拆开逐一比对；单数字维持原有三级优先。
    const tokens = String(classified.token ?? "").split("、").filter(Boolean);
    if (hasAssistant) {
      const options = parseOptions(assistantTail.text);
      if (tokens.length === 1) {
        const hit = options.get(tokens[0]);
        if (hit !== undefined) return { mode: "choice", anchor: hit, source: "assistant-options" };
        const sent = lastSentenceOf(assistantTail.text);
        if (isQuestion(sent)) return { mode: "answer", anchor: sent, source: "assistant-question" };
      } else {
        const hits = tokens.map((n) => options.get(n));
        // 全部对上才算可推断；部分对上时意图不明（选项还是编号回答？），拒绝硬猜。
        if (hits.every((h) => h !== undefined)) {
          return { mode: "choice", anchor: hits.join("；"), source: "assistant-options" };
        }
        return { mode: "none", reason: "no_pending" };
      }
    }
    if (lastUser !== undefined && tokens.length === 1 && isQuestion(lastUser)) {
      return { mode: "continue", anchor: lastUser, source: "user-question" };
    }
    return { mode: "none", reason: "no_pending" };
  }

  if (classified.kind === "signal") {
    if (hasAssistant) {
      const sent = lastSentenceOf(assistantTail.text);
      if (CONTINUATION_OFFER.test(sent)) return { mode: "continue", anchor: sent, source: "assistant-offer" };
      // 提议句后跟选项行时（"要不要继续？1. … 2. …"），末句是选项不是提议——
      // 扫全尾部找最后一个提议句（T-debug-M2）。有选项才扫：无选项时旧语义
      // （只认末句提议）保持不变，避免把更早的旧提议误当未决项。
      if (parseOptions(assistantTail.text).size >= 2) {
        const offer = lastMatchingSentenceOf(assistantTail.text, CONTINUATION_OFFER);
        if (offer !== undefined) return { mode: "continue", anchor: offer, source: "assistant-offer" };
      }
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

/**
 * 剥掉软化词与指示词后，短指令的实义字（用于"动词逐字保留"校验）。
 *
 * 指示词（这/那/它，T-debug-M1）必须剥：度契约**要求**模型消解指代——"改一下这个"
 * 的正确输出不含"这"字（指代物已替换成名词）。此前不剥，模型按契约做对反而被
 * 判 verb_missing，落进收紧重试后仍拒绝（fidelity_rejected），连模板自己的示范
 * 输出都过不了自己的校验。
 */
const SOFTENERS = /(一下|点儿|点|个|吗|吧|呢|了|这|那|它)/g;

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
  const anchorChars = cjkCharSet(anchor);
  if (anchorChars.size === 0) return { ok: true };
  const outChars = cjkCharSet(out);
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
