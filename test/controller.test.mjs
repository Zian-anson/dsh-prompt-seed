import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rewriteDocument, readEventResponse } from '../src/client-core.js';
import { fixture, tick } from './helpers/controller.mjs';

test('rewrite: applies once and regenerates from original, not rewritten text', async () => {
  const f = fixture(); const c = f.make('optimize'); await c.attach();
  const first = c.run(); f.calls[0].finish(); await first;
  assert.equal(f.writes.length, 1); assert.equal(c.untouched(), true);
  const second = c.run(); assert.equal(f.calls[1].body.text, '首页太慢，优化一下');
  f.calls[1].finish('另一个更清楚的版本'); await second;
  assert.equal(f.writes.length, 2);
  assert.equal(c.restore(), true); assert.equal(f.read().draft, '首页太慢，优化一下');
});

test('rewrite: manual edits start a new round but do not erase original recovery', async () => {
  const f = fixture(); const c = f.make('optimize'); await c.attach();
  const run = c.run(); f.calls[0].finish(); await run;
  f.edit('我手改后的草稿'); c.observe(f.read());
  assert.equal(c.untouched(), false); assert.equal(c.previewOriginal(), '首页太慢，优化一下');
  assert.equal(c.restore(), false); assert.equal(f.read().draft, '我手改后的草稿');
  const next = c.run(); assert.equal(f.calls[1].body.text, '我手改后的草稿');
  f.calls[1].finish('手改稿的优化版'); await next;
  assert.equal(c.previewOriginal(), '我手改后的草稿');
});

test('rewrite: an edit-and-revert during generation cannot pass the revision guard', async () => {
  const f = fixture(); const c = f.make('optimize'); await c.attach();
  const run = c.run(); f.edit('正在编辑'); f.edit('首页太慢，优化一下');
  f.calls[0].finish(); await run;
  assert.equal(f.writes.length, 0); assert.equal(c.getState().status, 'ready');
  assert.equal(c.replace(), true); assert.equal(f.writes.length, 1);
});

test('prediction: new typing is never overwritten and explicit retrieval is possible', async () => {
  const f = fixture({ text: '' }); const c = f.make('predict'); await c.attach();
  const run = c.run(); f.edit('我自己的下一句'); f.calls[0].finish('为什么选择这个方案？'); await run;
  assert.equal(f.read().draft, '我自己的下一句'); assert.equal(c.getState().status, 'ready');
  assert.equal(c.withdraw(), false); assert.equal(c.replace(), true);
  assert.equal(f.read().draft, '为什么选择这个方案？');
});

test('prediction: unchanged candidate supports another guess and withdrawal; edited one does not', async () => {
  const f = fixture({ text: '' }); const c = f.make('predict'); await c.attach();
  const run = c.run(); f.calls[0].finish('为什么这样设计？'); await run;
  assert.equal(c.untouched(), true); assert.equal(c.canRun(true), true);
  const again = c.run(); assert.equal(f.calls[1].body.text, ''); f.calls[1].finish('可以再解释一下吗？'); await again;
  assert.equal(c.withdraw(), true); assert.equal(f.read().draft, '');
  const next = c.run(); f.calls[2].finish('好的'); await next;
  f.edit('好的，不过先讨论'); c.observe(f.read());
  assert.equal(c.withdraw(), false); assert.equal(c.canRun(true), false);
});

test('features: overlapping tasks and cancellation are independent', async () => {
  const f = fixture({ text: '' }); const p = f.make('predict'); const o = f.make('optimize'); await p.attach(); await o.attach();
  const predict = p.run(); f.edit('把首页优化一下'); const optimize = o.run();
  await p.cancel(); assert.equal(o.getState().status, 'running');
  f.calls[0].finish('继续吧'); await predict;
  f.calls[1].finish(); await optimize;
  assert.equal(f.writes.length, 1); assert.equal(o.getState().status, 'applied');
  assert.equal(f.requests.filter((x) => x.action === 'cancel')[0].kind, 'predict');
});

test('cancellation: cancel before meta waits for the owned job id and ignores late output', async () => {
  const f = fixture({ delayMeta: true }); const c = f.make('optimize'); await c.attach();
  const run = c.run(); await c.cancel(); f.calls[0].meta(); await tick(); f.calls[0].finish(); await run;
  assert.equal(f.writes.length, 0); assert.equal(c.getState().status, 'neutral');
  assert.equal(f.requests.filter((x) => x.action === 'cancel').length, 1);
});

test('switching: a result never enters another conversation; same live editor can recover', async () => {
  const f = fixture(); const c = f.make('optimize'); await c.attach(); const run = c.run();
  c.detach(); f.set({ key: 's:s2', draft: '另一个会话' }); f.calls[0].finish(); await run;
  assert.equal(f.writes.length, 0);
  f.set({ key: 's:s1', draft: '首页太慢，优化一下' }); await c.attach();
  assert.equal(f.writes.length, 1);
});

test('reload: persisted original survives; recovered job requires explicit replacement', async () => {
  const f = fixture(); const c = f.make('optimize'); await c.attach(); const run = c.run();
  c.detach(); f.calls[0].finish(); await run;
  const restored = f.make('optimize', { inputIdentity: {} }); await restored.attach();
  assert.equal(f.writes.length, 0); assert.equal(restored.previewOriginal(), '首页太慢，优化一下');
  assert.equal(restored.replace(), true);
  f.edit('手改'); restored.observe(f.read());
  const fresh = f.make('optimize'); await fresh.attach();
  assert.equal(fresh.previewOriginal(), '首页太慢，优化一下'); assert.equal(fresh.restore(true), true);
});

