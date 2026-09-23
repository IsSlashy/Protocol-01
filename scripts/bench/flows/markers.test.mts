/**
 * node --test scripts/bench/flows/markers.test.mts
 *
 * A synthetic stamped log per flow shape: the parser must find start, stop and
 * every phase, compute product_ms from the stamps (not from line order), keep
 * full signatures, and report what is missing instead of inventing a number.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FLOWS, parseFlowLog, stampedLines } from './markers.mts';

const SIG_A = '5Hcgq2W2' + 'a'.repeat(80);
const SIG_B = '4b5XBfdA' + 'b'.repeat(80);

const depositLog = [
  'stdout | lib/privacy/pool/liveDevnetShield.test.ts > a shield > deposits',
  `[bench-t 1000.0] wallet 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin — 3.2 SOL`,
  `[bench-t 1100.5]   prepare: Reading the tree...`,
  `[bench-t 3000.0]   ephemeral Eph111111111111111111111111111111111111111 needs 1.58 SOL`,
  `[bench-t 3900.0]   funded: ${SIG_B}`,
  `[bench-t 4000.0]   execute: Uploading proof chunk (tx v1) 1/22`,
  `[bench-t 19600.0]   SHIELD LANDED: ${SIG_A} leaf 120`,
].join('\n');

test('stamped lines are read even behind a vitest prefix', () => {
  const l = stampedLines('stdout | x > y [bench-t 12.5] hello\nno stamp here');
  assert.deepEqual(l, [{ t: 12.5, text: 'hello' }]);
});

test('deposit: product time, phases and full signatures', () => {
  const s = parseFlowLog(depositLog, FLOWS.deposit);
  assert.equal(s.ok, true, s.missing.join('; '));
  assert.equal(s.product_ms, 18600);
  assert.deepEqual(s.phases, { identity_and_prepare: 2000, fund_ephemeral: 900, execute: 15700 });
  assert.equal(s.phases.identity_and_prepare + s.phases.fund_ephemeral + s.phases.execute, s.product_ms);
  assert.deepEqual(s.signatures, [SIG_B, SIG_A]);
});

test('a run that never landed yields no number and says why', () => {
  const cut = depositLog.split('\n').slice(0, 5).join('\n');
  const s = parseFlowLog(cut, FLOWS.deposit);
  assert.equal(s.ok, false);
  assert.equal(s.product_ms, null);
  assert.ok(s.missing.some((m) => m.startsWith('stop')));
});

test('withdrawal: the scan and a shield leg are extras, never part of product_ms', () => {
  const log = [
    '[bench-t 0.0] wallet X — 5 SOL',
    '[bench-t 100.0]   scan: Scanning the 1 SOL pool...',
    '[bench-t 2300.0]   no unspent note for this identity — shielding one',
    `[bench-t 25000.0]   SHIELD LANDED: ${SIG_A} | leaf 7`,
    '[bench-t 42000.0]   payee PAYEE11111111111111111111111111111111111 (re-derivable — sweep it back when done)',
    '[bench-t 46000.0]   route: v4 | job unshield-v4:1 | float 1',
    '[bench-t 47000.0]   funded EPH with 1',
    `[bench-t 63000.0]   V4 WITHDRAWAL LANDED: ${SIG_B}`,
  ].join('\n');
  const s = parseFlowLog(log, FLOWS.withdrawal);
  assert.equal(s.ok, true, s.missing.join('; '));
  assert.equal(s.product_ms, 21000);
  assert.deepEqual(s.phases, { prepare: 4000, fund_ephemeral: 1000, execute: 16000 });
  assert.equal(s.extras.scan, 2200);
  assert.equal(s.extras.shield_leg, 22700);
});

test('subscription: the shield leg funding line is not taken for the subscription funding', () => {
  const log = [
    '[bench-t 0.0]   funded shield signer EPH0 with 1',
    `[bench-t 20000.0]   SHIELD LANDED: ${SIG_A} | leaf 8`,
    '[bench-t 37000.0]   retailer RET1111111111111111111111111111111111111',
    '[bench-t 42000.0]   route: v4 | job subscribe-v4:1 | float 1',
    '[bench-t 43000.0]   funded EPH1 with 1',
    `[bench-t 59000.0]   V4 SUBSCRIPTION LANDED: ${SIG_B}`,
  ].join('\n');
  const s = parseFlowLog(log, FLOWS.subscription);
  assert.equal(s.ok, true, s.missing.join('; '));
  assert.equal(s.product_ms, 22000);
  assert.deepEqual(s.phases, { prepare: 5000, fund_ephemeral: 1000, execute: 16000 });
  assert.equal(s.extras.shield_leg, 20000);
});

test('purchase: withdraw to the till, claim and issue are consecutive phases', () => {
  const log = [
    '[bench-t 10.0]   unshield-prepare: Locating your note on-chain...',
    '[bench-t 3610.0]   route v4 | job unshield-v4:2 | float 1',
    '[bench-t 4610.0]   funded EPH with 1',
    `[bench-t 21010.0]   WITHDRAWAL TO THE TILL: ${SIG_A}`,
    '[bench-t 21610.0]   CLAIM abcdef0123456789...',
    '[bench-t 27910.0]   issue-note -> 200, an older note sealed to the buyer',
  ].join('\n');
  const s = parseFlowLog(log, FLOWS.purchase);
  assert.equal(s.ok, true, s.missing.join('; '));
  assert.equal(s.product_ms, 27900);
  assert.deepEqual(Object.keys(s.phases), ['prepare', 'fund_ephemeral', 'withdraw_to_till', 'claim', 'issue_note']);
  assert.deepEqual(s.signatures, [SIG_A]);
});

test('the spend signature the post-run probes need is the spend, never the shield leg', () => {
  const w = [
    `[bench-t 25000.0]   SHIELD LANDED: ${SIG_A} | leaf 7`,
    '[bench-t 42000.0]   payee PAYEE11111111111111111111111111111111111 (re-derivable — sweep it back when done)',
    `[bench-t 63000.0]   V4 WITHDRAWAL LANDED: ${SIG_B}`,
  ].join('\n');
  assert.equal(parseFlowLog(w, FLOWS.withdrawal).spend_signature, SIG_B);
  const sub = [`[bench-t 1.0]   SHIELD LANDED: ${SIG_A} | leaf 8`, `[bench-t 2.0]   V4 SUBSCRIPTION LANDED: ${SIG_B}`].join('\n');
  assert.equal(parseFlowLog(sub, FLOWS.subscription).spend_signature, SIG_B);
  const buy = [`[bench-t 1.0]   SHIELD LANDED: ${SIG_B} | leaf 9`, `[bench-t 2.0]   WITHDRAWAL TO THE TILL: ${SIG_A}`].join('\n');
  assert.equal(parseFlowLog(buy, FLOWS.purchase).spend_signature, SIG_A);
  assert.equal(parseFlowLog(depositLog, FLOWS.deposit).spend_signature, null);
});
