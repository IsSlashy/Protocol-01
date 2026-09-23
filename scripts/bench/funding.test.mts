/**
 * node --test scripts/bench/funding.test.mts
 *
 * 1. Every constant funding.mts uses is re-read from the file it cites, so a
 *    harness or app change that moves one fails here before a founder funds a
 *    key from a stale figure.
 * 2. The arithmetic: the rent formula, the order-dependent minimum balance,
 *    and the largest-N search at its boundary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { K, depositNet, rentExempt, need, planNeed, maxN, samplesFor, runsFor } from './funding.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');
const num = (s: string) => Number(s.replace(/_/g, ''));
const pick = (src: string, re: RegExp, what: string) => {
  const m = re.exec(src);
  assert.ok(m, `${what}: pattern not found, the source moved`);
  return m[1]!;
};

test('constants match the sources they cite', () => {
  const sf = read('apps/web/lib/privacy/pool/subscribeFloat.ts');
  assert.equal(num(pick(sf, /export const NULLIFIER_RENT = ([\d_]+);/, 'NULLIFIER_RENT')), K.nullifierRent);
  assert.equal(num(pick(sf, /export const E_TX_FEE_BUDGET = ([\d_]+);/, 'E_TX_FEE_BUDGET')), K.spendFeeBudget);
  assert.equal(num(pick(sf, /export const SUBSCRIPTION_VAULT_LEN = ([\d_]+);/, 'SUBSCRIPTION_VAULT_LEN')), K.vaultLen);
  assert.equal(num(pick(sf, /export const PROOF_BUFFER_HEADER_BYTES = ([\d_]+);/, 'PROOF_BUFFER_HEADER_BYTES')), K.proofHeader);
  assert.equal(num(pick(sf, /\n\s*c7: ([\d_]+),/, 'MEASURED_PROOF_BYTES.c7')), K.proofBytes[7]);
  assert.equal(num(pick(sf, /RENT_ACCOUNT_OVERHEAD_BYTES = ([\d_]+);/, 'overhead')), 128);
  assert.equal(num(pick(sf, /RENT_LAMPORTS_PER_BYTE_YEAR = ([\d_]+);/, 'per byte-year')), 3_480);
  assert.equal(num(pick(sf, /RENT_EXEMPTION_YEARS = ([\d_]+);/, 'years')), 2);

  const se = read('apps/web/lib/privacy/pool/shieldEphemeral.ts');
  const m = /([\d_]{9,}) − ([\d_]{9,}) = ([\d_]{9,})/.exec(se);
  assert.ok(m, 'the measured deposit arithmetic in shieldEphemeral.ts moved');
  assert.equal(num(m[1]!), K.depositPrefundMeasured);
  assert.equal(num(m[2]!), K.depositReturnedMeasured);
  assert.equal(num(m[3]!), depositNet);

  const pf = read('apps/web/lib/privacy/pool/prefundAmount.ts');
  const step = num(pick(pf, /const STEP_LAMPORTS = ([\d_]+);/, 'STEP_LAMPORTS'));
  const extra = num(pick(pf, /const MAX_EXTRA_STEPS = ([\d_]+);/, 'MAX_EXTRA_STEPS'));
  assert.equal(step * extra, K.prefundJitterMax);

  assert.match(read('apps/web/lib/privacy/pool/liveDevnetUnshieldV4.test.ts'), /expect\(balance\)\.toBeGreaterThan\(1\.8e9\)/);
  assert.equal(K.withdrawalBalanceFloor, 1.8e9);
  assert.match(read('apps/web/lib/privacy/pool/liveDevnetShield.test.ts'), /expect\(balance\)\.toBeGreaterThan\(0\.5e9\)/);
  assert.equal(K.depositBalanceFloor, 0.5e9);
  assert.equal(num(pick(read('apps/web/lib/privacy/pool/liveNoteInExchange.test.ts'), /EXPECTED_TILL_CREDIT = ([\d_]+);/, 'till credit')), K.spendPayout);
  assert.match(read('docs/BENCHMARK-2026-09-13.md'), /cost per run 0\.000855 SOL of fees/);
  assert.equal(K.pipelineFeePerRun, 855_000);
});

test('each live harness uses its own pool identity (so spend flows deposit their own notes)', () => {
  const metas = [
    ['liveDevnetShield', /const meta = 'live-devnet-shield'/],
    ['liveDevnetUnshieldV4', /const meta = 'live-devnet-unshield-v4'/],
    ['liveDevnetSubscribeV4', /const meta = 'live-devnet-subscribe-v4'/],
    ['liveNoteInExchange', /P01_EXCHANGE_META \?\? 'live-note-in-exchange'/],
  ] as const;
  for (const [f, re] of metas) assert.match(read(`apps/web/lib/privacy/pool/${f}.test.ts`), re, f);
});

test('rent formula matches the known C7 buffer figure (~0.55 SOL)', () => {
  assert.equal(rentExempt(83 + 79_405), 554_127_360);
});

test('the deposit flow has no warm-up; the spend flows add one only with a warm cache', () => {
  assert.equal(runsFor('deposit', 30, 'warm'), 30);
  assert.equal(runsFor('withdrawal', 30, 'warm'), 31);
  assert.equal(runsFor('withdrawal', 30, 'cold'), 30);
  assert.equal(runsFor('stark-pipeline', 30, 'warm'), 30);
});

test('minimum starting balance is order-dependent: max of (spent before) + (needed at start)', () => {
  const s = [
    { flow: 'deposit' as const, net: 10, start: 15, sweepable: 0, stockNotes: 0 },
    { flow: 'deposit' as const, net: 10, start: 15, sweepable: 0, stockNotes: 0 },
    { flow: 'withdrawal' as const, net: 1, start: 18, sweepable: 0, stockNotes: 0 },
  ];
  assert.deepEqual(need(s), { samples: 3, net: 21, minStart: 38, sweepable: 0, stockNotes: 0 });
});

test('purchase best case deposits once, worst case every sample', () => {
  const base = { n: 5, flows: ['purchase' as const], cache: 'cold' as const, circuits: [7] };
  const worst = samplesFor('purchase', base).filter((x) => x.net > depositNet).length;
  const best = samplesFor('purchase', { ...base, purchaseReusesNote: true }).filter((x) => x.net > depositNet).length;
  assert.equal(worst, 5);
  assert.equal(best, 1);
});

test('maxN returns the boundary exactly', () => {
  const o = { flows: ['deposit' as const, 'withdrawal' as const], cache: 'warm' as const, circuits: [7] };
  const at = planNeed({ ...o, n: 12 }).minStart;
  assert.equal(maxN(at, o), 12);
  assert.equal(maxN(at - 1, o), 11);
  assert.equal(maxN(0, o), 0);
});

test('the funding table in docs/BENCHMARK-METHOD.md is the one this module computes', () => {
  const doc = read('docs/BENCHMARK-METHOD.md');
  const p = planNeed({ n: 30, flows: ['stark-pipeline', 'deposit', 'withdrawal', 'subscription', 'purchase'], cache: 'warm', circuits: [0, 1, 3, 6, 7] });
  const f = (l: number) => (l / 1e9).toFixed(3);
  assert.ok(doc.includes(`| **all five flows in one run** | ${p.samples} | ${f(p.net)} | **${f(p.minStart)}** | ${f(p.sweepable)} |`), 'the all-flows row of §3 is stale: re-run funding.mts and copy the table');
  for (const [flow, x] of Object.entries(p.perFlow)) {
    assert.ok(doc.includes(`| ${f(x.net)} | ${f(x.minStart)} |`), `the ${flow} row of §3 is stale`);
  }
});
