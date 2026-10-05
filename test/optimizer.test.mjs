/**
 * prompt-seed 单元测试
 * 运行：npm test
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ERROR_CODES,
  assessInflation,
  collectStream,
  createOptimizerMessage,
  isSubstantivelyUnchanged,
  looksOpenEnded,
  isContentFree,
  isPreciseInstruction,
  preservesAnchors,
  looksSeedish,
  optimizePromptText,
  parseAuditVerdict,
  resolveRoute,
} from "../src/host-core.js";
import {
  AUDIT_SYSTEM_TEMPLATE,
  DEPTH_DEEP_SUFFIX,
  DEPTH_LIGHT_SUFFIX,
  DEPTH_STANDARD_SUFFIX,
  MAX_TEXT_LENGTH,
  PRECISE_SUFFIX,
  REPAIR_SUFFIX,
  SYSTEM_SUFFIX,
  SYSTEM_TEMPLATE,
  USER_TEMPLATE,
  buildSystemPrompt,
  buildSystemPromptFor,
  depthSuffix,
  detectScript,
  normalizeResult,
  renderAuditUserPrompt,
  renderContextBlock,
  renderUserPrompt,
  setTemplateOverrides,
  stripCodeFence,
  stripLeadingLabel,
  stripWrappingQuotes,
  validateInput,
} from "../src/prompt-templates.js";
import { extractRecentContext, needsContext } from "../src/session-context.js";
import { appendSample, resolveSamplePath } from "../src/sample-log.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 构造一个按脚本吐 chunk 的假 llm 服务。 */
function fakeLlm(chunks) {
  const seen = [];
  return {
    seen,
    stream(options) {
      seen.push(options);
      return (async function* generate() {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

/** 把一段文本包装成一次成功的模型响应。 */
function textChunks(text) {
  return [{ type: "text-delta", index: 0, text }, { type: "finish", reason: { kind: "stop" } }];
}

/**
 * 按调用次序回放不同响应的假 llm：responses[i] 是第 i+1 次调用的 chunk 序列，
 * 用尽后重复最后一组。保真闸门会连续发起改写/审判/重跑多次调用，需要这种脚本。
 */
function scriptedLlm(responses) {
  const seen = [];
  return {
    seen,
    stream(options) {
      seen.push(options);
      const chunks = responses[Math.min(seen.length - 1, responses.length - 1)];
      return (async function* generate() {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

const ROUTE = { provider: "test", model: "test-model" };

// --------------------------------------------------------------------------
// prompt-templates
// --------------------------------------------------------------------------

test("stripWrappingQuotes 去掉成对的首尾引号", () => {
  assert.equal(stripWrappingQuotes('"hello world"'), "hello world");
  assert.equal(stripWrappingQuotes("“你好”"), "你好");
  assert.equal(stripWrappingQuotes("'quoted'"), "quoted");
  assert.equal(stripWrappingQuotes("「引用」"), "引用");
});

test("stripWrappingQuotes 不动不成对或内部引号", () => {
  assert.equal(stripWrappingQuotes('he said "hi" loudly'), 'he said "hi" loudly');
  assert.equal(stripWrappingQuotes('"unbalanced'), '"unbalanced');
  assert.equal(stripWrappingQuotes(""), "");
});

test("stripCodeFence 去掉 markdown 围栏", () => {
  assert.equal(stripCodeFence("```\ninner\n```"), "inner");
  assert.equal(stripCodeFence("```text\ninner\n```"), "inner");
  assert.equal(stripCodeFence("no fence"), "no fence");
});

test("stripLeadingLabel 去掉模型自加的前缀", () => {
  assert.equal(stripLeadingLabel("Enhanced prompt: do X"), "do X");
  assert.equal(stripLeadingLabel("优化后的提示词：做 X"), "做 X");
  assert.equal(stripLeadingLabel("普通文本"), "普通文本");
});

test("normalizeResult 组合清洗：围栏 + 引号 + 标签", () => {
  const raw = '```\nEnhanced prompt: "帮我写一个单元测试"\n```';
  assert.equal(normalizeResult(raw), "帮我写一个单元测试");
});

test("validateInput 覆盖空、超长、正常", () => {
  assert.equal(validateInput(""), "empty_input");
  assert.equal(validateInput("   "), "empty_input");
  assert.equal(validateInput(undefined), "empty_input");
  assert.equal(validateInput(42), "empty_input");
  assert.equal(validateInput("x".repeat(MAX_TEXT_LENGTH + 1)), "input_too_long");
  assert.equal(validateInput("正常输入"), null);
});

test("detectScript 区分中英混排", () => {
  assert.equal(detectScript("帮我看看这段代码"), "cjk");
  assert.equal(detectScript("explain this code"), "latin");
  assert.equal(detectScript("这段代码有 bug，can you help"), "mixed");
  assert.equal(detectScript("   "), "unknown");
  assert.equal(detectScript("12345 !!!"), "unknown");
});

test("renderUserPrompt 正确插值且保留模板主体", () => {
  const rendered = renderUserPrompt("帮我看看这个登录接口有没有问题");
  assert.ok(rendered.includes("帮我看看这个登录接口有没有问题"));
  assert.ok(rendered.includes("Language. This outranks everything else on this page."));
  assert.ok(!rendered.includes("{input}"));
  // 无上下文时不出现 CONTEXT 段
  assert.ok(!rendered.includes("CONTEXT"));
});

test("renderContextBlock：上下文块渲染与防御", () => {
  const context = [
    { role: "user", text: "登录接口有时候 500" },
    { role: "assistant", text: "看起来是 token 校验的边界情况" },
  ];
  const withContext = renderUserPrompt("帮我修一下这个", context);
  assert.ok(withContext.includes("CONTEXT (recent conversation; use ONLY to resolve what the request refers to):"));
  assert.ok(withContext.includes("[user] 登录接口有时候 500"));
  assert.ok(withContext.includes("[assistant] 看起来是 token 校验的边界情况"));
  assert.ok(withContext.includes("帮我修一下这个"));
  // CONTEXT 在 REQUEST 之前（先指代来源，后请求本体）
  assert.ok(withContext.indexOf("CONTEXT") < withContext.indexOf("REQUEST:"));
  // 审判 prompt 同样携带上下文（蕴含判定需要知情指代来源）
  assert.ok(renderAuditUserPrompt("a", "b", context).includes("[user] 登录接口有时候 500"));
  // 非法形状静默降级为空
  assert.equal(renderContextBlock(undefined), "");
  assert.equal(renderContextBlock([]), "");
  assert.equal(renderContextBlock([{ role: "user", text: "   " }]), "");
});

test("两条模板各自独立声明语言一致性（设计原则 ①）", () => {
  // 中英混排产品里模型极易把中文输入改写成英文；单处声明压不住，必须各写一次。
  assert.ok(SYSTEM_TEMPLATE.includes("This rule outranks every other instruction"));
  assert.ok(USER_TEMPLATE.includes("This outranks everything else on this page"));
  assert.ok(USER_TEMPLATE.includes("Never name the language"));
});

test("混排语言规则不自相矛盾", () => {
  // 回归守卫：早期版本写着"不要翻译任何部分"，但模型对混排输入会把连接语句
  // 归并到主导语言——这是更好的行为，矛盾在规则不在模型。规则已改为
  // "保留术语 + 连接语句用主导语言"，此处锁死，避免回退。
  assert.ok(!USER_TEMPLATE.includes("Do not translate any part of it"));
  assert.ok(!SYSTEM_TEMPLATE.includes("Do not flatten it into one language"));
  assert.ok(USER_TEMPLATE.includes("do not move it into a different single language"));
  assert.ok(SYSTEM_TEMPLATE.includes("do not move the request into a different single language"));
  // 混排示例必须保留用户用的术语
  assert.ok(USER_TEMPLATE.includes("这个函数有 bug"));
});

test("模板禁止一切 meta 内容与作答（设计原则 ②③）", () => {
  assert.ok(SYSTEM_TEMPLATE.includes("You never carry out the request itself"));
  assert.ok(SYSTEM_TEMPLATE.includes("Answer the request, even partially"));
  assert.ok(USER_TEMPLATE.includes("Contain answers. When REQUEST asks a question, return a better question"));
  assert.ok(USER_TEMPLATE.includes("no code fence, no surrounding quotation marks"));
  assert.ok(SYSTEM_SUFFIX.includes("never an answer"));
});

test("补全契约：补全中间细节是产品本体，曲解才是红线（设计原则 ④）", () => {
  // v0.6 核心界线
  assert.ok(SYSTEM_TEMPLATE.includes("ELABORATE, NEVER DISTORT"));
  assert.ok(SYSTEM_TEMPLATE.includes("this is the product, not a risk"));
  assert.ok(SYSTEM_TEMPLATE.includes("KEEP EXACTLY AS THEY MEANT IT"));
  assert.ok(SYSTEM_TEMPLATE.includes("NEVER (each of these distorts the request)"));
  // 补全深度跟随"用户没说多少"
  assert.ok(SYSTEM_TEMPLATE.includes("Depth scales with what was left unsaid"));
  assert.ok(SYSTEM_TEMPLATE.includes("A bare seed grows a lot"));
  // 两侧旧病都不得回退
  assert.ok(!SYSTEM_TEMPLATE.includes("ENTAILMENT vs INVENTION"), "v0.3 蕴含契约已被补全契约取代");
  assert.ok(
    !SYSTEM_TEMPLATE.includes("Do not introduce a language, framework, library, or tool the user did not mention"),
    "禁止新增技术栈的旧红线已废除：为开放选择给具体默认值属于补全",
  );
  assert.ok(!SYSTEM_TEMPLATE.includes("IF IN DOUBT, CHANGE LESS"), "无条件少改指令已废除");
  assert.ok(!SYSTEM_TEMPLATE.includes("roughly 800 characters"), "长度配额已废除");
});

test("用户已做的选择不得被覆盖（新红线）", () => {
  assert.ok(SYSTEM_TEMPLATE.includes("Never override, replace, or drop one"));
  assert.ok(USER_TEMPLATE.includes("Contradict a choice the user made"));
  assert.ok(AUDIT_SYSTEM_TEMPLATE.includes("CONTRADICTED"));
});

test("语气是契约的一部分（新红线）", () => {
  assert.ok(SYSTEM_TEMPLATE.includes("Their voice. A casual message stays casual"));
  assert.ok(SYSTEM_SUFFIX.includes("Keep the user's voice"));
  assert.ok(AUDIT_SYSTEM_TEMPLATE.includes("TONE_SHIFTED"));
});

test("范围开放的保护写进了模板（设计原则 ⑥）", () => {
  // 不得替用户选类别 / 不得闭合开放范围
  assert.ok(SYSTEM_TEMPLATE.includes('must not become "security problems"'));
  assert.ok(USER_TEMPLATE.includes('"Any problems?" stays open across all kinds of problems'));
  assert.ok(USER_TEMPLATE.includes("Keep the breadth REQUEST set"));
});

test("示例区是三段对照：TOO PASSIVE / RIGHT / WRONG 同时画两条边界（设计原则 ⑦）", () => {
  // 下边界：原样返回是失职（v0.3–v0.5 的病），必须作为反例教学
  assert.ok(USER_TEMPLATE.includes("TOO PASSIVE - fails the user"));
  assert.ok(USER_TEMPLATE.includes("the seed came back"));
  // 上边界：曲解（v0.1 的病），必须以反例身份出现并解释为什么错
  assert.ok(USER_TEMPLATE.includes("WRONG - distorts the request"));
  assert.ok(USER_TEMPLATE.includes("a different and much bigger product"));
  assert.ok(USER_TEMPLATE.includes("rank them by expected impact"));
  // RIGHT 侧：补全到细节的正例（而不是旧的"展开蕴含为止"正例）
  assert.ok(USER_TEMPLATE.includes("帮我做一个导出报表功能："));
  assert.ok(USER_TEMPLATE.includes("near-unchanged is CORRECT"));
  // 已明确指令的"加戏"必须作为反例出现（v0.6.0 线上实测病征）
  assert.ok(USER_TEMPLATE.includes("WRONG - over-elaboration"));
  assert.ok(USER_TEMPLATE.includes("the added procedure and failure clause are padding, not help"));
  // meta 泄漏反例保留（旧守卫）
  assert.ok(USER_TEMPLATE.includes("WRONG - this leaks meta text"));
  assert.ok(USER_TEMPLATE.includes("RIGHT:"));
  assert.ok(USER_TEMPLATE.includes("Input:"));
});

test("长度约束：长度跟随补全，不设配额也不压缩", () => {
  assert.ok(SYSTEM_TEMPLATE.includes("Length follows the elaboration"));
  assert.ok(!SYSTEM_TEMPLATE.includes("Length follows the entailment"), "旧的蕴含长度规则已废除");
  // 两侧旧病都不得回退
  assert.ok(!SYSTEM_TEMPLATE.includes("Stay close to the input's own length"), "v0.2 压缩指令已废除");
  assert.ok(!USER_TEMPLATE.includes("Stay close to REQUEST's own length"), "v0.2 压缩指令已废除");
});

test("buildSystemPromptFor 只在有脚本信息时追加语言提示", () => {
  assert.ok(buildSystemPromptFor("explain this code").includes("predominantly Latin script"));
  assert.ok(buildSystemPromptFor("解释这段代码").includes("predominantly CJK"));
  assert.ok(!buildSystemPromptFor("1234").includes("Language check"));
});

// --------------------------------------------------------------------------
// session-context
// --------------------------------------------------------------------------

test("extractRecentContext：只取真实用户话轮，跳过注入与噪声", () => {
  const surface = {
    events: [
      { type: "turn/start" },
      { type: "user/message", data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "现有的项目包是有一些问题的" }] } },
      // 注入快照（runtime-context）：source.kind 区分，绝不能进入上下文
      { type: "user/message", data: { role: "user", source: { kind: "runtime-context" }, content: [{ type: "text", text: "Current runtime context. This snapshot supersedes..." }] } },
      { type: "user/message", data: { role: "user", source: { kind: "time-context" }, content: [{ type: "text", text: "Time sampled while preparing turn..." }] } },
      // agent 会话尾部的典型噪声：assistant 步骤消息与工具结果
      { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "会话 id 格式正确。" }] } } },
      { type: "tool/result", data: { message: { role: "tool", content: [] } } },
      { type: "user/message", data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "没问题，act。" }] } },
    ],
  };
  const context = extractRecentContext(surface);
  // 只取真实用户话轮，最近 2 条，时间正序
  assert.deepEqual(context, [
    { role: "user", text: "现有的项目包是有一些问题的" },
    { role: "user", text: "没问题，act。" },
  ]);
  // 注入快照与 assistant 步骤绝不出现
  const joined = JSON.stringify(context);
  assert.ok(!joined.includes("runtime context"), "注入快照不得进入上下文");
  assert.ok(!joined.includes("会话 id"), "assistant 步骤噪声不得进入上下文");

  // 超长话轮截断
  const long = "x".repeat(500);
  const truncated = extractRecentContext({
    events: [{ type: "user/message", data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: long }] } }],
  });
  assert.equal(truncated[0].text.length, 301);
  assert.ok(truncated[0].text.endsWith("…"));

  // 旧形状兼容：无 source 字段的真实消息仍可提取（kind === undefined 不视为注入）
  assert.deepEqual(
    extractRecentContext({ events: [{ type: "user/message", data: { role: "user", content: "纯文本输入" } }] }),
    [{ role: "user", text: "纯文本输入" }],
  );

  // 防御降级：形状漂移、空事件、非对象一律 undefined
  assert.equal(extractRecentContext(undefined), undefined);
  assert.equal(extractRecentContext(null), undefined);
  assert.equal(extractRecentContext({}), undefined);
  assert.equal(extractRecentContext({ events: [] }), undefined);
  assert.equal(extractRecentContext({ events: [{ type: "user/message", data: null }] }), undefined);
  // 只剩注入消息时等于无上下文
  assert.equal(
    extractRecentContext({ events: [{ type: "user/message", data: { role: "user", source: { kind: "time-context" }, content: [{ type: "text", text: "Time sampled..." }] } }] }),
    undefined,
  );
});

// --------------------------------------------------------------------------
// 拒绝样本落盘
// --------------------------------------------------------------------------

