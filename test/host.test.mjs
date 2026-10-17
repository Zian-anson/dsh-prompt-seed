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

async function makeServer(llm) {
  let registered;
  const ctx = {
    webServer: { register(route) { registered = route; return () => {}; } },
    effect(fn) { fn(); },
    get(name) {
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
