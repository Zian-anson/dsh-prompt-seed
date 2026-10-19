import { createFeatureController } from '../../src/client-core.js';
export const tick = () => new Promise((resolve) => setImmediate(resolve));
export function fixture(options = {}) {
  let current = { key: 's:s1', draft: options.text ?? '首页太慢，优化一下', draftRev: 1, phase: 'plain', occurrences: [], attachmentIds: [], ...options.input };
  const records = new Map();
  const writes = [];
  const calls = [];
  const requests = [];
  const memory = new Map();
  const storage = { getItem: (key) => memory.get(key), setItem: (key, value) => memory.set(key, value), removeItem: (key) => memory.delete(key) };
  let messageId = 's1:1';
  let serial = 0;
  const identity = {};
  const io = {
    key: current.key, sessionId: 's1', storage, inputIdentity: identity, semanticSupported: true,
    readInput: () => current,
    writeInput(doc) {
      writes.push(doc);
      current = { ...current, draft: typeof doc === 'string' ? doc : doc.text, draftRev: current.draftRev + 1,
        occurrences: typeof doc === 'string' ? [] : doc.references, claim: typeof doc === 'string' ? undefined : doc.command };
    },
    async post(body) {
      requests.push(body);
      const job = records.get(body.kind);
      if (body.action === 'status') return { ok: true, job: job ?? null, lastUserMessageId: messageId, hasAssistant: true, contextKnown: true };
      if (body.action === 'cancel') {
        if (job?.id === body.jobId) { job.status = 'cancelled'; job.result = { ok: false, code: 'cancelled' }; }
        return { ok: true, job };
      }
      if (body.action === 'consume') { if (job?.id === body.jobId) job.consumed = true; return { ok: true }; }
      if (body.action === 'bind') { if (job) job.sessionId = body.sessionId; return { ok: true, job }; }
    },
    stream(body, onEvent) {
      const job = { id: 'j' + ++serial, kind: body.kind, status: 'running', sessionId: body.sessionId, conversationKey: body.conversationKey, inputText: body.text };
      records.set(body.kind, job);
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      const call = { body, job, meta() { onEvent({ type: 'meta', jobId: job.id }); },
        delta(text) { onEvent({ type: 'delta', text }); },
        finish(text = '找出首页瓶颈并优化，对比修改前后的表现。', extra = {}) {
          job.result = { type: 'final', ok: true, kind: body.kind, text, changed: true, jobId: job.id, ...extra };
          job.status = job.result.ok ? 'done' : 'failed';
          onEvent(job.result); resolve(job.result);
        },
      };
      calls.push(call);
      if (!options.delayMeta) call.meta();
      return promise;
    },
  };
  function make(kind, extra = {}) { return createFeatureController(kind, { ...io, ...extra }); }
  return { io, make, storage, memory, writes, calls, requests, records, read: () => current,
    edit(text, extra = {}) { current = { ...current, draft: text, draftRev: current.draftRev + 1, ...extra }; },
    set(extra) { current = { ...current, ...extra }; },
    sent(id) { messageId = id; },
  };
}
