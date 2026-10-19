import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

test("client module: declares and injects session services", async () => {
  const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  let loaded;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(record) { loaded = record; },
      },
    },
    console,
  };
  vm.runInNewContext(source, sandbox);
  assert.equal(loaded.id, "dsh-prompt-seed");
  assert.equal(loaded.factory(() => ({ createElement: () => null })).inject.join(","), "slots,sessions,uiWorkspace");

  let dependencies;
  let mounted = false;
  const ctx = {
    effect(fn) { fn(); return () => {}; },
    inject(deps, callback) {
      dependencies = deps;
      callback({
        slots: {
          inject() { mounted = true; },
          register() { return () => {}; },
        },
        sessions: { create: async () => ({ sessionId: "s1" }), using: async () => ({ ok: true }) },
        uiWorkspace: { openSession() {} },
      });
    },
  };
  loaded.factory(() => ({ createElement: () => null })).apply(ctx);
  assert.equal(dependencies.join(","), "slots,sessions,uiWorkspace");
  assert.equal(mounted, true);
  assert.match(source, /data-client-version/);
  assert.match(source, /CLIENT_VERSION = '0\.20\.0'/);
});

import { toolbar } from './helpers/toolbar.mjs';

test('toolbar: one entry follows draft content, with recovery and prediction actions on demand', async () => {
  const f = await toolbar();
  try {
    assert.equal(f.r.byId('prompt-seed-optimize').props.disabled, false);
    assert.equal(f.r.byId('prompt-seed-predict'), undefined);
    f.r.click('prompt-seed-optimize'); await f.flush();
    assert.equal(f.r.byId('prompt-seed-optimize').props['aria-label'], '优化中 · 点击取消');
    f.calls[0].finish('找出首页瓶颈并优化，比较前后表现。'); await f.flush();
    assert.equal(f.read().draft, '找出首页瓶颈并优化，比较前后表现。');
    assert.equal(f.r.byId('prompt-seed-optimize').props['aria-label'], '换一版');
    f.r.click('prompt-seed-more'); await f.flush(); f.r.click('prompt-seed-undo'); await f.flush(); assert.equal(f.read().draft, '首页太慢，优化一下');
    f.edit(''); await f.flush();
    assert.equal(f.r.byId('prompt-seed-optimize'), undefined);
    assert.equal(f.r.byId('prompt-seed-predict').props.disabled, false);
    f.r.click('prompt-seed-predict'); await f.flush(); f.calls[1].finish('为什么这样设计？'); await f.flush();
    assert.equal(f.r.byId('prompt-seed-predict'), undefined);
    assert.equal(f.r.byId('prompt-seed-optimize').props.disabled, false);
    f.r.click('prompt-seed-more'); await f.flush();
    f.r.click('prompt-seed-again-predict'); await f.flush();
    assert.equal(f.calls[2].body.action, 'predict');
    f.calls[2].finish('能解释一下原因吗？'); await f.flush();
    f.r.click('prompt-seed-more'); await f.flush(); f.r.click('prompt-seed-withdraw'); await f.flush(); assert.equal(f.read().draft, '');
  } finally { f.close(); }
});

test('toolbar: manual edits show original preview, not destructive immediate restore', async () => {
  const f = await toolbar();
  try {
    f.r.click('prompt-seed-optimize'); await f.flush(); f.calls[0].finish('优化后的草稿'); await f.flush();
    f.edit('手改后不要覆盖'); await f.flush();
    f.r.click('prompt-seed-more'); await f.flush(); f.r.click('prompt-seed-undo'); await f.flush();
    assert.equal(f.read().draft, '手改后不要覆盖'); assert.ok(f.r.byLabel('原文预览'));
    assert.match(f.r.text(), /替换草稿/);
  } finally { f.close(); }
});

test('toolbar: existing blank session optimizes without create/open', async () => {
  const f = await toolbar({ blank: true });
  try {
    assert.equal(f.r.byId('prompt-seed-predict'), undefined);
    f.r.click('prompt-seed-optimize'); await f.flush(); assert.equal(f.creates.length, 0); assert.equal(f.opens.length, 0);
    f.calls[0].finish('改写结果'); await f.flush(); assert.equal(f.read().draft, '改写结果');
  } finally { f.close(); }
});

test('toolbar: session creation happens after generation starts and never runs the model twice', async () => {
  const f = await toolbar({ noSession: true, blank: true });
  try {
    f.r.click('prompt-seed-optimize'); await f.flush();
    assert.equal(f.calls.length, 1); assert.equal(f.creates.length, 1); assert.equal(f.opens[0], 'new');
    f.calls[0].finish('生成结果'); await f.flush(); assert.equal(f.calls.length, 1);
  } finally { f.close(); }
});

test('toolbar: late session creation must not navigate away from a different conversation', async () => {
  let complete;
  const f = await toolbar({ noSession: true, create: () => new Promise((resolve) => { complete = resolve; }) });
  try {
    f.r.click('prompt-seed-optimize'); await f.flush(); f.switchSession('other');
    complete({ sessionId: 'new' }); await f.flush(); assert.equal(f.opens.length, 0);
    f.calls[0].finish('旧会话结果'); await f.flush(); assert.equal(f.read().draft, '');
  } finally { f.close(); }
});

test('toolbar: failed session creation preserves generation and allows the next explicit attempt', async () => {
  let attempts = 0;
  const f = await toolbar({ noSession: true, create: async () => {
    if (++attempts === 1) throw new Error('temporary session failure');
    return { sessionId: 'new' };
  } });
  try {
    f.r.click('prompt-seed-optimize'); await f.flush();
    f.calls[0].finish('第一次改写'); await f.flush();
    assert.equal(f.read().draft, '第一次改写'); assert.equal(f.opens.length, 0);
    f.r.click('prompt-seed-optimize'); await f.flush();
    assert.equal(f.calls.length, 2); assert.equal(f.creates.length, 2); assert.equal(f.opens[0], 'new');
    f.calls[1].finish('第二次改写'); await f.flush();
  } finally { f.close(); }
});