test("resolveSamplePath：默认落 DSH_HOME，字符串自定义，false 关闭", () => {
  const previous = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = "/tmp/dsh-home-test";
    assert.equal(resolveSamplePath(undefined), "/tmp/dsh-home-test/prompt-seed/samples.jsonl");
    assert.equal(resolveSamplePath("/tmp/custom.jsonl"), "/tmp/custom.jsonl");
    assert.equal(resolveSamplePath(false), null, "samples:false 完全关闭采样");
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test("appendSample：写入 JSONL 并截断超长输入，失败静默", async () => {
  const dir = await mkdtemp(join(tmpdir(), "po-samples-"));
  const file = join(dir, "nested", "samples.jsonl");
  try {
    const long = "x".repeat(5000);
    assert.equal(await appendSample(file, { time: "t", code: "fidelity_rejected", input: long, added: ["a"] }), true);
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.input.length, 4000, "超长输入必须截断");
    assert.deepEqual(record.added, ["a"]);

    // 再追加一条：JSONL 是追加语义
    await appendSample(file, { time: "t2", code: "fidelity_rejected", input: "短", added: [] });
    assert.equal((await readFile(file, "utf8")).trim().split("\n").length, 2);

    // 非法路径：返回 false，不抛
    assert.equal(await appendSample("", { input: "x" }), false);
    assert.equal(await appendSample(null, { input: "x" }), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// host-core
// --------------------------------------------------------------------------

test("collectStream 拼接 text-delta 并识别终止失败", async () => {
  const ok = await collectStream(
    (async function* g() {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "abc" };
      yield { type: "text-delta", index: 0, text: "def" };
      yield { type: "finish", reason: { kind: "stop" } };
    })(),
  );
  assert.equal(ok.text, "abcdef");
  assert.equal(ok.failure, null);
  assert.equal(ok.finish, "stop");

  const failed = await collectStream(
    (async function* g() {
      yield { type: "text-delta", index: 0, text: "partial" };
      yield { type: "finish", reason: { kind: "error", failure: { code: "rate_limit", message: "429" } } };
    })(),
  );
  assert.equal(failed.text, "partial");
  assert.equal(failed.failure.message, "429");
});

test("createOptimizerMessage 形状满足 Message 契约", () => {
  const message = createOptimizerMessage("hello");
  assert.equal(message.role, "user");
  assert.equal(message.source.kind, "plugin");
  assert.equal(message.content[0].type, "text");
  assert.ok(typeof message.id === "string" && message.id.length > 0);
});

test("resolveRoute 读取 provider/model 并忽略空 reasoningEffort", () => {
  assert.deepEqual(resolveRoute({ currentSelection: () => ({ provider: "p", model: "m" }) }), {
    provider: "p",
    model: "m",
  });
  assert.deepEqual(resolveRoute({ currentSelection: () => ({ provider: "p", model: "m", reasoningEffort: "high" }) }), {
    provider: "p",
    model: "m",
    reasoningEffort: "high",
  });
  assert.equal(resolveRoute({ currentSelection: () => ({ provider: "p", model: "m", reasoningEffort: "  " }) }).reasoningEffort, undefined);
  assert.equal(resolveRoute(undefined), undefined);
  assert.equal(resolveRoute({ currentSelection: () => ({ provider: "p" }) }), undefined);
  assert.equal(resolveRoute({ currentSelection: () => { throw new Error("boom"); } }), undefined);
});

test("optimizePromptText 成功路径：清洗后返回", async () => {
  const llm = fakeLlm([
    { type: "text-delta", index: 0, text: '```\nEnhanced prompt: "' },
    { type: "text-delta", index: 0, text: "请解释这段代码的功能" },
    { type: "text-delta", index: 0, text: '"\n```' },
    { type: "finish", reason: { kind: "stop" } },
  ]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: "解释代码" });
  assert.deepEqual(result, { ok: true, text: "请解释这段代码的功能", tier: "full", gate: { verdict: "ok", repairs: 0, rechecked: false, violations: [] }, detail: "" });

  // 请求参数契约
  const sent = llm.seen[0];
  assert.equal(sent.provider, "test");
  assert.equal(sent.model, "test-model");
  assert.ok(sent.system.includes("You expand prompts for a coding assistant"));
  assert.equal(sent.messages.length, 1);
  assert.ok(sent.messages[0].content[0].text.includes("解释代码"));
});

test("optimizePromptText 不透传 reasoningEffort 但传递 signal", async () => {
  const llm = fakeLlm([{ type: "text-delta", index: 0, text: "ok" }, { type: "finish", reason: { kind: "stop" } }]);
  const controller = new AbortController();
  await optimizePromptText({
    llm,
    route: { ...ROUTE, reasoningEffort: "high" },
    text: "帮我看看这段代码",
    signal: controller.signal,
  });
  // 改写是轻任务：透传 max 档推理实测会让输出在"展开/原样"间发散（方差来源），不透传
  assert.equal(llm.seen[0].reasoningEffort, undefined, "改写调用不透传 reasoningEffort");
  assert.equal(llm.seen[0].signal, controller.signal);
});

test("optimizePromptText 错误分支全覆盖", async () => {
  const happy = fakeLlm([{ type: "text-delta", index: 0, text: "ok" }, { type: "finish", reason: { kind: "stop" } }]);

  assert.equal((await optimizePromptText({ llm: happy, route: ROUTE, text: "  " })).code, ERROR_CODES.EMPTY_INPUT);
  assert.equal(
    (await optimizePromptText({ llm: happy, route: ROUTE, text: "x".repeat(MAX_TEXT_LENGTH + 1) })).code,
    ERROR_CODES.INPUT_TOO_LONG,
  );
  assert.equal((await optimizePromptText({ llm: undefined, route: ROUTE, text: "帮我看看这段代码" })).code, ERROR_CODES.LLM_UNAVAILABLE);
  assert.equal((await optimizePromptText({ llm: happy, route: undefined, text: "帮我看看这段代码" })).code, ERROR_CODES.MODEL_UNAVAILABLE);

  const erroring = fakeLlm([{ type: "finish", reason: { kind: "error", failure: { code: "boom", message: "kaboom" } } }]);
  const errored = await optimizePromptText({ llm: erroring, route: ROUTE, text: "帮我看看这段代码" });
  assert.equal(errored.code, ERROR_CODES.LLM_ERROR);
  assert.equal(errored.error, "kaboom");

  const throwing = { stream() { throw new Error("network down"); } };
  const thrown = await optimizePromptText({ llm: throwing, route: ROUTE, text: "帮我看看这段代码" });
  assert.equal(thrown.code, ERROR_CODES.LLM_ERROR);
  assert.equal(thrown.error, "network down");

  const empty = fakeLlm([{ type: "text-delta", index: 0, text: '  ""  ' }, { type: "finish", reason: { kind: "stop" } }]);
  assert.equal((await optimizePromptText({ llm: empty, route: ROUTE, text: "帮我看看这段代码" })).code, ERROR_CODES.EMPTY_RESULT);
});

test("finish=max-tokens 一律拒绝，即使已经产出正文", async () => {
  // 依据：真实模型实测——被截断的 prompt 写进输入框比报错更危险。
  const partial = fakeLlm([
    { type: "text-delta", index: 0, text: "请检查这段代码是否存在语法错误、逻辑缺陷、边界情况，" },
    { type: "finish", reason: { kind: "max-tokens" } },
  ]);
  const result = await optimizePromptText({ llm: partial, route: ROUTE, text: "看看代码" });
  assert.equal(result.ok, false);
  assert.equal(result.code, ERROR_CODES.TRUNCATED);
  assert.equal(result.text, undefined, "截断结果绝不能回填输入框");
  assert.equal(result.error, "结果被截断，请缩短输入后重试");

  // 空正文 + max-tokens 同样走 truncated，而不是落到含义模糊的 empty_result
  const nothing = fakeLlm([{ type: "finish", reason: { kind: "max-tokens" } }]);
  assert.equal((await optimizePromptText({ llm: nothing, route: ROUTE, text: "帮我看看这段代码" })).code, ERROR_CODES.TRUNCATED);
});

test("optimizePromptText 失败时绝不清空调用方输入", async () => {
  const throwing = { stream() { throw new Error("x"); } };
  const result = await optimizePromptText({ llm: throwing, route: ROUTE, text: "keep me" });
  assert.equal(result.ok, false);
  assert.equal(result.text, undefined);
  assert.ok(typeof result.error === "string");
});

// --------------------------------------------------------------------------
// 保真闸门：粗筛、审判归一、处置矩阵
// --------------------------------------------------------------------------

test("assessInflation 粗筛：发明式膨胀命中，蕴含展开不误杀", () => {
  // 短输入 + 发明式膨胀比（>3）→ bloated
  const bloated = assessInflation("看看代码", "x".repeat(100));
  assert.equal(bloated.bloated, true);
  assert.equal(bloated.suspicious, true);
  assert.ok(bloated.ratio > 20);

  // 蕴含展开的正常区间（1.2–2.5×）不得命中（v0.2 的 2.0 阈值会误杀这类展开）
  const unfolded = assessInflation("帮我看看这个登录接口有没有问题", "请检查这个登录接口是否存在问题；如有，指出具体是什么问题、出现在哪里。");
  assert.ok(unfolded.ratio > 1.5 && unfolded.ratio <= 2.5, `ratio 应落在蕴含区间，实际 ${unfolded.ratio.toFixed(2)}`);
  assert.equal(unfolded.bloated, false, "蕴含展开不应被标记为膨胀");
  assert.equal(unfolded.suspicious, false);

  // 开放式输入 + 改写含发明交付物 → openEndedClosed
  const closed = assessInflation("帮我看看这个接口有没有问题", "请审查该接口的安全问题，并输出对比表格与选型建议");
  assert.equal(closed.openEndedClosed, true);
  assert.equal(closed.suspicious, true);

  // 开放式输入 + 蕴含展开 → 不命中
  const fine = assessInflation("帮我看看这个接口有没有问题", "请检查这个接口是否存在问题");
  assert.equal(fine.openEndedClosed, false);
  assert.equal(fine.bloated, false);
  assert.equal(fine.suspicious, false);

  // 长输入的正常展开（≥200 字符）不因比率触发（阈值只在短输入上生效）
  const longInput = "请修复 src/a.js 中 render 函数的空指针问题：当 config 为 undefined 时第 42 行的 config.theme 会抛出 TypeError，堆栈指向 render(src/a.js:42)，先在本地复现，再修复并补充回归测试覆盖 config 缺失的分支场景";
  const longOut = longInput + "，验证通过后说明改动点。";
  const longCase = assessInflation(longInput, longOut);
  assert.equal(longCase.bloated, false);
});

test("isSubstantivelyUnchanged：标点/敬语/大小写/近义替换级微调算未变，蕴含展开算已变", () => {
  const input = "帮我看看这个登录接口有没有问题";
  // 只加问号/句号/请 → 未变（v0.3.1 实测的平庸输出形态）
  assert.equal(isSubstantivelyUnchanged(input, "帮我看看这个登录接口有没有问题？"), true);
  assert.equal(isSubstantivelyUnchanged(input, "请帮我看看这个登录接口有没有问题。"), true);
  // 大小写 + 句号微调 → 未变（v0.3.3 英文案例逃逸形态）
  assert.equal(isSubstantivelyUnchanged("make the dashboard faster", "Make the dashboard faster."), true);
  // 近义替换（怎么→如何）→ 未变（v0.3.3 中文案例逃逸形态）
  assert.equal(isSubstantivelyUnchanged("调研一下这个功能该怎么开发", "请调研一下这个功能该如何开发。"), true);
  // 蕴含展开 → 已变
  assert.equal(isSubstantivelyUnchanged(input, "帮我看看这个登录接口有没有问题；如果有，指出是什么问题。"), false);
  assert.equal(isSubstantivelyUnchanged("make the dashboard faster", "Find what makes the dashboard slow and fix it."), false);
  assert.equal(isSubstantivelyUnchanged("", "anything"), false);
});

test("looksOpenEnded：开放式、问句与短祈使式命中，明确指令不命中", () => {
  assert.equal(looksOpenEnded("帮我看看这个登录接口有没有问题"), true, "开放式动词");
  assert.equal(looksOpenEnded("调研一下这个功能该怎么开发"), true, "调研");
  assert.equal(looksOpenEnded("这个函数有 bug，can you help fix it?"), true, "问句");
  assert.equal(looksOpenEnded("make the dashboard faster"), true, "短祈使式无锚定（v0.3.2 实测漏网形态）");
  assert.equal(looksOpenEnded("删除 src/utils/legacy.js 里未被引用的 export，跑一遍测试确认没破坏"), false, "已明确指令");
  assert.equal(looksOpenEnded("修复 render 函数第 42 行的空指针异常"), false, "含行号锚定的明确指令");
});

test("补全闸：种子输入的第一稿实质未变时，补全重跑并回填补全版", async () => {
  const input = "帮我看看这个登录接口有没有问题";
  const llm = scriptedLlm([
    textChunks("帮我看看这个登录接口有没有问题？"),  // 第一稿：标点级微调（未变）
    textChunks("请检查这个登录接口是否存在问题；如有，指出是什么问题、出现在哪里。"), // 补全重跑
    textChunks("OK"), // 审判
  ]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: input });
  assert.deepEqual(result, {
    ok: true,
    text: "请检查这个登录接口是否存在问题；如有，指出是什么问题、出现在哪里。",
    tier: "full",
    gate: { verdict: "ok", repairs: 0, rechecked: false, violations: [] },
    detail: "",
  });
  assert.equal(llm.seen.length, 3, "重跑脱离平庸即停，不再二次重试");
  assert.ok(llm.seen[1].system.includes("ELABORATION MODE"), "重跑必须带补全模式约束");
  assert.ok(llm.seen[1].messages[0].content[0].text.includes("too thin"), "重跑必须说明失败原因并要求补全");
  assert.equal(llm.seen[1].temperature, 0.4, "首次重试温度 0.4");
});

test("补全闸：两次重试温度递增，全部平庸时回填最后一次", async () => {
  const input = "调研一下这个功能该怎么开发";
  const llm = scriptedLlm([
    textChunks("调研一下这个功能该怎么开发。"), // 第一稿：未变
    textChunks("请调研一下这个功能该怎么开发。"), // 重试一：仍未变
    textChunks("请调研一下这个功能该如何开发。"), // 重试二：仍未变
    textChunks("OK"), // 审判
  ]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: input });
  assert.equal(result.ok, true);
  assert.equal(result.text, "请调研一下这个功能该如何开发。");
  assert.equal(result.tier, "full");
  assert.equal(llm.seen.length, 4, "两连重试 + 审判");
  assert.equal(llm.seen[1].temperature, 0.4);
  assert.equal(llm.seen[2].temperature, 0.7, "第二次重试升温扰动");
});

test("补全闸：已明确输入的第一稿未变时不触发重跑", async () => {
  const input = "删除 src/utils/legacy.js 里未被引用的 export，跑一遍测试确认没破坏";
  const llm = scriptedLlm([
    textChunks("删除 src/utils/legacy.js 中未被引用的 export，然后跑一遍测试确认没有破坏。"),
    textChunks("OK"),
  ]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: input });
  assert.equal(result.ok, true);
  assert.equal(result.tier, "full");
  // 精确模式 + 近原样 → 连审判一起省掉（P1-5）：只花 1 次调用
  assert.equal(llm.seen.length, 1, "精确输入近原样时跳过审判");
  assert.ok(llm.seen[0].system.includes("PRECISE-INPUT MODE"));
});

test("looksSeedish：短种子/开放式命中，带锚定的明确指令不命中", () => {
  assert.equal(looksSeedish("帮我做个图片压缩的功能"), true, "短种子");
  assert.equal(looksSeedish("帮我看看这个登录接口有没有问题"), true, "开放式");
  assert.equal(looksSeedish("这玩意儿咋老崩啊"), true, "短句无锚定");
  assert.equal(
    looksSeedish("删除 src/utils/legacy.js 里未被引用的 export，跑一遍测试确认没破坏"),
    false,
    "带路径锚定的明确指令",
  );
  assert.equal(looksSeedish(""), false);
});

test("isContentFree：纯招呼/纯标点命中，极短但有内容的输入不误杀", () => {
  // 实测病征：hi 空转 5.4s、你好 被拒 8.5s（v0.6.1 线上）
  assert.equal(isContentFree("hi"), true);
  assert.equal(isContentFree("HI"), true);
  assert.equal(isContentFree("你好"), true);
  assert.equal(isContentFree("谢谢"), true);
  assert.equal(isContentFree("?"), true);
  assert.equal(isContentFree("。。"), true);
  assert.equal(isContentFree("   "), true);
  assert.equal(isContentFree(""), true);
  assert.equal(isContentFree("👍"), true);
  // 阈值必须极低：登录（2 字）实测能补出高质量方案
  assert.equal(isContentFree("登录"), false);
  assert.equal(isContentFree("修一下"), false);
  assert.equal(isContentFree("帮我看看这个接口"), false);
});

test("无内容输入直接短路：零模型调用，返回中性错误码", async () => {
  const llm = scriptedLlm([textChunks("不该被调用")]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: "hi" });
  assert.equal(result.ok, false);
  assert.equal(result.code, ERROR_CODES.NOTHING_TO_OPTIMIZE);
  assert.equal(result.error, "内容太短，没有可优化的信息");
  assert.equal(llm.seen.length, 0, "内容下限不花任何模型调用");
});

test("精确模式近原样时跳过审判：只花一次调用", async () => {
  const input = "把 src/utils/legacy.js 里的 formatDate 改成用 dayjs 实现";
  const same = "把 src/utils/legacy.js 里的 formatDate 改成用 dayjs 实现";
  const llm = scriptedLlm([textChunks(same), textChunks("OK")]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: input });
  assert.deepEqual(result, { ok: true, text: same, tier: "full", gate: { verdict: "unverified", repairs: 0, rechecked: false, violations: [] }, detail: "" });
  assert.equal(llm.seen.length, 1, "近原样 → 不发起审判");
});

test("精确模式但改写动了实质：审判照常执行（短路不得放走真改动）", async () => {
  const input = "把 src/utils/legacy.js 里的 formatDate 改成用 dayjs 实现";
  const swapped = "把 src/utils/legacy.js 里的 formatDate 改成用 moment 实现";
  const llm = scriptedLlm([
    textChunks(swapped),
    textChunks("CONTRADICTED: 把 dayjs 换成了 moment"),
    textChunks("把 src/utils/legacy.js 里的 formatDate 改成用 dayjs 实现"),
    textChunks("OK"),
  ]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: input });
  assert.equal(llm.seen.length, 4, "实质改动必须过审判，并由定向修复拉回");
  assert.equal(result.ok, true);
  assert.equal(result.tier, "repaired");
  assert.equal(result.text, "把 src/utils/legacy.js 里的 formatDate 改成用 dayjs 实现");
});

test("isPreciseInstruction：点名目标+动作的完整指令命中，种子与问句不命中", () => {
  // 命中：锚定事实（路径/扩展名/数字）+ 明确动作 + 不是问句
  assert.equal(
    isPreciseInstruction("删除 src/utils/legacy.js 里未被引用的 export，跑一遍测试确认没破坏"),
    true,
    "v0.6.0 线上实测的过度发散病征输入",
  );
  assert.equal(isPreciseInstruction("把 src/utils/legacy.js 里的 formatDate 改成用 dayjs 实现"), true);
  assert.equal(isPreciseInstruction("修复 render 函数第 42 行的空指针异常"), true);
  // 不命中：种子/普通请求（无锚定）
  assert.equal(isPreciseInstruction("帮我做个导出报表的功能"), false);
  assert.equal(isPreciseInstruction("给设置页加个深色模式开关"), false);
  // 不命中：开放意图（问句/调研/看看）
  assert.equal(isPreciseInstruction("帮我看看这个登录接口有没有问题"), false);
  assert.equal(isPreciseInstruction("调研一下 src/api 下这个模块该怎么开发"), false);
  // 不命中：太短（信息量不足以称为完整指令）
  assert.equal(isPreciseInstruction("改 src/a.js"), false);
  assert.equal(isPreciseInstruction(""), false);
});

test("精确输入走精确模式：契约整段切换，输出接近原样", async () => {
  const input = "删除 src/utils/legacy.js 里未被引用的 export，跑一遍测试确认没破坏";
  const polished = "删除 src/utils/legacy.js 里未被引用的 export，然后跑一遍测试确认没有破坏现有功能。";
  const llm = scriptedLlm([textChunks(polished), textChunks("OK")]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: input });

  assert.deepEqual(result, { ok: true, text: polished, tier: "full", gate: { verdict: "ok", repairs: 0, rechecked: false, violations: [] }, detail: "" });
  assert.equal(llm.seen.length, 2, "精确输入不触发补全闸");
  assert.ok(llm.seen[0].system.includes("PRECISE-INPUT MODE"), "system 必须切换到精确模式");
  assert.ok(!llm.seen[0].system.includes("ELABORATE, NEVER DISTORT") === false, "基础契约仍在（模式是追加覆盖）");
  const userPrompt = llm.seen[0].messages[0].content[0].text;
  assert.ok(userPrompt.includes("already precise and complete"), "user 侧也要声明精确模式");
  assert.ok(userPrompt.includes("Do not add procedures"), "user 侧必须点名禁止加步骤");
});

test("种子输入不得走精确模式（否则会压住该有的补全）", async () => {
  const input = "帮我做个导出报表的功能";
  const fat = "帮我做一个导出报表功能：可以选择导出的时间范围和统计维度，支持导出 CSV 和 Excel，数据量大时显示进度。";
  const llm = scriptedLlm([textChunks(fat), textChunks("OK")]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: input });

  assert.equal(result.ok, true);
  assert.ok(!llm.seen[0].system.includes("PRECISE-INPUT MODE"), "种子必须走补全契约");
  assert.ok(llm.seen[0].system.includes("ELABORATE, NEVER DISTORT"));
});

test("审判报 PADDED：精确输入被加戏时定向修复，绝不回填加戏稿", async () => {
  const input = "删除 src/utils/legacy.js 里未被引用的 export，跑一遍测试确认没破坏";
  const padded = "删除 src/utils/legacy.js 里未被引用的 export：先在全仓库搜索每个 export 的引用，确认没有动态引用后再删；删完跑测试，失败就回退并说明原因。";
  const fixed = "删除 src/utils/legacy.js 里未被引用的 export，然后跑一遍测试确认没有破坏现有功能。";
  const llm = scriptedLlm([
    textChunks(padded),
    textChunks("PADDED: 加了搜索引用的步骤\nPADDED: 加了失败回退条款"),
    textChunks(fixed),
    textChunks("OK"),
  ]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: input });

  assert.deepEqual(result, {
    ok: true,
    text: fixed,
    tier: "repaired",
    gate: {
      verdict: "repaired",
      repairs: 1,
      rechecked: true,
      violations: [
        { kind: "padded", text: "加了搜索引用的步骤" },
        { kind: "padded", text: "加了失败回退条款" },
      ],
    },
    detail: "",
  });
  assert.equal(llm.seen.length, 4, "修复后一律复核：4 次调用");
  assert.equal(result.gate.rechecked, true, "复核过必须标注");
  assert.ok(llm.seen[2].system.includes("PRECISE-INPUT MODE"), "修复稿仍须遵守精确模式");
  assert.ok(llm.seen[2].system.includes("REPAIR MODE"));
  assert.ok(llm.seen[2].messages[0].content[0].text.includes("加了搜索引用的步骤"), "修复 prompt 必须点名加戏内容");
});

test("PADDED 判决归一为 padded 违规", () => {
  assert.deepEqual(parseAuditVerdict("PADDED: 加了操作步骤"), {
    status: "issues",
    violations: [{ kind: "padded", text: "加了操作步骤" }],
    thin: false, detail: "" });
});

test("精确模式与 PADDED 规则写进了模板", () => {
  assert.ok(PRECISE_SUFFIX.includes("PRECISE-INPUT MODE"));
  assert.ok(PRECISE_SUFFIX.includes("adding less is the correct answer"));
  assert.ok(AUDIT_SYSTEM_TEMPLATE.includes("PADDED"));
  assert.ok(AUDIT_SYSTEM_TEMPLATE.includes("For an ALREADY-PRECISE original they are PADDED"));
});

test("症状报告蕴含修复请求：改写侧与审判侧必须同步声明（实测漏掉导致红三角误拒）", () => {
  // 用户输入"按钮就是个禁止符号，啥都没有"——描述坏掉的现象蕴含"查清并修好"。
  // 缺这条时审判把"请排查原因"判成失真，功能表现为红三角 + 原文不动（真实故障）。
  assert.ok(SYSTEM_TEMPLATE.includes("A SYMPTOM REPORT is a request"), "改写侧缺少症状蕴含");
  assert.ok(AUDIT_SYSTEM_TEMPLATE.includes("A SYMPTOM REPORT is a request"), "审判侧缺少症状蕴含（不同步会继续误拒）");
  assert.ok(USER_TEMPLATE.includes("a symptom report"), "user prompt 缺少症状蕴含示例");
  // 展开必须有界：不能从症状跳到交付物清单
  assert.ok(AUDIT_SYSTEM_TEMPLATE.includes("root-cause reports, option lists, and acceptance criteria are not"));
});

