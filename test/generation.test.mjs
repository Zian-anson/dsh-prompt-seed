import assert from 'node:assert/strict';
import { test } from 'node:test';
import { optimizeOnce } from '../src/optimize.js';
import { predictNextPrompt, predictStream } from '../src/predict.js';
import { extractClarifyContext, extractPredictionContext } from '../src/context.js';
import { createJobStore } from '../src/jobs.js';
const route = { provider: 'p', model: 'm' };
function model(text, finish = 'stop') {
  const seen = [];
  return { seen, async *stream(request) { seen.push(request); yield { type: 'text-delta', text }; yield { type: 'finish', reason: { kind: finish } }; } };
}
const user = (text, seq = 1) => ({ type: 'user/message', seq, data: { content: text, source: { kind: 'user' } } });
const assistant = (text, seq = 2) => ({ type: 'assistant/message', seq, data: { message: { role: 'assistant', content: text } } });

test('rewrite contract reaches model: active detail, no literal expansion ceilings, explicit discussion boundary', async () => {
  const llm = model('先讨论 src/a.js 的重构方向，说明建议；暂时不要修改代码。');
  const result = await optimizeOnce({ text: '先讨论 src/a.js 的重构方向，别改代码', llm, route });
  assert.equal(result.ok, true); assert.equal(llm.seen.length, 1);
  const request = llm.seen[0];
  assert.match(request.system, /essential execution details/);
  assert.match(request.system, /discussion versus implementation/);
  assert.doesNotMatch(request.system, /under 3x|stay near-verbatim|do not add new features, steps, tests/);
  assert.match(request.messages[0].content[0].text, /别改代码/);
});

test('rewrite context: newest conversation wins the budget and untagged user messages are retained', async () => {
  const events = [user('旧'.repeat(300)), assistant('早'.repeat(600)), user('中'.repeat(300)), assistant('近'.repeat(600)), user('最新需求：只讨论不改代码。')];
  const context = extractClarifyContext({ events });
  assert.equal(context.at(-1).text, '最新需求：只讨论不改代码。');
  assert.ok(context.reduce((sum, item) => sum + item.text.length, 0) <= 1400);
  const llm = model('先讨论，不修改代码。');
  await optimizeOnce({ text: '按刚才说的处理', sessionId: 's', sessionQuery: { readSurface: async () => ({ events }) }, llm, route });
  assert.match(llm.seen[0].messages[0].content[0].text, /最新需求：只讨论不改代码/);
});

test('custom rewrite templates retain precedence', async () => {
  const llm = model('检查当前表现。');
  await optimizeOnce({ text: '看下现在表现', llm, route, overrides: { optimize: 'User-owned template', seed: 'Legacy template' } });
  assert.equal(llm.seen[0].system, 'User-owned template');
});

test('prediction: context, user voice and prediction goal reach exactly one model call', async () => {
  const context = extractPredictionContext({ events: [user('先别动代码，讲明白原因'), assistant('这里有两个可选方案，要直接实现第一个吗？')] });
  const llm = model('先解释一下这两个方案的区别。'); const events = [];
  for await (const event of predictStream({ context, llm, route })) events.push(event);
  assert.equal(llm.seen.length, 1); assert.equal(events[0].type, 'meta');
  assert.ok(events.some((e) => e.type === 'delta')); assert.equal(events.at(-1).ok, true);
  assert.match(llm.seen[0].system, /most likely to type next, not the next step you recommend/);
  assert.match(llm.seen[0].messages[0].content[0].text, /先别动代码/);
  assert.equal(llm.seen[0].maxTokens, undefined);
});

test('prediction: no context makes zero calls; no prediction and truncation do not return writable text', async () => {
  const llm = model('不应调用'); const result = await predictNextPrompt({ llm, route });
  assert.equal(result.code, 'cannot_predict'); assert.equal(llm.seen.length, 0);
  const context = { turns: [{ role: 'user', text: '讨论方案' }, { role: 'assistant', text: '需要更多信息。' }], assistantTail: '需要更多信息。' };
  assert.equal((await predictNextPrompt({ llm: model('[NO PREDICTION]'), route, context })).code, 'cannot_predict');
  const truncated = await predictNextPrompt({ llm: model('继续', 'max-tokens'), route, context });
  assert.equal(truncated.code, 'truncated'); assert.equal(truncated.text, undefined);
});

