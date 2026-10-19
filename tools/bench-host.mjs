/** Development-only Cordis entry. Loaded by --patch, never shipped in lib/. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { optimizeStream } from '../src/optimize.js';
import { predictStream } from '../src/predict.js';
import { createJobStore } from '../src/jobs.js';
import { loadPromptOverrides } from '../src/prompts.js';
import { preservesAnchors } from '../src/validate.js';
export const name = 'prompt-seed-benchmark';
export const inject = ['llm', 'agentDefaultModel', 'webServer'];
export function apply(ctx, config) {
  let alive = true;
  ctx.effect(() => () => { alive = false; }, 'benchmark-lifetime');
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    void run().catch((error) => { console.error('[bench] failed:', error.message); console.log('[bench] complete'); });
  };
  if (config.autorun !== false) start();
  else ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/prompt-seed-benchmark', handler(req, res) {
    const peer = req.socket?.remoteAddress;
    const host = req.headers?.host ?? '';
    const origin = req.headers?.origin;
    const trusted = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host) && (!origin || origin === 'http://' + host);
    if (!trusted || req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json')) { res.writeHead(403); res.end(); return; }
    start(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ started: true }));
  } }), 'benchmark-trigger');
  async function run() {
    const root = resolve(import.meta.dirname, '..');
    const corpus = ['corpus.json', 'predict-corpus.json'].flatMap((file) => JSON.parse(readFileSync(resolve(root, 'bench', file), 'utf8')));
    const rows = [];
    const route = config.provider && config.model ? { provider: config.provider, model: config.model, reasoningEffort: 'low' } : ctx.agentDefaultModel.currentSelection();
    const overrides = loadPromptOverrides();
    const store = createJobStore({ timeoutMs: 20000 });
    for (const item of corpus.slice(config.start ?? 0, (config.start ?? 0) + (config.limit ?? corpus.length))) {
      if (!alive) return;
      const kind = item.kind ?? 'optimize';
      let calls = 0;
      const sessionId = 'prompt-seed-bench-' + item.id;
      const llm = { stream(request) { calls += 1; return ctx.llm.stream({ ...request, sessionId }); } };
      const sessionQuery = { async readSurface() { return { events: (item.context ?? []).map((turn, seq) => ({ type: turn.role + '/message', seq, data: { role: turn.role, content: [{ type: 'text', text: turn.text }] } })) }; } };
      const started = Date.now();
      const job = store.create({ kind, sessionId, inputText: item.text ?? '', run: (signal) => (kind === 'predict' ? predictStream : optimizeStream)({ text: item.text ?? '', llm, route, sessionId, sessionQuery, overrides, signal }) });
      const result = await store.wait(job.job.id);
      rows.push({ ...item, kind, output: result.text, ok: result.ok, code: result.code ?? null, reason: result.reason ?? null, calls, ms: Date.now() - started, ttftMs: result.ttftMs ?? null, anchorOk: kind === 'predict' || preservesAnchors(item.text, result.text ?? '') });
      console.log(`[bench] ${item.id}: ${result.code ?? 'ok'}, calls=${calls}, ${rows.at(-1).ms}ms`);
      // Persist each completed sample so an interrupted provider never loses previous evidence.
      writeFileSync(config.out, JSON.stringify({ route, templates: Object.keys(overrides), rows }, null, 2) + '\n');
    }
    console.log('[bench] complete');
  }
}
