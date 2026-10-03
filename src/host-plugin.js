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

import { ERROR_MESSAGES, isPreciseInstruction, optimizePromptText, resolveRoute } from "./host-core.js";
import { setTemplateOverrides } from "./prompt-templates.js";
import { appendSample, resolveSamplePath } from "./sample-log.js";
import { extractRecentContext, needsContext } from "./session-context.js";

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

/** 事件落盘时保留的输入前缀长度：够分类，不整篇留存。 */
const SAMPLE_INPUT_PREVIEW = 400;

/**
 * 判断一个远端地址是否为回环。
 * @param {unknown} value `req.socket.remoteAddress` 的值。
 * @returns {boolean} 是否回环。
 */
function isLoopbackAddress(value) {
  if (typeof value !== "string" || value === "") return false;
  const address = value.startsWith("::ffff:") ? value.slice(7) : value;
  return address === "::1" || address === "127.0.0.1" || address.startsWith("127.");
}

/**
 * 判断 Host 头是否指向本机。
 * @param {unknown} value `req.headers.host` 的值。
 * @returns {boolean} 是否本机。
 */
function isLoopbackHost(value) {
  if (typeof value !== "string" || value === "") return false;
  const host = value.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || host === "127.0.0.1" || host.startsWith("127.");
}

/**
 * 回环防护：同时校验 peer socket 地址与 Host 头。
 *
 * 只校验其中一个是可以绕过的：DNS rebinding 能让 Host 头撒谎，而仅信 Host 头
 * 等于把内网任意来源都放进来。拒绝时直接写完 403 并返回 false。
 * @param {object} req 请求。
 * @param {object} res 响应。
 * @returns {boolean} 是否放行。
 */
export function guardLoopback(req, res) {
  const peer = req.socket?.remoteAddress;
  if (!isLoopbackAddress(peer) || !isLoopbackHost(req.headers?.host)) {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, code: "forbidden", error: "仅允许本机访问" }));
    return false;
  }
  return true;
}

/**
 * 读取并解析 JSON 请求体。
 * @param {object} req 请求。
 * @param {number} limit 字节上限。
 * @returns {Promise<unknown>} 解析后的 JSON 值。
 */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
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
    req.on("error", reject);
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
 * 装载 Host 半区：注册优化路由。
 * @param {object} ctx Cordis 上下文。
 * @param {{route?: string, provider?: string, model?: string, context?: boolean}} [config] 行配置。
 *   - `route`：路由路径（默认 /api/prompt-seed/optimize）。
 *   - `provider` + `model`：覆盖默认模型路由（两者必须同时提供）——改写任务
 *     对"指令遵循稳定性"的要求高于"聪明"，允许指向更合适的模型。
 *   - `context: false`：关闭会话上下文注入。
 */
