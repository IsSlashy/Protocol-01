#!/usr/bin/env node
/**
 * Generator for the TRUNCATED-WALK fixture — see README.md in this directory.
 *
 * Nothing here ever touched a chain. It is `../v4-stale-root` with ONE flag
 * changed: the manifest's `depositLimit` is 7 rather than 400, so the tree
 * walk may read only the spend and the six newest insertions of a history of
 * ten signatures. The root the spend names is inside what was read, so a tool
 * that ignored the walk's `complete` flag would still find it and print an age.
 *
 * ⛔ WHAT IT PINS: A WALK THAT STOPPED AT ITS BUDGET REPORTS NO AGE AND NO
 * BUCKET COUNT. P12 FAIL and P13 FAIL, both INCONCLUSIVE, neither with a
 * measure. [VERIFY-1 fix round 2] Every other fixture's walk completes by
 * construction, so hard-coding `complete: true` where `verifySpend` hands the
 * walk to P12 or P13 left all ten CI replays green (VERIFY-1-r2-mutants.log,
 * W13 and W14). This fixture is the end-to-end control for that handoff; the
 * offline one is "P12/P13 wiring ·" in `selfTestChannelDecoders`.
 *   node verify/fixtures/v4-truncated-walk/generate.mjs
 *   diff verify/fixtures/v4-stale-root/rpc.json verify/fixtures/v4-truncated-walk/rpc.json
 *
 * Synthetic for the same reason as its source: see ../v4-stale-root/README.md.
 *
 * Deterministic on purpose: same bytes every run, so `node generate.mjs`
 * followed by `git diff` proves the committed fixture matches this source.
 *
 * COUPLINGS THIS FILE MUST TRACK (the replay self-test catches drift in all):
 *  - discriminators: sha256("global:<name>")[..8], same rule as the verifier.
 *  - the LeafInserted event layout, 8 + 32 + 8 + 32 + 32 + 32 = 144 bytes
 *    (`programs/zk_shielded/src/state/merkle_tree_v3.rs:340-346`); P12 reads
 *    `new_root` at byte 80.
 *  - getSignaturesForAddress limit 201 = manifest flags.maxChunkTx (200) + 1,
 *    the "+1" completeness sentinel in scanProofChunks; and limit DEPOSIT_LIMIT (7) for the
 *    tree walk, which is `Math.min(100, depositLimit - scanned)`.
 *  - the v4 spend layout at FOUR walked levels: `SPEND_SUBTREE_DEPTH = 11`
 *    (`programs/zk_shielded/src/state/spend_root.rs:92`) under a depth-15 pool,
 *    which is what `C7_SUBTREE_DEPTH = 11` in
 *    `apps/web/lib/privacy/pool/denominatedPool.ts:2789` builds today. That is
 *    156 instruction bytes with the payee at 124 — NOT the 147/115 of the
 *    depth-12 circuit that shipped until 2026-08-30.
 *  - pool account byte offsets 72/120/121/169, `readPoolState` /
 *    `pool_v3.rs:53-98`.
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// The insertion whose `new_root` the spend names: v4-stale-root's, age 4 on a
// complete walk. The generated text
// (manifest note, console line) states the age only, never this position or a
// tree size: VERIFY-1 fix round 1, the same rule as P12's verdict.
const NAMED_LEAF = 3;

// ── THE ONE FLAG THIS FILE DOES NOT SHARE WITH v4-stale-root ────────────────
// The walk reads `Math.min(100, depositLimit - scanned)` signatures a page, so a
// budget of 7 asks for 7 and gets 7: newest-first, the insertion after the
// spend, the spend, and insertions down to NAMED_LEAF. `scanned === limit` with a full page is a walk that cannot show
// it saw everything, which is the state this fixture freezes.
const DEPOSIT_LIMIT = 7;

const sha256 = (b) => createHash('sha256').update(b).digest();
const disc = (name) => sha256(Buffer.from(`global:${name}`, 'utf8')).subarray(0, 8);
const eventDisc = (name) => sha256(Buffer.from(`event:${name}`, 'utf8')).subarray(0, 8);

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(buf) {
  const digits = [0];
  for (const byte of buf) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] * 256;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '';
  for (const b of buf) {
    if (b === 0) out += '1';
    else break;
  }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

const u32le = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
/** A root or a leaf on chain is a Goldilocks felt: low limb, 24 zero bytes. */
const felt32 = (n) => {
  const b = Buffer.alloc(32);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

// Real program ids — the classifier matches on them, and they identify
// programs, not transactions, so using the live values misleads nobody.
const ZK_SHIELDED = 'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c';
const STARK_VERIFIER = 'DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

// Repeated-byte patterns: obviously fake on sight in any explorer, and
// impossible to collide with a real devnet account by accident.
const payer = b58encode(Buffer.alloc(32, 0xa4));
const pool = b58encode(Buffer.alloc(32, 0xb7));
const tree = b58encode(Buffer.alloc(32, 0xc8));
const bufferPDA = b58encode(Buffer.alloc(32, 0xd5));
const payee = b58encode(Buffer.alloc(32, 0xe6));
const spendSig = b58encode(Buffer.alloc(64, 0x71));
const chunkSig1 = b58encode(Buffer.alloc(64, 0x72));
const chunkSig2 = b58encode(Buffer.alloc(64, 0x73));
const depositSig = (i) => b58encode(Buffer.alloc(64, 0x80 + i));
const depositKey = (i) => b58encode(Buffer.alloc(32, 0x60 + i));

// ── The tree: eight insertions before the spend, one after, one root each ───
// A root is created by exactly ONE insertion, which is the whole reason a
// stale root dates a deposit. `newRoot(i)` is therefore a function of i only.
const LEAVES = 8;
// [VERIFY-1 fix round 2] One more insertion lands AFTER the spend, the way a
// live pool keeps taking deposits between a spend and the moment the tool reads
// it. It makes the spend's own slot load-bearing: a verifySpend that stopped
// handing it over (measured, `spendSlot: Infinity`, VERIFY-1-fix2-mutants.log
// W3) counts this insertion as earlier and reports an age one higher than the
// manifest pins. It is also the only fixture path to the upper size bound taken
// from an insertion after the spend rather than from the pool account.
const LATER = 1;
const SPEND_SLOT = 1000;
// The first LEAVES strictly before SPEND_SLOT, the LATER ones strictly after.
const depositSlot = (i) => (i < LEAVES ? 900 + i * 10 : SPEND_SLOT + 10 * (i - LEAVES + 1));
const newRoot = (i) => felt32(0x00c0ffee00000000n + BigInt(i) + 1n);
const oldRoot = (i) => (i === 0 ? Buffer.alloc(32) : newRoot(i - 1));
const leafValue = (i) => felt32(0x00dada0000000000n + BigInt(i));

const leafInsertedLog = (i) => {
  const b = Buffer.concat([
    eventDisc('LeafInserted'),
    Buffer.alloc(32, 0xb7), // pool, as raw bytes
    u64le(i), // leaf_index
    leafValue(i),
    newRoot(i),
    oldRoot(i),
  ]);
  return `Program data: ${b.toString('base64')}`;
};

const meta = (over = {}) => ({ err: null, loadedAddresses: null, logMessages: [], ...over });

// ── The spend: unshield_denominated_stark_v4 at four walked levels ──────────
// disc 8 | nullifier 32 | merkle_root 32 | subtree_root 8 | 4 + 4*8 siblings
// | 4 + 4 directions | recipient 32 = 156 bytes, payee at 124.
// Every direction bit is 0, which is bucket 0 — the only bucket a pool of 8
// leaves can occupy (2,048 leaves per bucket at SPEND_SUBTREE_DEPTH 11).
const WALKED_LEVELS = 4;
const spendData = Buffer.concat([
  disc('unshield_denominated_stark_v4'),
  Buffer.alloc(32, 0x11), // nullifier
  newRoot(NAMED_LEAF), // merkle_root — THE FIELD THIS FIXTURE IS ABOUT
  u64le(0x00beef0000000001n), // subtree_root (C7 public input 1)
  u32le(WALKED_LEVELS),
  ...Array.from({ length: WALKED_LEVELS }, (_, i) => u64le(0x00515100000000n + BigInt(i))),
  u32le(WALKED_LEVELS),
  Buffer.alloc(WALKED_LEVELS, 0), // directions: bucket 0
  Buffer.alloc(32, 0xe6), // recipient == payee
]);

// The pool pays the payee by CPI, so the payee has an inbound edge and no
// outbound one: P10 PASS with measure 0, which its own text calls a statement
// about time rather than about privacy.
const sysTransfer = (lamports) =>
  b58encode(Buffer.concat([u32le(2), u64le(lamports)]));

const spendTx = {
  slot: SPEND_SLOT,
  meta: meta({
    innerInstructions: [
      { index: 0, instructions: [{ programIdIndex: 6, accounts: [1, 4], data: sysTransfer(995_000_000n) }] },
    ],
  }),
  transaction: {
    message: {
      // numRequiredSignatures: 1 marks keys[0] (payer) as the fee payer —
      // verifySpend refuses to guess the payer without this header.
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 2 },
      accountKeys: [payer, pool, tree, bufferPDA, payee, ZK_SHIELDED, SYSTEM_PROGRAM],
      instructions: [{ programIdIndex: 5, accounts: [0, 1, 2, 3, 4], data: b58encode(spendData) }],
    },
  },
};