test("parseAuditVerdict 归一 OK / 四类失真 / THIN / 无法解析", () => {
  const ok = { status: "ok", violations: [], thin: false, detail: "" };
  assert.deepEqual(parseAuditVerdict("OK"), ok);
  assert.deepEqual(parseAuditVerdict("OK."), ok);
  assert.deepEqual(parseAuditVerdict("ok\n"), ok);
  assert.deepEqual(parseAuditVerdict("DISTORTED: 把调研改成了实现"), {
    status: "issues",
    violations: [{ kind: "distorted", text: "把调研改成了实现" }],
    thin: false, detail: "" });
  assert.deepEqual(parseAuditVerdict("SCOPE_ADDED: 对比表格\nTONE_SHIFTED: 变成规格书"), {
    status: "issues",
    violations: [
      { kind: "scope_added", text: "对比表格" },
      { kind: "tone_shifted", text: "变成规格书" },
    ],
    thin: false, detail: "" });
  // 历史别名 ADDED 仍归一为 scope_added（旧样本日志里可能出现）
  assert.deepEqual(parseAuditVerdict("ADDED: 修复建议"), {
    status: "issues",
    violations: [{ kind: "scope_added", text: "修复建议" }],
    thin: false, detail: "" });
  // THIN 是"失职"不是"失真"：不带 violations，单独标记
  assert.deepEqual(parseAuditVerdict("THIN: 只改了措辞"), { status: "ok", violations: [], thin: true, detail: "" });
  assert.deepEqual(parseAuditVerdict("THIN: 只改了措辞\nDISTORTED: 换了目标"), {
    status: "issues",
    violations: [{ kind: "distorted", text: "换了目标" }],
    thin: true, detail: "" });
  // KIND 行不带说明时仍算抓到把柄（宁可多修一次，不可漏放）
  assert.deepEqual(parseAuditVerdict("DISTORTED:"), {
    status: "issues",
    violations: [{ kind: "distorted", text: "改变了原始目标" }],
    thin: false, detail: "" });
  // 夹杂的自然语言行被忽略，协议行仍生效
  assert.deepEqual(parseAuditVerdict("我检查了一下\nSCOPE_ADDED: 实施计划"), {
    status: "issues",
    violations: [{ kind: "scope_added", text: "实施计划" }],
    thin: false, detail: "" });
  // 审判输出被围栏/引号包裹时要先清洗
  assert.deepEqual(parseAuditVerdict('```\n"OK"\n```'), ok);
  // 空 / 越界输出 → unparsable，调用方 fail-open
  const unparsable = { status: "unparsable", violations: [], thin: false, detail: "" };
  assert.deepEqual(parseAuditVerdict(""), unparsable);
  assert.deepEqual(parseAuditVerdict("我觉得改写得不错"), unparsable);
});

test("审判通过：正常回填，改写与审计调用均轻量", async () => {
  const llm = scriptedLlm([
    textChunks("请检查这个接口是否存在问题"),
    textChunks("OK"),
  ]);
  const result = await optimizePromptText({ llm, route: { ...ROUTE, reasoningEffort: "high" }, text: "帮我看看这个接口有没有问题" });
  assert.deepEqual(result, { ok: true, text: "请检查这个接口是否存在问题", tier: "full", gate: { verdict: "ok", repairs: 0, rechecked: false, violations: [] }, detail: "" });

  assert.equal(llm.seen.length, 2, "改写 + 审判恰好两次调用");
  const [rewriteCall, auditCall] = llm.seen;
  assert.ok(rewriteCall.system.includes("You expand prompts for a coding assistant"));
  assert.equal(rewriteCall.reasoningEffort, undefined, "改写不透传 reasoningEffort（max 推理是方差源）");
  assert.ok(auditCall.system.includes("strict auditor"));
  assert.equal(auditCall.reasoningEffort, undefined, "审判不透传 reasoningEffort，保持轻量");
  assert.equal(auditCall.temperature, 0);
  assert.ok(auditCall.messages[0].content[0].text.includes("ORIGINAL:"));
  assert.ok(auditCall.messages[0].content[0].text.includes("REWRITE:"));
});

test("审判报失真：定向修复保留已补细节，只摘越线处，二次审判通过", async () => {
  const input = "帮我看看这个登录接口有没有问题";
  const invented = "请审查这个登录接口的安全问题与逻辑缺陷，说明每处问题的影响范围和触发条件，并给出具体的修复建议。";
  const llm = scriptedLlm([
    textChunks(invented),            // 第一稿：曲解式展开（v0.1 病灶输出）
    textChunks("DISTORTED: 把审查范围收窄成安全问题类别\nSCOPE_ADDED: 修复建议"), // 审判：抓到把柄
    textChunks("请检查这个登录接口是否存在问题；如有，指出是什么问题、出现在哪里。"), // 修复稿
    textChunks("OK"),                // 二次审判：通过
  ]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: input });
  assert.deepEqual(result, {
    ok: true,
    text: "请检查这个登录接口是否存在问题；如有，指出是什么问题、出现在哪里。",
    tier: "repaired",
    gate: {
      verdict: "repaired",
      repairs: 1,
      rechecked: true,
      violations: [
        { kind: "distorted", text: "把审查范围收窄成安全问题类别" },
        { kind: "scope_added", text: "修复建议" },
      ],
    },
    detail: "",
  });

  assert.equal(llm.seen.length, 4);
  const repairCall = llm.seen[2];
  assert.ok(repairCall.system.includes("REPAIR MODE"), "重跑必须带定向修复约束");
  assert.equal(result.gate.rechecked, true, "语义型越线（distorted）必须复核修复稿");
  assert.equal(llm.seen.length, 4, "语义型越线保持 4 次调用");
  assert.ok(repairCall.system.includes("KEEP the detail that was NOT flagged"), "修复不得退回原样（补全是产品本体）");
  assert.ok(repairCall.messages[0].content[0].text.includes("安全问题类别"), "修复 prompt 必须点名具体问题");
});

test("二次审判仍失真：fidelity_rejected，绝不回填，且携带可解释 added 清单", async () => {
  const input = "调研一下这个功能该怎么开发";
  const invented1 = "请调研该功能的主流实现方案，输出对比表格，评估优缺点与风险，给出选型建议和实施计划。";
  const invented2 = "请调研该功能并整理成对比表格，同时给出选型建议与实施排期。";
  const llm = scriptedLlm([
    textChunks(invented1),
    textChunks("DISTORTED: 把调研改成了直接实施\nSCOPE_ADDED: 对比表格"),
    textChunks(invented2),
    textChunks("DISTORTED: 仍然把调研当成实施任务"),
  ]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: input });

  assert.equal(result.ok, false);
  assert.equal(result.code, ERROR_CODES.FIDELITY_REJECTED);
  assert.equal(result.error, "优化会改变原意，已保留原文");
  assert.equal(result.text, undefined, "失真拒绝时绝不能带 text 字段（不变量 I1）");
  assert.deepEqual(result.added, ["仍然把调研当成实施任务"], "可解释拒绝：携带审判抓到的问题");
  assert.equal(result.rejected, invented2, "被拒版本随结果回传，供用户显式查看（不变量 I1 不变）");
  assert.equal(llm.seen.length, 4);
});

test("optimizePromptText 把会话上下文传给改写与审判调用", async () => {
  const context = [
    { role: "user", text: "登录接口有时候 500" },
    { role: "assistant", text: "看起来是 token 校验的边界情况" },
  ];
  const llm = scriptedLlm([
    textChunks("请修复登录接口的 token 校验问题"),
    textChunks("OK"),
  ]);
  const result = await optimizePromptText({
    llm,
    route: ROUTE,
    text: "帮我修一下这个",
    context,
  });
  assert.equal(result.ok, true);
  // 改写与审判的 user prompt 都携带 CONTEXT 段（审判需要知情指代来源）
  assert.ok(llm.seen[0].messages[0].content[0].text.includes("[user] 登录接口有时候 500"));
  assert.ok(llm.seen[1].messages[0].content[0].text.includes("[assistant] 看起来是 token 校验的边界情况"));
});

test("宽容带已废除：审判报失真一律定向修复，长度比不再参与放行", async () => {
  // 旧的 2.5× 宽容带会把"开放式 + 轻微新增"直接放行；补全契约下长度比不再指示
  // 越线（种子长成一段细节是正常的），真伪只由审判的语义标尺判定。
  const open = "帮我看看这个接口有没有问题";
  const distorted = "请审查这个接口的安全问题，并输出对比表格。";
  const llm = scriptedLlm([
    textChunks(distorted),
    textChunks("SCOPE_ADDED: 安全问题\nSCOPE_ADDED: 对比表格"),
    textChunks("请检查这个接口是否存在问题；如有，指出是什么问题、出现在哪里。"),
    textChunks("OK"),
  ]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: open });
  assert.equal(result.ok, true);
  assert.equal(result.tier, "repaired");
  assert.equal(llm.seen.length, 4, "失真一律走完整修复+复核流程");
});

test("审判报 THIN：种子输入补全一次并重新审判，补全稿通过即回填", async () => {
  const input = "帮我做个图片压缩的功能";
  const thin = "请帮我实现图片压缩，把图片压小一点。";
  const fat = "帮我做一个图片压缩功能：上传图片后按目标尺寸或质量压缩，压缩前显示原图大小，压缩后显示压缩比，支持单张和批量，结果可下载，覆盖 jpg/png/webp，压缩失败时说明原因。";
  const llm = scriptedLlm([
    textChunks(thin),
    textChunks("THIN: 只改了措辞，没有补出实现细节"),
    textChunks(fat),
    textChunks("OK"),
  ]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: input });
  assert.deepEqual(result, { ok: true, text: fat, tier: "elaborated", gate: { verdict: "ok", repairs: 0, rechecked: true, violations: [] }, detail: "" });
  assert.equal(llm.seen.length, 4);
  assert.equal(llm.seen[2].temperature, 0.5, "补全重试带温度扰动（零温度重跑只会再薄一次）");
  assert.ok(llm.seen[2].system.includes("ELABORATION MODE"));
});

test("THIN 补全后引入失真：回退薄但忠实的第一稿，绝不回填失真稿", async () => {
  const input = "帮我做个图片压缩的功能";
  const thin = "请帮我实现图片压缩，把图片压小一点。";
  const distorted = "请实现一个基于 WebAssembly 的高性能图片压缩服务，包含断点续传、CDN 分发与压缩率报表。";
  const llm = scriptedLlm([
    textChunks(thin),
    textChunks("THIN: 没有补出细节"),
    textChunks(distorted),
    textChunks("SCOPE_ADDED: CDN 分发\nSCOPE_ADDED: 压缩率报表"),
  ]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: input });
  assert.deepEqual(result, { ok: true, text: thin, tier: "thin", gate: { verdict: "thin", repairs: 0, rechecked: false, violations: [] }, detail: "" }, "宁可薄而忠实，不可厚而曲解");
  assert.equal(llm.seen.length, 4);
});

test("审判报 THIN 但输入已明确：不补全（误报不得把明确指令堆胖）", async () => {
  const input = "删除 src/utils/legacy.js 里未被引用的 export，跑一遍测试确认没破坏";
  // 故意写长，避开"精确 + 近原样 → 跳过审判"的短路，确保审判真的会执行
  const rewrite = "删除 src/utils/legacy.js 中未被任何地方引用的导出，然后运行完整测试套件，确认现有功能没有被破坏。";
  const llm = scriptedLlm([
    textChunks(rewrite),
    textChunks("THIN: 没有补充细节"),
  ]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: input });
  assert.deepEqual(result, { ok: true, text: rewrite, tier: "full", gate: { verdict: "ok", repairs: 0, rechecked: false, violations: [] }, detail: "" });
  assert.equal(llm.seen.length, 2, "已明确输入不因 THIN 误报而重跑");
});

test("审判调用失败：fail-open 接受改写（闸门是纵深防御而非唯一机制）", async () => {
  const llm = scriptedLlm([
    textChunks("请检查这个接口是否存在问题"),
    [{ type: "finish", reason: { kind: "error", failure: { code: "boom", message: "audit down" } } }],
  ]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: "帮我看看这个接口有没有问题" });
  assert.deepEqual(result, { ok: true, text: "请检查这个接口是否存在问题", tier: "full", gate: { verdict: "ok", repairs: 0, rechecked: false, violations: [] }, detail: "" });
});

test("审判输出无法解析：fail-open 接受改写", async () => {
  const llm = scriptedLlm([
    textChunks("请检查这个接口是否存在问题"),
    textChunks("这段改写保持了一致性，整体质量不错"),
  ]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: "帮我看看这个接口有没有问题" });
  assert.deepEqual(result, { ok: true, text: "请检查这个接口是否存在问题", tier: "full", gate: { verdict: "ok", repairs: 0, rechecked: false, violations: [] }, detail: "" });
});

test("审判误报失真：定向修复稿被采纳，绝不因为一次误报就拒绝", async () => {
  // 短输入 + 高膨胀比但改写其实没曲解 → 审判误报也应走修复；修复稿只要过审就回填，
  // 用户的等待不能白费（旧流程在这里会退化成保守重跑甚至拒绝）。
  const input = "看看代码";
  const expanded = "请查看这段代码，检查其中是否存在任何问题。";
  const llm = scriptedLlm([
    textChunks(expanded),
    textChunks("DISTORTED: 加了检查问题的要求"),
    textChunks("请查看这段代码，检查其中是否存在任何问题。"),
    textChunks("OK"),
  ]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: input });
  assert.equal(result.ok, true);
  assert.equal(result.text, expanded);
  assert.equal(result.tier, "repaired");
  assert.equal(llm.seen.length, 4);
});

// --------------------------------------------------------------------------
// 构建产物一致性

// --------------------------------------------------------------------------
// 构建产物：bundle 形态的清单、Host 半区路由、浏览器半区模块
// --------------------------------------------------------------------------

/** 读取 package.json。 */
async function readPackage() {
  return JSON.parse(await readFile(join(root, "package.json"), "utf8"));
}

/** 假装成一个 webServer 服务，收集注册的路由。 */
function makeWebServer() {
  const routes = [];
  return {
    routes,
    register(route) {
      routes.push(route);
      return () => {};
    },
  };
}

/** 造一个可读的假请求。 */
function makeRequest(options = {}) {
  const method = options.method ?? "POST";
  const host = options.host ?? "127.0.0.1:3080";
  const remoteAddress = options.remoteAddress ?? "127.0.0.1";
  const body = options.body ?? "";
  const req = Readable.from(body === "" ? [] : [Buffer.from(body, "utf8")]);
  req.method = method;
  req.headers = { host };
  req.socket = { remoteAddress };
  req.destroy = () => {};
  return req;
}

/** 造一个记录响应的假 res。 */
function makeResponse() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk) {
      this.body = chunk ?? "";
    },
  };
}

/** 造一个带 llm 与默认模型的假 ctx。 */
function makeHostContext(webServer, options = {}) {
  const responses = options.responses ?? [
    [
      { type: "text-delta", index: 0, text: '```\nEnhanced prompt: "改写结果"\n```' },
      { type: "finish", reason: { kind: "stop" } },
    ],
    textChunks("OK"),
  ];
  const llm = options.llm === undefined ? scriptedLlm(responses) : options.llm;
  const sessionQuery =
    options.sessionQuery === undefined
      ? undefined
      : options.sessionQuery;
  return {
    webServer,
    // Cordis fiber 生命周期：effect 的返回值即 disposer（路由注册必须挂靠，
    // 否则 fiber 销毁后路由残留，热升级撞 duplicate route——实测修过的 bug）。
    effect(fn) {
      return fn();
    },
    get(name) {
      if (name === "llm") return llm;
      if (name === "sessionQuery") return sessionQuery;
      if (name === "agentDefaultModel") {
        return options.model === undefined ? { currentSelection: () => ({ provider: "p", model: "m" }) } : options.model;
      }
      return undefined;
    },
  };
}

test("package.json 是合法的 bundle 清单，且每个入口都真的存在", async () => {
  const pkg = await readPackage();
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(pkg.dsh.client.platform, "web");
  assert.equal(pkg.exports["./client"], "./lib/client.js");

  // 入口文件必须真实存在，否则 npm pack 出来的包在用户侧装载即失败
  for (const rel of [pkg.main, pkg.exports["./client"], pkg.dsh.bundle.patch]) {
    await readFile(join(root, rel), "utf8");
  }

  // files 白名单必须覆盖 lib 与 patch：漏掉任何一个都会让已发布的包缺文件
  assert.ok(pkg.files.includes("lib"));
  assert.ok(pkg.files.includes("cordis.patch.yml"));
});

test("cordis.patch.yml 以包名引用本包，而不是相对路径", async () => {
  const pkg = await readPackage();
  const patch = await readFile(join(root, "cordis.patch.yml"), "utf8");
  // 行必须按包名引用，Node 的模块解析才能找到已安装的代码
  assert.ok(patch.includes(`name: ${pkg.name}`));
  assert.ok(patch.includes("id: prompt-seed"));
  assert.ok(patch.includes("- insert:"));
});

test("lib/index.js 导出标准 Cordis 插件形状", async () => {
  const host = await import("../lib/index.js");
  assert.equal(host.name, "prompt-seed");
  assert.deepEqual(host.inject, ["webServer"]);
  assert.equal(typeof host.apply, "function");
  assert.equal(host.DEFAULT_ROUTE, "/api/prompt-seed/optimize");
});

test("Host 路由：回环放行、非法来源拒绝、方法与非 JSON 体各自归一", async () => {
  const host = await import("../lib/index.js");
  const webServer = makeWebServer();
  host.apply(makeHostContext(webServer), { samples: false });

  assert.equal(webServer.routes.length, 1);
  const route = webServer.routes[0];
  assert.equal(route.kind, "exact");
  assert.equal(route.path, host.DEFAULT_ROUTE);

  // 正常路径：清洗后返回 ok
  const ok = makeResponse();
  await route.handler(makeRequest({ body: JSON.stringify({ text: "解释代码" }) }), ok);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(JSON.parse(ok.body), { ok: true, text: "改写结果", tier: "full", gate: { verdict: "ok", repairs: 0, rechecked: false, violations: [] }, detail: "" });

  // 空输入仍然 200，但带业务错误码
  const empty = makeResponse();
  await route.handler(makeRequest({ body: JSON.stringify({ text: "   " }) }), empty);
  assert.equal(empty.statusCode, 200);
  assert.equal(JSON.parse(empty.body).code, "empty_input");

  const wrongMethod = makeResponse();
  await route.handler(makeRequest({ method: "GET" }), wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);

  const badJson = makeResponse();
  await route.handler(makeRequest({ body: "{not json" }), badJson);
  assert.equal(badJson.statusCode, 400);

  // 超长请求体必须被拒绝，而不是无限缓冲
  const tooLarge = makeResponse();
  await route.handler(makeRequest({ body: JSON.stringify({ text: "x".repeat(70000) }) }), tooLarge);
  assert.equal(tooLarge.statusCode, 400);
});

