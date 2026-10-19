/**
 * Host：回环路由、模型连接、按会话与功能隔离的内存任务。
 * 优化与预测各有自己的生成契约；断开传输不取消任务。
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ERROR_CODES, ERROR_MESSAGES } from "./errors.js";
import { optimizeStream } from "./optimize.js";
import { createJobStore } from "./jobs.js";
import { eventMessageOf } from "./message-text.js";
import { predictStream } from "./predict.js";
import { loadPromptOverrides } from "./prompts.js";
import { appendSample, resolveSamplePath } from "./sample-log.js";
import { safeSlice } from "./message-text.js";

export const name = "prompt-seed";
export const inject = ["webServer"];
export const DEFAULT_ROUTE = "/api/prompt-seed/optimize";

/** 0.18.4：总墙钟顶；首轮按“无输出 15s”看门狗，不在 12s 总时长处切流。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 20000;
/** 请求体上限。 */
const MAX_BODY_BYTES = 64 * 1024;
/** 样本里的输入/输出预览长度。 */
const SAMPLE_INPUT_PREVIEW = 400;

const LOADED_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
})();

export function codeVersion() {
  return LOADED_VERSION;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(level, message, meta) {
  if (level === "error") console.error(message, meta ?? "");
  else if (level === "warn") console.warn(message, meta ?? "");
}

const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * 把一个 host 字面量归一成可判定的形状。
 *
 * 为什么必须归一：peer / Host / Origin 三处此前各写各的解析，于是 IPv4-mapped 的 IPv6
 * 拼法在 peer 一处被解包、在 Host 与 Origin 两处没有——同一台机器、同一段文本，一处放行
 * 一处拒绝。对抗性复核抓到了这个分歧（`Origin: http://[::ffff:127.0.0.1]:P` 与
 * `http://localhost.:P` 在旧代码放行、新代码 403，而它们都是货真价实的本机拼法）。
 * 归一放在一处，三条判定就再也分不了家。
 *
 * 处理四件事：小写；去方括号；去尾点（FQDN 根，与不带点同义）；解包 IPv4-mapped IPv6
 * ——既有 `::ffff:127.0.0.1` 这种点分写法，也有 URL 解析器规范化后产出的
 * `::ffff:7f00:1` 十六进制写法。
 * @param {unknown} value host 字面量。
 * @returns {string} 归一后的 host；无法识别时原样返回，交由判定拒绝。
 */
function canonicalHostLiteral(value) {
  if (typeof value !== "string") return "";
  let host = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host.startsWith("::ffff:")) return host;
  const rest = host.slice("::ffff:".length);
  if (LOOPBACK_IPV4.test(rest)) return rest;
  const groups = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
  if (groups === null) return host;
  const packed = ((parseInt(groups[1], 16) << 16) | parseInt(groups[2], 16)) >>> 0;
  return [(packed >>> 24) & 255, (packed >>> 16) & 255, (packed >>> 8) & 255, packed & 255].join(".");
}

/**
 * 从 Host 头里取出主机部分（去掉端口）。
 *
 * 方括号形式必须先解括号再找端口，否则 `[::1]:3080` 与裸 `::1` 会被同一条 `:\d+$`
 * 规则搅在一起（`"::1".replace(/:\d+$/,"")` 得到的是 `":"`）。
 * @param {unknown} value `req.headers.host` 的值。
 * @returns {string} 主机部分；空串表示无法识别。
 */
function extractHostHeader(value) {
  if (typeof value !== "string") return "";
  const raw = value.trim();
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(raw);
  if (bracketed !== null) return bracketed[1];
  // 多个冒号 = 没加方括号的 IPv6 字面量，不能再按"尾部端口"切
  if ((raw.match(/:/g) ?? []).length > 1) return raw;
  return raw.replace(/:\d+$/, "");
}

/**
 * 判断一个**已归一化**的 host 是否本机。
 * @param {string} host 归一化后的 host（见 canonicalHostLiteral）。
 * @returns {boolean} 是否回环。
 */
function isLoopbackHostLiteral(host) {
  if (host === "localhost" || host === "::1") return true;
  if (!LOOPBACK_IPV4.test(host)) return false;
  return host.split(".").every((part) => Number(part) <= 255);
}

