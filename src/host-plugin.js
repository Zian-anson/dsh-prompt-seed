/**
 * prompt-seed / Host 半区
 * ---------------------------------------------------------------------------
 * 一个普通 Cordis 插件：向 DSH 的 webServer 注册一条回环限定的 JSON 路由，
 * 浏览器半区通过 fetch 调用它换取优化结果。
 *
 * 为什么走 HTTP 路由而不是 Remote 服务：Remote 需要 Typert 的构建期 schema
 * 生成链路，而本插件只有一个请求/响应字段对，路由是更小的接缝，也不需要把
 * 构建链绑到 DSH 的内部代码生成器上。路由只接受回环来源，见 guardLoopback。
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { ERROR_CODES, ERROR_MESSAGES, isPreciseInstruction, optimizePromptText, predictNextPrompt, resolveRoute } from "./host-core.js";
import { safeSlice } from "./message-text.js";
import { setTemplateOverrides } from "./prompt-templates.js";
import { appendSample, resolveSamplePath } from "./sample-log.js";
import { extractPredictionWindow, extractRecentContext, needsContext } from "./session-context.js";
import { classifySignalInput, extractAssistantTail } from "./signal-inference.js";
import { classifyPredictionAnchor } from "./prediction.js";

/** Cordis 插件名。 */
export const name = "prompt-seed";

/**
 * 硬依赖。
 *
 * `llm` 与 `agentDefaultModel` **不在此列**：它们是可选能力，缺席时插件仍然装载，
 * 只在调用时返回结构化错误码（`llm_unavailable` / `model_unavailable`）。
 * 把可选能力写进 inject 会让整行在缺少模型服务的 profile 里永久等待。
 */
export const inject = ["webServer"];

/** 默认路由。浏览器半区必须与这里保持一致。 */
export const DEFAULT_ROUTE = "/api/prompt-seed/optimize";

/**
 * 读取本包在磁盘上的版本号，作为**运行时身份探针**。
 * 热升级（disable→enable）是否真的换掉了模块，只能靠运行时自报身份来确认：
 * ESM 缓存、旧 fiber 残留都会让"看起来升级了"与"实际在跑旧代码"同时成立。
 *
 * **必须在模块加载时读一次并冻结**：早先的实现是每次调用现读 package.json，
 * 于是"装上新版但进程还跑着旧代码"时它照样报新版本号——实测确认过一次
 * （线上报 0.8.0，响应体里却没有 0.8.0 才有的 gate 字段）。这个版本号是排查
 * "改了没生效"的第一手证据，它撒谎比没有更糟。
 * @returns {string | null} 本进程实际加载的代码版本，读取失败返回 null。
 */
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

/**
 * 本插件声明的宿主要求（来自 package.json 的 engines.dsh）。
 * 从元数据读而不是再写一份常量：两处写死必然会不同步，而这一条恰好是
 * 用户遇到 ERESOLVE 时唯一能看到的原因说明。
 */
const REQUIRES_DSH = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    return typeof pkg?.engines?.dsh === "string" ? pkg.engines.dsh : null;
  } catch {
    return null;
  }
})();

/** 请求体上限。输入本身已被 MAX_TEXT_LENGTH 限制，这里只是防滥用。 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * 整条路由的墙钟硬上限（毫秒，T-debug-M4）。
 *
 * deadlineMs 只预算**可选**调用（第 3/4 次），这是 host-core 的既有设计；但它
 * 管不到必发调用——provider 挂起时改写/审判两次调用会把请求无限期吊死，客户端
 * fetch 跟着挂死（实测 deadlineMs=100 的请求跑了 6s，永不 finish 的流永不返回）。
 * 这里给每条请求一个独立的天花板：到点即放弃等待并回结构化超时错误，同时把
 * AbortSignal 透传给 llm.stream（callModel 本就支持），守规矩的 provider 会停烧
 * token。默认 120s 刻意宽——实测最慢的合法拒绝 17.8s，它只负责把"挂死"变成
 * "可重试的错误"，不参与正常延迟调节。`requestTimeoutMs` 行配置可调。
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;

/** 事件落盘时保留的输入前缀长度：够分类，不整篇留存。 */
const SAMPLE_INPUT_PREVIEW = 400;

