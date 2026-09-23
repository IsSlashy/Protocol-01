/**
 * node --test scripts/bench/summary.test.mts
 *
 * summary.md is the only file the published tables quote (BENCHMARK-METHOD.md
 * §7), so it must carry the publishability verdict of every flow. Before this
 * test (re-verifier finding, 2026-09-22) it said "Not publishable (smoke)" only
 * when N < 30 or on a dry run: a run on Node 26 without --node-accepted, a live
 * run without --rpc-plan, a busy machine or a flow with fewer than 30 good
 * samples wrote a clean-looking summary.md while its <flow>.json said
 * publishable: false.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderSummary, type SummaryInput } from './summary.mts';

const ok = { publishable: true, why_not: [] as string[] };
const base: SummaryInput = {
  startedAt: '2026-09-22T10:00:00.000Z',
  baseline: 'pre-v2 (pre-WP10) baseline: v1 as deployed',
  commit: 'beaa87ba',
  n: 30,
  coldN: 30,
  node: 'v24.9.0',
  dry: false,
  flows: ['wasm-node', 'deposit'],
  rows: [
    { flow: 'wasm-node', row: '| wasm-node | C0 | warm prove | n 30  min 1 | 1 B |' },
    { flow: 'deposit', row: '| deposit | — | product time | n 30  min 1 | 0 failed |' },
  ],
  verdicts: { 'wasm-node': ok, deposit: ok },
  errors: [],
};

const NOT = /NOT PUBLISHABLE/;

test('every flow publishable: the verdict says so, and no row is marked no', () => {
  const md = renderSummary(base);
  assert.doesNotMatch(md, NOT);
  assert.match(md, /Verdict: publishable/);
  for (const line of md.split('\n').filter((l) => l.startsWith('| wasm-node') || l.startsWith('| deposit'))) {
    assert.match(line, /\| yes \|$/, line);
  }
});

test('Node 26 without --node-accepted at N = 30: NOT PUBLISHABLE, with the reason', () => {
  const why = 'Node v26.1.0: the plan names Node 24; the founder records another choice with --node-accepted 26';
  const md = renderSummary({ ...base, node: 'v26.1.0', verdicts: { 'wasm-node': { publishable: false, why_not: [why] }, deposit: { publishable: false, why_not: [why] } } });
  assert.match(md, NOT);
  assert.ok(md.includes(why), md);
  assert.match(md, /\| wasm-node \| C0 .*\| no \|$/m);
});

test('a live flow without --rpc-plan: NOT PUBLISHABLE, only that flow\'s rows marked no', () => {
  const why = 'the RPC plan tier is not recorded (--rpc-plan "<provider and tier>")';
  const md = renderSummary({ ...base, verdicts: { 'wasm-node': ok, deposit: { publishable: false, why_not: [why] } } });
  assert.match(md, NOT);
  assert.ok(md.includes(`deposit: ${why}`), md);
  assert.match(md, /^\| deposit .*\| no \|$/m);
  assert.match(md, /^\| wasm-node .*\| yes \|$/m);
});

test('a busy machine or fewer than 30 good samples: NOT PUBLISHABLE', () => {
  for (const why of ['machine 40 % busy on average during this flow (limit 15 %)', 'n = 29 < 30']) {
    const md = renderSummary({ ...base, verdicts: { 'wasm-node': { publishable: false, why_not: [why] }, deposit: ok } });
    assert.match(md, NOT);
    assert.ok(md.includes(why), why);
  }
});

test('a flow that failed or wrote no verdict makes the whole run NOT PUBLISHABLE', () => {
  const failed = renderSummary({ ...base, verdicts: { 'wasm-node': ok }, errors: ['deposit: vitest exited 1'] });
  assert.match(failed, NOT);
  assert.match(failed, /deposit: failed/);
  const missing = renderSummary({ ...base, verdicts: { 'wasm-node': ok } });
  assert.match(missing, NOT);
  assert.match(missing, /deposit: no verdict/);
});

test('a dry run is never publishable, even with every flow marked publishable', () => {
  assert.match(renderSummary({ ...base, dry: true }), NOT);
});