export function apply(ctx, config = {}) {
  const route = typeof config.route === "string" && config.route.startsWith("/") ? config.route : DEFAULT_ROUTE;
  const contextEnabled = config.context !== false;
  const samplePath = resolveSamplePath(config.samples);
  // 提示词模板覆盖（F 项）：默认开启，`templates: false` 关闭。
  const templatesEnabled = config.templates !== false;

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
    context: contextEnabled,
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
   * @param {unknown} sessionId 客户端报告的会话 id。
   * @returns {Promise<{role: string, text: string}[] | undefined>} 上下文消息。
   */
  const readContext = async (sessionId, draft) => {
    if (!contextEnabled || typeof sessionId !== "string" || sessionId === "") return undefined;
    // 按需注入（E 项）：草稿自足时不读会话——省一次 readSurface、省 token，
    // 也避免把无关内容塞进改写 prompt。精确指令（指名道姓写清文件/函数/数字）
    // 一律视为自足。
    if (isPreciseInstruction(draft) || !needsContext(draft)) return undefined;
    try {
      const sessionQuery = ctx.get("sessionQuery");
      if (sessionQuery === undefined || typeof sessionQuery.readSurface !== "function") return undefined;
      const surface = await sessionQuery.readSurface(sessionId);
      return extractRecentContext(surface);
    } catch (error) {
      log("warn", "[prompt-seed] context read failed; optimizing without context", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  };

  /**
   * 读取提示词模板覆盖层（F 项）。
   *
   * 每次请求重读，不是启动时读一次——宿主模块代码要重启才能换，但数据不用。
   * 用户在 `$DSH_HOME/prompt-seed/prompts/` 下放 `system.md` / `user.md` /
   * `audit.md` 即可替换对应模板，**改完下一次点击就生效**，不必重启应用。
   * 缺失或空文件一律回落内置模板；`templates: false` 可整体关闭。
   * @returns {Promise<{system?: string, user?: string, audit?: string} | null>} 覆盖内容。
   */
  const readTemplateOverrides = async () => {
    if (templatesEnabled === false) return null;
    const home =
      typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.trim() !== ""
        ? process.env.DSH_HOME
        : join(homedir(), ".dsh");
    const dir = join(home, "prompt-seed", "prompts");
    const overrides = {};
    for (const [key, file] of [["system", "system.md"], ["user", "user.md"], ["audit", "audit.md"]]) {
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

  // 注册必须挂到 fiber 生命周期（ctx.effect）：webServer.register 返回的 disposer
  // 若被丢弃，fiber 销毁后路由残留，disable→enable 的热升级会撞 duplicate exact route
  // （实测确认）。effect 的返回值就是 register 的 disposer，fiber 销毁时自动注销。
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: route,
        handler: async (req, res) => {
          if (!guardLoopback(req, res)) return;
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, code: "method_not_allowed", error: "仅接受 POST" });
            return;
          }

          let text = "";
          let sessionId;
          let body;
          try {
            body = await readJsonBody(req, MAX_BODY_BYTES);
            text = body && typeof body.text === "string" ? body.text : "";
            sessionId = body && typeof body.sessionId === "string" ? body.sessionId : undefined;
          } catch (error) {
            sendJson(res, 400, {
              ok: false,
              code: "bad_request",
              error: error instanceof Error ? error.message : "请求体无法解析",
            });
            return;
          }

          // ---- 反馈通道（同一条路由，body 带 feedback 字段）----
          // 隐式信号：改写后"立刻撤销"= 补多了，"立刻再点一次"= 补少了。这类标签
          // 零打扰且是真实分布的唯一来源；不落盘就永远只能靠猜着调参。
          const feedback =
            body && typeof body.feedback === "object" && body.feedback !== null ? body.feedback : null;
          if (feedback !== null) {
            if (samplePath !== null) {
              await appendSample(samplePath, {
                time: new Date().toISOString(),
                event: "feedback",
                kind: typeof feedback.kind === "string" ? feedback.kind : "unknown",
                tier: typeof feedback.tier === "string" ? feedback.tier : null,
                charsDelta: Number.isFinite(feedback.charsDelta) ? feedback.charsDelta : null,
                elapsedMs: Number.isFinite(feedback.elapsedMs) ? feedback.elapsedMs : null,
              });
            }
            sendJson(res, 200, { ok: true });
            return;
          }

          const context = await readContext(sessionId, text);
          const callRoute = resolveCallRoute();
          setTemplateOverrides(await readTemplateOverrides());
          const startedAt = Date.now();
          const result = await optimizePromptText({
            llm: ctx.get("llm"),
            route: callRoute,
            text,
            context,
            depth: depthOf(body),
            log,
          });
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
              mode: isPreciseInstruction(text) ? "precise" : "elaborate",
              // 调用来源：界面点击（带 sessionId）还是脚本直接打路由（不带）。
              // 没有这个字段时，验证脚本的几百次探针会和真实使用混在一条日志里——
              // 实测一次全量验证就写进 159 条固定输入，把"深度合不合适"这类
              // 基于分布判断的问题彻底淹没。
              from: typeof sessionId === "string" && sessionId !== "" ? "ui" : "script",
              depth: depthOf(body),
              // 闸门凭证与越线类别落盘：延迟归因（哪类越线走几次调用）和
              // "闸门是不是误判"都只能靠这两个字段回答。
              gate: result.ok ? (result.gate?.verdict ?? null) : null,
              repairs: result.ok ? (result.gate?.repairs ?? 0) : 1,
              rechecked: result.ok ? (result.gate?.rechecked ?? false) : true,
              // 拒绝路径没有 gate 对象，但它恰恰是最需要归因的一次：早期实现只读
              // result.gate，于是"被拒时到底撞了哪类越线"在日志里永远是空数组——
              // 排查一次真实拒绝时，正是这个字段缺失让诊断多绕了一圈。
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

          // 回环限定的排障开关：?debug=1 附带内部状态（不含上下文原文，只含形状），
          // 用于诊断"上下文是否注入/路由是否覆盖生效"这类管线问题。
          const wantsDebug =
            typeof req.url === "string" && new URL(req.url, "http://localhost").searchParams.get("debug") === "1";
          if (wantsDebug) {
            result._debug = {
              codeVersion: codeVersion(),
              sessionId: sessionId ?? null,
              contextMessages: Array.isArray(context) ? context.length : 0,
              contextChars: Array.isArray(context) ? context.reduce((n, item) => n + (item?.text?.length ?? 0), 0) : 0,
              provider: callRoute?.provider ?? null,
              model: callRoute?.model ?? null,
              samplePath,
            };
          }

          sendJson(res, 200, result);
        },
      }),
    "prompt-seed:route",
  );
}

export { ERROR_MESSAGES };