/**
 * 判断一个远端地址是否为回环。
 * @param {unknown} value `req.socket.remoteAddress` 的值。
 * @returns {boolean} 是否回环。
 */
function isLoopbackAddress(value) {
  if (typeof value !== "string" || value === "") return false;
  return isLoopbackHostLiteral(canonicalHostLiteral(value));
}

/**
 * 判断 Host 头是否指向本机。
 * @param {unknown} value `req.headers.host` 的值。
 * @returns {boolean} 是否本机。
 */
function isLoopbackHost(value) {
  const host = extractHostHeader(value);
  if (host === "") return false;
  return isLoopbackHostLiteral(canonicalHostLiteral(host));
}

/**
 * 判断 Origin 头是否来自本机页面。
 *
 * 为什么回环校验之外还需要这一个头：回环只能证明"请求来自这台机器"，而**浏览器就在
 * 这台机器上**——用户访问的任意网页都能向 127.0.0.1 发请求。真正的边界是"来源页面"，
 * 不只是"网络位置"。浏览器对 POST 一律携带 Origin（同源也带），所以缺省即非浏览器
 * 客户端（脚本、curl）——那类调用方本来就被回环校验限定住了。
 *
 * 这条检查是必需的而非锦上添花：`content-type: text/plain` 属于 CORS 简单请求、不触发
 * 预检，而本路由从不校验 content-type，于是没有它时任意网页都能盲打这条路由
 * （实测：`Origin: https://evil.example` + text/plain → 200 且真的花掉一次模型调用）。
 *
 * 粒度说明（不要把它读成比实际更强）：本检查判的是"**本机**页面"，不是"**本应用**页面"
 * ——从任意回环端口提供服务的页面都能通过。要收窄到同源，得把 Origin 与请求自身的 Host
 * 逐字比对，而那会一并否掉一切经代理改写 Host 的访问方式（隧道、端口转发），所以没有
 * 默认打开。
 * @param {unknown} value `req.headers.origin` 的值。
 * @returns {boolean} 是否放行。
 */
function isLoopbackOrigin(value) {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value !== "string") return false;
  let origin;
  try {
    origin = new URL(value);
  } catch {
    // "null"（沙箱 iframe、file://）解析失败，一律不放行：无法确认来源就不放行。
    return false;
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") return false;
  return isLoopbackHostLiteral(canonicalHostLiteral(origin.hostname));
}

/**
 * 回环防护：同时校验 peer socket 地址、Host 头与 Origin 头。
 *
 * 三项各挡一类绕过，缺一不可：只信 peer 会放过"本机浏览器里的任意网页"；只信 Host 头
 * 会被 DNS rebinding 骗过（Host 是可控文本）；Origin 则是浏览器场景下唯一能区分
 * "本应用页面"与"别的页面"的字段。拒绝时直接写完 403 并返回 false。
 * @param {object} req 请求。
 * @param {object} res 响应。
 * @param {(level: string, message: string, meta?: object) => void} [log] 日志回调。
 * @returns {boolean} 是否放行。
 */
function guardLoopback(req, res, log) {
  const peer = req.socket?.remoteAddress;
  const host = req.headers?.host;
  const origin = req.headers?.origin;
  if (!isLoopbackAddress(peer) || !isLoopbackHost(host) || !isLoopbackOrigin(origin)) {
    // 三项失败在排查时含义完全不同（内网来源 / DNS rebinding / 跨站页面），逐个记下来。
    log?.("warn", "[prompt-seed] rejected a non-loopback request", {
      peer: typeof peer === "string" ? peer : null,
      host: typeof host === "string" ? host : null,
      origin: typeof origin === "string" ? origin : null,
    });
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, code: "forbidden", error: "仅允许本机访问" }));
    return false;
  }
  return true;
}

/** 请求体溢出时挂在 Error 上的标记：路由据此回 413 而不是 400。 */
const PAYLOAD_TOO_LARGE = "payload_too_large";

