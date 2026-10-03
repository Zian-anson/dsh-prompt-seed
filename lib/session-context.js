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
    const data = event.data;
    if (data === null || typeof data !== "object") continue;
    if (data.role !== "user") continue;
    // 只认真实用户话轮；runtime-context / time-context 注入快照一律跳过。
    const kind = data.source?.kind;
    if (kind !== undefined && kind !== "user") continue;
    const text = textOfBlocks(data.content).replace(/\s+/g, " ").trim();
    if (text === "") continue;
    picked.push({ role: "user", text: text.length > PER_MESSAGE_LIMIT ? `${text.slice(0, PER_MESSAGE_LIMIT)}…` : text });
  }
  if (picked.length === 0) return undefined;
  return picked.reverse();
}

/**
 * 从消息 content（字符串或块数组）里提取纯文本。
 * @param {unknown} content 消息内容。
 * @returns {string} 拼接后的文本。
 */
function textOfBlocks(content) {
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