test('submission: transient submitting/failure preserves recovery; persisted user message clears it', async () => {
  const f = fixture(); const c = f.make('optimize'); await c.attach(); const run = c.run(); f.calls[0].finish(); await run;
  f.set({ phase: 'submitting' }); c.observe(f.read()); f.set({ phase: 'plain' }); c.observe(f.read()); await tick();
  assert.ok(c.getState().original);
  f.sent('s1:9'); await c.refresh(); assert.equal(c.getState().original, null); assert.equal(c.getState().candidate, null);
});

test('host restart: missing running job removes stale spinner without erasing draft', async () => {
  const f = fixture(); const c = f.make('optimize'); await c.attach(); const run = c.run();
  f.records.clear(); await c.refresh(); assert.equal(c.getState().status, 'idle'); assert.equal(f.writes.length, 0);
  f.calls[0].finish('', { ok: false, code: 'llm_error' }); await run;
});

test('input safety: submitting phase, attachment changes and different session all prevent automatic write', async () => {
  for (const change of [{ phase: 'submitting' }, { attachmentIds: ['new-image'] }, { key: 's:other' }]) {
    const f = fixture(); const c = f.make('optimize'); await c.attach(); const run = c.run(); f.set(change); f.calls[0].finish(); await run;
    assert.equal(f.writes.length, 0);
  }
});

test('references: structured write preserves chips and attachments; missing/ambiguous refs stay preview-only', async () => {
  const ref = { source: 'file', ref: '/a.ts', label: 'a.ts', clipboardText: '@a.ts', offset: 3, length: 5 };
  const f = fixture({ text: '检查 @a.ts', input: { occurrences: [ref], attachmentIds: ['image'] } });
  const c = f.make('optimize'); await c.attach(); const run = c.run(); f.calls[0].finish('请检查 @a.ts 的问题。'); await run;
  assert.equal(typeof f.writes[0], 'object'); assert.equal(f.writes[0].references[0].offset, 4);
  assert.deepEqual(f.read().attachmentIds, ['image']);
  const original = { text: '检查 @a.ts', references: [ref] };
  assert.equal(rewriteDocument(original, '检查文件', true), null);
  assert.equal(rewriteDocument(original, '@a.ts 和 @a.ts', true), null);
  assert.equal(rewriteDocument(original, '检查 @a.ts', false), null);
});

test('unchanged and failed results do not manufacture editor transactions', async () => {
  const f = fixture(); const c = f.make('optimize'); await c.attach(); const run = c.run();
  f.calls[0].finish(f.read().draft, { changed: false }); await run;
  assert.equal(f.writes.length, 0); assert.equal(c.getState().note, '已清楚，保留原文');
  const failed = c.run(); f.calls[1].finish('', { ok: false, code: 'truncated', error: '不完整' }); await failed;
  assert.equal(f.writes.length, 0); assert.equal(c.getState().status, 'error');
});

test('transport: split UTF-8 NDJSON is reassembled, including final without newline', async () => {
  const text = '{"type":"delta","text":"你好"}\n{"type":"final","ok":true,"text":"你好"}';
  const bytes = new TextEncoder().encode(text); const events = [];
  const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { 'content-type': 'application/x-ndjson' } });
  const final = await readEventResponse(response, (event) => events.push(event));
  assert.equal(final.text, '你好'); assert.equal(events.length, 2);
});

test('references: newly inserted chips disable explicit replacement and restoration', async () => {
  const f = fixture(); const c = f.make('optimize'); await c.attach(); const run = c.run();
  f.edit('新加 @b.ts', { occurrences: [{ source: 'file', ref: '/b.ts', label: 'b.ts', clipboardText: '@b.ts', offset: 3, length: 5 }] });
  f.calls[0].finish(); await run;
  assert.equal(c.canReplace(), false); assert.equal(c.replace(), false);
  assert.equal(c.canRestore(), false); assert.equal(c.restore(true), false); assert.equal(f.writes.length, 0);
});

test('status: a response issued before a new run cannot erase its task', async () => {
  const f = fixture(); let resolveStatus; let slow = false;
  const c = f.make('optimize', { post: (body) => body.action === 'status' && slow ? new Promise((resolve) => { resolveStatus = resolve; }) : f.io.post(body) });
  await c.attach(); slow = true; const status = c.refresh(); const run = c.run();
  resolveStatus({ ok: true, job: null }); await status;
  assert.equal(c.getState().status, 'running'); assert.equal(c.getState().jobId, f.calls[0].job.id);
  f.calls[0].finish(); await run; assert.equal(f.writes.length, 1);
});

test('submission: sending during generation cannot resurrect recovery after completion', async () => {
  const f = fixture(); const c = f.make('optimize'); await c.attach(); const run = c.run();
  f.sent('s1:8'); await c.refresh(); f.calls[0].finish(); await run;
  assert.equal(c.getState().original, null); assert.equal(c.getState().pending, null); assert.equal(f.writes.length, 0);
});
