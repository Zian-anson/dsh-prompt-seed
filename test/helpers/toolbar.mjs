import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { renderer } from './render.mjs';
import { tick } from './controller.mjs';
export async function toolbar(options = {}) {
  const r = renderer(); let loaded; let occupant;
  let sessionId = options.noSession ? undefined : 's1';
  let input = { draft: options.text ?? '首页太慢，优化一下', draftRev: 1, phase: 'plain', occurrences: [], attachmentIds: [] };
  let running = false;
  const memory = new Map(); const requests = []; const jobs = []; const calls = []; const creates = []; const opens = []; const writes = [];
  let serial = 0;
  const storage = { getItem: (k) => memory.get(k), setItem: (k, v) => memory.set(k, v), removeItem: (k) => memory.delete(k) };
  const inputActions = { setDraft(doc) { writes.push(doc); input = { ...input, draft: typeof doc === 'string' ? doc : doc.text, occurrences: typeof doc === 'string' ? [] : doc.references, draftRev: input.draftRev + 1 }; r.render(); }, persistDraft() {} };
  const source = await readFile(new URL('../../lib/client.js', import.meta.url), 'utf8');
  const sandbox = { window: { sessionStorage: storage, __ModuleLoader__: { load(record) { loaded = record; } } }, console, setTimeout, clearTimeout, setInterval, clearInterval, Response, TextDecoder, crypto: globalThis.crypto,
    async fetch(_url, init) {
      const body = JSON.parse(init.body); requests.push(body);
      const job = jobs.findLast((j) => j.kind === (body.kind ?? 'optimize') && (body.sessionId ? j.sessionId === body.sessionId : j.conversationKey === body.conversationKey));
      const json = (data) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
      if (body.action === 'status') return json({ ok: true, job: job ?? null, hasAssistant: !options.blank, contextKnown: true, lastUserMessageId: 's1:1' });
      if (body.action === 'bind') { if (job) job.sessionId = body.sessionId; else { const old = jobs.findLast((j) => j.conversationKey === body.conversationKey && j.kind === body.kind); if (old) { old.sessionId = body.sessionId; return json({ ok: true, job: old }); } } return json({ ok: true, job }); }
      if (body.action === 'consume') { const j = jobs.find((j) => j.id === body.jobId); if (j) j.consumed = true; return json({ ok: true }); }
      if (body.action === 'cancel') { const j = jobs.find((j) => j.id === body.jobId); if (j) { j.status = 'cancelled'; j.result = { ok: false, code: 'cancelled' }; } return json({ ok: true, job: j }); }
      const next = { id: 'j' + ++serial, kind: body.action, status: 'running', sessionId: body.sessionId, conversationKey: body.conversationKey, inputText: body.text };
      jobs.push(next);
      const encoder = new TextEncoder(); let stream;
      const response = new Response(new ReadableStream({ start(c) { stream = c; c.enqueue(encoder.encode(JSON.stringify({ type: 'meta', jobId: next.id, kind: next.kind }) + '\n')); } }), { headers: { 'content-type': 'application/x-ndjson' } });
      calls.push({ body, finish(text, extra = {}) { next.status = extra.ok === false ? 'failed' : 'done'; next.result = { type: 'final', ok: true, text, changed: true, jobId: next.id, kind: next.kind, ...extra }; stream.enqueue(encoder.encode(JSON.stringify(next.result) + '\n')); stream.close(); } });
      return response;
    },
  };
  vm.runInNewContext(source, sandbox); const plugin = loaded.factory(() => r.React);
  plugin.apply({ effect(fn) { fn(); }, inject(_deps, fn) { fn({
    slots: { inject(_name, fn) { fn(); }, register(_meta, component) { occupant = component; } },
    sessions: { async create(request) { creates.push(request); return options.create ? options.create() : { sessionId: 'new' }; } },
    uiWorkspace: { openSession(id) { opens.push(id); sessionId = id; input = { ...input, draft: '', draftRev: 0 }; r.render(); } },
  }); } });
  r.mount(() => occupant({ sessionId, workspaceId: 'w1', useInput: (selector) => selector(input), inputActions,
    useSession: (selector) => selector({ sessionId, blank: options.blank ?? false, running, awaitingFirstTurn: false }) }));
  await tick(); await tick();
  return { r, calls, requests, creates, opens, writes, read: () => input,
    async flush() { await tick(); await tick(); },
    edit(text, extra = {}) { input = { ...input, draft: text, draftRev: input.draftRev + 1, ...extra }; r.render(); },
    setRunning(value) { running = value; r.render(); },
    switchSession(id) { sessionId = id; input = { ...input, draft: '', draftRev: 0 }; r.render(); },
    close: () => r.unmount(),
  };
}
