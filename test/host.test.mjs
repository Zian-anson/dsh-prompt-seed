import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { apply } from "../src/host-plugin.js";
import { createJobStore } from "../src/jobs.js";

const ROUTE = { provider: "p", model: "m" };

function fakeLlm(output) {
  const seen = [];
  return {
    seen,
    async *stream(request) {
      seen.push(request);
      if (typeof request.sessionId !== "string" || request.sessionId === "") {
        yield { type: "finish", reason: { kind: "error", failure: { code: "MissingSessionID", message: "missing" } } };
        return;
      }
      yield { type: "text-delta", text: output };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
}

async function makeServer(llm, sessionQuery) {
  let registered;
  const ctx = {
    webServer: { register(route) { registered = route; return () => {}; } },
    effect(fn) { fn(); },
    get(name) {
      if (name === "sessionQuery" && sessionQuery) return sessionQuery;
      if (name === "llm") return llm;
      if (name === "agentDefaultModel") return { currentSelection: () => ROUTE };
      return undefined;
    },
  };
  apply(ctx, { samples: false, templates: false, requestTimeoutMs: 1000 });
  const server = http.createServer((req, res) => registered.handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, path: registered.path };
}

function post(port, path, body, accept = "application/json") {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", accept, "content-length": Buffer.byteLength(data) } }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

test("host: JSON optimize and sessionId binding", async () => {
  const llm = fakeLlm("确认插件是否已经更新，并检查更新后的实际表现是否正常。");
  const { server, port, path } = await makeServer(llm);
  try {
    const res = await post(port, path, { text: "现在应该已经更新了，你看看。", sessionId: "s1" });
    const final = JSON.parse(res.text);
    assert.equal(final.ok, true);
    assert.equal(final.calls, 1);
    assert.equal(llm.seen.length, 1);
    assert.equal(llm.seen[0].sessionId, "s1");
    assert.equal(final.shape, undefined);
  } finally { server.close(); }
});

test("host: NDJSON meta/delta/final", async () => {
  const llm = fakeLlm("确认插件是否已经更新，并检查更新后的实际表现是否正常。");
  const { server, port, path } = await makeServer(llm);
  try {
    const res = await post(port, path, { text: "现在应该已经更新了，你看看。", sessionId: "s1", stream: true }, "application/x-ndjson");
    const lines = res.text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(lines[0].type, "meta");
    assert.ok(lines.some((line) => line.type === "delta"));
    assert.equal(lines.at(-1).type, "final");
    assert.equal(lines.at(-1).ok, true);
  } finally { server.close(); }
});

test("jobs: session key switch does not leak or cancel", async () => {
  const store = createJobStore({ timeoutMs: 2000, ttlMs: 60000 });
  const created = store.create({
    sessionId: "s1",
    inputText: "hi",
    run: async function* () {
      yield { type: "text-delta", text: "ok" };
      yield { type: "final", ok: true, text: "ok", changed: true, calls: 1 };
    },
  });
  assert.equal(created.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.status({ sessionId: "s2" }), null);
  const job = store.status({ sessionId: "s1" });
  assert.equal(job.status, "done");
  assert.equal(job.result.text, "ok");
});

test("jobs: explicit cancel is the only cancel", async () => {
  const store = createJobStore({ timeoutMs: 5000, ttlMs: 60000 });
  const created = store.create({
    sessionId: "s1",
    inputText: "hi",
    run: async function* () {
      await new Promise(() => {});
    },
  });
  assert.equal(created.ok, true);
  assert.equal(store.cancel(created.job.id).status, "cancelled");
  assert.equal(store.status({ sessionId: "s1" }).status, "cancelled");
});
test("host: duplicate click while running returns job_running, not an error", async () => {
  function slowLlm() {
    const seen = [];
    return {
      seen,
      async *stream() {
        seen.push(1);
        await new Promise((resolve) => setTimeout(resolve, 80));
        yield { type: "text-delta", text: "确认更新并检查表现。" };
        yield { type: "finish", reason: { kind: "stop" } };
      },
    };
  }
  const llm = slowLlm();
  const { server, port, path } = await makeServer(llm);
  try {
    const body = { text: "现在应该已经更新了，你看看。", sessionId: "s-dup", stream: false };
    const [first, second] = await Promise.all([post(port, path, body), post(port, path, body)]);
    const firstFinal = JSON.parse(first.text);
    const secondFinal = JSON.parse(second.text);
    assert.equal(firstFinal.ok, true);
    assert.equal(secondFinal.code, "job_running");
    assert.equal(secondFinal.job.status, "running");
  } finally { server.close(); }
});

test("host: empty-input prediction uses one call and fills draft text", async () => {
  let registered;
  const sessionQuery = {
    async readSurface() {
      return { events: [
        { type: "user/message", data: { role: "user", content: "登录页校验做完了吗？" } },
        { type: "assistant/message", data: { message: { role: "assistant", content: "校验已加，还差错误提示。要不要继续？" } } },
      ] };
    },
  };
  const llm = fakeLlm("好，继续补齐错误提示。");
  const ctx = {
    webServer: { register(route) { registered = route; return () => {}; } },
    effect(fn) { fn(); },
    get(name) {
      if (name === "llm") return llm;
      if (name === "sessionQuery") return sessionQuery;
      if (name === "agentDefaultModel") return { currentSelection: () => ROUTE };
      return undefined;
    },
  };
  apply(ctx, { samples: false, templates: false, requestTimeoutMs: 1000 });
  const server = http.createServer((req, res) => registered.handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await post(server.address().port, registered.path, { action: "predict", sessionId: "s-predict" });
    const data = JSON.parse(res.text);
    assert.equal(data.ok, true);
    assert.equal(data.text, "好，继续补齐错误提示。");
    assert.equal(llm.seen.length, 1);
    assert.equal(llm.seen[0].sessionId, "s-predict");
  } finally { server.close(); }
});

test("host: explicit cancel leaves a terminal job and status survives", async () => {
  function hangingLlm() {
    return {
      async *stream(request) {
        if (typeof request.sessionId !== "string") {
          yield { type: "finish", reason: { kind: "error", failure: { code: "MissingSessionID" } } };
          return;
        }
        await new Promise(() => {});
      },
    };
  }
  let registered;
  const llm = hangingLlm();
  const ctx = {
    webServer: { register(route) { registered = route; return () => {}; } },
    effect(fn) { fn(); },
    get(name) {
      if (name === "llm") return llm;
      if (name === "agentDefaultModel") return { currentSelection: () => ROUTE };
      return undefined;
    },
  };
  apply(ctx, { samples: false, templates: false, requestTimeoutMs: 5000 });
  const server = http.createServer((req, res) => registered.handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const start = post(port, registered.path, { text: "帮我做个登录页", sessionId: "s-cancel", stream: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const statusBefore = JSON.parse((await post(port, registered.path, { action: "status", sessionId: "s-cancel" })).text);
    assert.equal(statusBefore.ok, true);
    assert.equal(statusBefore.job.status, "running");
    const cancel = JSON.parse((await post(port, registered.path, { action: "cancel", jobId: statusBefore.job.id })).text);
    assert.equal(cancel.ok, true);
    assert.equal(cancel.job.status, "cancelled");
    const statusAfter = JSON.parse((await post(port, registered.path, { action: "status", sessionId: "s-cancel" })).text);
    assert.equal(statusAfter.job.status, "cancelled");
    await start;
  } finally { server.close(); }
});


test('host: streaming prediction participates in kind-scoped status without changing legacy JSON', async () => {
  const context = { readSurface: async () => ({ events: [
    { type: 'user/message', seq: 7, data: { content: '先讨论原因', source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 8, data: { message: { role: 'assistant', content: '可能是两个原因。' } } },
  ] }) };
  const llm = fakeLlm('分别解释一下这两个原因。'); const { server, port, path } = await makeServer(llm, context);
  try {
    const stream = await post(port, path, { action: 'predict', stream: true, sessionId: 's' });
    const events = stream.text.trim().split('\n').map(JSON.parse);
    assert.equal(events[0].kind, 'predict'); assert.ok(events.some((e) => e.type === 'delta')); assert.equal(events.at(-1).calls, 1);
    const normal = JSON.parse((await post(port, path, { action: 'status', sessionId: 's' })).text);
    assert.equal(normal.job, null); assert.equal(normal.lastUserMessageId, 's:7'); assert.equal(normal.hasAssistant, true);
    const prediction = JSON.parse((await post(port, path, { action: 'status', kind: 'predict', sessionId: 's' })).text);
    assert.equal(prediction.job.kind, 'predict');
    const wrong = JSON.parse((await post(port, path, { action: 'consume', kind: 'optimize', jobId: prediction.job.id })).text);
    assert.equal(wrong.ok, false);
    const legacy = JSON.parse((await post(port, path, { action: 'predict', sessionId: 's' })).text);
    assert.deepEqual(legacy, { ok: true, text: '分别解释一下这两个原因。' });
  } finally { server.close(); }
});

test('host: client stream disconnect leaves prediction running until explicit cancellation', async () => {
  let seenSignal;
  const llm = { async *stream(request) { seenSignal = request.signal; yield { type: 'text-delta', text: '正在想' }; await new Promise(() => {}); } };
  const context = { readSurface: async () => ({ events: [{ type: 'assistant/message', data: { message: { role: 'assistant', content: '要继续讨论吗？' } } }] }) };
  const { server, port, path } = await makeServer(llm, context);
  try {
    await new Promise((resolve, reject) => {
      const data = JSON.stringify({ action: 'predict', stream: true, sessionId: 's' });
      const request = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
        response.once('data', () => { response.destroy(); resolve(); });
      }); request.on('error', reject); request.end(data);
    });
    await new Promise((r) => setTimeout(r, 10));
    const state = JSON.parse((await post(port, path, { action: 'status', kind: 'predict', sessionId: 's' })).text);
    assert.equal(state.job.status, 'running'); assert.equal(seenSignal.aborted, false);
    await post(port, path, { action: 'cancel', kind: 'predict', jobId: state.job.id });
    assert.equal(seenSignal.aborted, true);
  } finally { server.close(); }
});
