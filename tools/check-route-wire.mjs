#!/usr/bin/env node
/**
 * 0.15.0 真实 socket 检查：把新路由挂到真的 http.createServer 上，
 * 用原始 HTTP 驱动 JSON/NDJSON、回环守卫、请求体与超时。
 *
 * 用法：node tools/check-route-wire.mjs
 */

import assert from "node:assert/strict";
import http from "node:http";

import * as host from "../lib/index.js";

const DECLARED_CHECKS = 13;
let passed = 0;

function check(name, condition, detail = "") {
  if (!condition) {
    console.error("[wire] FAIL " + name + (detail ? " — " + detail : ""));
    process.exit(1);
  }
  passed += 1;
  console.log("[wire] ok   " + name);
}

function fakeLlm(output, options = {}) {
  const seen = [];
  return {
    seen,
    async *stream() {
      seen.push(1);
      if (options.hang === true) { await new Promise(() => {}); return; }
      if (options.empty === true) { yield { type: "finish", reason: { kind: "stop" } }; return; }
      for (const piece of String(output).match(/[\s\S]{1,20}/g) ?? []) yield { type: "text-delta", text: piece };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
}

function makeCtx(llm) {
  let registered;
  const ctx = {
    webServer: { register(route) { registered = route; return () => {}; } },
    effect(fn) { fn(); },
    get(name) {
      if (name === "llm") return llm;
      if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "p", model: "m" }) };
      return undefined;
    },
  };
  host.apply(ctx, { samples: false, templates: false, requestTimeoutMs: 80 });
  return registered;
}

function raw(port, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const payload = opts.body ?? "";
    const req = http.request({
      host: "127.0.0.1", port, path, method: opts.method ?? "POST",
      headers: {
        "content-type": opts.contentType ?? "application/json",
        "content-length": Buffer.byteLength(payload),
        ...(opts.headers ?? {}),
      },
    }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

const INPUT = "帮我做个登录页";
const OUTPUT = "帮我做一个登录页面：支持账号密码与验证码登录；失败时提示原因；包含记住我；适配移动端。";
const llm = fakeLlm(OUTPUT);
const route = makeCtx(llm);
const server = http.createServer((req, res) => route.handler(req, res));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const path = route.path;

try {
  const json = await raw(port, path, { body: JSON.stringify({ text: INPUT }) });
  check("JSON 优化成功", json.status === 200 && JSON.parse(json.text).ok === true, json.text);

  const stream = await raw(port, path, { body: JSON.stringify({ text: INPUT, stream: true }) });
  const events = stream.text.trim().split(String.fromCharCode(10)).map((line) => JSON.parse(line));
  check("NDJSON 流式 meta/delta/final", events[0]?.type === "meta" && events.some((e) => e.type === "delta") && events.at(-1)?.type === "final", stream.text);
  check("NDJSON 只有一条 final", events.filter((e) => e.type === "final").length === 1, String(events.filter((e) => e.type === "final").length));

  llm.seen.length = 0;
  const ack = await raw(port, path, { body: JSON.stringify({ text: "好了", stream: true }) });
  const ackEvents = ack.text.trim().split(String.fromCharCode(10)).map((line) => JSON.parse(line));
  check("passthrough 0 次模型调用", llm.seen.length === 0 && ackEvents.at(-1)?.code === "nothing_to_optimize", ack.text);

  const foreign = await raw(port, path, { headers: { host: "evil.example" }, body: JSON.stringify({ text: INPUT }) });
  check("跨站 Host 403", foreign.status === 403, String(foreign.status));

  const get = await raw(port, path, { method: "GET", body: "" });
  check("非 POST 405", get.status === 405, String(get.status));

  const plain = await raw(port, path, { contentType: "text/plain", body: JSON.stringify({ text: INPUT }) });
  check("非 JSON 415", plain.status === 415, String(plain.status));

  const big = await raw(port, path, { body: JSON.stringify({ text: "x".repeat(70000) }) });
  check("超大 body 413", big.status === 413, String(big.status));

  const bad = await raw(port, path, { body: "{" });
  check("坏 JSON 400", bad.status === 400, String(bad.status));

  const debug = await raw(port, path + "?debug=1", { body: JSON.stringify({ text: INPUT }) });
  const debugFinal = JSON.parse(debug.text);
  check("?debug=1 带版本与调用数", debugFinal._debug?.codeVersion === host.codeVersion() && debugFinal._debug?.calls === 1, debug.text);

  const feedback = await raw(port, path, { body: JSON.stringify({ feedback: { kind: "applied" }, runId: "r-1" }) });
  check("feedback 200", feedback.status === 200 && JSON.parse(feedback.text).ok === true, feedback.text);

  const empty = await raw(port, path, { body: JSON.stringify({ text: "" }) });
  check("空输入结构化拒绝", empty.status === 200 && JSON.parse(empty.text).code === "empty_input", empty.text);

  const hang = fakeLlm("", { hang: true });
  const hangRoute = makeCtx(hang);
  const hangServer = http.createServer((req, res) => hangRoute.handler(req, res));
  await new Promise((resolve) => hangServer.listen(0, "127.0.0.1", resolve));
  const started = Date.now();
  const timeout = await raw(hangServer.address().port, hangRoute.path, { body: JSON.stringify({ text: INPUT }) });
  const timeoutFinal = JSON.parse(timeout.text);
  check("provider 挂起 80ms 内超时", timeoutFinal.code === "request_timeout" && Date.now() - started < 2000, timeout.text);
  hangServer.close();
} finally {
  server.close();
}

assert.equal(passed, DECLARED_CHECKS, "实际检查数必须与 DECLARED_CHECKS 一致");
console.log("[wire] " + passed + " 项真实 socket 检查通过");
