#!/usr/bin/env node
/** Real-model samples through DSH's own llm service. No credential or provider HTTP access. */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const root = resolve(import.meta.dirname, '..');
const out = resolve(option('--out', join(root, 'bench/latest.json')));
const profile = option('--profile', 'web');
if (profile === 'desktop') throw new Error('Use a separate test profile, not the reserved live desktop profile.');
const dir = mkdtempSync(join(tmpdir(), 'prompt-seed-bench-'));
const patch = join(dir, 'bench.yml');
const runOutput = join(dir, 'results.json');
const config = { out: runOutput, start: Number(option('--start', 0)), limit: Number(option('--limit', args.includes('--quick') ? 6 : 40)), provider: option('--provider'), model: option('--model') };
const corpusSize = ['corpus.json', 'predict-corpus.json'].reduce((sum, file) => sum + JSON.parse(readFileSync(join(root, 'bench', file), 'utf8')).length, 0);
const expectedCases = Math.max(0, Math.min(config.limit, corpusSize - config.start));
writeFileSync(patch, JSON.stringify([{ insert: [{ id: 'prompt-seed-benchmark', name: pathToFileURL(join(root, 'tools/bench-host.mjs')).href, config }] }]));
const child = spawn(option('--dsh', 'dsh'), ['--profile', profile, ...(option('--patch') ? ['--patch', resolve(option('--patch'))] : []), '--patch', patch, '--no-open', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
let done = false;
let buffer = '';
const finish = () => { done = true; child.kill('SIGTERM'); };
child.stdout.on('data', (data) => { process.stdout.write(data); buffer = (buffer + data).slice(-3000); if (buffer.includes('[bench] complete')) finish(); });
child.stderr.on('data', (data) => process.stderr.write(data));
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
process.on('SIGINT', finish);
const timeout = setTimeout(() => { console.error('[bench] host deadline exceeded'); finish(); }, (config.limit * 21000) + 30000);
await new Promise((resolve) => child.on('close', resolve));
clearTimeout(timeout);
if (!done) process.exitCode = 1;
let report;
try { report = JSON.parse(readFileSync(runOutput, 'utf8')); } catch { console.error('[bench] this run produced no results; existing output was not changed'); process.exitCode = 1; }
rmSync(dir, { recursive: true });
if (report) {
  if (report.rows.length !== expectedCases) { console.error(`[bench] incomplete: ${report.rows.length}/${expectedCases} cases`); process.exitCode = 1; }
  const summary = {};
  for (const kind of ['optimize', 'predict']) {
    const rows = report.rows.filter((row) => row.kind === kind);
    const times = rows.filter((row) => row.calls > 0).map((row) => row.ms).sort((a, b) => a - b);
    const percentile = (p) => times.length ? times[Math.ceil(times.length * p) - 1] : null;
    summary[kind] = { cases: rows.length, timedCases: times.length, p50: percentile(.5), p95: percentile(.95),
      badCalls: rows.filter((row) => row.calls !== row.expectCalls).length,
      failures: rows.filter((row) => row.expectCalls && !row.ok && !(row.allowNoPrediction && row.code === 'cannot_predict')).length,
      anchorLoss: rows.filter((row) => !row.anchorOk).length };
    const s = summary[kind];
    if (s.badCalls || s.failures || s.anchorLoss || s.p50 > 3000 || s.p95 > 8000) process.exitCode = 1;
  }
  writeFileSync(out, JSON.stringify({ ...report, summary }, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  console.log('[bench] Review information gain/distortion and reply plausibility in ' + out);
}