/**
 * 读取并解析 JSON 请求体。
 *
 * 溢出后**继续排空**而不是立刻 destroy：只有把请求读干净，同一条连接上的错误响应才
 * 真的送达客户端。早先的实现先 reject 再 `req.destroy()`，socket 先于响应被拆掉，
 * 客户端拿到的是 ECONNRESET、连错误码都看不到（实测 80KB 请求体 → "Empty reply from
 * server"）。真正失控的推流（远超上限）仍然切断，那时响应已经没有意义。
 * @param {object} req 请求。
 * @param {number} limit 字节上限。
 * @returns {Promise<unknown>} 解析后的 JSON 值。
 */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflowed = false;
    let settled = false;
    const hardLimit = limit * 8;
    /**
     * 只拒绝一次：溢出后剩余分片仍会到达，重复 reject 没有意义。
     * @param {Error} error 失败原因。
     */
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (overflowed) {
        if (size > hardLimit) req.destroy?.();
        return;
      }
      if (size > limit) {
        overflowed = true;
        chunks.length = 0;
        const error = new Error(PAYLOAD_TOO_LARGE);
        error.code = PAYLOAD_TOO_LARGE;
        fail(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflowed) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid json body"));
      }
    });
    req.on("error", (error) => fail(error));
  });
}

/**
 * 写一个 JSON 响应。
 * @param {object} res 响应。
 * @param {number} status HTTP 状态码。
 * @param {unknown} payload 响应体。
 */
function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/**
 * 回环限定的排障开关：?debug=1 附带内部状态（不含上下文原文，只含形状），
 * 用于诊断"上下文是否注入/路由是否覆盖生效"这类管线问题。predict 与 optimize
 * 两条通道各查一次，此前各写一份（0.10.0 收拢）。
 * @param {object} req 请求。
 * @returns {boolean} 是否附带调试块。
 */
function wantsDebugFlag(req) {
  if (typeof req.url !== "string") return false;
  try {
    return new URL(req.url, "http://localhost").searchParams.get("debug") === "1";
  } catch {
    return false;
  }
}

/**
 * 解析当前调用路由：行配置优先，否则跟随 Host 的模型选择。
 * @param {object} ctx Cordis 上下文。
 * @param {object} config 行配置。
 * @returns {{provider: string, model: string, reasoningEffort?: string} | undefined} 路由。
 */
function resolveCallRoute(ctx, config) {
  if (typeof config.provider === "string" && config.provider !== "" && typeof config.model === "string" && config.model !== "") {
    return { provider: config.provider, model: config.model };
  }
  try {
    const service = ctx.get("agentDefaultModel");
    const selection = service?.currentSelection?.();
    if (selection !== null && typeof selection === "object" && typeof selection.provider === "string" && typeof selection.model === "string") {
      const route = { provider: selection.provider, model: selection.model };
      if (typeof selection.reasoningEffort === "string" && selection.reasoningEffort !== "") route.reasoningEffort = selection.reasoningEffort;
      return route;
    }
  } catch {
    // 可选服务缺席：返回 undefined，由 optimize 给出结构化错误。
  }
  return undefined;
}

/**
 * 绑定 x-opencode-session 所需的会话 id。
 * DSH 的 llm.stream 会把 request.sessionId 映射为 x-opencode-session；
 * 0.16.1 重写时漏了这一步，真实 provider 直接 400 MissingSessionID。
 * @param {object | undefined} service llm 服务。
 * @param {string | undefined} sessionId 会话 id。
 * @param {string | undefined} runId 本次运行关联 id。
 * @returns {object | undefined} 带 sessionId 的代理。
 */
function bindLlmSession(service, sessionId, runId) {
  if (service === null || service === undefined || typeof service.stream !== "function") return service;
  const sid = typeof sessionId === "string" && sessionId !== ""
    ? sessionId
    : "prompt-seed-" + (typeof runId === "string" && runId !== "" ? runId : "local");
  const scoped = Object.create(service);
  scoped.stream = (input) => service.stream({ ...input, sessionId: sid });
  return scoped;
}

/**
 * 写一行 NDJSON。
 * @param {object} res 响应。
 * @param {object} event 事件。
 * @returns {boolean} 是否写出。
 */
function writeLine(res, event) {
  if (res.writableEnded === true) return false;
  try {
    res.write(JSON.stringify(event) + "\n");
    return true;
  } catch {
    return false;
  }
}

/**
 * 构造超时 final。
 * @param {string} requestId 请求 id。
 * @param {string} route 路由。
 * @param {string} text 原文。
 * @param {number} ms 已耗时。
 * @returns {object} final 事件。
 */
