/**
 * prompt-seed / 会话上下文提取
 * ---------------------------------------------------------------------------
 * 从 Host 的 sessionQuery.readSurface() 结果中提取"最近的用户话轮"，
 * 作为改写与审判的 grounding 上下文：只用于消解指代（"这个 bug""上面说的方案"）
 * 与锚定事实，不作为新增任务元素的来源（该约束写在 prompt 里，由审判复核）。
 *
 * 为什么只取 user 话轮：agent 会话的尾部是海量中间步骤（assistant 步骤消息、
 * tool/result），"最近的 N 条 user/assistant 消息"会全部落在噪声上，真实用户
 * 话轮被挤掉（实测确认）。而指代消解的黄金来源就是用户自己说过的话。
 * source.kind 区分真实话轮（"user"）与注入（"runtime-context"/"time-context"），
 * 注入快照绝不进入上下文。
 *
 * 纯函数、零依赖：surface 形状（event.type / event.data）来自
 * @deepseek-ai/dsh-session 的 surface fold，这里防御式读取，任何形状漂移
 * 都安全降级为"无上下文"，绝不阻塞优化本身。
 */

import { eventMessageOf, messageTextOf, safeSlice } from "./message-text.js";

/** 每条消息的截断长度（字符）。 */
const PER_MESSAGE_LIMIT = 300;

/** 最多携带的用户话轮数（时间正序）。 */
const MAX_MESSAGES = 2;

/**
 * 从 surface 事件里提取最近的**真实用户话轮**。
 * @param {{events?: unknown[]} | null | undefined} surface readSurface 的返回值。
 * @returns {{role: 'user', text: string}[] | undefined} 上下文消息（时间正序），无内容时 undefined。
 */
export function extractRecentContext(surface) {
  if (surface === null || typeof surface !== "object") return undefined;
  const events = Array.isArray(surface.events) ? surface.events : [];
  const picked = [];
  for (let i = events.length - 1; i >= 0 && picked.length < MAX_MESSAGES; i -= 1) {
    const event = events[i];
    if (event === null || typeof event !== "object") continue;
    if (event.type !== "user/message") continue;
    const message = eventMessageOf(event);
    if (message === undefined) continue;
    if (message.role !== "user") continue;
    // 只认真实用户话轮；runtime-context / time-context 注入快照一律跳过。
    const kind = message.source?.kind;
    if (kind !== undefined && kind !== "user") continue;
    const text = messageTextOf(message.content).replace(/\s+/g, " ").trim();
    if (text === "") continue;
    picked.push({ role: "user", text: text.length > PER_MESSAGE_LIMIT ? `${safeSlice(text, 0, PER_MESSAGE_LIMIT)}…` : text });
  }
  if (picked.length === 0) return undefined;
  return picked.reverse();
}

/** 预测窗口：最多带回几条消息（时间正序，含用户与助手）。 */
const PREDICT_MAX_MESSAGES = 6;

/** 预测窗口里助手消息的保留长度（取**尾部**：锚点都在结尾）。 */
const PREDICT_ASSISTANT_LIMIT = 800;

/** 预测窗口里用户话轮的保留长度（取头部）。 */
const PREDICT_USER_LIMIT = 300;

/** 取文本尾部（超长时；代理对安全，见 safeSlice）。 */
function tailOf(text, limit) {
  return text.length > limit ? `…${safeSlice(text, -limit)}` : text;
}

/** 取文本头部（超长时；代理对安全，见 safeSlice）。 */
function headOf(text, limit) {
  return text.length > limit ? `${safeSlice(text, 0, limit)}…` : text;
}

