import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function runFakeHost(source, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-seed-bench-test-'));
  const host = join(dir, 'host.mjs'); const out = join(dir, 'report.json');
  const previous = '{"rows":[{"kind":"optimize","ms":1,"calls":1,"expectCalls":1,"ok":true,"anchorOk":true}]}';
  writeFileSync(host, '#!/usr/bin/env node\n' + source, { mode: 0o700 });
  writeFileSync(out, previous);
  const result = spawnSync(process.execPath, ['tools/bench.mjs', '--dsh', host, '--out', out, ...args], { encoding: 'utf8' });
  const saved = readFileSync(out, 'utf8'); rmSync(dir, { recursive: true });
  return { result, saved, previous };
}

test('benchmark: a failed Host cannot reuse a previous run as current evidence', () => {
  const { result, saved, previous } = runFakeHost('process.exit(1);');
  assert.equal(result.status, 1); assert.equal(saved, previous);
  assert.match(result.stderr, /this run produced no results/);
  assert.doesNotMatch(result.stdout, /Review information gain/);
});

test('benchmark: partial results remain usable but cannot pass a complete run', () => {
  const { result, saved } = runFakeHost(`
    import { readFileSync, writeFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    const config = JSON.parse(readFileSync(args[args.indexOf('--patch') + 1], 'utf8'))[0].insert[0].config;
    writeFileSync(config.out, JSON.stringify({ rows: [{ kind: 'optimize', ms: 1000, calls: 1, expectCalls: 1, ok: true, anchorOk: true }] }));
    console.log('[bench] complete');
  `, ['--limit', '2']);
  assert.equal(result.status, 1); assert.match(result.stderr, /incomplete: 1\/2/);
  assert.equal(JSON.parse(saved).summary.optimize.cases, 1);
});