function timeoutFinal(requestId, route, text, ms) {
  return {
    type: "final", ok: false, route: route ?? "error", text,
    code: ERROR_CODES.REQUEST_TIMEOUT, error: ERROR_MESSAGES.request_timeout,
    reason: "request_timeout", requestId, ttftMs: 0, ms, calls: 0, changed: false, detail: "",
  };
}

/**
 * 记录一条样本。
 * @param {string | null} samplePath 样本路径。
 * @param {object} args 参数。
 * @returns {Promise<void>} 完成。
 */
async function recordSample(samplePath, args) {
  if (samplePath === null) return;
  const { text, final, meta, sessionId, runId, jobId, provider, model } = args;
  await appendSample(samplePath, {
    time: new Date().toISOString(),
    event: final.kind === "predict" ? "predict" : "optimize",
    code: final.ok ? "ok" : final.code,
    route: final.route ?? meta?.route ?? null,
    shape: final.shape ?? meta?.shape ?? null,
    ambiguity: final.ambiguity ?? meta?.ambiguity ?? null,
    targetRatio: final.targetRatio ?? meta?.targetRatio ?? null,
    repairAttempted: final.repairAttempted === true,
    clarity: final.clarity === true,
    reasons: Array.isArray(meta?.reasons) ? meta.reasons : [],
    codeVersion: codeVersion(),
    requestId: final.requestId ?? null,
    jobId: typeof jobId === "string" ? jobId : null,
    runId: typeof runId === "string" ? safeSlice(runId, 0, 64) : null,
    from: typeof sessionId === "string" && sessionId !== "" ? "ui" : "script",
    inputChars: Array.from(text).length,
    outputChars: typeof final.text === "string" ? Array.from(final.text).length : 0,
    changed: final.changed === true,
    ms: final.ms ?? 0,
    ttftMs: final.ttftMs ?? 0,
    calls: final.calls ?? 0,
    detail: typeof final.detail === "string" ? final.detail : "",
    reason: final.reason ?? null,
    provider: provider ?? null,
    model: model ?? null,
    input: text.slice(0, SAMPLE_INPUT_PREVIEW),
    output: typeof final.text === "string" ? final.text.slice(0, SAMPLE_INPUT_PREVIEW) : "",
  });
}

/**
 * 把任务的 NDJSON 事件写给一个 HTTP 连接。连接断开只退订，不取消任务。
 * @param {object} req 请求。
 * @param {object} res 响应。
 * @param {object} store JobStore。
 * @param {object} job 公开任务。
 * @returns {Promise<void>} 连接结束。
 */
function streamJob(req, res, store, job) {
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe = () => {};
    const finish = () => {
      if (done) return;
      done = true;
      res.off("close", onClose);
      unsubscribe();
      if (res.writableEnded !== true) {
        try { res.end(); } catch { /* 连接已断 */ }
      }
      resolve();
    };
    const onClose = () => finish();
    res.on("close", onClose);
    try {
      res.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      });
      res.flushHeaders?.();
    } catch {
      finish();
      return;
    }
    try {
      unsubscribe = store.subscribe(job.id, (event) => {
        if (done) return;
        const ok = writeLine(res, event);
        if (event.type === "final" || ok === false) finish();
      });
    } catch {
      finish();
      return;
    }
    if (done) unsubscribe();
  });
}

/**
 * 非流式：等待任务终态后返回一个 JSON final。
 * @param {object} res 响应。
 * @param {object} store JobStore。
 * @param {object} job 公开任务。
 * @param {boolean} debug 是否附 _debug。
 * @returns {Promise<void>} 完成。
 */
async function jsonJob(res, store, job, debug) {
  const final = await store.wait(job.id);
  if (final === null) {
    sendJson(res, 200, { ok: false, code: "job_not_found", error: "任务不存在或已过期" });
    return;
  }
  if (debug === true) {
    final._debug = {
      codeVersion: codeVersion(),
      jobId: job.id,
      conversationKey: job.conversationKey,
      sessionId: job.sessionId,
      route: final.route,
      calls: final.calls,
      ttftMs: final.ttftMs,
      ms: final.ms,
    };
  }
  sendJson(res, 200, final);
}

/**
 * 装载 Host 半区。
 * @param {object} ctx Cordis 上下文。
 * @param {{route?: string, provider?: string, model?: string, requestTimeoutMs?: number,
 *          context?: boolean, samples?: string|boolean, templates?: boolean}} [config] 行配置。
 */