test('jobs: kinds coexist and default queries/binds retain optimize semantics', async () => {
  const store = createJobStore({ timeoutMs: 5000 });
  const run = async function* () { await new Promise(() => {}); };
  const o = store.create({ sessionId: 's', conversationKey: 'draft:x', inputText: '优化', run });
  const p = store.create({ kind: 'predict', sessionId: 's', conversationKey: 'draft:x', inputText: '', run });
  assert.equal(o.ok, true); assert.equal(p.ok, true);
  assert.equal(store.status({ sessionId: 's' }).id, o.job.id);
  assert.equal(store.status({ sessionId: 's', kind: 'predict' }).id, p.job.id);
  assert.equal(store.create({ kind: 'predict', sessionId: 's', run }).code, 'job_running');
  store.cancel(p.job.id); assert.equal(store.status({ sessionId: 's' }).status, 'running');
  store.consume(p.job.id); assert.equal(store.status({ sessionId: 's' }).consumed, false);
  store.cancel(o.job.id);
});

test('jobs: binding picks newest matching kind and refuses cross-session reassignment', async () => {
  const store = createJobStore({ timeoutMs: 5000, now: () => 100 });
  const run = async function* () { yield { type: 'final', ok: true, text: '结果' }; };
  const a = store.create({ conversationKey: 'draft:x', run }); await store.wait(a.job.id);
  const b = store.create({ conversationKey: 'draft:x', run }); await store.wait(b.job.id);
  const p = store.create({ conversationKey: 'draft:x', kind: 'predict', run }); await store.wait(p.job.id);
  assert.equal(store.bind('draft:x', 's').id, b.job.id);
  assert.equal(store.bind('draft:x', 'other'), null);
  assert.equal(store.status({ conversationKey: 'draft:x', kind: 'predict' }).sessionId, null);
});

test('jobs: completed work expires and host instances never reuse old job state', async () => {
  const store = createJobStore({ ttlMs: 5 });
  const created = store.create({ sessionId: 's', run: async function* () { yield { type: 'final', ok: true, text: 'ok' }; } });
  await store.wait(created.job.id);
  assert.equal(createJobStore().status({ sessionId: 's' }), null);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(store.status({ sessionId: 's' }), null);
});

import { preservesAnchors } from '../src/validate.js';
test('anchors: preserve full path and exact identifiers without treating adjoining Chinese prose as a path', () => {
  assert.equal(preservesAnchors('检查src/a.js的实现', '检查 src/a.js 的实现。'), true);
  assert.equal(preservesAnchors('检查 src/a.js', '检查 lib/a.js'), false);
  assert.equal(preservesAnchors('修改 getUser', '修改 getuser'), false);
  assert.equal(preservesAnchors('检查 `目录/a b.js`', '检查 `目录/a b.js` 的实现'), true);
  assert.equal(preservesAnchors('检查 https://example.com/api?a=1。', '检查 https://example.com/api?a=1 的响应。'), true);
});

test('greetings and compound confirmations stay zero-call without swallowing substantive continuation', async () => {
  const llm = model('继续讨论，不修改。');
  for (const text of ['', '你好', '可以，继续吧', 'OK, go ahead']) {
    const result = await optimizeOnce({ text, llm, route }); assert.equal(result.calls, 0);
  }
  assert.equal(llm.seen.length, 0);
  await optimizeOnce({ text: '继续讨论缓存失效，不要修改代码', llm, route }); assert.equal(llm.seen.length, 1);
});

test('long oral drafts may compress substantially without a false language rejection', async () => {
  const text = '我想说的是这个列表每次往下翻都会卡住，先查清原因别改代码。'.repeat(10);
  const result = await optimizeOnce({ text, llm: model('先调查列表滚动卡顿的原因，不要修改代码。'), route });
  assert.equal(result.ok, true); assert.equal(result.changed, true);
});