// Two proof chunks so P3 has bytes to scan (chunkCount 0 is INCONCLUSIVE-fail
// by design). No commitment is published anywhere, so there is no target value
// to avoid; all-zeros would be a suspiciously unrealistic proof.
const chunkPayload = (offset) =>
  Buffer.from(Array.from({ length: 512 }, (_, i) => ((offset + i) * 37 + 11) & 0xff));
const chunkData = (offset) =>
  Buffer.concat([disc('write_proof_chunk'), u32le(offset), u32le(512), chunkPayload(offset)]);

const chunkTx = (slot, offset) => ({
  slot,
  meta: meta(),
  transaction: {
    message: {
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
      accountKeys: [payer, bufferPDA, STARK_VERIFIER],
      instructions: [{ programIdIndex: 2, accounts: [0, 1], data: b58encode(chunkData(offset)) }],
    },
  },
});

const depositTx = (i) => ({
  slot: depositSlot(i),
  meta: meta({ logMessages: [leafInsertedLog(i)] }),
  transaction: {
    message: {
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
      accountKeys: [depositKey(i), pool, tree, ZK_SHIELDED],
      instructions: [{ programIdIndex: 3, accounts: [0, 1, 2], data: b58encode(disc('shield_denominated_v3')) }],
    },
  },
});