test("回环防护同时校验 peer 地址与 Host 头", async () => {
  const host = await import("../lib/index.js");
  const webServer = makeWebServer();
  host.apply(makeHostContext(webServer), { samples: false });
  const route = webServer.routes[0];
  const payload = JSON.stringify({ text: "帮我看看这段代码" });

  // 远端 peer：直接 403
  const remotePeer = makeResponse();
  await route.handler(makeRequest({ remoteAddress: "10.0.0.7", body: payload }), remotePeer);
  assert.equal(remotePeer.statusCode, 403);
  assert.equal(JSON.parse(remotePeer.body).code, "forbidden");

  // peer 合法但 Host 头撒谎（DNS rebinding）：同样 403
  const reboundHost = makeResponse();
  await route.handler(makeRequest({ host: "evil.example.com", body: payload }), reboundHost);
  assert.equal(reboundHost.statusCode, 403);

  // ::ffff:127.0.0.1 与 localhost 都要放行
  for (const options of [
    { remoteAddress: "::ffff:127.0.0.1", host: "localhost:3080" },
    { remoteAddress: "::1", host: "[::1]:3080" },
  ]) {
    const res = makeResponse();
    await route.handler(makeRequest({ ...options, body: payload }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(options));
  }
});

test("Host 路由在 llm 或默认模型缺席时返回结构化错误码", async () => {
  const host = await import("../lib/index.js");

  const noLlm = makeWebServer();
  host.apply(makeHostContext(noLlm, { llm: null }), { samples: false });
  const first = makeResponse();
  await noLlm.routes[0].handler(makeRequest({ body: JSON.stringify({ text: "帮我看看这段代码" }) }), first);
  assert.equal(JSON.parse(first.body).code, "llm_unavailable");

  const noModel = makeWebServer();
  host.apply(makeHostContext(noModel, { model: null }), { samples: false });
  const second = makeResponse();
  await noModel.routes[0].handler(makeRequest({ body: JSON.stringify({ text: "帮我看看这段代码" }) }), second);
  assert.equal(JSON.parse(second.body).code, "model_unavailable");
});

test("Host 路由支持自定义 path，且忽略不以 / 开头的非法值", async () => {
  const host = await import("../lib/index.js");

  const custom = makeWebServer();
  host.apply(makeHostContext(custom), { route: "/api/custom/optimize", samples: false });
  assert.equal(custom.routes[0].path, "/api/custom/optimize");

  const invalid = makeWebServer();
  host.apply(makeHostContext(invalid), { route: "no-leading-slash", samples: false });
  assert.equal(invalid.routes[0].path, host.DEFAULT_ROUTE);
});

test("行 config 覆盖模型路由：provider+model 成对生效", async () => {
  const host = await import("../lib/index.js");

  const overridden = makeWebServer();
  const ctx = makeHostContext(overridden);
  host.apply(ctx, { provider: "zai", model: "glm-flash", samples: false });
  const res = makeResponse();
  await overridden.routes[0].handler(makeRequest({ body: JSON.stringify({ text: "帮我看看这段代码" }) }), res);
  assert.equal(res.statusCode, 200);
  const llm = ctx.get("llm");
  assert.equal(llm.seen[0].provider, "zai", "provider 覆盖生效");
  assert.equal(llm.seen[0].model, "glm-flash", "model 覆盖生效");

  // 只给 provider 不给 model：忽略覆盖，回落默认模型
  const half = makeWebServer();
  const ctxHalf = makeHostContext(half);
  host.apply(ctxHalf, { provider: "zai", samples: false });
  const resHalf = makeResponse();
  await half.routes[0].handler(makeRequest({ body: JSON.stringify({ text: "帮我看看这段代码" }) }), resHalf);
  assert.equal(ctxHalf.get("llm").seen[0].provider, "p", "残缺覆盖回落 agentDefaultModel");
});

test("请求带 sessionId 时读取会话上下文并注入改写调用", async () => {
  const host = await import("../lib/index.js");

  const webServer = makeWebServer();
  const readCalls = [];
  const ctx = makeHostContext(webServer, {
    sessionQuery: {
      readSurface(sessionId) {
        readCalls.push(sessionId);
        return Promise.resolve({
          events: [
            { type: "user/message", data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "登录接口有时候 500" }] } },
          ],
        });
      },
    },
  });
  host.apply(ctx, { samples: false });
  const res = makeResponse();
  await webServer.routes[0].handler(makeRequest({ body: JSON.stringify({ text: "帮我修一下这个", sessionId: "s-1" }) }), res);

  assert.deepEqual(readCalls, ["s-1"]);
  const userPrompt = ctx.get("llm").seen[0].messages[0].content[0].text;
  assert.ok(userPrompt.includes("[user] 登录接口有时候 500"), "上下文进入了改写 prompt");

  // 不带 sessionId：不读会话
  const res2 = makeResponse();
  await webServer.routes[0].handler(makeRequest({ body: JSON.stringify({ text: "帮我看看这段代码" }) }), res2);
  assert.equal(readCalls.length, 1, "无 sessionId 不触发 readSurface");

  // sessionQuery 缺席：静默降级，优化照常
  const bare = makeWebServer();
  host.apply(makeHostContext(bare), { samples: false });
  const res3 = makeResponse();
  await bare.routes[0].handler(makeRequest({ body: JSON.stringify({ text: "帮我看看这段代码", sessionId: "s-2" }) }), res3);
  assert.equal(JSON.parse(res3.body).ok, true);

  // context: false 配置：即使有 sessionId 也不读
  const off = makeWebServer();
  const offCalls = [];
  host.apply(makeHostContext(off, {
    sessionQuery: { readSurface(id) { offCalls.push(id); return Promise.resolve({ events: [] }); } },
  }), { context: false, samples: false });
  const res4 = makeResponse();
  await off.routes[0].handler(makeRequest({ body: JSON.stringify({ text: "帮我看看这段代码", sessionId: "s-3" }) }), res4);
  assert.deepEqual(offCalls, [], "context:false 完全关闭会话读取");
});

test("readSurface 抛错时静默降级为无上下文", async () => {
  const host = await import("../lib/index.js");
  const webServer = makeWebServer();
  host.apply(makeHostContext(webServer, {
    sessionQuery: {
      readSurface() { return Promise.reject(new Error("corrupt log")); },
    },
  }), { samples: false });
  const res = makeResponse();
  await webServer.routes[0].handler(makeRequest({ body: JSON.stringify({ text: "帮我看看这段代码", sessionId: "s-x" }) }), res);
  assert.equal(JSON.parse(res.body).ok, true, "上下文失败不阻塞优化");
});

test("preservesAnchors：标识符/路径/数字一个都不能少", () => {
  const input = "把 src/utils/legacy.js 里的 formatDate 改成用 dayjs 实现";
  assert.equal(preservesAnchors(input, "把 src/utils/legacy.js 里的 formatDate 改成用 dayjs 实现。"), true);
  assert.equal(preservesAnchors(input, "请把 src/utils/legacy.js 中的 formatDate 改用 dayjs。"), true);
  // 内容词替换必须被发现（实测编辑距离容差放走过这一例）
  assert.equal(preservesAnchors(input, "把 src/utils/legacy.js 里的 formatDate 改成用 moment 实现"), false);
  assert.equal(preservesAnchors(input, "把 src/utils/legacy.js 里的 formatDate 改掉"), false, "丢掉 dayjs");
  // 数字同样算锚定
  assert.equal(preservesAnchors("修复 render 函数第 42 行的空指针", "修复 render 函数第 43 行的空指针"), false);
  assert.equal(preservesAnchors("修复 render 函数第 42 行的空指针", "修复 render 函数第 42 行的空指针异常。"), true);
});

