/**
 * 0.19.0 最小编排：一次调用，没有路由/修复/语义审判。
 */

import { analyzeInput, ROUTES } from "./classify.js";
import { buildMinimalPrompt, PROMPT_VERSION } from "./prompts.js";
import { validateResult } from "./validate.js";
import { readClarifyContext } from "./context.js";
import { ERROR_CODES, ERROR_MESSAGES } from "./errors.js";

const IDLE_TIMEOUT_MS = 15000;

function createMessage(text) {
  return {
    id: "ps-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "prompt-seed" },
  };
}

function cleanText(raw) {
  let s = String(raw ?? "").trim();
  s = s.replace(/^\x60\x60\x60[^\n]*\n?/, "").replace(/\n?\x60\x60\x60$/, "").trim();
  s = s.replace(/^["“]([\s\S]*)["”]$/, "$1").trim();
  return s;
}

function baseFinal(args) {
  const { ok, text, analysis, requestId, ttftMs, ms, provider, model, code = null, error = null, reason = null, rejected = null, changed = false, calls = 1 } = args;
  return {
    type: "final", ok, route: analysis?.route ?? "error", text, changed,
    code, error, reason, rejected, requestId, ttftMs, ms, calls,
    provider: provider ?? null, model: model ?? null, promptVersion: PROMPT_VERSION,
  };
}

export async function* optimizeStream(args) {
  const { text, sessionId, sessionQuery, llm, route, signal, contextEnabled = true, requestId, overrides = {}, log } = args;
  const startedAt = Date.now();
  const input = typeof text === "string" ? text.trim() : "";
  const analysis = analyzeInput(input);
  yield {
    type: "meta", requestId, route: analysis.route, reasons: analysis.reasons,
    promptVersion: PROMPT_VERSION, provider: route?.provider ?? null, model: route?.model ?? null,
  };

  if (analysis.route === ROUTES.PASSTHROUGH) {
    const code = analysis.code ?? ERROR_CODES.NOTHING_TO_OPTIMIZE;
    yield baseFinal({ ok: false, text: input, analysis, requestId, ttftMs: 0, ms: 0, calls: 0, provider: route?.provider, model: route?.model, code, error: ERROR_MESSAGES[code] ?? analysis.error ?? ERROR_MESSAGES.nothing_to_optimize, reason: analysis.reasons.join(",") });
    return;
  }
  if (llm === null || llm === undefined || typeof llm.stream !== "function") {
    yield baseFinal({ ok: false, text: input, analysis, requestId, ttftMs: 0, ms: 0, calls: 0, code: ERROR_CODES.LLM_UNAVAILABLE, error: ERROR_MESSAGES.llm_unavailable, reason: "llm_unavailable" });
    return;
  }
  if (route === null || route === undefined) {
    yield baseFinal({ ok: false, text: input, analysis, requestId, ttftMs: 0, ms: 0, calls: 0, code: ERROR_CODES.MODEL_UNAVAILABLE, error: ERROR_MESSAGES.model_unavailable, reason: "model_unavailable" });
    return;
  }

  let context;
  if (contextEnabled) context = await readClarifyContext({ sessionQuery, sessionId, log });
  const prompt = buildMinimalPrompt(input, context, overrides);
  const request = {
    provider: route.provider,
    model: route.model,
    system: prompt.system,
    messages: [createMessage(prompt.user)],
    temperature: 0.2,
  };
  if (typeof route.reasoningEffort === "string") request.reasoningEffort = "low";
  if (signal !== undefined) request.signal = signal;

  const controller = new AbortController();
  const requestSignal = signal === undefined
    ? controller.signal
    : (typeof AbortSignal.any === "function" ? AbortSignal.any([signal, controller.signal]) : signal);
  let idleTimer = null;
  let idleTimedOut = false;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idleTimedOut = true; controller.abort(); }, IDLE_TIMEOUT_MS);
    idleTimer.unref?.();
  };
  resetIdle();

  let calls = 0;
  let firstAt = 0;
  let raw = "";
  let finish = null;
  let failure = null;
  try {
    calls += 1;
    for await (const chunk of llm.stream({ ...request, signal: requestSignal })) {
      resetIdle();
      if (chunk === null || typeof chunk !== "object") continue;
      if (chunk.type === "text-delta" && typeof chunk.text === "string") {
        if (firstAt === 0 && chunk.text !== "") firstAt = Date.now();
        raw += chunk.text;
        yield { type: "delta", text: chunk.text };
      } else if (chunk.type === "finish" && chunk.reason) {
        finish = typeof chunk.reason.kind === "string" ? chunk.reason.kind : "unknown";
        if (finish === "error" || finish === "aborted") failure = chunk.reason.failure ?? { message: "model call failed" };
      } else if (chunk.type === "error") {
        failure = chunk.error ?? { message: "model call failed" };
      }
    }
  } catch (error) {
    failure = { message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(idleTimer);
  }

  const elapsed = Date.now() - startedAt;
  const ttftMs = firstAt === 0 ? 0 : firstAt - startedAt;
  if (signal?.aborted || idleTimedOut || requestSignal?.aborted) {
    yield baseFinal({ ok: false, text: input, analysis, requestId, ttftMs, ms: elapsed, calls, code: ERROR_CODES.REQUEST_TIMEOUT, error: ERROR_MESSAGES.request_timeout, reason: "request_timeout" });
    return;
  }
  if (failure) {
    yield baseFinal({ ok: false, text: input, analysis, requestId, ttftMs, ms: elapsed, calls, code: ERROR_CODES.LLM_ERROR, error: ERROR_MESSAGES.llm_error, reason: failure.message ?? "llm_error" });
    return;
  }
  if (finish === "max-tokens") {
    yield baseFinal({ ok: false, text: input, analysis, requestId, ttftMs, ms: elapsed, calls, code: ERROR_CODES.TRUNCATED, error: ERROR_MESSAGES.truncated, reason: "truncated" });
    return;
  }

  const output = cleanText(raw);
  if (output === "") {
    yield baseFinal({ ok: false, text: input, analysis, requestId, ttftMs, ms: elapsed, calls, code: ERROR_CODES.EMPTY_RESULT, error: ERROR_MESSAGES.empty_result, reason: "empty_result" });
    return;
  }
  const verdict = validateResult({ input, output });
  if (!verdict.ok) {
    yield baseFinal({ ok: false, text: input, analysis, requestId, ttftMs, ms: elapsed, calls, code: ERROR_CODES.VALIDATION_FAILED, error: ERROR_MESSAGES.validation_failed, reason: verdict.reason, rejected: output });
    return;
  }
  yield baseFinal({ ok: true, text: verdict.text, analysis, requestId, ttftMs, ms: Date.now() - startedAt, calls, changed: verdict.changed });
}

export async function optimizeOnce(args) {
  let final = null;
  for await (const event of optimizeStream(args)) {
    if (event.type === "final") final = event;
  }
  return final ?? { type: "final", ok: false, route: "error", text: args.text ?? "", code: ERROR_CODES.LLM_ERROR, error: ERROR_MESSAGES.llm_error, reason: "no_final", requestId: args.requestId, ttftMs: 0, ms: 0, calls: 0, changed: false, promptVersion: PROMPT_VERSION };
}