// Pool account bytes at the offsets `readPoolState` reads (`pool_v3.rs:53-98`):
// denomination u64 @72, tree_depth u8 @120, next_leaf_index u64 @121,
// unspent_notes u64 @169. tree_depth 15 is DEFAULT_TREE_DEPTH, and P13 divides
// it by the instruction's walked levels to derive the bucket size.
const poolData = Buffer.alloc(177);
poolData.writeBigUInt64LE(1_000_000_000n, 72);
poolData[120] = 15;
poolData.writeBigUInt64LE(BigInt(LEAVES + LATER), 121);
poolData.writeBigUInt64LE(5n, 169);

const txOpts = { maxSupportedTransactionVersion: 0, encoding: 'json', commitment: 'confirmed' };

const calls = [
  { method: 'getTransaction', params: [spendSig, txOpts], result: spendTx },
  {
    // limit 201 = flags.maxChunkTx + 1 (see header). Newest-first, like the
    // real RPC: the spend itself, then the two uploads that preceded it.
    method: 'getSignaturesForAddress',
    params: [payer, { limit: 201 }],
    result: [
      { signature: spendSig, err: null },
      { signature: chunkSig2, err: null },
      { signature: chunkSig1, err: null },
    ],
  },
  { method: 'getTransaction', params: [chunkSig2, txOpts], result: chunkTx(998, 512) },
  { method: 'getTransaction', params: [chunkSig1, txOpts], result: chunkTx(997, 0) },
  // The payee's own life: the withdrawal that paid it, and nothing since.
  { method: 'getSignaturesForAddress', params: [payee, { limit: 201 }], result: [{ signature: spendSig, err: null }] },
  // ⚠️ THE 32 BYTES A PRE-2026-08-30 READING OF THE PAYEE LANDS ON, AND WHY
  // THIS ENTRY IS HERE AT ALL.
  // `SPEND_KINDS` pins the payee of a v4 withdrawal at offset 115, which is
  // where it sat while circuit 7 proved 12 levels and the instruction was 147
  // bytes. At `SPEND_SUBTREE_DEPTH = 11` the instruction is 156 bytes and the
  // payee is at 124, so offset 115 reads the tail of the last sibling, the two
  // Borsh lengths and the first 23 bytes of the payee: a syntactically valid
  // address belonging to nobody. MEASURED on this fixture before P12 existed —
  // the old reading walked `14YBZAim…` and the replay hard-stopped on it.
  // Answering it with an empty history lets this fixture replay under BOTH
  // readings, so VERIFY-1's red and green are the same command. Nothing reads
  // it once the payee is taken from the parsed instruction; it stays as the
  // record of what the stale offset did.
  { method: 'getSignaturesForAddress', params: [b58encode(spendData.subarray(115, 147)), { limit: 201 }], result: [] },
  // The tree's history, newest first: the spend touches the tree too, and it
  // emits no LeafInserted — so the walk must skip it rather than trip on it.
  {
    method: 'getSignaturesForAddress',
    params: [tree, { limit: DEPOSIT_LIMIT }],
    // A full page: the history holds LEAVES + LATER + 1 signatures, the budget stops at
    // DEPOSIT_LIMIT of them.
    result: [
      ...Array.from({ length: LATER }, (_, k) => ({ signature: depositSig(LEAVES + LATER - 1 - k), err: null })),
      { signature: spendSig, err: null },
      ...Array.from({ length: LEAVES }, (_, k) => ({ signature: depositSig(LEAVES - 1 - k), err: null })),
    ].slice(0, DEPOSIT_LIMIT),
  },
  // Only the insertions inside the budget are ever fetched.
  ...Array.from({ length: DEPOSIT_LIMIT - 1 }, (_, k) => {
    const i = LEAVES + LATER - 1 - k;
    return { method: 'getTransaction', params: [depositSig(i), txOpts], result: depositTx(i) };
  }),
  {
    method: 'getAccountInfo',
    params: [pool, { encoding: 'base64' }],
    result: { value: { data: [poolData.toString('base64'), 'base64'] } },
  },
];