/**
 * 抽取"预测下一步输入"所需的会话窗口。
 *
 * 与 extractRecentContext 的三处关键差异，每处都对应一个会毁掉预测的具体问题：
 *   ① 助手消息取**尾部**而不是头部——待答问句、"要不要继续"、"1./2./3. 选项"
 *      全在结尾，而既有实现只保留前 300 字（predict 拿到的会是一段没有锚点的铺垫）。
 *   ② 窗口更宽（6 条：用户与助手交替）——只看最后一条助手消息，无法判断
 *      这次交付的是哪一步工作。
 *   ③ 带回 sawToolActivity：最后一轮用户话轮之后出现过 tool/* 事件 = 这轮真的干了活，
 *      是 next-step 分型唯一客观的锚点证据（"助手只是说了一段话"不足以支撑预测）。
 *
 * 全防御：形状漂移一律降级为 undefined，绝不阻塞预测本身（与既有模块同构）。
 * @param {{events?: unknown[]} | null | undefined} surface readSurface 的返回值。
 * @returns {{turns: {role: 'user'|'assistant', text: string}[], assistantTail: string|undefined,
 *            sawToolActivity: boolean} | undefined} 预测窗口，无内容时 undefined。
 */
export function extractPredictionWindow(surface) {
  if (surface === null || typeof surface !== "object") return undefined;
  const events = Array.isArray(surface.events) ? surface.events : [];

  // 最后一轮用户话轮的起点：tool 活动只有落在这之后才算"这轮干了活"。
  let lastUserIndex = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event !== null && typeof event === "object" && event.type === "user/message") {
      lastUserIndex = i;
      break;
    }
  }
  let sawToolActivity = false;
  for (let i = lastUserIndex + 1; i < events.length; i += 1) {
    const type = events[i]?.type;
    if (typeof type === "string" && type.startsWith("tool/")) {
      sawToolActivity = true;
      break;
    }
  }

  const picked = [];
  for (let i = events.length - 1; i >= 0 && picked.length < PREDICT_MAX_MESSAGES; i -= 1) {
    const event = events[i];
    if (event === null || typeof event !== "object") continue;
    if (event.type !== "user/message" && event.type !== "assistant/message") continue;
    // 助手事件的消息嵌在 data.message 下（见 eventMessageOf），这里必须先归一。
    const message = eventMessageOf(event);
    if (message === undefined) continue;
    if (event.type === "user/message") {
      if (message.role !== "user") continue;
      const kind = message.source?.kind;
      if (kind !== undefined && kind !== "user") continue;
      const text = messageTextOf(message.content).replace(/\s+/g, " ").trim();
      if (text === "") continue;
      picked.push({ role: "user", text: headOf(text, PREDICT_USER_LIMIT) });
      continue;
    }
    if (message.role !== undefined && message.role !== "assistant") continue;
    // 助手消息保留换行（清单与选项靠换行成形），只压掉行内多余空白。
    const text = messageTextOf(message.content).replace(/[ \t]+/g, " ").trim();
    if (text === "") continue;
    picked.push({ role: "assistant", text: tailOf(text, PREDICT_ASSISTANT_LIMIT) });
  }
  if (picked.length === 0) return undefined;
  picked.reverse();
  let assistantTail;
  for (let i = picked.length - 1; i >= 0; i -= 1) {
    if (picked[i].role === "assistant") {
      assistantTail = picked[i].text;
      break;
    }
  }
  return { turns: picked, assistantTail, sawToolActivity };
}

/** 指代/回指词：出现即说明这条草稿在指向上文，而不是自足描述。 */
const ANAPHORA = /(它|他|她|这个|那个|这些|那些|上面|上述|刚才|之前|前面|该|此|这里|那里|\bit\b|\bthis\b|\bthat\b|\bthese\b|\bthose\b|\bthe above\b|\bprevious\b|\bsame\b)/i;

/** 短草稿阈值：12 字以内的输入几乎必然依赖上文。 */
const SHORT_DRAFT = 12;

/**
 * 这条草稿是否需要会话上下文（E 项：按需注入）。
 *
 * 旧行为是"只要有 sessionId 就注入最近两轮"，代价是三重的：白烧 token、
 * 每次多一次 readSurface、以及把无关内容塞进改写 prompt 造成跑偏。
 * 现在只在两种确定性信号下注入：①草稿短到不足以自足；②出现指代/回指词。
 * 两者都是本地正则判定，零额外调用（与生态里 hoyyang 的做法一致）。
 * @param {string} text 用户草稿。
 * @returns {boolean} 是否需要注入会话上下文。
 */
export function needsContext(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return false;
  if (trimmed.length <= SHORT_DRAFT) return true;
  return ANAPHORA.test(trimmed);
}
