import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { analyzeInput, classify, isContentFree } from "../src/classify.js";
import { buildMinimalPrompt, PROMPT_VERSION } from "../src/prompts.js";
import { optimizeOnce, optimizeStream } from "../src/optimize.js";

const ROUTE = { provider: "p", model: "m" };

function fakeLlm(output, options = {}) {
  const seen = [];
  return {
    seen,
    async *stream(request) {
      seen.push(request);
      if (options.hang === true) { await new Promise(() => {}); return; }
      if (options.error === true) {
        yield { type: "finish", reason: { kind: "error", failure: { code: "x", message: "boom" } } };
        return;
      }
      yield { type: "text-delta", text: output };
      yield { type: "finish", reason: { kind: options.finish ?? "stop" } };
    },
  };
}

test("内容下限：招呼/确认/空不调用", () => {
  assert.equal(isContentFree("好了"), true);
  assert.equal(isContentFree("hi"), true);
  assert.equal(isContentFree("登录"), false);
});

test("分析：只有 passthrough 与 optimize 两条路", () => {
  assert.equal(analyzeInput("").route, "passthrough");
  assert.equal(analyzeInput("好了").route, "passthrough");
  assert.equal(analyzeInput("现在应该已经更新了，你看看。").route, "optimize");
  assert.equal(classify("帮我做个登录页").route, "optimize");
});

test("prompt：只改写，不回答、不执行、不要 maxTokens", async () => {
  const prompt = buildMinimalPrompt("现在应该已经更新了，你看看。");
  assert.match(prompt.system, /Do not answer/i);
  assert.match(prompt.system, /Do not execute/i);
  assert.doesNotMatch(prompt.system, /maxTokens/i);
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(PROMPT_VERSION, pkg.version);
});

test("优化：内容恰好一次调用，流式 final", async () => {
  const llm = fakeLlm("确认插件是否已经更新，并检查更新后的实际表现是否正常。");
  const events = [];
  for await (const event of optimizeStream({ text: "现在应该已经更新了，你看看。", llm, route: ROUTE, requestId: "r1" })) events.push(event);
  assert.equal(llm.seen.length, 1);
  assert.equal(llm.seen[0].maxTokens, undefined);
  assert.equal(events[0].type, "meta");
  assert.equal(events[0].route, "optimize");
  assert.ok(events.some((event) => event.type === "delta"));
  const final = events.at(-1);
  assert.equal(final.ok, true);
  assert.equal(final.calls, 1);
  assert.equal(final.text, "确认插件是否已经更新，并检查更新后的实际表现是否正常。");
  assert.equal(final.shape, undefined);
  assert.equal(final.repairAttempted, undefined);
});

test("优化：passthrough 零调用", async () => {
  const llm = fakeLlm("不应调用");
  const final = await optimizeOnce({ text: "好了", llm, route: ROUTE, requestId: "r2" });
  assert.equal(llm.seen.length, 0);
  assert.equal(final.code, "nothing_to_optimize");
  assert.equal(final.calls, 0);
});

test("优化：锚点丢失回原文，不修复", async () => {
  const llm = fakeLlm("删除 src/b.js 里的 export，跑测试。");
  const final = await optimizeOnce({ text: "删除 src/a.js 里的 export，跑测试。", llm, route: ROUTE, requestId: "r3" });
  assert.equal(llm.seen.length, 1);
  assert.equal(final.ok, false);
  assert.equal(final.code, "validation_failed");
  assert.equal(final.reason, "anchor_lost");
  assert.equal(final.text, "删除 src/a.js 里的 export，跑测试。");
});

test("优化：模型错误回原文", async () => {
  const llm = fakeLlm("", { error: true });
  const final = await optimizeOnce({ text: "帮我做个登录页", llm, route: ROUTE, requestId: "r4" });
  assert.equal(final.ok, false);
  assert.equal(final.code, "llm_error");
  assert.equal(final.text, "帮我做个登录页");
});

test("优化：空结果回原文", async () => {
  const llm = fakeLlm("");
  const final = await optimizeOnce({ text: "帮我做个登录页", llm, route: ROUTE, requestId: "r5" });
  assert.equal(final.ok, false);
  assert.equal(final.code, "empty_result");
  assert.equal(final.text, "帮我做个登录页");
});

test("host bundle：自动重启看门狗仍在", async () => {
  const source = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");
  assert.match(source, /startSelfReloadWatch/);
  assert.match(source, /fiber\.restart/);
});

test("final 不再携带旧语义字段", async () => {
  const llm = fakeLlm("确认插件是否已经更新，并检查更新后的实际表现是否正常。");
  const final = await optimizeOnce({ text: "现在应该已经更新了，你看看。", llm, route: ROUTE, requestId: "r6" });
  for (const key of ["shape", "ambiguity", "targetRatio", "clarity", "repairAttempted", "truncated"]) {
    assert.equal(final[key], undefined, key);
  }
});