const manifest = {
  synthetic: true,
  note:
    'SYNTHETIC fixture — hand-built by generate.mjs, never touched any chain. It is ' +
    'verify/fixtures/v4-stale-root with one flag changed: depositLimit ' + DEPOSIT_LIMIT + ', so the tree ' +
    'walk stops at its budget before the history ends. The named root is inside what was read, and ' +
    'P12 and P13 must still report no measure: a walk that cannot show it read everything reports ' +
    'INCONCLUSIVE, never an age. Pins the handoff of the walk to both probes (VERIFY-1 fix round 2).',
  spend: spendSig,
  kind: 'unshield_denominated_stark_v4',
  flags: { maxChunkTx: 200, depositLimit: DEPOSIT_LIMIT, maxRootAge: 2 },
  pools: { [pool]: { label: 'SYNTHETIC 1 SOL (truncated-walk fixture)', tree } },
  // Every pin but P12/P13 is v4-stale-root's, for the same reasons (see its
  // generator): depositLimit reaches only the tree walk on a v4 spend, since
  // P4's deposit trace runs only when a commitment is published.
  // P12 FAIL, no measure: INCONCLUSIVE, the walk is not complete. A measure of 4
  //   here means the flag was dropped between the walker and the verdict.
  // P13 FAIL, no measure: INCONCLUSIVE, same reason. PASS with 1 means the same.
  expect: {
    P1: 'PASS',
    P2: 'PASS',
    P3: 'PASS',
    P3b: 'FAIL',
    P4: 'PASS',
    P6: 'PASS',
    P7: 'FAIL',
    P8: 'FAIL',
    P9: 'FAIL',
    P10: 'PASS',
    P12: 'FAIL',
    P13: 'FAIL',
  },
  measure: { P6: 0, P10: 0 },
};

writeFileSync(join(here, 'rpc.json'), JSON.stringify({ calls }, null, 1));
writeFileSync(join(here, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`wrote ${join(here, 'rpc.json')} (${calls.length} calls) and manifest.json`);
console.log(`  spend      ${spendSig}`);
console.log(`  pool       ${pool}`);
console.log(`  walk budget ${DEPOSIT_LIMIT} of ${LEAVES + LATER + 1} signatures: expected P12 and P13 INCONCLUSIVE`);