test("反馈通道：同一条路由收隐式信号，落盘且不花模型调用", async () => {
  const host = await import("../lib/index.js");
  const dir = await mkdtemp(join(tmpdir(), "po-feedback-"));
  const file = join(dir, "samples.jsonl");
  try {
    const webServer = makeWebServer();
    const ctx = makeHostContext(webServer, { responses: [textChunks("不该被调用")] });
    host.apply(ctx, { samples: file });

    const res = makeResponse();
    await webServer.routes[0].handler(
      makeRequest({ body: JSON.stringify({ feedback: { kind: "reverted", tier: "full", charsDelta: 120, elapsedMs: 4200 } }) }),
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
    assert.equal(ctx.get("llm").seen.length, 0, "反馈不触发任何模型调用");

    const record = JSON.parse((await readFile(file, "utf8")).trim().split("\n")[0]);
    assert.equal(record.event, "feedback");
    assert.equal(record.kind, "reverted");
    assert.equal(record.tier, "full");
    assert.equal(record.charsDelta, 120);
    assert.equal(record.elapsedMs, 4200);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("每次优化都落盘：不只记拒绝，带 tier/mode/长度/耗时", async () => {
  const host = await import("../lib/index.js");
  const dir = await mkdtemp(join(tmpdir(), "po-events-"));
  const file = join(dir, "samples.jsonl");
  try {
    const webServer = makeWebServer();
    host.apply(
      makeHostContext(webServer, {
        responses: [textChunks("删除 src/utils/legacy.js 中未被引用的 export，然后跑测试确认没有破坏。"), textChunks("OK")],
      }),
      { samples: file },
    );
    const res = makeResponse();
    await webServer.routes[0].handler(
      makeRequest({ body: JSON.stringify({ text: "删除 src/utils/legacy.js 里未被引用的 export，跑一遍测试确认没破坏" }) }),
      res,
    );
    assert.equal(JSON.parse(res.body).ok, true);

    const record = JSON.parse((await readFile(file, "utf8")).trim().split("\n")[0]);
    assert.equal(record.event, "optimize");
    assert.equal(record.code, "ok");
    assert.equal(record.tier, "full");
    assert.equal(record.mode, "precise", "该输入命中精确模式");
    assert.ok(record.inputChars > 0 && record.outputChars > 0);
    assert.ok(typeof record.ms === "number");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("引用标记守恒规则写进了模板", () => {
  assert.ok(SYSTEM_SUFFIX.includes("@src/a.js"));
  assert.ok(SYSTEM_SUFFIX.includes("Never drop, translate, or reword one"));
});

test("路由在保真拒绝时把样本落盘（误拒的唯一证据来源）", async () => {
  const host = await import("../lib/index.js");
  const dir = await mkdtemp(join(tmpdir(), "po-route-samples-"));
  const file = join(dir, "samples.jsonl");
  try {
    const webServer = makeWebServer();
    // 审判两次都判 ADDED → 走到 fidelity_rejected
    host.apply(
      makeHostContext(webServer, {
        responses: [
          textChunks("请审查这个接口的安全问题，并给出修复建议。"),
          textChunks("DISTORTED: 把检查变成了安全审查"),
          textChunks("请审查这个接口的安全问题，并给出修复建议。"),
          textChunks("DISTORTED: 仍然把检查变成了安全审查"),
        ],
      }),
      { samples: file },
    );
    const res = makeResponse();
    await webServer.routes[0].handler(makeRequest({ body: JSON.stringify({ text: "帮我看看这个接口有没有问题" }) }), res);
    const body = JSON.parse(res.body);
    assert.equal(body.code, "fidelity_rejected");

    const lines = (await readFile(file, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1, "每次拒绝写一条");
    const record = JSON.parse(lines[0]);
    assert.equal(record.code, "fidelity_rejected");
    assert.equal(record.input, "帮我看看这个接口有没有问题");
    assert.ok(Array.isArray(record.added) && record.added.length > 0, "必须带审判抓到的条目");

    // samples:false 时不写
    const dir2 = await mkdtemp(join(tmpdir(), "po-route-samples-off-"));
    const file2 = join(dir2, "samples.jsonl");
    const webServer2 = makeWebServer();
    host.apply(makeHostContext(webServer2, {
      responses: [
        textChunks("请审查这个接口的安全问题，并给出修复建议。"),
        textChunks("DISTORTED: 把检查变成了安全审查"),
        textChunks("请审查这个接口的安全问题，并给出修复建议。"),
        textChunks("DISTORTED: 仍然把检查变成了安全审查"),
      ],
    }), { samples: false });
    const res2 = makeResponse();
    await webServer2.routes[0].handler(makeRequest({ body: JSON.stringify({ text: "帮我看看这个接口有没有问题" }) }), res2);
    assert.equal(JSON.parse(res2.body).code, "fidelity_rejected");
    await assert.rejects(readFile(file2, "utf8"), "samples:false 时不得创建样本文件");
    await rm(dir2, { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("客户端半区带隐式反馈与引用守恒逻辑", async () => {
  const bundle = await readFile(join(root, "lib", "client.js"), "utf8");
  // 三档隐式信号 + applied（客户端存活性证据）
  for (const kind of ["applied", "reverted", "retried", "submitted"]) {
    assert.ok(bundle.includes(`'${kind}'`), `缺少反馈信号 ${kind}`);
  }
  assert.ok(bundle.includes("FEEDBACK_WINDOW_MS"), "缺少反馈窗口常量");
  assert.ok(bundle.includes("丢失引用标记"), "缺少引用守恒校验");
  assert.ok(bundle.includes("nothing_to_optimize"), "内容下限必须走中性提示而不是红色故障");
});

test("lib/client.js 是合法的 __ModuleLoader__ 模块，id 与包名一致", async () => {
  const pkg = await readPackage();
  const source = await readFile(join(root, "lib/client.js"), "utf8");

  let entry;
  // eslint-disable-next-line no-new-func
  new Function("window", source)({ __ModuleLoader__: { load: (value) => { entry = value; } } });

  assert.ok(entry, "bundle 必须通过 window.__ModuleLoader__.load 注册");
  assert.equal(entry.id, pkg.name, "模块 id 必须是包名，否则 client-modules 的图对不上");
  assert.equal(typeof entry.factory, "function");
  // factory 只注册不执行：副作用必须留在 materialize 之后
  assert.ok(!/document\./.test(source.split("factory")[0]));
});

test("lib/client.js materialize 后导出可用的客户端插件，并注册按钮与样式", async () => {
  const source = await readFile(join(root, "lib/client.js"), "utf8");
  let entry;
  // eslint-disable-next-line no-new-func
  new Function("window", source)({ __ModuleLoader__: { load: (value) => { entry = value; } } });

  const fakeReact = { createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => {}, useRef: () => ({}) };
  const required = [];
  const exported = entry.factory((name) => {
    required.push(name);
    return fakeReact;
  });

  assert.deepEqual(required, ["react"], "react 是 shell 提供的 seed 模块，不需要声明为 external");
  assert.equal(exported.name, "prompt-seed");
  assert.deepEqual(exported.inject, ["slots"]);
  assert.equal(typeof exported.apply, "function");

  // 只注册一个槽位：输入框右侧的按钮。状态行（conversation.input.dock）在 0.8.4 试过，
  // 0.8.6 撤掉——全宽横幅为一行字占满整行，且它对"正在优化"这类瞬时状态毫无信息量。
  const slotNames = [];
  const fakeSlots = {
    inject(name, cb) { slotNames.push(name); cb(); },
    register() { return {}; },
  };
  const previousWindowForSlots = globalThis.window;
  globalThis.window = { localStorage: { getItem: () => null, setItem() {} } };
  try {
    exported.apply({ slots: fakeSlots, effect() {} });
  } finally {
    if (previousWindowForSlots === undefined) delete globalThis.window;
    else globalThis.window = previousWindowForSlots;
  }
  assert.deepEqual(slotNames, ["conversation.input.right"], "只挂按钮，不再挂状态行");

  const previousDocument = globalThis.document;
  const styleNodes = [];
  globalThis.document = {
    createElement() {
      return {
        attrs: {},
        textContent: "",
        setAttribute(key, value) {
          this.attrs[key] = value;
        },
        remove() {
          this.removed = true;
        },
      };
    },
    head: {
      appendChild(node) {
        styleNodes.push(node);
      },
    },
  };

  try {
    const injections = [];
    const registrations = [];
    const effects = [];
    const ctx = {
      slots: {
        inject(key, callback) {
          injections.push(key);
          callback();
        },
        register(options, render) {
          registrations.push(options);
          assert.equal(typeof render, "function");
          return () => {};
        },
      },
      effect(callback, label) {
        effects.push(label);
        return callback();
      },
    };

    exported.apply(ctx);

    assert.deepEqual(injections, ["conversation.input.right"]);
    assert.deepEqual(registrations, [{ name: "conversation.input.right", id: "prompt-seed", order: -10 }]);
    assert.deepEqual(effects, ["prompt-seed:styles"]);
    assert.equal(styleNodes.length, 1);
    assert.equal(styleNodes[0].attrs["data-dsh-plugin"], "prompt-seed");
    assert.ok(styleNodes[0].textContent.includes(".dsh-seed-btn"));
    assert.ok(styleNodes[0].textContent.includes("--dsw-alias-brand-primary"), "样式必须使用主题变量");
    // 拒绝态必须是中性色（红三角让人以为"功能坏了"，实测教训）
    assert.ok(styleNodes[0].textContent.includes('[data-mode="declined"]{color:var(--dsw-alias-label-secondary)'), "拒绝态必须中性");
    assert.ok(styleNodes[0].textContent.includes('[data-mode="error"]{color:var(--dsw-alias-state-error-primary)'), "红色只留给真错误");
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("浏览器半区请求的路由与 Host 半区的默认路由一致", async () => {
  const host = await import("../lib/index.js");
  const client = await readFile(join(root, "lib/client.js"), "utf8");
  // 两份产物分别编译，路由漂移会让按钮永远报错——这里锁死
  assert.ok(client.includes(host.DEFAULT_ROUTE), `客户端必须请求 ${host.DEFAULT_ROUTE}`);
});


// ---------------------------------------------------------------------------
// A–F 项新增能力
// ---------------------------------------------------------------------------

test("A 闸门凭证：审判的 DETAIL 行被解析成摘要，且不计入违规", () => {
  assert.deepEqual(parseAuditVerdict("OK\nDETAIL: 边界情况、失败处理"), {
    status: "ok",
    violations: [],
    thin: false,
    detail: "边界情况、失败处理",
  });
  // 摘要与违规可以共存
  const both = parseAuditVerdict("PADDED: 加了操作步骤\nDETAIL: 失败处理");
  assert.equal(both.status, "issues");
  assert.equal(both.detail, "失败处理");
  assert.equal(both.violations.length, 1);
  // "no change" 不当作摘要
  assert.equal(parseAuditVerdict("OK\nDETAIL: no change").detail, "");
  // 裸 OK 仍然必须被识别（曾因重写解析器丢失，测试锁死）
  assert.equal(parseAuditVerdict("OK").status, "ok");
  assert.equal(parseAuditVerdict("OK.").status, "ok");
});

test("A 闸门凭证：摘要随成功结果回传", async () => {
  const llm = scriptedLlm([
    textChunks("请检查这个登录接口是否存在问题，并说明出现在哪里。"),
    textChunks("OK\nDETAIL: 出错位置与复现条件"),
  ]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: "帮我看看这个登录接口有没有问题" });
  assert.equal(result.ok, true);
  assert.equal(result.detail, "出错位置与复现条件");
  assert.equal(result.gate.verdict, "ok");
});

test("修复稿一律复核：scope_added（过度发散）不得免检直接交付", async () => {
  // 回归守卫。0.8.0 曾对结构型越线跳过复核以省一次调用，实测代价是线上一次
  // scope_added 的修复稿未经复核就交付——而旧版本会复核、仍越线则拒绝并保留原文。
  // 省下的那次调用恰好省在唯一拦住"越修越发散"的环节上。
  const input = "帮我看看这个登录接口有没有问题";
  const llm = scriptedLlm([
    textChunks("请审查这个登录接口的安全问题，并给出修复建议与实施排期。"),
    textChunks("SCOPE_ADDED: 实施排期"),
    textChunks("请检查这个登录接口是否存在问题，并说明出现在哪里。"),
    textChunks("OK"),
  ]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: input });
  assert.equal(llm.seen.length, 4, "修复后必须复核：4 次调用");
  assert.equal(result.ok, true);
  assert.equal(result.tier, "repaired");
  assert.equal(result.gate.rechecked, true, "复核过就必须标注 rechecked=true");
  assert.deepEqual(result.gate.violations, [{ kind: "scope_added", text: "实施排期" }]);
});

test("修复稿复核仍越线：拒绝并保留原文（发散控制不得被延迟优化吃掉）", async () => {
  const input = "帮我做个图片压缩的功能";
  const llm = scriptedLlm([
    textChunks("请实现一个图片压缩服务：支持上传压缩、断点续传、CDN 分发，并提供压缩率报表。"),
    textChunks("SCOPE_ADDED: CDN 分发"),
    textChunks("请实现图片压缩并分发到 CDN。"),
    textChunks("SCOPE_ADDED: CDN 分发"),
  ]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: input });
  assert.equal(result.ok, false);
  assert.equal(result.code, ERROR_CODES.FIDELITY_REJECTED);
  assert.equal(result.text, undefined, "拒绝时绝不带 text");
  assert.ok(typeof result.rejected === "string" && result.rejected !== "");
});

test("D/E 深度档位：标准档为空（等于基线），轻/深度档才偏离", () => {
  assert.ok(DEPTH_LIGHT_SUFFIX.includes("DEPTH - LIGHT"));
  assert.ok(DEPTH_DEEP_SUFFIX.includes("DEPTH - DEEP"));
  assert.ok(!DEPTH_LIGHT_SUFFIX.includes("DEPTH - DEEP"));
  // 标准档不加任何后缀：默认路径的 prompt 必须与引入深度档位之前逐字节相同。
  // 这是"回到之前那版效果"唯一可靠的实现方式——任何附加说明都是对模型的又一次干预。
  assert.equal(DEPTH_STANDARD_SUFFIX, "", "标准档必须为空");
  assert.equal(depthSuffix("standard"), "");
  assert.equal(depthSuffix(undefined), "");
  assert.equal(depthSuffix("deep"), DEPTH_DEEP_SUFFIX);
  assert.equal(depthSuffix("light"), DEPTH_LIGHT_SUFFIX);
  assert.equal(depthSuffix(undefined), depthSuffix("standard"));
  assert.equal(depthSuffix("garbage"), depthSuffix("standard"));
});

test("D 深度档位随请求下发到 system prompt", async () => {
  const llm = scriptedLlm([
    textChunks("帮我做一个导出报表功能：支持选择时间范围与统计维度，导出 CSV 与 Excel。"),
    textChunks("OK"),
  ]);
  await optimizePromptText({ llm, route: ROUTE, text: "帮我做个导出报表的功能", depth: "deep" });
  assert.ok(llm.seen[0].system.includes("DEPTH - DEEP"));
  assert.ok(!llm.seen[0].system.includes("DEPTH - LIGHT"));
});

test("F 模板覆盖层：覆盖后立即生效，清除后回落内置", () => {
  const llm = scriptedLlm([textChunks("改写结果文本"), textChunks("OK")]);
  setTemplateOverrides({ system: "CUSTOM SYSTEM CONTRACT" });
  assert.ok(buildSystemPrompt().startsWith("CUSTOM SYSTEM CONTRACT"));
  assert.ok(buildSystemPrompt().includes(SYSTEM_SUFFIX), "部署级追加约束必须保留");
  setTemplateOverrides(null);
  assert.ok(buildSystemPrompt().startsWith(SYSTEM_TEMPLATE));
  assert.equal(buildSystemPrompt(), SYSTEM_TEMPLATE + SYSTEM_SUFFIX);
  assert.equal(llm.seen.length, 0);
});

test("F 模板覆盖层可覆盖 user 模板且保留 {input} 占位", () => {
  setTemplateOverrides({ user: "自定义前缀\n{input}" });
  const rendered = renderUserPrompt("原始草稿", undefined);
  assert.ok(rendered.includes("自定义前缀"));
  assert.ok(rendered.includes("原始草稿"));
  setTemplateOverrides(null);
  assert.ok(renderUserPrompt("原始草稿", undefined).includes("原始草稿"));
});

test("E 按需上下文：短草稿与指代才需要会话，自足描述不需要", () => {
  assert.equal(needsContext("帮我看看这个"), true, "短草稿必然依赖上文");
  assert.equal(needsContext("把那个接口改一下"), true, "指代词命中");
  assert.equal(needsContext("fix that bug in the parser"), true, "英文指代同样命中");
  assert.equal(
    needsContext("在 src/utils/format.js 里新增一个 formatBytes 函数，输入字节数返回可读字符串，并补单元测试"),
    false,
    "自足描述不该白读会话",
  );
  assert.equal(needsContext(""), false);
});

test("E 精确指令一律视为自足：不读会话（省一次 readSurface）", async () => {
  const host = await import("../lib/index.js");
  const webServer = makeWebServer();
  const readCalls = [];
  host.apply(
    makeHostContext(webServer, {
      sessionQuery: {
        readSurface(id) { readCalls.push(id); return Promise.resolve({ events: [] }); },
      },
    }),
    { samples: false },
  );
  const res = makeResponse();
  await webServer.routes[0].handler(
    makeRequest({ body: JSON.stringify({ text: "删除 src/utils/legacy.js 里未被引用的 export，跑一遍测试确认没破坏", sessionId: "s-1" }) }),
    res,
  );
  assert.deepEqual(readCalls, [], "精确指令指名道姓，不需要上文");
});

test("E 指代草稿仍然读会话（按需注入不能把有用的上下文一起砍掉）", async () => {
  const host = await import("../lib/index.js");
  const webServer = makeWebServer();
  const readCalls = [];
  host.apply(
    makeHostContext(webServer, {
      sessionQuery: {
        readSurface(id) { readCalls.push(id); return Promise.resolve({ events: [] }); },
      },
    }),
    { samples: false },
  );
  const res = makeResponse();
  await webServer.routes[0].handler(makeRequest({ body: JSON.stringify({ text: "把那个接口加上限流", sessionId: "s-2" }) }), res);
  assert.deepEqual(readCalls, ["s-2"]);
});

test("F 模板覆盖：从 $DSH_HOME 读取，改完立刻生效（不必重启）", async () => {
  const host = await import("../lib/index.js");
  const dir = await mkdtemp(join(tmpdir(), "po-templates-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    const prompts = join(dir, "prompt-seed", "prompts");
    await mkdir(prompts, { recursive: true });
    await writeFile(join(prompts, "system.md"), "OVERRIDDEN CONTRACT", "utf8");

    const llm = scriptedLlm([
      textChunks("请检查这段代码是否存在问题，并说明出现在哪里。"),
      textChunks("OK"),
    ]);
    const webServer = makeWebServer();
    host.apply(makeHostContext(webServer, { llm }), { samples: false });

    const res = makeResponse();
    await webServer.routes[0].handler(makeRequest({ body: JSON.stringify({ text: "帮我看看这段代码" }) }), res);
    assert.equal(res.statusCode, 200);
    assert.ok(llm.seen[0].system.startsWith("OVERRIDDEN CONTRACT"), "覆盖文件必须真的进入 system prompt");
    assert.ok(llm.seen[0].system.includes("Never drop, translate, or reword one"), "部署级追加约束仍在");

    // 改完立刻生效：不重启、不重新 apply
    await writeFile(join(prompts, "system.md"), "SECOND CONTRACT", "utf8");
    llm.seen.length = 0;
    const res2 = makeResponse();
    await webServer.routes[0].handler(makeRequest({ body: JSON.stringify({ text: "帮我看看这段代码" }) }), res2);
    assert.ok(llm.seen[0].system.startsWith("SECOND CONTRACT"), "每次请求重读模板，改完下一次点击即生效");

    // 删除覆盖文件 → 回落内置模板
    await rm(join(prompts, "system.md"));
    llm.seen.length = 0;
    const res3 = makeResponse();
    await webServer.routes[0].handler(makeRequest({ body: JSON.stringify({ text: "帮我看看这段代码" }) }), res3);
    assert.ok(llm.seen[0].system.startsWith(SYSTEM_TEMPLATE.slice(0, 40)), "文件缺失即回落内置");
    setTemplateOverrides(null);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("F 模板覆盖可用 templates:false 整体关闭", async () => {
  const host = await import("../lib/index.js");
  const dir = await mkdtemp(join(tmpdir(), "po-templates-off-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    const prompts = join(dir, "prompt-seed", "prompts");
    await mkdir(prompts, { recursive: true });
    await writeFile(join(prompts, "system.md"), "SHOULD NOT APPLY", "utf8");
    const llm = scriptedLlm([
      textChunks("请检查这段代码是否存在问题，并说明出现在哪里。"),
      textChunks("OK"),
    ]);
    const webServer = makeWebServer();
    host.apply(makeHostContext(webServer, { llm }), { samples: false, templates: false });
    const res = makeResponse();
    await webServer.routes[0].handler(makeRequest({ body: JSON.stringify({ text: "帮我看看这段代码" }) }), res);
    assert.ok(!llm.seen[0].system.includes("SHOULD NOT APPLY"));
    setTemplateOverrides(null);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("F 被拒版本随结果回传，且绝不占用 text 字段（不变量 I1）", async () => {
  const input = "调研一下这个功能该怎么开发";
  const invented1 = "请调研该功能的主流实现方案，输出对比表格，评估优缺点与风险。";
  const invented2 = "请调研该功能并整理成对比表格，同时给出选型建议。";
  const llm = scriptedLlm([
    textChunks(invented1),
    textChunks("DISTORTED: 把调研改成了实施"),
    textChunks(invented2),
    textChunks("DISTORTED: 仍然把调研当成实施任务"),
  ]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: input });
  assert.equal(result.ok, false);
  assert.equal(result.text, undefined, "拒绝时绝不能带 text（客户端可能误写回）");
  assert.equal(result.rejected, invented2, "被拒版本走独立字段，只在用户显式查看时才用");
});

test("D 深度档位非法值安全降级为标准档（旧客户端兼容）", async () => {
  const llm = scriptedLlm([
    textChunks("帮我做一个导出报表功能：支持选择时间范围与统计维度，导出 CSV 与 Excel。"),
    textChunks("OK"),
  ]);
  await optimizePromptText({ llm, route: ROUTE, text: "帮我做个导出报表的功能", depth: "ultra" });
  // 非法值 → 标准档 → 无后缀：system prompt 里不该出现任何 DEPTH 块
  assert.ok(!llm.seen[0].system.includes("DEPTH - "), "非法值必须降级到不加后缀的基线");
  assert.equal(llm.seen[0].system, buildSystemPromptFor("帮我做个导出报表的功能"));
});

test("codeVersion 报的是本进程加载的代码版本，不是磁盘上的 package.json", async () => {
  const host = await import("../lib/index.js");
  const pkg = await readPackage();
  // 模块加载时冻结：文件内容改变不影响已加载实例的报告值（这正是它的用途——
  // 区分"装上了新版"和"跑的是新版"）。
  const loaded = host.codeVersion();
  assert.equal(loaded, pkg.version);

  // 决定性回归：模块已加载后改写磁盘上的 package.json，报告值必须不变。
  // 旧实现每次现读磁盘 → 装了新版但跑着旧代码时会报新版本号，把排查带进沟里。
  const file = join(root, "package.json");
  const original = await readFile(file, "utf8");
  try {
    await writeFile(file, original.replace(/"version": "[^"]+"/, '"version": "99.99.99"'), "utf8");
    assert.equal(host.codeVersion(), loaded, "codeVersion 必须在模块加载时冻结，不得现读磁盘");
    assert.notEqual(host.codeVersion(), "99.99.99");
  } finally {
    await writeFile(file, original, "utf8");
  }
  assert.equal(JSON.parse(await readFile(file, "utf8")).version, pkg.version, "package.json 必须复原");
});

test("客户端按钮真的渲染出正确形态（空草稿常驻、有内容微光、凭证标记）", async () => {
  const source = await readFile(join(root, "lib", "client.js"), "utf8");
  let entry;
  // eslint-disable-next-line no-new-func
  new Function("window", source)({ __ModuleLoader__: { load: (value) => { entry = value; } } });

  // 极简 React 替身：只记录元素树，不做调和。
  const React = {
    createElement(type, props, children) {
      // 函数组件必须真的被调用（槽位注册的 render 是包了一层的函数，不会自动执行）。
      if (typeof type === "function") return type(props || {});
      return { type, props: props || {}, children: children === undefined ? [] : [].concat(children) };
    },
    useState(initial) { return [typeof initial === "function" ? initial() : initial, () => {}]; },
    useRef(value) { return { current: value }; },
    useEffect() {},
  };
  const exported = entry.factory(() => React);

  const registered = [];
  const slots = {
    inject(name, cb) { registered.push({ name, value: cb() }); },
    register(meta, render) { return { meta, render }; },
  };
  exported.apply({ slots, effect() {} });
  assert.equal(registered.length, 1, "只注册一个槽位");
  const render = registered[0].value.render;

  const previousWindow = globalThis.window;
  globalThis.window = { localStorage: { getItem: () => null, setItem() {} } };
  try {
    const makeProps = (draft) => ({
      useInput(selector) { return selector({ draft, draftRev: 1, phase: "plain", occurrences: [] }); },
      inputActions: { setDraft() {}, addAttachments() {}, removeAttachment() {}, pruneAttachments() {} },
      t: (key) => key,
    });

    // 空草稿：仍然渲染（旧实现 return null 会闪进闪出），并标成空态
    const empty = render(makeProps(""));
    const emptyButton = empty.type === "button" ? empty : empty.children[0];
    assert.equal(emptyButton.props["data-testid"], "prompt-seed-button");
    assert.equal(emptyButton.props["data-empty"], "1", "空草稿必须常驻而不是整块消失");

    // 有内容：微光开启、报出深度档位
    const idle = render(makeProps("帮我做个导出报表的功能"));
    assert.equal(idle.type, "button", "空闲态只有一个主按钮");
    assert.equal(idle.props["data-empty"], "0");
    assert.equal(idle.props["data-glow"], "1", "有内容且空闲时给呼吸微光");
    assert.ok(String(idle.props.title).includes("深度："), "tooltip 必须报出当前深度档位");
    assert.ok(String(idle.props.title).includes("右键切换"), "深度切换入口必须在 tooltip 里说明");
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("客户端半区包含 B/D/F 三项的界面与状态逻辑（防误删守卫）", async () => {
  const bundle = await readFile(join(root, "lib", "client.js"), "utf8");
  for (const marker of [
    "dsh-opt-secondary",
    "prompt-seed-regenerate",
    "prompt-seed-previous",
    "prompt-seed-view-rejected",
    "HISTORY_MAX",
    "resolveDepth",
    "storedDepthMode",
    "autoDepth",
    "onContextMenu",
    "dsh-opt-gate",
  ]) {
    assert.ok(bundle.includes(marker), `客户端半区缺少 ${marker}`);
  }
  // 请求必须真的下发深度档位，否则 D 项只是死代码
  assert.ok(bundle.includes("depth:"), "请求体必须带 depth");
  // 空草稿常驻而不是整块消失
  assert.ok(!bundle.includes("!hasContent) return null"), "按钮不得在空草稿时整块消失");
});


// ---------------------------------------------------------------------------
// 开源准备：能力探测 + 优雅自禁用
// ---------------------------------------------------------------------------

test("宿主缺 webServer 接缝时自禁用，绝不抛异常拖垮宿主启动", async () => {
  const host = await import("../lib/index.js");
  const logged = [];
  const previousError = console.error;
  console.error = (...args) => logged.push(args);
  const ctx = {
    // 旧宿主：没有 webServer 服务
    get: () => undefined,
    effect: (fn) => fn(),
    on: () => {},
  };
  try {
    assert.doesNotThrow(() => host.apply(ctx, { samples: false }), "宿主启动是 all-or-nothing，插件绝不能抛");
  } finally {
    console.error = previousError;
  }
  assert.ok(logged.length > 0, "自禁用必须留下可读原因，而不是静默什么都不做");
  assert.ok(JSON.stringify(logged).includes("webServer"), "原因里必须点名缺的是哪个接缝");
  assert.ok(JSON.stringify(logged).includes("0.2.0-rc.1"), "原因里必须带上宿主要求，便于用户自查版本");
});

test("宿主缺 ctx.effect 时拒绝注册无法回收的路由", async () => {
  const host = await import("../lib/index.js");
  const routes = [];
  const logged = [];
  const previousError = console.error;
  console.error = (...args) => logged.push(args);
  const ctx = {
    webServer: { register: (r) => { routes.push(r); return () => {}; } },
    get: () => undefined,
    // 没有 effect：注册出来的路由无法随 fiber 回收，宁可不禁用也不能留下幽灵路由
  };
  try {
    assert.doesNotThrow(() => host.apply(ctx, { samples: false }));
  } finally {
    console.error = previousError;
  }
  assert.equal(routes.length, 0, "不得注册无法回收的路由");
  assert.ok(JSON.stringify(logged).includes("effect"));
});

test("正常宿主仍然完整注册（自禁用不得误伤）", async () => {
  const host = await import("../lib/index.js");
  const webServer = makeWebServer();
  host.apply(makeHostContext(webServer), { samples: false });
  assert.equal(webServer.routes.length, 1);
  assert.equal(webServer.routes[0].path, "/api/prompt-seed/optimize");
});

test("客户端半区缺 slots 服务时警告并退出，不抛异常", async () => {
  const source = await readFile(join(root, "lib", "client.js"), "utf8");
  let entry;
  // eslint-disable-next-line no-new-func
  new Function("window", source)({ __ModuleLoader__: { load: (value) => { entry = value; } } });
  const React = { createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => {}, useRef: () => ({}) };
  const exported = entry.factory(() => React);
  const warnings = [];
  const previousWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    assert.doesNotThrow(() => exported.apply({ effect() {} }), "缺 slots 时不得抛");
    assert.ok(warnings.length > 0, "必须说明按钮为什么没挂上");
    assert.ok(JSON.stringify(warnings).includes("slots"));
  } finally {
    console.warn = previousWarn;
  }
});


test("修复契约含保守兜底：修不动就给轻润色稿，而不是赌第二次拒绝", () => {
  assert.ok(REPAIR_SUFFIX.includes("lightly polished version of the user's original request"));
  assert.ok(REPAIR_SUFFIX.includes("Do not gamble on keeping the flagged material"));
  // 兜底不能与"保留已补细节"的主指令冲突到自相矛盾：主指令仍在
  assert.ok(REPAIR_SUFFIX.includes("KEEP the detail that was NOT flagged"));
});




test("拒绝时样本日志记录越线类别（诊断一次真实拒绝时最需要的字段）", async () => {
  const host = await import("../lib/index.js");
  const dir = await mkdtemp(join(tmpdir(), "po-reject-log-"));
  const file = join(dir, "samples.jsonl");
  try {
    const webServer = makeWebServer();
    host.apply(
      makeHostContext(webServer, {
        responses: [
          textChunks("请审查这个接口的安全问题，并给出修复建议与实施排期。"),
          textChunks("SCOPE_ADDED: 实施排期"),
          textChunks("请审查这个接口的安全问题，并给出修复建议。"),
          textChunks("SCOPE_ADDED: 实施排期"),
        ],
      }),
      { samples: file },
    );
    const res = makeResponse();
    await webServer.routes[0].handler(makeRequest({ body: JSON.stringify({ text: "帮我看看这个接口有没有问题" }) }), res);
    const body = JSON.parse(res.body);
    assert.equal(body.code, "fidelity_rejected");
    assert.deepEqual(body.violations.map((v) => v.kind), ["scope_added"], "响应带结构化违规");
    assert.equal(body.violations[0].label, "增加了原本没有的要求", "客户端直接用中文类别渲染");

    const record = JSON.parse((await readFile(file, "utf8")).trim().split("\n")[0]);
    assert.equal(record.code, "fidelity_rejected");
    assert.deepEqual(record.violations, ["scope_added"], "日志必须记下类别，而不是空数组");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("样本记录区分界面调用与脚本探针（否则验证脚本会淹没真实使用分布）", async () => {
  const host = await import("../lib/index.js");
  const dir = await mkdtemp(join(tmpdir(), "po-from-"));
  const file = join(dir, "samples.jsonl");
  try {
    const webServer = makeWebServer();
    host.apply(makeHostContext(webServer), { samples: file });
    // 带 sessionId = 界面点击
    const uiRes = makeResponse();
    await webServer.routes[0].handler(makeRequest({ body: JSON.stringify({ text: "帮我看看这段代码", sessionId: "s-9" }) }), uiRes);
    // 不带 sessionId = 脚本直接打路由
    const scriptRes = makeResponse();
    await webServer.routes[0].handler(makeRequest({ body: JSON.stringify({ text: "帮我看看这段代码" }) }), scriptRes);

    const lines = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].from, "ui", "带 sessionId 记为界面调用");
    assert.equal(lines[1].from, "script", "不带 sessionId 记为脚本探针");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// 信号与短指令推断（0.9.0）
// --------------------------------------------------------------------------

import {
  DEICTIC_FALLBACK_MARKER,
  SIGNAL_FALLBACK_MARKER,
  classifySignalInput,
  checkDeicticDegree,
  checkSignalOutput,
  describeMode,
  extractAssistantTail,
  inferPendingItem,
  parseOptions,
} from "../src/signal-inference.js";

test("classifySignalInput 分类纯数字/信号词/短指令/其他", () => {
  assert.equal(classifySignalInput("42").kind, "number");
  assert.equal(classifySignalInput("1").kind, "number");
  assert.equal(classifySignalInput("3.14").kind, "number");
  assert.equal(classifySignalInput("继续").kind, "signal");
  assert.equal(classifySignalInput("ok").kind, "signal");
  assert.equal(classifySignalInput("改一下").kind, "deictic");
  assert.equal(classifySignalInput("不对").kind, "deictic");
  assert.equal(classifySignalInput("换一个").kind, "deictic");
  // 不该命中的：普通种子、带锚定的精确指令、问句、长句
  assert.equal(classifySignalInput("帮我做个图片压缩").kind, "none");
  assert.equal(classifySignalInput("删除 src/utils/legacy.js 的导出").kind, "none");
  assert.equal(classifySignalInput("这样对吗").kind, "none");
  assert.equal(classifySignalInput("把整个导出报表模块重写成异步队列").kind, "none");
  assert.equal(describeMode("42"), "signal");
  assert.equal(describeMode("改一下"), "deictic");
  assert.equal(describeMode("帮我做个功能"), null);
});

test("parseOptions 解析行内与圈号选项，切在下一个选项标记处", () => {
  const map = parseOptions("要不要继续？1. 继续梳理剩余功能 2. 先停下来");
  assert.equal(map.get("1"), "继续梳理剩余功能");
  assert.equal(map.get("2"), "先停下来");
  const circled = parseOptions("选一个：①本地缓存 ②服务端缓存");
  assert.equal(circled.get("1"), "本地缓存");
  assert.equal(circled.get("2"), "服务端缓存");
});

test("纯数字无上下文 → cannot_infer，零模型调用", async () => {
  const llm = fakeLlm([]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: "42" });
  assert.equal(result.ok, false);
  assert.equal(result.code, ERROR_CODES.CANNOT_INFER);
  assert.equal(llm.seen.length, 0, "无上下文时不得发起任何模型调用");
});

test("数字对不上任何选项 → cannot_infer，绝不硬猜", async () => {
  const llm = fakeLlm([]);
  const assistantTail = { role: "assistant", text: "要不要继续？1. 继续梳理剩余功能 2. 先停下来" };
  const result = await optimizePromptText({ llm, route: ROUTE, text: "42", assistantTail });
  assert.equal(result.ok, false);
  assert.equal(result.code, ERROR_CODES.CANNOT_INFER);
  assert.equal(llm.seen.length, 0, "42 对应不上选项是确定性判定，不应花调用");
});

test("数字命中选项 → 展开为选中项，锚定校验通过", async () => {
  const llm = fakeLlm(textChunks("继续，把剩下的功能梳理完。"));
  const assistantTail = { role: "assistant", text: "要不要继续？1. 继续梳理剩余功能 2. 先停下来" };
  const result = await optimizePromptText({ llm, route: ROUTE, text: "1", assistantTail });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "signal");
  assert.equal(result.tier, "signal");
  assert.equal(llm.seen.length, 1);
  assert.ok(result.text.includes("梳理"), "输出必须锚定在选项文本上");
});

test("模型回执 [无法推断] → 转为 cannot_infer", async () => {
  const llm = fakeLlm(textChunks(SIGNAL_FALLBACK_MARKER));
  const assistantTail = { role: "assistant", text: "要不要继续？1. 继续梳理 2. 先停" };
  const result = await optimizePromptText({ llm, route: ROUTE, text: "1", assistantTail });
  assert.equal(result.ok, false);
  assert.equal(result.code, ERROR_CODES.CANNOT_INFER);
});

test("信号输出未锚定上下文 → cannot_infer", async () => {
  const llm = fakeLlm(textChunks("帮我重新部署服务器并检查全部日志。"));
  const assistantTail = { role: "assistant", text: "要不要继续？1. 继续梳理剩余功能 2. 先停下来" };
  const result = await optimizePromptText({ llm, route: ROUTE, text: "1", assistantTail });
  assert.equal(result.ok, false);
  assert.equal(result.code, ERROR_CANNOT_INFER_REF(), "无锚点的输出宁可拒绝");
});

function ERROR_CANNOT_INFER_REF() {
  return ERROR_CODES.CANNOT_INFER;
}

test("信号词 继续 + 助手待续提议 → 展开为放行动作", async () => {
  const llm = fakeLlm(textChunks("继续，按刚才说的把插件发到 npm。"));
  const assistantTail = { role: "assistant", text: "已经打包好了，要不要继续发布到 npm？" };
  const result = await optimizePromptText({ llm, route: ROUTE, text: "继续", assistantTail });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "signal");
  assert.ok(result.text.includes("npm"));
});

test("短指令无上下文 → cannot_infer，零模型调用", async () => {
  const llm = fakeLlm([]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: "改一下" });
  assert.equal(result.ok, false);
  assert.equal(result.code, ERROR_CODES.CANNOT_INFER);
  assert.equal(llm.seen.length, 0);
});

test("短指令 + 上下文 → 有度展开，动词逐字保留", async () => {
  const llm = fakeLlm(textChunks("把刚才那个按钮的红色再改一下，先给我两三个候选颜色。"));
  const context = [{ role: "user", text: "刚才把按钮颜色改成了红色" }];
  const result = await optimizePromptText({ llm, route: ROUTE, text: "改一下", context });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "deictic");
  assert.ok(result.text.includes("改"), "动词必须逐字保留");
  assert.ok(result.text.length <= 180);
  assert.equal(llm.seen.length, 1);
});

test("短指令发散越界 → 一次收紧重试，成功则带 repairs=1", async () => {
  const overlong = "把按钮改成 #2F6FED，同步更新 hover 态、禁用态、加载态的配色，把全站色彩统一到新的设计规范，重做图标体系，调整间距与圆角，补充完整的变更说明文档，并把这次改动写进里程碑计划、通知设计团队评审、安排灰度发布与回滚预案，同时把导航栏和侧边栏也一起重构，输出迁移计划与风险清单，顺便把首页的营销位、活动页和落地页也按同一套视觉重新排版，拉齐埋点口径与数据看板，最后组织一次全员设计走查确认无遗漏再上线。";
  assert.ok(overlong.length > 180, "测试前提：越界文本必须真的超过 180 字上限（实际 " + overlong.length + "）");
  const llm = scriptedLlm([
    textChunks(overlong),
    textChunks("把刚才那个按钮的颜色再改一下，先给我几个候选。"),
  ]);
  const context = [{ role: "user", text: "刚才把按钮颜色改成了红色" }];
  const result = await optimizePromptText({ llm, route: ROUTE, text: "改一下", context });
  assert.equal(result.ok, true);
  assert.equal(result.gate.repairs, 1);
  assert.equal(result.gate.rechecked, true);
  assert.equal(llm.seen.length, 2);
});

test("短指令两次越界 → fidelity_rejected", async () => {
  const overlong = "把按钮改成 #2F6FED，同步更新 hover 态、禁用态、加载态的配色，把全站色彩统一到新的设计规范，重做图标体系，调整间距与圆角，补充完整的变更说明文档，并把这次改动写进里程碑计划、通知设计团队评审、安排灰度发布与回滚预案，同时把导航栏和侧边栏也一起重构，输出迁移计划与风险清单，并把页脚、弹窗、下拉菜单、表格、表单控件全部对齐同一套设计 token，生成前后对比截图。";
  assert.ok(overlong.length > 180, "测试前提：越界文本必须真的超过 180 字上限");
  const llm = scriptedLlm([textChunks(overlong), textChunks(overlong)]);
  const context = [{ role: "user", text: "刚才把按钮颜色改成了红色" }];
  const result = await optimizePromptText({ llm, route: ROUTE, text: "改一下", context });
  assert.equal(result.ok, false);
  assert.equal(result.code, ERROR_CODES.FIDELITY_REJECTED);
});

test("短指令指代消解失败回执 → cannot_infer", async () => {
  const llm = fakeLlm(textChunks(DEICTIC_FALLBACK_MARKER));
  const context = [{ role: "user", text: "随便一段无关上下文" }];
  const result = await optimizePromptText({ llm, route: ROUTE, text: "改一下", context });
  assert.equal(result.ok, false);
  assert.equal(result.code, ERROR_CODES.CANNOT_INFER);
});

test("extractAssistantTail 提取最近助手文本话轮并跳过空内容", () => {
  const surface = {
    events: [
      { type: "user/message", data: { role: "user", content: "帮我看看" } },
      { type: "assistant/message", data: { role: "assistant", content: [{ type: "text", text: "" }] } },
      { type: "assistant/message", data: { role: "assistant", content: [{ type: "text", text: "要不要继续？1. 继续 2. 停" }] } },
    ],
  };
  const tail = extractAssistantTail(surface);
  assert.equal(tail?.role, "assistant");
  assert.ok(tail.text.includes("要不要继续"));
  assert.equal(extractAssistantTail(null), undefined);
  assert.equal(extractAssistantTail({ events: [] }), undefined);
});

test("inferPendingItem 优先级：选项 > 助手问题 > 用户未答问题", () => {
  const assistantTail = { role: "assistant", text: "要继续吗？1. 打包 2. 先停" };
  assert.equal(inferPendingItem({ kind: "number", token: "1" }, undefined, assistantTail).mode, "choice");
  const question = { role: "assistant", text: "这个月几号发布？" };
  assert.equal(inferPendingItem({ kind: "number", token: "15" }, undefined, question).mode, "answer");
  const userQ = [{ role: "user", text: "这个插件叫什么名字？" }];
  assert.equal(inferPendingItem({ kind: "number", token: "42" }, userQ, undefined).mode, "continue");
  assert.equal(inferPendingItem({ kind: "deictic", token: "改一下" }, undefined, undefined).mode, "none");
});

test("checkDeicticDegree 的动词守恒与上限独立可测", () => {
  assert.equal(checkDeicticDegree("把红色再改一下，给我候选色。", "改一下").ok, true);
  assert.equal(checkDeicticDegree("调整一下样式。", "改一下").reason, "verb_missing");
  assert.equal(checkDeicticDegree("x".repeat(200), "改一下").reason, "overlong");
  assert.equal(checkSignalOutput("继续梳理。", "1", "继续梳理剩余功能", "choice").ok, true);
  assert.equal(checkSignalOutput("十五号。", "15", "几号发布？", "answer").reason, "token_missing");
});

// --------------------------------------------------------------------------
// 会话消息分支（0.9.1）
// --------------------------------------------------------------------------

import { isConversationalMessage } from "../src/signal-inference.js";

test("isConversationalMessage 识别真实病灶输入", () => {
  // 真实事故样本（日志原句）
  assert.equal(isConversationalMessage("还有一些问题，刚才我想问你的准确的是如何进行开源？是直接把仓库上传到GitHub上吗？"), true);
  assert.equal(isConversationalMessage("但是我为什么觉得实际优化效果好像还不如之前的？这是怎么回事？"), true);
  assert.equal(isConversationalMessage("你继续看一下这个项目，梳理一下现在的进度和代码结构，然后告诉我该怎么继续推进。"), true);
  assert.equal(isConversationalMessage("我觉得深度模式的输出还是太长了"), true);
  assert.equal(isConversationalMessage("这个方案该不该现在就定下来？"), true);
});

test("isConversationalMessage 不吞种子和精确指令", () => {
  assert.equal(isConversationalMessage("帮我做个图片压缩的功能"), false);
  assert.equal(isConversationalMessage("给设置页加个深色模式开关"), false);
  assert.equal(isConversationalMessage("怎么做一个图片压缩功能？"), false, "带任务动词的问句是种子");
  assert.equal(isConversationalMessage("删除 src/utils/legacy.js 里未被引用的 export，跑一遍测试确认没破坏"), false);
  assert.equal(isConversationalMessage("登录"), false);
});

test("describeMode 覆盖 conversational", () => {
  assert.equal(describeMode("这是怎么回事？"), "conversational");
  assert.equal(describeMode("帮我做个功能"), null);
});

test("会话消息模型原样返回 → 未改动，单次调用", async () => {
  const input = "还有一些问题，刚才我想问你的准确的是如何进行开源？";
  const llm = fakeLlm(textChunks(input));
  const result = await optimizePromptText({ llm, route: ROUTE, text: input });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "conversational");
  assert.equal(result.text, input);
  assert.ok(result.detail.includes("未改动"));
  assert.equal(llm.seen.length, 1);
});

test("会话消息轻润色在限度内 → 采纳润色稿", async () => {
  const input = "还有一些问题，刚才我想问你的准确的是如何进行开源？";
  const polished = "还有一个问题：刚才我想问你的准确的是如何进行开源？";
  const llm = fakeLlm(textChunks(polished));
  const result = await optimizePromptText({ llm, route: ROUTE, text: input });
  assert.equal(result.ok, true);
  assert.equal(result.text, polished);
  assert.ok(result.text.length <= Math.ceil(input.length * 1.35) + 6);
});

test("会话消息被模型改写成任务书 → 越限两次 → 兜底返回原文（永不拒绝）", async () => {
  const input = "刚才我想问的准确的是如何进行开源？";
  const taskSpec = "请评估开源流程：第一步在 GitHub 创建公开仓库并推送 main 分支；第二步执行 npm publish --access public 发布安装包；第三步向 awesome-dsh-plugin 提交收录 PR，并附上一句话英文描述与安装验证命令，确保 dsh plugin add 可直接安装；第四步在 README 中补齐双语说明与徽章。";
  const llm = scriptedLlm([textChunks(taskSpec), textChunks(taskSpec)]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: input });
  assert.equal(result.ok, true, "会话消息分支永不拒绝");
  assert.equal(result.text, input, "改不好就还原文");
  assert.equal(llm.seen.length, 2, "一次收紧重试后兜底");
});

test("会话消息越限后收敛 → 采纳收敛稿并记 repairs=1", async () => {
  const input = "刚才我想问的准确的是如何进行开源？";
  const overlong = "请评估开源流程：第一步在 GitHub 创建公开仓库并推送 main 分支；第二步执行 npm publish --access public 发布安装包；第三步向 awesome-dsh-plugin 提交收录 PR，并补齐双语 README 与徽章，确保 dsh plugin add 可直接安装；第四步通知社区目录站抓取。";
  const tightened = "刚才我想问的准确的是：该如何进行开源？";
  const llm = scriptedLlm([textChunks(overlong), textChunks(tightened)]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: input });
  assert.equal(result.ok, true);
  assert.equal(result.text, tightened);
  assert.equal(result.gate.repairs, 1);
});

// --------------------------------------------------------------------------
// 共享消息文本转换（T001 去重）
// --------------------------------------------------------------------------

import { messageTextOf } from "../src/message-text.js";

test("messageTextOf 处理字符串 / 块数组 / 形状漂移", () => {
  assert.equal(messageTextOf("hello"), "hello");
  assert.equal(messageTextOf([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a b");
  assert.equal(messageTextOf([{ type: "tool", text: "x" }, { type: "text", text: "keep" }]), "keep");
  assert.equal(messageTextOf([{ type: "text", text: 42 }]), "", "非字符串 text 必须丢弃");
  assert.equal(messageTextOf(null), "");
  assert.equal(messageTextOf(undefined), "");
  assert.equal(messageTextOf({ type: "text", text: "x" }), "", "非数组对象不是合法消息内容");
  assert.equal(messageTextOf([null, "raw", { type: "text", text: "y" }]), "y");
});

test("两个话轮提取器共用同一份文本转换（去重回归守卫）", () => {
  const content = [{ type: "text", text: "共享实现" }, { type: "tool", text: "ignored" }];
  const userSurface = { events: [{ type: "user/message", data: { role: "user", content } }] };
  const assistantSurface = { events: [{ type: "assistant/message", data: { role: "assistant", content } }] };
  assert.equal(extractRecentContext(userSurface)?.[0]?.text, "共享实现");
  assert.equal(extractAssistantTail(assistantSurface)?.text, "共享实现");
});

// --------------------------------------------------------------------------
// T002：信号/短指令/会话三个契约的覆盖入口（此前不可达：键被读取但文件从不加载）
// --------------------------------------------------------------------------

import {
  buildConversationalSystemPrompt,
  buildDeicticSystemPrompt,
  buildSignalSystemPrompt,
} from "../src/prompt-templates.js";

test("三个新契约的构建器读取各自的覆盖键", () => {
  setTemplateOverrides({
    signalSystem: "SIGNAL OVERRIDE",
    deicticSystem: "DEICTIC OVERRIDE",
    conversationalSystem: "CONVERSATIONAL OVERRIDE",
  });
  assert.ok(buildSignalSystemPrompt().startsWith("SIGNAL OVERRIDE"));
  assert.ok(buildDeicticSystemPrompt().startsWith("DEICTIC OVERRIDE"));
  assert.ok(buildDeicticSystemPrompt({ tightened: true }).startsWith("DEICTIC OVERRIDE"), "收紧后缀叠加在覆盖文本之后");
  assert.ok(buildConversationalSystemPrompt().startsWith("CONVERSATIONAL OVERRIDE"));
  assert.ok(buildConversationalSystemPrompt({ tightened: true }).startsWith("CONVERSATIONAL OVERRIDE"));
  setTemplateOverrides(null);
  assert.ok(buildSignalSystemPrompt().includes("You turn a bare signal"), "归还后回落内置");
  assert.ok(buildConversationalSystemPrompt().includes("You tidy up a conversational message"));
});

test("T002 会话契约覆盖文件真的进入 system prompt（此前放文件完全无效）", async () => {
  const host = await import("../lib/index.js");
  const dir = await mkdtemp(join(tmpdir(), "po-conv-override-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    const prompts = join(dir, "prompt-seed", "prompts");
    await mkdir(prompts, { recursive: true });
    await writeFile(join(prompts, "conversational.md"), "CONVERSATIONAL OVERRIDE CONTRACT", "utf8");
    const llm = scriptedLlm([textChunks("这是怎么回事？")]);
    const webServer = makeWebServer();
    host.apply(makeHostContext(webServer, { llm }), { samples: false });
    const res = makeResponse();
    await webServer.routes[0].handler(makeRequest({ body: JSON.stringify({ text: "这是怎么回事？" }) }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(llm.seen.length, 1, "会话分支应产生一次调用");
    assert.ok(llm.seen[0].system.startsWith("CONVERSATIONAL OVERRIDE CONTRACT"), "覆盖文件必须进入 system prompt");
    setTemplateOverrides(null);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// T004：sample-log 未覆盖边界
// --------------------------------------------------------------------------

test("T004 sample-log 边界：非字符串 input、不可写目标", async () => {
  const dir = await mkdtemp(join(tmpdir(), "po-samples-edge-"));
  try {
    const file = join(dir, "nested", "s.jsonl");
    // 缺 input 字段：仍要写成功，input 落空串，其余字段原样保留
    assert.equal(await appendSample(file, { time: "t", code: "ok" }), true);
    let record = JSON.parse((await readFile(file, "utf8")).trim());
    assert.equal(record.input, "", "缺 input 字段时落空串");
    assert.equal(record.code, "ok", "其余字段不能被丢");

    // number 型 input：同样落空串而不是抛
    assert.equal(await appendSample(file, { input: 42 }), true);
    const last = JSON.parse((await readFile(file, "utf8")).trim().split("\n").pop());
    assert.equal(last.input, "", "number 型 input 落空串");

    // 目标是已存在的目录：写入必然失败，必须静默返回 false
    const asDir = join(dir, "adir");
    await mkdir(asDir, { recursive: true });
    assert.equal(await appendSample(asDir, { input: "x" }), false, "目标是目录时静默失败");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T004 resolveSamplePath 退化：空白 DSH_HOME 回落 homedir，非路径值走默认", () => {
  const previous = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = "   ";
    const fallback = resolveSamplePath(undefined);
    assert.ok(fallback.endsWith(join(".dsh", "prompt-seed", "samples.jsonl")), "空白 DSH_HOME 必须回落 homedir");
    assert.equal(resolveSamplePath(true), fallback, "true 不是自定义路径");
    assert.equal(resolveSamplePath(""), fallback, "空串不是自定义路径");
    assert.equal(resolveSamplePath("  "), fallback, "空白串不是自定义路径");
    assert.equal(resolveSamplePath("/x/y.jsonl"), "/x/y.jsonl", "自定义路径原样返回");
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

// --------------------------------------------------------------------------
// T005：session-context 形状漂移与取序边界
// --------------------------------------------------------------------------

test("T005 session-context 形状漂移：任何非法结构都降级为无上下文", () => {
  assert.equal(extractRecentContext({ events: "nope" }), undefined, "events 非数组");
  assert.equal(extractRecentContext({ events: { 0: {} } }), undefined, "events 是对象不是数组");
  assert.equal(
    extractRecentContext({ events: [null, 42, "x", {}, { type: "user/message" }, { type: "user/message", data: null }] }),
    undefined,
    "垃圾节点与半截节点必须全部跳过",
  );
  assert.equal(
    extractRecentContext({ events: [{ type: "user/message", data: { role: "assistant", content: "x" } }] }),
    undefined,
    "角色不是 user 的消息不是用户话轮",
  );
  assert.equal(
    extractRecentContext({ events: [{ type: "user/message", data: { role: "user", content: [] } }] }),
    undefined,
    "空内容不算话轮",
  );
  assert.equal(
    extractRecentContext({ events: [{ type: "user/message", data: { role: "user", content: [{ type: "tool", text: "x" }] } }] }),
    undefined,
    "只有非 text 块时文本为空",
  );
  assert.equal(
    extractRecentContext({ events: [{ type: "user/message", data: { role: "user", content: "   \n  " } }] }),
    undefined,
    "纯空白话轮不入上下文",
  );
});

test("T005 只保留最近两条真实话轮；source 缺失按真实话轮处理", () => {
  const mk = (t, kind) => ({
    type: "user/message",
    data: { role: "user", ...(kind === "none" ? {} : { source: { kind } }), content: [{ type: "text", text: t }] },
  });
  const surface = { events: [mk("第一条", "user"), mk("第二条", "user"), mk("第三条", "user")] };
  assert.deepEqual(
    extractRecentContext(surface).map((m) => m.text),
    ["第二条", "第三条"],
    "只取最近两条，且按时间正序返回",
  );
  const noSource = { events: [mk("没有 source 字段", "none")] };
  assert.deepEqual(
    extractRecentContext(noSource).map((m) => m.text),
    ["没有 source 字段"],
    "source.kind 缺失时按真实用户话轮处理（只有显式非 user 才跳过）",
  );
});

// --------------------------------------------------------------------------
// T006：cannot_infer 的前端呈现（设计内的中性拒绝，不是故障）
// --------------------------------------------------------------------------

test("T006 cannot_infer 在客户端走 declined 中性态，不是红色错误态", async () => {
  const source = await readFile(join(root, "lib", "client.js"), "utf8");
  assert.ok(source.includes("cannot_infer"), "客户端必须认识这个码，否则会当未知错误处理");
  // 分支内部必须是 setDeclined（中性盾），不能是 setError（红色 ⚠）——
  // 拒绝硬猜是系统按设计工作，报成故障会让用户以为插件坏了。
  assert.ok(/cannot_infer[\s\S]{0,220}setDeclined/.test(source), "cannot_infer 必须走 declined");
  assert.ok(!/cannot_infer[\s\S]{0,220}setError/.test(source), "cannot_infer 不能走 error");
  // 兜底仍在：未知码必须还能报错，而不是静默吞掉
  assert.ok(source.includes("setError((res && res.error) || '优化失败')"), "未知码兜底必须保留");
});

// --------------------------------------------------------------------------
// T009：目录就绪缓存（性能）与其失效路径
// --------------------------------------------------------------------------

test("T009 目录缓存：目录被外部删除后，下一次写入必须自愈", async () => {
  const parent = await mkdtemp(join(tmpdir(), "po-dircache-"));
  const dir = join(parent, "nested");
  const file = join(dir, "s.jsonl");
  try {
    assert.equal(await appendSample(file, { input: "第一次" }), true, "首次写入须自建目录");
    // 目录被外部删除（进程内缓存仍记着它已就绪）
    await rm(dir, { recursive: true, force: true });
    assert.equal(await appendSample(file, { input: "第二次" }), true, "缓存失效后必须重建目录并写入");
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1, "旧目录已删，只剩重建后的这一条");
    assert.equal(JSON.parse(lines[0]).input, "第二次");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// T010：会话分支与 depth/上下文的交互矩阵
// --------------------------------------------------------------------------

test("T010 会话分支：depth 不改变契约，上下文刻意不注入", async () => {
  const llm = fakeLlm(textChunks("这是怎么回事？"));
  const res = await optimizePromptText({
    llm,
    route: ROUTE,
    text: "这是怎么回事？",
    depth: "deep",
    context: [{ role: "user", text: "刚才说的是打包脚本的问题" }],
  });
  assert.equal(res.ok, true);
  assert.equal(res.mode, "conversational", "提问走会话分支");
  assert.equal(llm.seen.length, 1, "会话分支只调用一次");
  const system = llm.seen[0].system;
  assert.ok(system.includes("conversational message"), "必须是轻润色契约");
  assert.ok(!system.includes("You expand prompts"), "绝不能进入补全契约");
  assert.ok(!/depth|深度/i.test(system), "depth 后缀不得进入会话契约");
  const user = llm.seen[0].messages[0].content;
  assert.ok(!user.includes("刚才说的是打包脚本的问题"), "会话分支刻意不携带上下文，堵死\"用上下文补内容\"的路径");
});

test("T010 提问里带路径与标识符，仍走会话分支（有意的前置优先级）", async () => {
  const text = "src/utils/format.js 里的 formatBytes 为什么返回了负数？";
  const llm = fakeLlm(textChunks(text));
  const res = await optimizePromptText({ llm, route: ROUTE, text });
  assert.equal(res.mode, "conversational");
  assert.ok(llm.seen[0].system.includes("conversational message"), "提问就是提问，不因为提到文件而变成待补全的种子");
  assert.equal(res.text, text, "原样返回（本例模型回显输入）");
});

// --------------------------------------------------------------------------
// T012：错误码与用户文案的完备性
// --------------------------------------------------------------------------

import { ERROR_MESSAGES } from "../src/host-core.js";

test("T012 每个错误码都有面向用户的中文文案，且没有孤儿文案", () => {
  const codes = Object.values(ERROR_CODES);
  for (const code of codes) {
    const message = ERROR_MESSAGES[code];
    assert.equal(typeof message, "string", `错误码 ${code} 缺文案（界面会显示原始 code）`);
    assert.ok(message.trim().length > 0, `错误码 ${code} 的文案为空`);
    assert.ok(/[\u4e00-\u9fff]/.test(message), `错误码 ${code} 的文案应面向用户（中文），当前为：${message}`);
  }
  for (const key of Object.keys(ERROR_MESSAGES)) {
    assert.ok(codes.includes(key), `文案 ${key} 没有对应的错误码（孤儿条目）`);
  }
  assert.ok(codes.length >= 12, "错误码数量骤降说明有码被误删");
});

// --------------------------------------------------------------------------
// T013：debug 路由字段与不变量
// --------------------------------------------------------------------------

test("T013 ?debug=1 附带形状而非上下文原文；开关关闭时不出现", async () => {
  const host = await import("../lib/index.js");
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const webServer = makeWebServer();
  const surfaceText = "上一轮说的是把接口的限流参数调大";
  const llm = scriptedLlm([textChunks("请把那个接口的限流参数调整一下。"), textChunks("OK")]);
  host.apply(
    makeHostContext(webServer, {
      llm,
      sessionQuery: {
        readSurface: () =>
          Promise.resolve({
            events: [
              { type: "user/message", data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: surfaceText }] } },
            ],
          }),
      },
    }),
    { samples: false },
  );
  const route = webServer.routes[0];

  const req = makeRequest({ body: JSON.stringify({ text: "把那个接口改一下", sessionId: "s-dbg" }) });
  req.url = "/?debug=1";
  const res = makeResponse();
  await route.handler(req, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(body._debug, "?debug=1 必须附带 _debug");
  assert.equal(body._debug.codeVersion, pkg.version, "codeVersion 必须等于当前包版本（排障第一证据）");
  assert.equal(body._debug.sessionId, "s-dbg");
  assert.equal(body._debug.contextMessages, 1, "上下文条数按形状统计");
  assert.equal(body._debug.contextChars, surfaceText.length, "上下文字符数按形状统计");
  assert.equal(body._debug.provider, "p");
  assert.equal(body._debug.model, "m");
  assert.equal(body._debug.samplePath, null, "samples:false 时路径为空");
  assert.ok(
    !JSON.stringify(body._debug).includes(surfaceText),
    "调试字段只带形状，绝不带上下文原文（回环限定也不等于可以泄露草稿内容）",
  );

  const req2 = makeRequest({ body: JSON.stringify({ text: "把那个接口改一下", sessionId: "s-dbg" }) });
  const res2 = makeResponse();
  await route.handler(req2, res2);
  assert.equal(JSON.parse(res2.body)._debug, undefined, "未开开关时不得出现调试字段");
});

// --------------------------------------------------------------------------
// T015：五状态的优先级链与呈现约束
//
// 说明：客户端组件内部状态由异步响应驱动，而渲染测试用的是极简 React 替身
// （useState 不产生更新），因此这里断言**产物级不变量**——优先级链、每态的
// 颜色与动画、条件入口——而不是逐态的真实迁移。链的顺序本身即语义：
// 调换顺序会让一种状态永久遮住另一种。
// --------------------------------------------------------------------------

test("T015 五状态优先级链与各态呈现约束", async () => {
  const source = await readFile(join(root, "lib", "client.js"), "utf8");
  assert.ok(
    /busy \? 'busy' : isRevertMode \? 'revert' : declined !== '' \? 'declined' : error !== '' \? 'error' : 'idle'/.test(source),
    "优先级链必须是 busy > revert > declined > error > idle",
  );
  assert.ok(
    source.includes('.dsh-seed-btn[data-mode="declined"]{color:var(--dsw-alias-label-secondary);}'),
    "拒绝态必须中性（不是红色——拒绝硬猜是设计内行为）",
  );
  assert.ok(
    source.includes('.dsh-seed-btn[data-mode="error"]{color:var(--dsw-alias-state-error-primary);}'),
    "错误态必须用 error 色",
  );
  assert.ok(
    source.includes('.dsh-seed-btn[data-mode="revert"]{color:var(--dsw-alias-brand-primary);}'),
    "可恢复态必须用品牌色",
  );
  assert.ok(
    /data-mode="busy"\][^{]*\{animation:/.test(source),
    "busy 必须有旋转动画（唯一的持续视觉信号）",
  );
  assert.ok(
    source.includes("if (mode === 'declined' && rejected !== '')"),
    "查看被拒稿的入口只在拒绝态且确有被拒稿时出现",
  );
  assert.ok(
    source.includes("'data-glow': mode === 'idle' && hasContent ? '1' : '0'"),
    "微光只在 idle 且有内容时出现",
  );
});

// --------------------------------------------------------------------------
// T017：审计 fail-open 与 THIN 分支的组合矩阵
// --------------------------------------------------------------------------

test("T017 审计无法解析 → fail-open 接受改写稿（不因解析失败而拒绝）", async () => {
  const llm = scriptedLlm([
    textChunks("请检查这段代码是否存在问题，并说明出现在哪里。"),
    textChunks("这段话说得不太清楚，我重新讲一遍……"), // 既非 OK 也非任何 KIND 行
  ]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: "帮我看看这段代码" });
  assert.equal(result.ok, true, "审判解析失败必须 fail-open");
  assert.equal(result.text, "请检查这段代码是否存在问题，并说明出现在哪里。");
  assert.equal(llm.seen.length, 2, "只发改写 + 审判两次调用（不因 fail-open 多跑）");
  assert.equal(result.tier, "full");
});

test("T017 THIN 只对种子再补一次：非种子输入被报 THIN 时不追加调用", async () => {
  const draft = "删除 src/utils/legacy.js 中未被引用的导出，然后运行一遍测试，确认没有破坏任何功能。";
  const llm = scriptedLlm([textChunks(draft), textChunks("THIN: 只改了措辞")]);
  const result = await optimizePromptText({
    llm,
    route: ROUTE,
    text: "删除 src/utils/legacy.js 里未被引用的 export，跑一遍测试确认没破坏",
  });
  assert.equal(result.ok, true);
  assert.equal(llm.seen.length, 2, "带路径锚定的输入被报 THIN 不值得再花调用（审判误报居多）");
  assert.equal(result.text, draft);
});

test("T017 THIN → 补全 → 二次审判失真：回退薄但忠实的第一稿", async () => {
  const first = "请检查这段代码是否存在问题，并说明出现在哪里。";
  const elaborated = "请检查这段代码是否存在问题，说明出现在哪里，并顺带评估整个项目的测试覆盖率和发布计划。";
  const llm = scriptedLlm([
    textChunks(first),
    textChunks("THIN: 只改了措辞"),
    textChunks(elaborated),
    textChunks("SCOPE_ADDED: 追加了测试覆盖率与发布计划"),
  ]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: "帮我看看这段代码" });
  assert.equal(result.ok, true, "薄但忠实优于直接拒绝");
  assert.equal(result.text, first, "补全越线时必须回退第一稿");
  assert.equal(result.tier, "thin");
  assert.equal(result.gate.verdict, "thin");
  assert.equal(llm.seen.length, 4, "改写 + 审判 + 补全 + 二次审判");
});

test("T017 两道审判的 fail-open 方向相反：第一道放行，第二道保守回退", async () => {
  // 这是**有意的不对称**，且此前没有测试钉住它：
  //   第一道审判解析失败 → fail-open，接受改写稿（闸门是纵深防御，不是唯一机制）；
  //   第二道审判解析失败 → 保守，回退薄但忠实的第一稿。
  // 理由：第二道审判存在的唯一目的就是验证"补全没有越线"。它无法解析时，
  // 补全稿就是**未经验证**的；而本产品的前提正是"闸门让补全安全"。宁可薄，
  // 不可把未验证的加料交付出去。
  const first = "请检查这段代码是否存在问题，并说明出现在哪里。";
  const elaborated = "请检查这段代码是否存在问题，说明出现在哪里，并指出你判断的依据。";
  const llm = scriptedLlm([
    textChunks(first),
    textChunks("THIN: 只改了措辞"),
    textChunks(elaborated),
    textChunks("嗯，我觉得这版还行吧。"), // 解析不出任何 KIND 行
  ]);
  const result = await optimizePromptText({ llm, route: ROUTE, text: "帮我看看这段代码" });
  assert.equal(result.ok, true, "仍然交付（不拒绝）");
  assert.equal(result.text, first, "第二道审判无法解析时必须回退第一稿");
  assert.equal(result.tier, "thin");
  assert.equal(result.gate.rechecked, false);
  assert.equal(llm.seen.length, 4);
});

// --------------------------------------------------------------------------
// T022：带重渲染能力的 React 替身 —— 驱动真实的响应路径
// --------------------------------------------------------------------------

test("T022 驱动完整响应：cannot_infer 必须渲染成 declined 中性态而不是 error", async () => {
  // 与 T006 的产物断言不同，harness 会真的走完 onClick → fetch → setState → 重渲染。
  const CANNOT_INFER_MESSAGE = "上下文不足以推断这个输入的含义，请直接写出想说的内容";
  const h = await makeClientHarness({
    draft: "42",
    fetchImpl: () => Promise.resolve({ json: () => Promise.resolve({ ok: false, code: "cannot_infer", error: CANNOT_INFER_MESSAGE }) }),
  });
  try {
    assert.equal(h.tree.props["data-mode"], "idle", "初始应为 idle");
    assert.equal(typeof h.tree.props.onClick, "function", "主按钮必须可点击");
    h.tree.props.onClick();
    await h.settle();
    assert.equal(h.tree.props["data-mode"], "declined", "cannot_infer 必须落到中性盾态");
    const title = String(h.tree.props.title || "");
    assert.ok(title.includes("无法推断") || title.includes("上下文不足"), "tooltip 必须给出可读原因，当前：" + title);
    assert.deepEqual(h.writes, [], "拒绝路径绝不能写回草稿");
  } finally {
    h.restore();
  }
});
// --------------------------------------------------------------------------
// T023：三个启发式在共享边界输入上的一致性
// --------------------------------------------------------------------------

test("T023 looksOpenEnded / looksSeedish 的边界与超集关系", () => {
  const zh = (n) => "帮".repeat(n);
  const cases = [
    { text: "", openEnded: false, seedish: false, note: "空输入两者皆假" },
    { text: "登录", openEnded: true, seedish: true, note: "2 字无锚定：下限刻意极低" },
    { text: zh(40), openEnded: true, seedish: true, note: "40 字整：仍在短句阈值内" },
    { text: zh(41), openEnded: false, seedish: true, note: "41 字：超出开放式阈值，但仍在种子阈值（60）内" },
    { text: zh(60), openEnded: false, seedish: true, note: "60 字整：种子的上界" },
    { text: zh(61), openEnded: false, seedish: false, note: "61 字无锚定：不再是种子" },
    { text: "为什么这么说？", openEnded: true, seedish: true, note: "问句形态无视长度" },
    { text: "把 src/a.js 改一下，跑一遍测试确认没破坏", openEnded: false, seedish: false, note: "带路径与扩展名：事实锚定即非种子" },
    { text: "这个月 15 号之前能不能给个版本？", openEnded: true, seedish: true, note: "问句形态优先于数字锚定" },
  ];
  for (const c of cases) {
    assert.equal(looksOpenEnded(c.text), c.openEnded, `looksOpenEnded(${JSON.stringify(c.text.slice(0, 12))}…) — ${c.note}`);
    assert.equal(looksSeedish(c.text), c.seedish, `looksSeedish(${JSON.stringify(c.text.slice(0, 12))}…) — ${c.note}`);
    if (looksOpenEnded(c.text)) {
      assert.ok(looksSeedish(c.text), "开放式必须是种子的子集：开放 ⟹ 种子（否则 THIN 重试与补全闸会各判一套）");
    }
  }
});

test("T023 assessInflation 的边界：空输入不抛且比值有限；形态指标只告警不判定", () => {
  assert.equal(assessInflation("", "").ratio, 0);
  const long = assessInflation("", "x".repeat(10));
  assert.ok(Number.isFinite(long.ratio) && long.ratio === 10, "空输入按长度 1 兜底，比值仍有限");
  assert.equal(long.bloated, true, "空输入被算作膨胀——但管线在更早的确定性闸门就拦下了空输入，此处仅记录语义");
  // 长输入不再算膨胀（阈值保护：长草稿本来就会更长大）
  const big = "字".repeat(250);
  assert.equal(assessInflation(big, big + "字".repeat(1000)).bloated, false, "超过 200 字的输入不参与膨胀告警");
  // 开放式被闭合：判的是 OPEN_ENDED_PATTERN 与 DELIVERABLE_PATTERN 的**交集**，
  // 不是 looksOpenEnded（后者还含问句形态）——用问句样本会得到 false，这个口径差异值得写明。
  const closed = assessInflation("帮我看看这个模块的性能", "请检查该模块的性能，并输出一份性能对比表格与优化实施计划。");
  assert.equal(closed.openEndedClosed, true, "开放式被闭合必须被标出（历史上的跑偏形态）");
  assert.equal(closed.suspicious, true);
  const questionOnly = assessInflation("这个能优化吗？", "请检查该模块并输出一份性能对比表格。");
  assert.equal(questionOnly.openEndedClosed, false, "问句形态不在 OPEN_ENDED_PATTERN 内，故不触发闭合告警（判定口径与 looksOpenEnded 不同）");
});

// --------------------------------------------------------------------------
// T025：客户端行为测试 harness（自 T022 抽取）+ 网络失败路径
// --------------------------------------------------------------------------

/**
 * 客户端行为 harness：可重渲染的 React 替身 + slot 注册 + 可注入 fetch。
 *
 * 抽取原因：每加一条行为测试就复制一份桩，很快会出现"某个测试的桩修了、
 * 其它测试的没修"——而桩本身正是这些测试的可信度来源。
 *
 * 两条关键规则（缺一条就无限递归，实测踩过）：
 *   ① setState 只在微任务里重渲染；② effect 在渲染之后执行。
 * @param {{fetchImpl?: Function, draft?: string}} [options] 注入点。
 * @returns {Promise<object>} harness 句柄（tree/render/settle/writes/restore…）。
 */
async function makeClientHarness(options = {}) {
  const source = await readFile(join(root, "lib", "client.js"), "utf8");
  // 注意：bundle 由 `new Function("window", source)` 注入，模块里的 window 指的是**传入的
  // 那个对象**，不是 globalThis.window。localStorage 必须挂在同一个对象上，否则模块内
  // 读到的永远是 undefined（readStored 静默回落 fallback）——这会悄悄让所有依赖本地
  // 状态的断言退化到默认路径。
  const storage = options.storage ?? {};
  const fakeWindow = {
    localStorage: {
      getItem: (key) => (key in storage ? JSON.stringify(storage[key]) : null),
      setItem(key, value) { storage[key] = JSON.parse(value); },
    },
  };
  let entry;
  new Function("window", source)(Object.assign(fakeWindow, { __ModuleLoader__: { load: (v) => { entry = v; } } }));

  const store = { hooks: [] };
  let cursor = 0;
  // effect 槽：真实 React 会按依赖数组决定是否重跑，桩必须同样处理——否则像
  // "草稿发散就丢弃撤销备份"这类依赖 [draft] 的 effect 永远只跑一次，
  // 组件会停在早就该失效的状态里，测试于是断言到一个不存在的世界。
  const effectSlots = new Map();
  let pendingEffects = [];
  let scheduled = false;
  let tree = null;
  let rerender = () => {};
  const scheduleRerender = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; rerender(); });
  };
  const React = {
    createElement(type, props, children) {
      if (typeof type === "function") return type(props || {});
      return { type, props: props || {}, children: children === undefined ? [] : [].concat(children) };
    },
    useState(initial) {
      const i = cursor++;
      if (!(i in store.hooks)) store.hooks[i] = typeof initial === "function" ? initial() : initial;
      return [
        store.hooks[i],
        (value) => {
          store.hooks[i] = typeof value === "function" ? value(store.hooks[i]) : value;
          scheduleRerender();
        },
      ];
    },
    useRef(value) { const i = cursor++; if (!(i in store.hooks)) store.hooks[i] = { current: value }; return store.hooks[i]; },
    useEffect(fn, deps) { const i = cursor++; pendingEffects.push({ i, fn, deps }); },
    useCallback(fn) { return fn; },
    useMemo(fn) { return fn(); },
  };
  const exported = entry.factory(() => React);

  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  globalThis.window = fakeWindow;
  globalThis.fetch = options.fetchImpl ?? (() => Promise.reject(new Error("harness: no fetch stub")));

  const client = { draft: options.draft ?? "", draftRev: 1, phase: "plain", occurrences: options.occurrences ?? [] };
  const writes = [];
  const props = {
    useInput: (selector) => selector(client),
    inputActions: {
      setDraft(text) { writes.push(text); client.draft = text; },
      addAttachments() {},
      removeAttachment() {},
      pruneAttachments() {},
    },
    t: (key) => key,
  };

  const registered = [];
  const slots = {
    inject(name, cb) { registered.push({ name, value: cb() }); },
    register(meta, render) { return { meta, render }; },
  };
  exported.apply({ slots, effect() {} });
  const component = registered[0].value.render;

  const render = () => {
    cursor = 0;
    pendingEffects = [];
    tree = component(props);
    for (const item of pendingEffects) {
      const previous = effectSlots.get(item.i);
      const sameDeps =
        previous !== undefined &&
        Array.isArray(item.deps) &&
        Array.isArray(previous.deps) &&
        item.deps.length === previous.deps.length &&
        item.deps.every((value, index) => Object.is(value, previous.deps[index]));
      // 无依赖数组 = 每次渲染都跑；有依赖 = 依赖变了才跑（Object.is 逐项比较）
      const shouldRun = previous === undefined || !Array.isArray(item.deps) || !sameDeps;
      if (!shouldRun) continue;
      if (typeof previous?.cleanup === "function") previous.cleanup();
      effectSlots.set(item.i, { deps: item.deps, cleanup: item.fn() });
    }
    return tree;
  };
  rerender = render;
  render();

  /** 深度优先按 data-testid 查找（revert 态下根节点不再是主按钮）。 */
  const findByTestId = (node, id) => {
    if (node === null || typeof node !== "object") return null;
    if (node.props && node.props["data-testid"] === id) return node;
    const children = [];
    if (Array.isArray(node.children)) children.push(...node.children);
    if (Array.isArray(node.props?.children)) children.push(...node.props.children);
    for (const child of children) {
      const found = findByTestId(child, id);
      if (found !== null) return found;
    }
    return null;
  };
  const describe = () => {
    const seen = [];
    const walk = (node, depth) => {
      if (node === null || typeof node !== "object" || depth > 3) return;
      seen.push({ type: typeof node.type === "string" ? node.type : "fn", id: node.props?.["data-testid"] ?? null, mode: node.props?.["data-mode"] ?? null });
      const children = [];
      if (Array.isArray(node.children)) children.push(...node.children);
      if (Array.isArray(node.props?.children)) children.push(...node.props.children);
      for (const child of children) walk(child, depth + 1);
    };
    walk(tree, 0);
    return seen;
  };

  return {
    get tree() { return tree; },
    /** 主按钮：revert 态下也用它，而不是假设根节点就是按钮。 */
    primary() { return findByTestId(tree, "prompt-seed-button"); },
    describe,
    render,
    client,
    writes,
    /** 模拟用户在等待期间改动草稿（draftRev 递增，触发 CAS 失效）。 */
    editDraft(text) { client.draft = text; client.draftRev += 1; },
    /** 让 fetch 的 then 链与排队中的重渲染跑完。 */
    async settle() {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 8));
    },
    restore() {
      globalThis.fetch = previousFetch;
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    },
  };
}

test("T025 网络失败：fetch reject → error 态，草稿一个字符都不写回", async () => {
  const h = await makeClientHarness({
    draft: "帮我把这个模块的导出整理一下",
    fetchImpl: () => Promise.reject(new Error("network down")),
  });
  try {
    assert.equal(h.tree.props["data-mode"], "idle");
    h.tree.props.onClick();
    await h.settle();
    assert.equal(h.tree.props["data-mode"], "error", "网络失败必须落到 error 态");
    assert.ok(String(h.tree.props.title || "").includes("network down"), "必须把失败原因带到界面");
    assert.deepEqual(h.writes, [], "失败时绝不写回草稿（不变量 I1）");
  } finally {
    h.restore();
  }
});

test("T026 陈旧响应必须被丢弃：等待期间用户改过草稿（不变量 I2）", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const h = await makeClientHarness({
    draft: "帮我改一下这个模块",
    fetchImpl: () =>
      pending.then(() => ({
        json: () => Promise.resolve({ ok: true, text: "请检查该模块的导出结构，并给出整理方案。" }),
      })),
  });
  try {
    h.tree.props.onClick();
    await h.settle();
    assert.equal(h.tree.props["data-mode"], "busy", "等待期间必须是 busy");

    // 用户在等待期间自己动手改了草稿：draftRev 递增，旧请求的结果就此作废。
    h.editDraft("我自己重新写过的内容");
    h.render();
    release();
    await h.settle();

    assert.deepEqual(h.writes, [], "陈旧响应绝不能写回（否则会覆盖用户刚打的字）");
    assert.equal(h.tree.props["data-mode"], "idle", "丢弃后回到 idle，而不是进入 revert 态");
  } finally {
    h.restore();
  }
});

test("T027 引用守恒：改写丢掉引用标签 → declined 且不写回（不变量 I1）", async () => {
  const h = await makeClientHarness({
    draft: "@src/index.js 帮我看看这个文件",
    occurrences: [{ label: "@src/index.js" }],
    // 改写把 @ 去掉，变成纯文本路径——引用结构被静默降级
    fetchImpl: () =>
      Promise.resolve({ json: () => Promise.resolve({ ok: true, text: "请检查 src/index.js 的实现，并给出改进建议。" }) }),
  });
  try {
    h.tree.props.onClick();
    await h.settle();
    assert.equal(h.tree.props["data-mode"], "declined", "丢引用必须走拒绝态，而不是照常写回");
    assert.ok(String(h.tree.props.title || "").includes("引用"), "必须说明原因与引用有关，当前：" + String(h.tree.props.title || ""));
    assert.deepEqual(h.writes, [], "拒绝时绝不能写回，原文保留（I1）");
  } finally {
    h.restore();
  }
});

test("T027 引用守恒的正例：标签原样保留时正常写回一次", async () => {
  const h = await makeClientHarness({
    draft: "@src/index.js 帮我看看这个文件",
    occurrences: [{ label: "@src/index.js" }],
    fetchImpl: () =>
      Promise.resolve({
        json: () => Promise.resolve({ ok: true, text: "@src/index.js 请检查该文件的导出结构，并给出改进建议。" }),
      }),
  });
  try {
    h.tree.props.onClick();
    await h.settle();
    assert.equal(h.writes.length, 1, "标签保留时必须写回且只写一次");
    assert.ok(h.writes[0].includes("@src/index.js"), "引用标签必须原样出现在写回内容里");
  } finally {
    h.restore();
  }
});

test("T028 路由挂靠 fiber 生命周期：dispose 后不残留，重复 apply 不叠加", async () => {
  const host = await import("../lib/index.js");

  // 默认 helper 的 register 返回空函数，测不出"残留"——这里返回真正的摘除器。
  const makeServer = () => {
    const routes = [];
    return {
      routes,
      register(route) {
        routes.push(route);
        return () => {
          const i = routes.indexOf(route);
          if (i >= 0) routes.splice(i, 1);
        };
      },
    };
  };

  const webServer = makeServer();
  const disposers = [];
  const ctx = makeHostContext(webServer, {});
  ctx.effect = (fn) => { const disposer = fn(); disposers.push(disposer); return disposer; };

  host.apply(ctx, { samples: false });
  assert.equal(webServer.routes.length, 1, "apply 必须注册恰好一条路由");
  assert.equal(webServer.routes[0].path, "/api/prompt-seed/optimize");
  assert.equal(typeof disposers[0], "function", "effect 必须返回 disposer，否则热升级会撞 duplicate route");

  // 模拟 disable → enable：先回收，再挂一次
  disposers[0]();
  assert.equal(webServer.routes.length, 0, "dispose 后不得残留路由");
  host.apply(ctx, { samples: false });
  assert.equal(webServer.routes.length, 1, "重新 apply 后恰好一条，不叠加");
  disposers[1]();
  assert.equal(webServer.routes.length, 0, "再次回收仍然干净");
});

test("T030 反馈分支的退化输入：字段缺失、非对象、非数值都不得崩", async () => {
  const host = await import("../lib/index.js");
  const dir = await mkdtemp(join(tmpdir(), "po-feedback-edge-"));
  const file = join(dir, "nested", "samples.jsonl");
  try {
    const webServer = makeWebServer();
    const ctx = makeHostContext(webServer, { responses: [textChunks("不该被调用")] });
    host.apply(ctx, { samples: file });
    const route = webServer.routes[0];

    // 1) 字段全缺：kind 落 unknown，其余落 null（而不是 undefined / NaN）
    const res1 = makeResponse();
    await route.handler(makeRequest({ body: JSON.stringify({ feedback: {} }) }), res1);
    assert.equal(res1.statusCode, 200);
    assert.deepEqual(JSON.parse(res1.body), { ok: true });
    const first = JSON.parse((await readFile(file, "utf8")).trim().split("\n")[0]);
    assert.equal(first.kind, "unknown");
    assert.equal(first.tier, null);
    assert.equal(first.charsDelta, null);
    assert.equal(first.elapsedMs, null);

    // 2) feedback 不是对象：按"没有反馈"处理，继续走正常流程（无 text → 确定性拒绝）
    const res2 = makeResponse();
    await route.handler(makeRequest({ body: JSON.stringify({ feedback: "reverted" }) }), res2);
    assert.equal(res2.statusCode, 200);
    assert.equal(JSON.parse(res2.body).ok, false, "非对象 feedback 不得被当成反馈通道");
    assert.equal(ctx.get("llm").seen.length, 0, "确定性拒绝不花模型调用");

    // 3) 数值字段给了非数字：落 null（而不是让 NaN 经 JSON 变成 null 还被当成合法值）
    const res3 = makeResponse();
    await route.handler(makeRequest({ body: JSON.stringify({ feedback: { kind: "retried", charsDelta: "很多", elapsedMs: null } }) }), res3);
    assert.equal(res3.statusCode, 200);
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    const third = JSON.parse(lines[lines.length - 1]);
    assert.equal(third.kind, "retried");
    assert.equal(third.charsDelta, null);
    assert.equal(third.elapsedMs, null);

    // 4) 采样关闭：反馈仍然返回成功（采样是旁路，不是前置条件）
    const webServer2 = makeWebServer();
    const ctx2 = makeHostContext(webServer2, { responses: [textChunks("不该被调用")] });
    host.apply(ctx2, { samples: false });
    const res4 = makeResponse();
    await webServer2.routes[0].handler(makeRequest({ body: JSON.stringify({ feedback: { kind: "submitted" } }) }), res4);
    assert.equal(res4.statusCode, 200);
    assert.deepEqual(JSON.parse(res4.body), { ok: true });
    assert.equal(ctx2.get("llm").seen.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T031 busy 期间再点一次 = 取消：不发第二次请求，旧响应被丢弃", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const h = await makeClientHarness({
    draft: "帮我改一下这个模块",
    fetchImpl: () => {
      calls += 1;
      return pending.then(() => ({
        json: () => Promise.resolve({ ok: true, text: "请检查该模块的导出结构，并给出整理方案。" }),
      }));
    },
  });
  try {
    h.tree.props.onClick();
    await h.settle();
    assert.equal(h.tree.props["data-mode"], "busy", "第一次点击进入 busy");

    // 第二次点击是"取消"，不是"再发一次"
    h.tree.props.onClick();
    await h.settle();
    assert.equal(h.tree.props["data-mode"], "idle", "取消后立刻回到 idle（用户看得到反馈）");
    assert.equal(calls, 1, "取消不得再发一次请求——否则就是两次扣费");

    release();
    await h.settle();
    assert.deepEqual(h.writes, [], "被取消的响应绝不能写回");
    assert.equal(h.tree.props["data-mode"], "idle", "旧响应到达后也不得把状态拉回 busy/revert");
  } finally {
    h.restore();
  }
});

test("T032 自适应深度：统计驱动的档位必须在渲染层可见", async () => {
  const SIGNAL_KEY = "dsh-prompt-seed/signals";
  const DEPTH_KEY = "dsh-prompt-seed/depth";
  const titleFor = async (storage) => {
    const h = await makeClientHarness({ draft: "帮我改一下这个模块", storage });
    try {
      return String(h.tree.props.title || "");
    } finally {
      h.restore();
    }
  };

  // 补少了（retried 多于 reverted）→ 升档到深度
  const deepTitle = await titleFor({ [SIGNAL_KEY]: { retried: 3, reverted: 0, submitted: 1 } });
  assert.ok(deepTitle.includes("当前深度档"), "retried 占优应升到深度档，当前标题：" + deepTitle);
  // 补多了（reverted 多于 submitted）→ 降档到轻
  assert.ok((await titleFor({ [SIGNAL_KEY]: { reverted: 3, submitted: 0, retried: 0 } })).includes("当前轻档"), "reverted 占优应降到轻档");
  // 冷启动保护：只点过一两次不得改变档位
  assert.ok((await titleFor({ [SIGNAL_KEY]: { retried: 1, reverted: 0, submitted: 0 } })).includes("当前标准档"), "冷启动必须是标准档");
  assert.ok((await titleFor({ [SIGNAL_KEY]: { reverted: 1, submitted: 0, retried: 0 } })).includes("当前标准档"), "冷启动的降档方向同样要拦住");
  assert.ok((await titleFor({})).includes("当前标准档"), "没有任何统计时是标准档");

  // 手动档位优先于统计（用户显式选过就不再自作主张）
  const manual = await titleFor({ [DEPTH_KEY]: { mode: "light" }, [SIGNAL_KEY]: { retried: 9, reverted: 0, submitted: 0 } });
  assert.ok(manual.includes("深度：轻"), "手动档位必须压过统计，当前：" + manual);
  assert.ok(!manual.includes("自动"), "手动档位下不该再显示自动");

  // 非法持久化值回落 auto（而不是把脏数据当档位用）
  const dirty = await titleFor({ [DEPTH_KEY]: { mode: "超级深度" }, [SIGNAL_KEY]: { retried: 3, reverted: 0, submitted: 0 } });
  assert.ok(dirty.includes("自动"), "非法档位必须回落 auto，当前：" + dirty);
});

  const makeFetch = (bodies) => (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.feedback) return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, text: "请检查该模块的导出结构，并给出整理方案。" }) });
  };
  const kindsOf = (bodies) => bodies.filter((b) => b.feedback).map((b) => b.feedback.kind);

test("T033 撤销路径：写回回传 applied，撤销回传 reverted 并写回原文", async () => {
  const bodies = [];
  const h = await makeClientHarness({ draft: "帮我改一下这个模块", fetchImpl: makeFetch(bodies) });
  try {
    h.primary().props.onClick();
    await h.settle();
    assert.equal(h.writes.length, 1, "改写已写回");
    assert.equal(h.primary().props["data-mode"], "revert", "成功后进入 revert 态");
    h.primary().props.onClick();
    await h.settle();
    // 顺序即语义：写回成功 = applied（采纳），撤销 = reverted（补多了）。记反会让自适应深度调错方向。
    assert.deepEqual(kindsOf(bodies), ["applied", "reverted"], "实际：" + JSON.stringify(kindsOf(bodies)));
    const reverted = bodies.filter((b) => b.feedback && b.feedback.kind === "reverted")[0].feedback;
    assert.ok(Number.isFinite(reverted.charsDelta), "charsDelta 必须是数字");
    assert.ok(Number.isFinite(reverted.elapsedMs), "elapsedMs 必须是数字");
    assert.equal(h.writes.length, 2, "撤销写回原文");
    assert.equal(h.writes[1], "帮我改一下这个模块", "写回的必须是原文");
    assert.equal(h.primary().props["data-mode"], "idle", "撤销后回到 idle");
  } finally {
    h.restore();
  }
});

test("T033 改后再点路径：回传 retried 并真的发起新一次优化", async () => {
  // 注意与撤销路径的区别：运行记录会被**第一次**反馈消费掉（消费即置空），
  // 所以在撤销之后再点不会回传 retried。retried 的真实条件是：上一稿仍在窗口内且未被消费。
  const bodies = [];
  const h = await makeClientHarness({ draft: "帮我改一下这个模块", fetchImpl: makeFetch(bodies) });
  try {
    h.primary().props.onClick();
    await h.settle();
    h.editDraft("换个方向：帮我看看性能");
    h.render();
    // 编辑后必须等一次微任务：发散检测（依赖 [draft] 的 effect）在渲染后执行并把
    // 重渲染排进微任务，撤销备份是在那一次渲染里被丢掉的。真实用户点击的是重渲染
    // 之后的按钮；拿着旧树点击会点到"撤销"，那不是用户会经历的时序。
    await h.settle();
    assert.notEqual(h.primary().props["data-mode"], "revert", "草稿一旦改动，撤销入口必须消失");
    h.primary().props.onClick();
    await h.settle();
    assert.deepEqual(kindsOf(bodies), ["applied", "retried", "applied"], "实际：" + JSON.stringify(kindsOf(bodies)));
    const optimizeCalls = bodies.filter((b) => !b.feedback);
    assert.equal(optimizeCalls.length, 2, "retried 之后确实发起了新一次优化");
    assert.equal(optimizeCalls[1].text, "换个方向：帮我看看性能", "新请求带的是用户改后的草稿");
  } finally {
    h.restore();
  }
});
test("T034 事件日志字段与 FEATURES 声明一致（文档抽查转常驻守卫）", async () => {
  const host = await import("../lib/index.js");
  const dir = await mkdtemp(join(tmpdir(), "po-fields-"));
  const file = join(dir, "samples.jsonl");
  try {
    const webServer = makeWebServer();
    const ctx = makeHostContext(webServer, {
      responses: [textChunks("请检查该模块的导出结构，并给出整理方案。"), textChunks("OK")],
    });
    host.apply(ctx, { samples: file });
    const res = makeResponse();
    // 用超长输入，顺带钉住 input 字段的截断长度
    const long = "帮我把这个模块的导出结构梳理一遍，" + "补充说明。".repeat(100); // 517 字，必定触发 400 字截断
    await webServer.routes[0].handler(makeRequest({ body: JSON.stringify({ text: long }) }), res);
    assert.equal(res.statusCode, 200);
    const record = JSON.parse((await readFile(file, "utf8")).trim().split("\n")[0]);

    // 这份清单逐字来自 docs/FEATURES.md 模块 8 的"事件日志"行；改其一必须同改另一处。
    const documented = [
      "time", "event", "code", "tier", "mode", "depth", "gate", "repairs", "rechecked",
      "violations", "inputChars", "outputChars", "ms", "input", "added", "provider", "model", "from",
    ];
    for (const key of documented) {
      assert.ok(key in record, `FEATURES 声明的字段 ${key} 没有落盘（文档与实现已经不一致）`);
    }
    assert.equal(record.input.length, 400, "input 必须是前 400 字（SAMPLE_INPUT_PREVIEW）");
    assert.ok(record.inputChars > 400, "inputChars 记录的是完整长度，不是截断后的长度");
    assert.equal(record.event, "optimize");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T035 submitted 信号的两条触发路径：草稿被清空 / 离开 plain 阶段", async () => {
  const bodies = [];
  const h = await makeClientHarness({
    draft: "帮我改一下这个模块",
    fetchImpl: (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.feedback) return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, text: "请检查该模块的导出结构，并给出整理方案。" }) });
    },
  });
  try {
    h.primary().props.onClick();
    await h.settle();
    assert.deepEqual(bodies.filter((b) => b.feedback).map((b) => b.feedback.kind), ["applied"]);

    // 路径一：草稿被清空（用户把结果发出去了）→ 最强正信号
    h.editDraft("");
    h.render();
    await h.settle();
    assert.deepEqual(
      bodies.filter((b) => b.feedback).map((b) => b.feedback.kind),
      ["applied", "submitted"],
      "草稿清空必须回传 submitted",
    );

    // 路径二：会话离开 plain 阶段（提交/切换）→ 同样是最强正信号
    const h2 = await makeClientHarness({
      draft: "帮我改一下这个模块",
      fetchImpl: (url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        if (body.feedback) return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, text: "请检查该模块的导出结构，并给出整理方案。" }) });
      },
    });
    const kindsBefore = bodies.filter((b) => b.feedback).length;
    h2.primary().props.onClick();
    await h2.settle();
    h2.client.phase = "submitting";
    h2.render();
    await h2.settle();
    const kinds = bodies.filter((b) => b.feedback).map((b) => b.feedback.kind);
    assert.equal(kinds[kinds.length - 1], "submitted", "离开 plain 阶段必须回传 submitted，实际：" + JSON.stringify(kinds.slice(kindsBefore)));
    h2.restore();
  } finally {
    h.restore();
  }
});
