#!/usr/bin/env node
/**
 * 真实 socket 检查：把宿主路由挂到一个真的 `http.createServer` 上，用原始 HTTP 驱动它。
 *
 * 为什么需要它（而不是更多的单元测试）：单元测试里的 `req`/`res` 是替身，而这一层要
 * 验的恰好是替身**看不见**的东西——连接有没有被拆、错误响应能不能送达、头部判定用的是
 * 完整形状还是前缀。0.9.5 修掉的三个缺陷全都是这样漏过去的：
 *
 *   - `Origin` 从不校验 → 跨站页面可盲打（替身没有 Origin 概念）
 *   - `Host` 用 `startsWith("127.")` → `127.0.0.1.evil.example` 放行（替身里 Host 是普通字符串）
 *   - 溢出时先 `req.destroy()` → 客户端只拿到 ECONNRESET；测试替身把 destroy 写成空函数，
 *     于是断言 400 通过，真实 socket 上却一个字节都送不出去
 *
 * 零依赖、零网络（回环临时端口 + 可编程 llm 桩），因此可以直接进 `npm test`。
 * 用法：node tools/check-route-wire.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE = "/api/prompt-seed/optimize";
const results = [];

/**
 * 本文件声明的检查条数。
 *
 * 为什么要有这个常数，而不是让守卫去数源码里的 `check("`：循环里生成的检查在源码中
 * 只出现一次、运行时却跑多次（本文件的"同一台机器的不同拼法"就是 5 次），所以**源码
 * 计数永远不等于运行时计数**——用源码数去守卫文档，只会制造新的漂移。
 * 改成运行时自证：结束前核对实际执行条数，数字没跟上就当场失败；文档守卫读这个常数，
 * 于是"文档 = 常数 = 实际执行"三者被锁在一起。
 */
const DECLARED_CHECKS = 24;

/** 记录一条检查结果，失败不抛（一次跑完，看全貌）。 */
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

/** 一轮"停止"的模型输出。 */
function txt(text) {
  return [
    { type: "text-delta", index: 0, text },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

/** 可编程 llm 桩：第 i 次调用回放 responses[i]，用尽后重复最后一组。 */
function scriptedLlm(responses) {
  const seen = [];
  return {
    seen,
    stream(request) {
      seen.push(request);
      const chunks = responses[Math.min(seen.length - 1, responses.length - 1)];
      return (async function* generate() {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

/** 起一个插件实例 + 真实 HTTP 服务。 */
async function boot({ config = {}, responses, sessionQuery }) {
  const host = await import(pathToFileURL(join(root, "lib/index.js")).href);
  const work = mkdtempSync(join(tmpdir(), "po-wire-"));
  const samples = join(work, "samples.jsonl");
  const llm = scriptedLlm(responses);
  let route = null;
  const ctx = {
    webServer: {
      register(spec) {
        route = spec;
        return () => {};
      },
    },
    effect: (fn) => fn(),
    get(name) {
      if (name === "llm") return llm;
      if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "stub", model: "stub" }) };
      // 预测通道的上下文来源：缺省 undefined（等价于旧宿主没有 sessionQuery，
      // 那时预测应当走中性拒绝而不是抛）。
      if (name === "sessionQuery") return sessionQuery;
      return undefined;
    },
  };
  host.apply(ctx, { samples, ...config });
  const server = http.createServer((req, res) => {
    if (new URL(req.url, "http://localhost").pathname !== ROUTE) {
      res.writeHead(404);
      res.end();
      return;
    }
    route.handler(req, res);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  return {
    port,
    llm,
    samples,
    async close() {
      await new Promise((done) => server.close(done));
      rmSync(work, { recursive: true, force: true });
    },
    records() {
      try {
        return readFileSync(samples, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
  };
}

/** 一次原始 HTTP 请求：返回 status/body，或 socket 层失败（这正是要观察的东西）。 */
function rawRequest(port, { method = "POST", headers = {}, body } = {}) {
  return new Promise((done) => {
    const payload = body === undefined ? "" : body;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: ROUTE,
        agent: false,
        headers: { host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => done({ status: res.statusCode, body: text }));
        res.on("error", (error) => done({ status: null, socketError: error.code ?? String(error), body: text }));
      },
    );
    req.on("error", (error) => done({ status: null, socketError: error.code ?? String(error) }));
    req.end(payload);
  });
}

const OK_SCRIPT = [
  txt("MODE: seed\n先读一遍这个模块的导出结构，看看有没有循环依赖，再给出整理方案。"),
  txt("OK"),
];

// ---------------------------------------------------------------- 正常路径
{
  const p = await boot({ responses: OK_SCRIPT });
  const res = await rawRequest(p.port, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "帮我看看这段代码", sessionId: "s-1", runId: "wire-run" }),
  });
  const parsed = JSON.parse(res.body);
  check("正常路径：200 + ok + 真实档位", () => {
    assert.equal(res.status, 200);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.mode, "seed");
  });
  const record = p.records().find((item) => item.event === "optimize") ?? {};
  check("日志：codeVersion 与 runId 落盘", () => {
    assert.equal(record.runId, "wire-run");
    assert.equal(typeof record.codeVersion, "string");
    assert.ok(record.codeVersion.length > 0);
  });
  check("日志：mode 是管线真实档位", () => assert.equal(record.mode, "seed"));

  // 只断言"某次成功 = seed"关不住"永远写 seed"这种退化（实测：把日志里的 mode 硬编码成
  // "seed"，上面那条照样通过）。补一条根本走不到选档的失败路径——它的 mode 必须是 null。
  const greeting = await rawRequest(p.port, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hi" }),
  });
  check("日志：未走到选档的失败路径 mode 为 null（关住「永远记 seed」的退化）", () => {
    assert.equal(JSON.parse(greeting.body).code, "nothing_to_optimize");
    const failed = p
      .records()
      .filter((item) => item.event === "optimize" && item.code === "nothing_to_optimize")
      .pop();
    assert.equal(failed.mode, null);
  });

  const feedback = await rawRequest(p.port, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ feedback: { kind: "applied", tier: "full" }, runId: "wire-run" }),
  });
  check("反馈通道：零模型调用且可 join", () => {
    assert.equal(feedback.status, 200);
    assert.equal(p.llm.seen.length, 2, "反馈不得触发模型调用");
    const fb = p.records().find((item) => item.event === "feedback") ?? {};
    assert.equal(fb.runId, "wire-run");
  });
  await p.close();
}

