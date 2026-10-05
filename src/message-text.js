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