/**
 * 严格 IPv4 回环：127.a.b.c 四段十进制，且每段必须是 0–255。
 *
 * 为什么不能用 `startsWith("127.")`：Host 头是**攻击者可控文本**，而
 * `"127.0.0.1.evil.example".startsWith("127.")` 为真——一个 DNS 记录指向 127.0.0.1
 * 的域名（`127.0.0.1.evil.example`）就能同时骗过 peer 校验（真的解析到了本机）和这处
 * 前缀匹配，实测确认放行。边界要按完整形状判，不能按前缀判。
 * 段值范围另判：`127.0.0.999` 不是地址，正则放它过去只是"看着像"。
 */
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
 * 每请求硬超时 + 客户端断开中止（T-debug-M4，见 DEFAULT_REQUEST_TIMEOUT_MS）。
 *
 * 三件事：
 *   ① 把 AbortSignal 透传给任务（optimizePromptText / predictNextPrompt →
 *      callModel → llm.stream），provider 侧能停则停；
 *   ② 到点不再等任务醒来，直接以结构化超时结果 settle——客户端绝不无限期挂起；
 *   ③ 客户端断开连接同样触发中止（改写结果没人等了，就不必烧完剩余调用）。
 * 任务异常也归一为结构化错误：这条路由的约定是"业务结果一律 200 + code"，
 * handler 不向 webServer 抛任何东西。
 * @param {object} req 请求（用于监听客户端断开）。
 * @param {number} timeoutMs 墙钟上限。
 * @param {(signal: AbortSignal) => Promise<object>} task 业务任务。
 * @returns {Promise<object>} 任务结果或结构化超时/错误结果。
 */
