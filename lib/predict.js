/**
 * 0.16.0 下一步输入预测（水晶球）。
 * 一次调用；不做自动重试。输入框为空时由 Host 调用。
 */

import { languageDrifts } from "./validate.js";

const SYSTEM = [
  "You predict the single message the user is most likely to type next in this coding conversation.",
  "Use the last assistant turn and recent turns as context.",
  "Output only that message, in the same language as the user, one sentence, at most 120 characters.",
  "If the context cannot support a prediction, output exactly [NO PREDICTION].",
].join("\n");

/**
 * 渲染预测窗口。
 * @param {{turns: {role: string, text: string}[], assistantTail: string}} context 窗口。
 * @returns {string} user prompt。
 */
function render(context) {
  const lines = context.turns.map((item) => "[" + item.role + "] " + item.text).join("\n");
  return "CONVERSATION:\n" + lines + "\n\nPredict the user's next message. Output only the message.";
}

/**
 * 预测下一句。
 * @param {{llm: object, route: object, context: object, signal?: AbortSignal, log?: Function}} args 参数。
 * @returns {Promise<{ok: true, text: string} | {ok: false, code: string, error: string}>} 结果。
 */
export async function predictNextPrompt({ llm, route, context, signal, log }) {
  if (!llm || typeof llm.stream !== "function") return { ok: false, code: "llm_unavailable", error: "模型服务不可用" };
  if (!route) return { ok: false, code: "model_unavailable", error: "未找到可用的默认模型" };
  if (!context || !Array.isArray(context.turns) || context.turns.length === 0 || typeof context.assistantTail !== "string") {
    return { ok: false, code: "cannot_predict", error: "这段上下文里没有可预测的下一步" };
  }
  const request = {
    provider: route.provider,
    model: route.model,
    system: SYSTEM,
    messages: [{
      id: "ps-predict-" + Date.now().toString(36),
      role: "user",
      content: [{ type: "text", text: render(context) }],
      source: { kind: "plugin", plugin: "prompt-seed" },
    }],
    temperature: 0.5,
  };
  if (typeof route.reasoningEffort === "string") request.reasoningEffort = "low";
  if (signal !== undefined) request.signal = signal;

  let full = "";
  let finish = null;
  let failure = null;
  try {
    for await (const chunk of llm.stream(request)) {
      if (chunk === null || typeof chunk !== "object") continue;
      if (chunk.type === "text-delta" && typeof chunk.text === "string") full += chunk.text;
      else if (chunk.type === "finish" && chunk.reason) {
        finish = typeof chunk.reason.kind === "string" ? chunk.reason.kind : "unknown";
        if (finish === "error" || finish === "aborted") failure = chunk.reason.failure ?? { message: "model call failed" };
      } else if (chunk.type === "error") failure = chunk.error ?? { message: "model call failed" };
    }
  } catch (error) {
    failure = { message: error instanceof Error ? error.message : String(error) };
  }
  if (failure) return { ok: false, code: "llm_error", error: failure.message ?? "模型调用失败" };
  if (finish === "max-tokens") return { ok: false, code: "truncated", error: "预测结果被截断" };
  let text = String(full ?? "").trim();
  text = text.replace(/^\x60\x60\x60[^\n]*\n?/, "").replace(/\n?\x60\x60\x60$/, "").trim();
  text = text.replace(/^["“]([\s\S]*)["”]$/, "$1").trim();
  if (text === "" || text.includes("[NO PREDICTION]")) {
    return { ok: false, code: "cannot_predict", error: "这段上下文里没有可预测的下一步" };
  }
  if (Array.from(text).length > 300) return { ok: false, code: "cannot_predict", error: "预测结果过长" };
  const lastUser = [...context.turns].reverse().find((item) => item.role === "user");
  if (lastUser !== undefined && languageDrifts(lastUser.text, text)) {
    return { ok: false, code: "cannot_predict", error: "预测语言与原对话不一致" };
  }
  return { ok: true, text };
}