/**
 * 监听已安装的 Host 模块变化；包更新后自动重启自身 fiber，
 * 避免每次改插件都要求用户手动重启。
 * @param {object} ctx Cordis 上下文。
 * @param {Function} log 日志。
 */
function startSelfReloadWatch(ctx, log) {
  const fiber = ctx?.fiber;
  if (fiber === undefined || fiber === null || typeof fiber.restart !== "function") return;
  let file;
  try { file = fileURLToPath(import.meta.url); } catch { return; }
  let last;
  try { last = statSync(file).mtimeMs; } catch { return; }
  const timer = setInterval(() => {
    try {
      const next = statSync(file).mtimeMs;
      if (next === last) return;
      last = next;
      log("info", "[prompt-seed] installed module changed; restarting plugin", { file });
      Promise.resolve(fiber.restart()).catch((error) => {
        log("warn", "[prompt-seed] self-restart failed", { error: String(error) });
      });
    } catch { /* 文件短暂不存在时等下一轮 */ }
  }, 1500);
  timer.unref?.();
  if (typeof ctx.effect === "function") {
    ctx.effect(() => () => clearInterval(timer), "prompt-seed:self-reload");
  }
}

export function apply(ctx, config = {}) {
  const route = typeof config.route === "string" && config.route.startsWith("/") ? config.route : DEFAULT_ROUTE;
  const requestTimeoutMs = Number.isFinite(config.requestTimeoutMs) && config.requestTimeoutMs > 0
    ? Math.min(config.requestTimeoutMs, 60000)
    : DEFAULT_REQUEST_TIMEOUT_MS;
  const contextEnabled = config.context !== false;
  const samplePath = resolveSamplePath(config.samples);
  const overrides = config.templates === false ? {} : loadPromptOverrides();
  const jobs = createJobStore({ timeoutMs: requestTimeoutMs, log });
  startSelfReloadWatch(ctx, log);

  const handler = async (req, res) => {
    if (!guardLoopback(req, res, log)) return;
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, code: "method_not_allowed", error: "仅接受 POST" });
      return;
    }
    const contentType = String(req.headers?.["content-type"] ?? "").toLowerCase();
    if (!contentType.includes("application/json")) {
      sendJson(res, 415, { ok: false, code: "unsupported_media_type", error: "仅接受 application/json" });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req, MAX_BODY_BYTES);
    } catch (error) {
      const tooLarge = error?.code === PAYLOAD_TOO_LARGE;
      sendJson(res, tooLarge ? 413 : 400, {
        ok: false,
        code: tooLarge ? ERROR_CODES.PAYLOAD_TOO_LARGE : "bad_request",
        error: tooLarge ? ERROR_MESSAGES.payload_too_large : (error instanceof Error ? error.message : "请求体无法解析"),
      });
      return;
    }
    if (body === null || typeof body !== "object") {
      sendJson(res, 400, { ok: false, code: "bad_request", error: "请求体必须是 JSON 对象" });
      return;
    }

    if (body.feedback !== null && typeof body.feedback === "object") {
      if (samplePath !== null) {
        await appendSample(samplePath, {
          time: new Date().toISOString(),
          event: "feedback",
          codeVersion: codeVersion(),
          runId: typeof body.runId === "string" ? safeSlice(body.runId, 0, 64) : null,
          kind: typeof body.feedback.kind === "string" ? body.feedback.kind : "unknown",
          route: typeof body.feedback.route === "string" ? body.feedback.route : null,
          charsDelta: Number.isFinite(body.feedback.charsDelta) ? body.feedback.charsDelta : null,
        });
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    const sessionId = typeof body.sessionId === "string" && body.sessionId !== "" ? body.sessionId : undefined;
    const conversationKey = typeof body.conversationKey === "string" && body.conversationKey !== "" ? body.conversationKey : undefined;
    const action = typeof body.action === "string" ? body.action : "optimize";
    if (body.kind !== undefined && body.kind !== "optimize" && body.kind !== "predict") {
      sendJson(res, 400, { ok: false, code: "bad_kind", error: "未知功能类型" });
      return;
    }
    const kind = action === "predict" ? "predict" : (body.kind ?? "optimize");

    if (action === "status") {
      let lastUserMessageId = null;
      let hasAssistant = false;
      let contextKnown = false;
      if (sessionId) {
        try {
          const query = ctx.get("sessionQuery");
          if (typeof query?.readSurface === "function") {
            const surface = await query.readSurface(sessionId);
            for (const event of surface?.events ?? []) {
              const message = eventMessageOf(event);
              if (!message) continue;
              if (event.type === "assistant/message") hasAssistant = true;
              if (event.type === "user/message" && (!message.source?.kind || message.source.kind === "user")) {
                if (Number.isFinite(event.seq)) lastUserMessageId = sessionId + ":" + event.seq;
              }
            }
            contextKnown = true;
          }
        } catch { /* Missing context must not hide an existing job. */ }
      }
      sendJson(res, 200, { ok: true, protocolVersion: 2, job: jobs.status({ sessionId, conversationKey, kind }), lastUserMessageId, hasAssistant, contextKnown });
      return;
    }
    if (action === "bind") {
      if (conversationKey === undefined || sessionId === undefined) {
        sendJson(res, 200, { ok: false, code: "bad_bind", error: "bind 需要 conversationKey 与 sessionId" });
        return;
      }
      sendJson(res, 200, { ok: true, job: jobs.bind(conversationKey, sessionId, kind) });
      return;
    }
    if (action === "cancel") {
      const jobId = typeof body.jobId === "string" ? body.jobId : "";
      const job = jobId === "" ? null : jobs.cancel(jobId, body.kind);
      sendJson(res, 200, job === null
        ? { ok: false, code: "job_not_found", error: "任务不存在或已过期" }
        : { ok: true, job });
      return;
    }
    if (action === "consume") {
      const jobId = typeof body.jobId === "string" ? body.jobId : "";
      const job = jobId === "" ? null : jobs.consume(jobId, body.kind);
      sendJson(res, 200, job === null
        ? { ok: false, code: "job_not_found", error: "任务不存在或已过期" }
        : { ok: true, job });
      return;
    }

    if (!["optimize", "predict"].includes(action)) {
      sendJson(res, 400, { ok: false, code: "bad_action", error: "未知操作" });
      return;
    }
    if (action === "predict" && sessionId === undefined) {
      sendJson(res, 200, { ok: false, code: "cannot_predict", error: "暂时无法预测" });
      return;
    }

    const text = action === "predict" ? "" : (typeof body.text === "string" ? body.text : "");
    const runId = typeof body.runId === "string" ? body.runId : undefined;
    const stream = body.stream === true;
    const debug = wantsDebugFlag(req);
    const requestId = "r-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    let llm;
    let sessionQuery;
    try { llm = ctx.get("llm"); } catch { llm = undefined; }
    try { sessionQuery = ctx.get("sessionQuery"); } catch { sessionQuery = undefined; }
    const callRoute = resolveCallRoute(ctx, config);

    const boundLlm = bindLlmSession(llm, sessionId, runId ?? requestId);
    const created = jobs.create({
      kind: action,
      sessionId,
      conversationKey: conversationKey ?? (sessionId === undefined ? undefined : "s:" + sessionId),
      runId,
      inputText: text,
      run: (signal) => action === "predict" ? predictStream({
        sessionId, sessionQuery, llm: boundLlm, route: callRoute, signal, requestId, log,
      }) : optimizeStream({
        text, sessionId, sessionQuery, llm: boundLlm, route: callRoute, signal,
        contextEnabled, requestId, overrides, log,
      }),
      onFinal: (final, job) => {
        void recordSample(samplePath, {
          text,
          final,
          meta: { route: job.route, reasons: [] },
          sessionId,
          runId,
          jobId: job.id,
          provider: callRoute?.provider,
          model: callRoute?.model,
        });
      },
    });

    if (created.ok !== true) {
      sendJson(res, 200, { ok: false, code: created.code, error: created.error, job: created.job ?? null });
      return;
    }
    if (stream) {
      await streamJob(req, res, jobs, created.job);
    } else if (action === "predict") {
      const final = await jobs.wait(created.job.id);
      sendJson(res, 200, final?.ok ? { ok: true, text: final.text }
        : { ok: false, code: final?.code ?? "llm_error", error: final?.error ?? "预测失败" });
    } else {
      await jsonJob(res, jobs, created.job, debug);
    }
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: "exact", path: route, handler }),
    "prompt-seed:route",
  );
}