function runWithRequestTimeout(req, timeoutMs, task) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let done = false;
    const settle = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off("close", onClientGone);
      resolve(value);
    };
    const timer = setTimeout(() => {
      controller.abort();
      settle({ ok: false, code: ERROR_CODES.REQUEST_TIMEOUT, error: ERROR_MESSAGES.request_timeout });
    }, timeoutMs);
    const onClientGone = () => controller.abort();
    req.on("close", onClientGone);
    Promise.resolve(task(controller.signal)).then(settle, (error) => {
      settle({
        ok: false,
        code: ERROR_CODES.LLM_ERROR,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
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
 * 装载 Host 半区：注册优化路由。
 * @param {object} ctx Cordis 上下文。
 * @param {{route?: string, provider?: string, model?: string, auditProvider?: string,
 *          auditModel?: string, deadlineMs?: number, context?: boolean,
 *          samples?: string|boolean, templates?: boolean}} [config] 行配置。
 *   - `route`：路由路径（默认 /api/prompt-seed/optimize）。
 *   - `provider` + `model`：覆盖默认模型路由（两者必须同时提供）——改写任务
 *     对"指令遵循稳定性"的要求高于"聪明"，允许指向更合适的模型。
 *   - `auditProvider` + `auditModel`：把两次审判单独路由到另一个模型（同样成对）。
 *     最坏路径四次调用里审判占两次，这是压拒绝延迟最直接的杠杆；缺省沿用主路由。
 *   - `deadlineMs`：可选调用（补全重试 / 收紧重试 / 定向修复）的墙钟预算，默认 20s。
 *   - `context: false`：关闭会话上下文注入。
 *   - `samples`：事件日志路径；`false` 整体关闭。
 *   - `templates: false`：忽略 `$DSH_HOME/prompt-seed/prompts/*.md` 覆盖层。
 */
export function apply(ctx, config = {}) {
  const route = typeof config.route === "string" && config.route.startsWith("/") ? config.route : DEFAULT_ROUTE;
  const contextEnabled = config.context !== false;
  // 预测通道独立开关（T-debug-F2）：`context` 管的是改写/审判的上下文注入，
  // 预测的唯一依据就是会话读取——此前被同一个 contextEnabled 一并关掉，行配置
  // `context: false` 时水晶球变成"永远 cannot_predict"的死按钮（客户端无从得知
  // 该配置）。现在预测默认开启，`predict: false` 单独关闭。
  const predictEnabled = config.predict !== false;
  const requestTimeoutMs =
    Number.isFinite(config.requestTimeoutMs) && config.requestTimeoutMs > 0
      ? config.requestTimeoutMs
      : DEFAULT_REQUEST_TIMEOUT_MS;
  // 推理力度透传（0.10.1）：默认不透传（改写是轻任务，max 档实测让输出发散且慢
  // 数秒）；`rewriteReasoningEffort: "inherit"` 让改写类调用跟随当前模型选择的
  // reasoningEffort。只作用于生成型改写调用，不作用于审判与压缩（它们要快）。
  const inheritReasoningEffort = config.rewriteReasoningEffort === "inherit";
  // 管线选择（0.12.0）：unified = 改写+自审+修正在同一次调用（DRAFT→AUDIT→FINAL，
  // 协议残缺自动降级 split 语义，质量下界即双调用）；split = 两次独立调用的旧路径。
  // body.pipeline 允许逐请求覆盖（回环限定环境里的 A/B 与排障用，客户端不下发）。
  const DEFAULT_PIPELINE = "unified";
  const pipelineOf = (body) => {
    const value = body !== null && typeof body === "object" ? body.pipeline : undefined;
    return value === "split" || value === "unified" ? value : config.pipeline === "split" ? "split" : config.pipeline === "unified" ? "unified" : DEFAULT_PIPELINE;
  };
  const samplePath = resolveSamplePath(config.samples);
  // 提示词模板覆盖（F 项）：默认开启，`templates: false` 关闭。
  const templatesEnabled = config.templates !== false;

  /**
   * 审判专用路由（README 已知限制 5）：两次审判是主路径里最轻的调用，
   * 把它们挪到更便宜/更快的模型上是压最坏延迟最直接的杠杆（四次调用的路径上，
   * 两次审判通常占掉一半以上墙钟）。两个键必须成对给出，缺省即沿用主路由——
   * 不配这两个键时行为与从前逐字一致。
   *
   * 必须在启动横幅之前求值：横幅里要报出它，而 const 声明在横幅之后就撞 TDZ。
   */
  const auditRoute =
    typeof config.auditProvider === "string" && config.auditProvider !== "" &&
    typeof config.auditModel === "string" && config.auditModel !== ""
      ? { provider: config.auditProvider, model: config.auditModel }
      : undefined;

  /**
   * 从请求体读深度档位（D/E 项）。非法值一律按标准档处理——客户端是唯一调用方，
   * 但它可能跑着旧版本，未知取值必须安全降级。
   * @param {unknown} body 已解析的请求体。
   * @returns {'standard' | 'deep'} 深度档位。
   */
  const depthOf = (body) => {
    const value = body !== null && typeof body === "object" ? body.depth : undefined;
    return value === "deep" || value === "light" ? value : "standard";
  };
  /**
   * 从请求体读本次运行的关联 id（客户端生成，优化与反馈两条记录共用）。
   * 没有它，57 条隐式反馈只能靠时间戳相邻去猜自己标的是哪一次输入。
   * 长度截断是必要的：这是外部可控字符串，会直接进本地日志文件。
   * @param {unknown} body 已解析的请求体。
   * @returns {string | null} 关联 id，或 null。
   */
  const runIdOf = (body) => {
    const value = body !== null && typeof body === "object" ? body.runId : undefined;
    return typeof value === "string" && value !== "" ? value.slice(0, 64) : null;
  };
  const log = (level, message, meta) => {
    if (level === "error") console.error(message, meta ?? "");
    else if (level === "warn") console.warn(message, meta ?? "");
  };

  // ---- 能力探测 + 优雅自禁用 ----
  // 宿主启动是 all-or-nothing：一个插件抛异常会拖垮整个进程。所以接缝缺失时
  // **绝不能抛**，只能自禁用并把原因说清楚（生态里的范本：dsh-market 在旧宿主上
  // 自我禁用并在控制台说明，而不是渲染到不存在的原语上）。
  if (ctx?.webServer === undefined || typeof ctx.webServer.register !== "function") {
    log("error", "[prompt-seed] webServer.register unavailable; disabling the plugin instead of breaking boot", {
      codeVersion: codeVersion(),
      hint: "This host is older than the plugin expects. Requires dsh " + (REQUIRES_DSH ?? ">=0.2.0-rc.1 <0.3.0-0") + ".",
    });
    return;
  }
  if (typeof ctx.effect !== "function") {
    log("error", "[prompt-seed] ctx.effect unavailable; refusing to register a route that cannot be disposed", {
      codeVersion: codeVersion(),
    });
    return;
  }

  // 启动横幅：宿主模块代码无法热替换（loader 启动时固化解析 + ESM 缓存），
  // 唯一可靠的"当前跑的是哪份代码"证据就是这行日志与 ?debug=1 的 codeVersion。
  // 排查"改了没生效"时先看这里，不要靠行为反推。
  log("warn", "[prompt-seed] loaded", {
    codeVersion: codeVersion(),
    route,
    provider: config.provider ?? null,
    model: config.model ?? null,
    auditProvider: auditRoute?.provider ?? null,
    auditModel: auditRoute?.model ?? null,
    context: contextEnabled,
    predict: predictEnabled,
    requestTimeoutMs,
    rewriteReasoningEffort: inheritReasoningEffort ? "inherit" : "none",
    pipeline: config.pipeline === "split" ? "split" : config.pipeline === "unified" ? "unified" : DEFAULT_PIPELINE,
    samples: samplePath,
  });

  /**
   * 解析本次调用的模型路由：行 config 覆盖 > agentDefaultModel。
   * @returns {{provider: string, model: string, reasoningEffort?: string} | undefined} 路由。
   */
  const resolveCallRoute = () => {
    if (typeof config.provider === "string" && config.provider !== "" && typeof config.model === "string" && config.model !== "") {
      return { provider: config.provider, model: config.model };
    }
    return resolveRoute(ctx.get("agentDefaultModel"));
  };

  /**
   * 读取最近会话上下文（全防御：任何一步失败都静默降级为无上下文，
   * 绝不能让 grounding 增强阻塞优化本身）。
   *
   * 返回 { context, assistantTail }：前者是既有的用户话轮（消解指代用），
   * 后者是最近一条助手话轮——纯信号推断的锚点大多在助手尾部（选项、
   * 待答问题、待续提议），只取用户话轮会丢掉最有信息量的半边。
   * @param {unknown} sessionId 客户端报告的会话 id。
   * @returns {Promise<{context: {role: string, text: string}[] | undefined,
   *                      assistantTail: {role: 'assistant', text: string} | undefined} | undefined>}
   */
  const readContext = async (sessionId, draft) => {
    if (!contextEnabled || typeof sessionId !== "string" || sessionId === "") return undefined;
    // 按需注入（E 项）：草稿自足时不读会话——省一次 readSurface、省 token，
    // 也避免把无关内容塞进改写 prompt。精确指令（指名道姓写清文件/函数/数字）
    // 一律视为自足。信号/短指令输入相反：它们整个语义都在上文里。
    const signalClass = classifySignalInput(draft ?? "");
    if (signalClass.kind === "none" && (isPreciseInstruction(draft) || !needsContext(draft))) {
      return undefined;
    }
    try {
      const sessionQuery = ctx.get("sessionQuery");
      if (sessionQuery === undefined || typeof sessionQuery.readSurface !== "function") return undefined;
      const surface = await sessionQuery.readSurface(sessionId);
      return { context: extractRecentContext(surface), assistantTail: extractAssistantTail(surface) };
    } catch (error) {
      log("warn", "[prompt-seed] context read failed; optimizing without context", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  };

  /**
   * 读取"预测下一步输入"所需的会话窗口（0.9.6）。
   *
   * 与 readContext 的关键差异：**无条件读取**。readContext 的按需注入判据建立在
   * 用户草稿上（短草稿 / 指代词 / 纯信号），而预测通道的输入框是空的——没有草稿
   * 可判，全部依据都在会话尾部，所以这里不做任何"省一次 readSurface"的取舍。
   * 同样全防御：任何一步失败都返回 undefined，由调用方走中性拒绝，绝不抛。
   * @param {unknown} sessionId 客户端报告的会话 id。
   * @returns {Promise<{turns: {role: string, text: string}[], assistantTail?: string,
   *                    sawToolActivity: boolean} | undefined>} 会话窗口。
   */
  const readPredictionWindow = async (sessionId) => {
    if (!predictEnabled || typeof sessionId !== "string" || sessionId === "") return undefined;
    try {
      const sessionQuery = ctx.get("sessionQuery");
      if (sessionQuery === undefined || typeof sessionQuery.readSurface !== "function") return undefined;
      const surface = await sessionQuery.readSurface(sessionId);
      return extractPredictionWindow(surface);
    } catch (error) {
      log("warn", "[prompt-seed] prediction context read failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  };

  /**
   * 读取提示词模板覆盖层（F 项）。
   *
   * 每次请求重读，不是启动时读一次——宿主模块代码要重启才能换，但数据不用。
   * 用户在 `$DSH_HOME/prompt-seed/prompts/` 下放同名文件即可替换对应模板，
   * **改完下一次点击就生效**，不必重启应用：
   *   system.md / user.md / audit.md —— 补全、精确、审判三份契约
   *   signal.md / deictic.md / conversational.md —— 0.9.x 三个分支的契约
   *   predict.md —— 0.9.6 的下一步输入预测契约
   * 后三个键在 prompt-templates 里早就被读取，但这里从不加载它们，
   * 等于用户在 prompts/ 下放这三个文件完全无效——不可达的配置比没有更糟。
   * 缺失或空文件一律回落内置模板；`templates: false` 可整体关闭。
   * @returns {Promise<{system?: string, user?: string, audit?: string, signalSystem?: string, deicticSystem?: string, conversationalSystem?: string} | null>} 覆盖内容。
   */
  const readTemplateOverrides = async () => {
    if (templatesEnabled === false) return null;
    const home =
      typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.trim() !== ""
        ? process.env.DSH_HOME
        : join(homedir(), ".dsh");
    const dir = join(home, "prompt-seed", "prompts");
    const overrides = {};
    const OVERRIDE_FILES = [
      ["system", "system.md"],
      ["user", "user.md"],
      ["audit", "audit.md"],
      ["signalSystem", "signal.md"],
      ["deicticSystem", "deictic.md"],
      ["conversationalSystem", "conversational.md"],
      ["predictSystem", "predict.md"],
    ];
    for (const [key, file] of OVERRIDE_FILES) {
      try {
        const text = await readFile(join(dir, file), "utf8");
        if (text.trim() !== "") overrides[key] = text;
      } catch (error) {
        // 文件不存在即使用内置模板——这是常态，不是错误。但**其他**错误必须吼出来：
        // 这里曾经因为吞掉一切而藏住一个真 bug（readFile 从 node:fs 导入成回调版，
        // 每次调用都抛异常，覆盖功能静默失效，直到测试断言 system prompt 才暴露）。
        if (error?.code !== "ENOENT") {
          log("warn", "[prompt-seed] template override unreadable; using the built-in template", {
            file,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return Object.keys(overrides).length > 0 ? overrides : null;
  };

  // ---------------------------------------------------------------------------
  // 三条通道（0.10.1 起从 handler 内联块拆出）：同一条路由按 body 形状分流，
  // feedback 落盘即应答、predict / optimize 返回结果对象由 handler 统一写回。
  // 拆分的动机是流式/调试扩展都要在通道内部动刀，内联块已经长到没法安全改。
  // ---------------------------------------------------------------------------

  /**
   * 反馈通道：body 带 feedback 字段。隐式信号（改写后"立刻撤销"= 补多了，
   * "立刻再点一次"= 补少了）零打扰且是真实分布的唯一来源；不落盘就只能靠猜着调参。
   * @param {object} body 已解析的请求体。
   */
  const handleFeedback = async (body) => {
    const feedback = body.feedback;
    if (samplePath === null) return;
    await appendSample(samplePath, {
      time: new Date().toISOString(),
      event: "feedback",
      // 与 optimize 记录同源的关联 id：57 条反馈此前只能靠时间戳相邻去猜
      // 自己标的是哪一次输入，配上它就变成可精确 join 的监督信号。
      runId: runIdOf(body),
      codeVersion: codeVersion(),
      kind: typeof feedback.kind === "string" ? feedback.kind : "unknown",
      tier: typeof feedback.tier === "string" ? feedback.tier : null,
      charsDelta: Number.isFinite(feedback.charsDelta) ? feedback.charsDelta : null,
      elapsedMs: Number.isFinite(feedback.elapsedMs) ? feedback.elapsedMs : null,
    });
  };

  /**
   * 预测通道：body.mode === "predict"。输入框为空时点预测图标走这里：
   * 没有草稿可依据，全部依据来自会话尾部。分型由确定性规则判定（零额外调用），
   * 锚点不存在即中性拒绝——"拒绝硬猜"的不变量与信号分支同构。
   * @param {object} req 请求（超时包装与 debug 判定用）。
   * @param {object} body 已解析的请求体。
   * @param {unknown} sessionId 会话 id。
   * @returns {Promise<object>} 结果对象（可能带 _debug）。
   */
  const handlePredict = async (req, body, sessionId) => {
    const predictionWindow = await readPredictionWindow(sessionId);
    const anchor = classifyPredictionAnchor({
      assistantTail: predictionWindow?.assistantTail,
      sawToolActivity: predictionWindow?.sawToolActivity === true,
    });
    const callRoute = resolveCallRoute();
    setTemplateOverrides(await readTemplateOverrides());
    const startedAt = Date.now();
    const result =
      anchor.kind === "none"
        ? {
            ok: false,
            code: ERROR_CODES.CANNOT_PREDICT,
            error: ERROR_MESSAGES.cannot_predict,
            mode: "predict",
            kind: null,
          }
        : await runWithRequestTimeout(req, requestTimeoutMs, (signal) =>
            predictNextPrompt({
              llm: ctx.get("llm"),
              route: callRoute,
              kind: anchor.kind,
              anchor: anchor.anchor,
              choiceOptions: anchor.options,
              turns: predictionWindow?.turns,
              signal,
              log,
            }),
          );
    const elapsedMs = Date.now() - startedAt;

    // 与 optimize 同一份事件日志：预测也需要一份真实分布才能判断"值不值得留"
    // （拒绝率、分型分布、模型是否总在超预算）。anchor 只留 200 字前缀——
    // 它和 optimize 的 input 预览处在同一个隐私平面（本机文件、同一目录）。
    if (samplePath !== null) {
      await appendSample(samplePath, {
        time: new Date().toISOString(),
        event: "predict",
        code: result.ok ? "ok" : result.code,
        mode: "predict",
        kind: typeof result.kind === "string" ? result.kind : null,
        anchorSource: anchor.kind === "none" ? null : anchor.source,
        codeVersion: codeVersion(),
        runId: runIdOf(body),
        from: typeof sessionId === "string" && sessionId !== "" ? "ui" : "script",
        turns: Array.isArray(predictionWindow?.turns) ? predictionWindow.turns.length : 0,
        sawToolActivity: predictionWindow?.sawToolActivity === true,
        inputChars: 0,
        outputChars: result.ok ? result.text.length : 0,
        ms: elapsedMs,
        anchor: anchor.kind === "none" ? "" : safeSlice(String(anchor.anchor ?? ""), 0, 200),
        provider: callRoute?.provider ?? null,
        model: callRoute?.model ?? null,
      });
    }

    if (wantsDebugFlag(req)) {
      result._debug = {
        codeVersion: codeVersion(),
        sessionId: sessionId ?? null,
        runId: runIdOf(body),
        kind: typeof result.kind === "string" ? result.kind : anchor.kind ?? null,
        anchorSource: anchor.kind === "none" ? anchor.reason : anchor.source,
        turns: Array.isArray(predictionWindow?.turns) ? predictionWindow.turns.length : 0,
        sawToolActivity: predictionWindow?.sawToolActivity === true,
        provider: callRoute?.provider ?? null,
        model: callRoute?.model ?? null,
        samplePath,
      };
    }
    return result;
  };

  /**
   * 优化通道：默认路径。读会话上下文（按需）、跑改写管线、全量事件落盘。
   * @param {object} req 请求（超时包装与 debug 判定用）。
   * @param {object} body 已解析的请求体。
   * @param {unknown} sessionId 会话 id。
   * @param {string} text 用户草稿。
   * @returns {Promise<object>} 结果对象（可能带 _debug）。
   */
  const handleOptimize = async (req, body, sessionId, text) => {
    const contextBundle = await readContext(sessionId, text);
    // 提到变量：0.9.0 把上下文改成 { context, assistantTail } 之后，
    // ?debug=1 的统计块曾引用已不存在的 context——调试端点在 0.9.0 起每次调用
    // 都抛 ReferenceError，直到 T013 的路由测试把它撞出来。
    const context = contextBundle?.context;
    const callRoute = resolveCallRoute();
    setTemplateOverrides(await readTemplateOverrides());
    const startedAt = Date.now();
    const result = await runWithRequestTimeout(req, requestTimeoutMs, (signal) =>
      optimizePromptText({
        llm: ctx.get("llm"),
        route: callRoute,
        auditRoute,
        text,
        context,
        assistantTail: contextBundle?.assistantTail,
        depth: depthOf(body),
        deadlineMs: config.deadlineMs,
        pipeline: pipelineOf(body),
        inheritReasoningEffort,
        signal,
        log,
      }),
    );
    const elapsedMs = Date.now() - startedAt;

    // 全量事件落盘：不只记拒绝。没有"每次优化长什么样"的分布，就无法判断
    // 深度是否合适、哪类输入在哪个方向上出问题——样本是唯一证据来源。
    // 只存输入前 400 字（够分类，不整篇留存），`samples: false` 可整体关闭。
    if (samplePath !== null) {
      await appendSample(samplePath, {
        time: new Date().toISOString(),
        event: "optimize",
        code: result.ok ? "ok" : result.code,
        tier: result.ok ? result.tier : null,
        // 只登记管线**真实做出**的操作判定。结果对象在"还没走到选档就被拒"
        // 的路径上根本没有 mode，这里如实写 null——早先的实现会退回启发式重猜
        // （describeMode / isPreciseInstruction），于是 empty_input、hi、超长
        // 输入、被拒草稿全被记成 "elaborate"：一个从未运行过的档位。
        mode: typeof result.mode === "string" ? result.mode : null,
        // 路由归因（0.10.1）：这条输入最终被哪条规则接管。mode 只说"走了哪个
        // 管线"，classificationSource 说"是谁把它送进去的"（signal-multi /
        // conversational-go-ahead / adaptive-clarify-forced…）——调阈值、补
        // 规则、验证英文命中率都靠它做分母。
        classificationSource: typeof result.classificationSource === "string" ? result.classificationSource : null,
        // 归因字段：这份日志跨版本累积，没有它就只能靠时间戳考古。
        codeVersion: codeVersion(),
        runId: runIdOf(body),
        // 调用来源：界面点击（带 sessionId）还是脚本直接打路由（不带）。
        from: typeof sessionId === "string" && sessionId !== "" ? "ui" : "script",
        depth: depthOf(body),
        // 闸门凭证与越线类别落盘：延迟归因和"闸门是不是误判"都靠这两个字段回答。
        gate: result.ok ? (result.gate?.verdict ?? null) : null,
        repairs: result.ok ? (result.gate?.repairs ?? 0) : 1,
        rechecked: result.ok ? (result.gate?.rechecked ?? false) : true,
        // 拒绝路径没有 gate 对象，但它恰恰是最需要归因的一次。
        violations: (Array.isArray(result.gate?.violations)
          ? result.gate.violations
          : Array.isArray(result.violations)
            ? result.violations
            : []
        ).map((item) => item.kind),
        inputChars: text.trim().length,
        outputChars: result.ok ? result.text.length : 0,
        ms: elapsedMs,
        input: text.slice(0, SAMPLE_INPUT_PREVIEW),
        added: Array.isArray(result.added) ? result.added : [],
        provider: callRoute?.provider ?? null,
        model: callRoute?.model ?? null,
      });
    }

    // 回环限定的排障开关：?debug=1 附带内部状态（不含上下文原文，只含形状）。
    if (wantsDebugFlag(req)) {
      result._debug = {
        codeVersion: codeVersion(),
        sessionId: sessionId ?? null,
        runId: runIdOf(body),
        classificationSource: typeof result.classificationSource === "string" ? result.classificationSource : null,
        contextMessages: Array.isArray(context) ? context.length : 0,
        contextChars: Array.isArray(context) ? context.reduce((n, item) => n + (item?.text?.length ?? 0), 0) : 0,
        provider: callRoute?.provider ?? null,
        model: callRoute?.model ?? null,
        auditProvider: auditRoute?.provider ?? null,
        auditModel: auditRoute?.model ?? null,
        deadlineMs: config.deadlineMs ?? null,
        samplePath,
      };
    }
    return result;
  };

  // 注册必须挂到 fiber 生命周期（ctx.effect）：webServer.register 返回的 disposer
  // 若被丢弃，fiber 销毁后路由残留，disable→enable 的热升级会撞 duplicate exact route
  // （实测确认）。effect 的返回值就是 register 的 disposer，fiber 销毁时自动注销。
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: route,
        handler: async (req, res) => {
          // 调度器只做四件事：回环/方法守卫、读体、按 body 形状分通道、写回结果。
          // 通道实现见上方 handleFeedback / handlePredict / handleOptimize。
          if (!guardLoopback(req, res)) return;
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, code: "method_not_allowed", error: "仅接受 POST" });
            return;
          }

          let body;
          try {
            body = await readJsonBody(req, MAX_BODY_BYTES);
          } catch (error) {
            // 请求体溢出走 413 + 专属错误码：它是传输层事实，不是业务结果，
            // 因此不适用"业务结果一律 200"的约定；把它并进 400 会让客户端无法区分
            // "JSON 写坏了"（可修）与"内容太大"（该精简）。
            const tooLarge = error?.code === PAYLOAD_TOO_LARGE;
            sendJson(res, tooLarge ? 413 : 400, {
              ok: false,
              code: tooLarge ? ERROR_CODES.PAYLOAD_TOO_LARGE : "bad_request",
              error: tooLarge
                ? ERROR_MESSAGES.payload_too_large
                : error instanceof Error
                  ? error.message
                  : "请求体无法解析",
            });
            return;
          }

          const text = body && typeof body.text === "string" ? body.text : "";
          const sessionId = body && typeof body.sessionId === "string" ? body.sessionId : undefined;

          if (body !== null && typeof body === "object" && typeof body.feedback === "object" && body.feedback !== null) {
            await handleFeedback(body);
            sendJson(res, 200, { ok: true });
            return;
          }
          if (body !== null && typeof body === "object" && body.mode === "predict") {
            sendJson(res, 200, await handlePredict(req, body, sessionId));
            return;
          }
          sendJson(res, 200, await handleOptimize(req, body, sessionId, text));
        },
      }),
    "prompt-seed:route",
  );
}

export { ERROR_MESSAGES };
