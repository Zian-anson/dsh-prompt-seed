#!/usr/bin/env node
/** Prepare an offline review sheet. No extra model call or credentials. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const input = process.argv[2] ?? resolve(import.meta.dirname, '../bench/latest.json');
const report = JSON.parse(readFileSync(input, 'utf8'));
const review = report.rows.map((row) => ({ id: row.id, kind: row.kind, input: row.text ?? '', context: row.context ?? [], output: row.output,
  criteria: row.criteria, improvable: row.improvable ?? null, verdict: null, informationGain: '', distortion: '', plausibleReply: null, note: '' }));
const out = input.replace(/\.json$/, '') + '-review.json';
writeFileSync(out, JSON.stringify(review, null, 2) + '\n');
console.log('Review sheet: ' + out + '\nRewrite target: ≥80% substantive improvement among improvable cases. Prediction: likely user reply, not recommended next step.');