test('toolbar: unsafe replacement explains disabled action when a new reference was added', async () => {
  const f = await toolbar();
  try {
    f.r.click('prompt-seed-optimize'); await f.flush(); f.calls[0].finish('改写候选'); await f.flush();
    f.edit('新增 @README.md', { occurrences: [{ source: 'file', ref: '/README.md', label: 'README.md', clipboardText: '@README.md', offset: 3, length: 10 }] }); await f.flush();
    f.r.click('prompt-seed-more'); await f.flush(); f.r.click('prompt-seed-undo'); await f.flush();
    assert.equal(f.r.byId('prompt-seed-replace-optimize').props.disabled, true);
    assert.match(f.r.text(), /无法安全替换，可复制所需文字/); assert.equal(f.read().draft, '新增 @README.md');
  } finally { f.close(); }
});


test('toolbar: whitespace selects prediction but a blank conversation cannot generate', async () => {
  const f = await toolbar({ blank: true, text: '  \n' });
  try {
    assert.equal(f.r.byId('prompt-seed-optimize'), undefined);
    assert.equal(f.r.byId('prompt-seed-predict').props.disabled, true);
    assert.equal(f.calls.length, 0); assert.equal(f.r.byId('prompt-seed-more'), undefined);
    f.edit('有内容'); await f.flush();
    assert.equal(f.r.byId('prompt-seed-predict'), undefined);
    assert.equal(f.r.byId('prompt-seed-optimize').props.disabled, false);
  } finally { f.close(); }
});

test('toolbar: success and progress have no persistent copy; unchanged and failure stay distinct', async () => {
  const f = await toolbar();
  try {
    f.r.click('prompt-seed-optimize'); await f.flush(); assert.equal(f.r.text().trim(), '');
    f.calls[0].finish('更清楚的草稿'); await f.flush(); assert.equal(f.r.text().trim(), '');
    f.r.click('prompt-seed-optimize'); await f.flush();
    f.calls[1].finish('首页太慢，优化一下', { changed: false }); await f.flush();
    assert.equal(f.r.text().trim(), '未改动');
    f.r.click('prompt-seed-optimize'); await f.flush();
    f.calls[2].finish('', { ok: false, code: 'llm_error', error: '模型连接失败，未修改草稿' }); await f.flush();
    assert.equal(f.r.text().trim(), '失败');
    assert.match(f.r.byId('prompt-seed-optimize').props.title, /模型连接失败/);
  } finally { f.close(); }
});

test('toolbar: typing during prediction switches the icon without losing cancellation', async () => {
  const f = await toolbar({ text: '' });
  try {
    f.r.click('prompt-seed-predict'); await f.flush(); f.edit('我的手写内容'); await f.flush();
    assert.equal(f.r.byId('prompt-seed-predict'), undefined); assert.ok(f.r.byId('prompt-seed-optimize'));
    assert.match(f.r.byId('prompt-seed-more').props.title, /预测中/);
    f.r.click('prompt-seed-more'); await f.flush(); f.r.click('prompt-seed-cancel-predict'); await f.flush();
    assert.equal(f.requests.filter(x => x.action === 'cancel')[0].kind, 'predict');
    f.calls[0].finish('迟到的预测'); await f.flush();
    assert.equal(f.read().draft, '我的手写内容'); assert.equal(f.r.byId('prompt-seed-withdraw'), undefined);
  } finally { f.close(); }
});

test('toolbar: hidden prediction result remains explicitly retrievable without overwriting edits', async () => {
  const f = await toolbar({ text: '' });
  try {
    f.r.click('prompt-seed-predict'); await f.flush(); f.edit('后写的草稿'); await f.flush();
    f.calls[0].finish('为什么这样设计？'); await f.flush();
    assert.equal(f.read().draft, '后写的草稿'); assert.equal(f.r.byId('prompt-seed-predict'), undefined);
    assert.match(f.r.byId('prompt-seed-more').props.title, /预测结果待取/);
    f.r.click('prompt-seed-more'); await f.flush(); f.r.click('prompt-seed-view-predict'); await f.flush();
    assert.ok(f.r.byLabel('预测结果')); f.r.click('prompt-seed-replace-predict'); await f.flush();
    assert.equal(f.read().draft, '为什么这样设计？');
    f.edit('我编辑了这个候选'); await f.flush();
    assert.equal(f.r.byId('prompt-seed-more'), undefined);
  } finally { f.close(); }
});

test('toolbar: clearing during rewrite allows prediction and keeps both cancel targets isolated', async () => {
  const f = await toolbar();
  try {
    f.r.click('prompt-seed-optimize'); await f.flush(); f.edit(''); await f.flush();
    assert.equal(f.r.byId('prompt-seed-optimize'), undefined);
    f.r.click('prompt-seed-predict'); await f.flush();
    f.r.click('prompt-seed-more'); await f.flush(); f.r.click('prompt-seed-cancel-optimize'); await f.flush();
    assert.equal(f.requests.filter(x => x.action === 'cancel')[0].kind, 'optimize');
    assert.equal(f.r.byId('prompt-seed-predict').props['aria-label'], '预测中 · 点击取消');
    f.calls[0].finish('不能填入的优化'); f.calls[1].finish('接下来呢？'); await f.flush();
    assert.equal(f.read().draft, '接下来呢？');
  } finally { f.close(); }
});