// ---------------------------------------------------------------- 守卫路径
{
  const p = await boot({ responses: OK_SCRIPT });
  const payload = JSON.stringify({ text: "帮我看看这段代码" });

  const get = await rawRequest(p.port, { method: "GET" });
  check("方法校验：GET → 405", () => assert.equal(get.status, 405));
  const foreignHost = await rawRequest(p.port, { headers: { "content-type": "application/json", host: "evil.example" }, body: payload });
  check("Host 非回环：403", () => assert.equal(foreignHost.status, 403));

  const prefixHost = await rawRequest(p.port, {
    headers: { "content-type": "application/json", host: "127.0.0.1.evil.example" },
    body: payload,
  });
  check("Host 前缀伪装（127.0.0.1.evil.example）：403", () => assert.equal(prefixHost.status, 403));

  const crossSite = await rawRequest(p.port, {
    headers: { "content-type": "text/plain", origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    body: payload,
  });
  check("跨站 Origin（免预检简单请求）：403", () => {
    assert.equal(crossSite.status, 403);
    assert.equal(JSON.parse(crossSite.body).code, "forbidden");
  });

  const opaque = await rawRequest(p.port, { headers: { "content-type": "application/json", origin: "null" }, body: payload });
  check("来源不可判定（Origin: null）：403", () => assert.equal(opaque.status, 403));

  const sameOrigin = await rawRequest(p.port, {
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${p.port}` },
    body: payload,
  });
  check("同源页面：仍然放行", () => assert.equal(sameOrigin.status, 200));

  const noOrigin = await rawRequest(p.port, { headers: { "content-type": "application/json" }, body: payload });
  check("无 Origin（脚本/curl）：仍然放行", () => assert.equal(noOrigin.status, 200));

  const loopbackRange = await rawRequest(p.port, {
    headers: { "content-type": "application/json", host: `127.0.0.53:${p.port}` },
    body: payload,
  });
  check("127.0.0.0/8 内的回环 Host：仍然放行", () => assert.equal(loopbackRange.status, 200));

  // 同一台机器的不同拼法必须给出同一个答案。peer 一处解包过 ::ffff:、Host/Origin 两处
  // 没有，曾造成"旧代码放行、新代码 403"的误拒（对抗性复核实测）。
  const spellings = [
    ["Host [::ffff:127.0.0.1]", { host: `[::ffff:127.0.0.1]:${p.port}` }],
    ["Host localhost.（尾点）", { host: `localhost.:${p.port}` }],
    ["Host LOCALHOST（大小写）", { host: `LOCALHOST:${p.port}` }],
    ["Origin http://[::ffff:127.0.0.1]", { origin: `http://[::ffff:127.0.0.1]:${p.port}` }],
    ["Origin http://localhost.（尾点）", { origin: `http://localhost.:${p.port}` }],
  ];
  for (const [label, headers] of spellings) {
    const res = await rawRequest(p.port, {
      headers: { "content-type": "application/json", ...headers },
      body: payload,
    });
    check(`${label}：是同一台机器，必须放行`, () => assert.equal(res.status, 200));
  }

  // 越界段值只是"看着像地址"
  const outOfRange = await rawRequest(p.port, {
    headers: { "content-type": "application/json", host: `127.0.0.256:${p.port}` },
    body: payload,
  });
  check("Host 127.0.0.256（越界段值）：403", () => assert.equal(outOfRange.status, 403));
  await p.close();
}

// ---------------------------------------------------------------- 请求体溢出
{
  const p = await boot({ responses: OK_SCRIPT });
  const big = JSON.stringify({ text: "x".repeat(80000) });
  const res = await rawRequest(p.port, {
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(big) },
    body: big,
  });
  check("超限请求体：可读的 413，而不是连接被重置", () => {
    assert.equal(res.socketError, undefined, `客户端拿到的是 ${res.socketError}，说明 socket 先于响应被拆掉`);
    assert.equal(res.status, 413);
    assert.equal(JSON.parse(res.body).code, "payload_too_large");
  });
  check("超限请求体：不花任何模型调用", () => assert.equal(p.llm.seen.length, 0));
  await p.close();
}

// ---------------------------------------------------------------- 预测通道（0.9.6）
{
  const surface = {
    events: [
      { type: "user/message", data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "重构登录流程" }] } },
      { type: "tool/result", data: {} },
      // 真实形状：助手消息嵌在 data.message 下（0.9.6 之前的提取按平铺读，永远读不到，
      // 于是这条通道每次都以 cannot_predict 收场——正是本次线上排查的病灶）。
      { type: "assistant/message", data: { turn: 1, step: 2, message: { role: "assistant", content: [{ type: "reasoning", text: "内部推理" }, { type: "text", text: "已改完。要不要我继续把测试补上？" }] } } },
    ],
  };
  const p = await boot({ responses: [txt("继续，把测试补上。")], sessionQuery: { readSurface: async () => surface } });
  const res = await rawRequest(p.port, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "predict", sessionId: "s-1", runId: "wire-predict" }),
  });
  const parsed = JSON.parse(res.body);
  check("预测通道：200 + 一句话 + 只花一次调用", () => {
    assert.equal(res.status, 200);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.kind, "continue");
    assert.equal(parsed.text, "继续，把测试补上。");
    assert.equal(p.llm.seen.length, 1, "预测只该花一次模型调用");
  });
  check("预测通道：predict 日志可归因（kind / runId / 工具活动）", () => {
    const record = p.records().find((item) => item.event === "predict") ?? {};
    assert.equal(record.code, "ok");
    assert.equal(record.kind, "continue");
    assert.equal(record.runId, "wire-predict");
    assert.equal(record.sawToolActivity, true);
    assert.equal(record.mode, "predict");
  });

  // 没有锚点的会话：一次调用都不该花（"拒绝硬猜"是这条通道的不变量）
  const plain = {
    events: [
      { type: "user/message", data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "你好" }] } },
      { type: "assistant/message", data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "这个过程涉及三个步骤。" }] } } },
    ],
  };
  const quiet = await boot({ responses: [txt("不该被调用")], sessionQuery: { readSurface: async () => plain } });
  const refused = await rawRequest(quiet.port, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "predict", sessionId: "s-2" }),
  });
  check("预测通道：无锚点 → cannot_predict 且零模型调用", () => {
    assert.equal(refused.status, 200);
    assert.equal(JSON.parse(refused.body).code, "cannot_predict");
    assert.equal(quiet.llm.seen.length, 0, "推不出来时不得花任何模型调用");
  });
  await p.close();
  await quiet.close();
}

// ---------------------------------------------------------------- 汇总
if (results.length !== DECLARED_CHECKS) {
  console.error(
    `[wire] 实际执行 ${results.length} 项，DECLARED_CHECKS 声明 ${DECLARED_CHECKS} 项——` +
      "加了检查没改数字，文档守卫会读到错的数",
  );
  process.exit(1);
}
const failed = results.filter((item) => !item.ok);
for (const item of results) {
  if (!item.ok) console.error(`  ✖ ${item.name}\n      ${item.detail}`);
}
if (failed.length > 0) {
  console.error(`[wire] ${failed.length}/${results.length} 项失败：连接层行为与声明不一致`);
  process.exit(1);
}
console.log(`[wire] ${results.length} 项真实 socket 检查通过（回环守卫 / 请求体溢出 / 日志字段）`);
