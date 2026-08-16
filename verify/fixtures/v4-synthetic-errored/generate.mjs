#!/usr/bin/env node
/**
 * Generator for the SYNTHETIC errored-history fixture — see README.md in this
 * directory.
 *
 * Nothing here ever touched a chain. Same construction as
 * ../v4-synthetic/generate.mjs — deliberately: one reviewed shape, two
 * fixtures — with ONE difference that is the whole point: the payer's history
 * carries TWO errored signatures.
 *
 * WHAT THIS PINS
 * scanProofChunks skips errored signatures without fetching them — chunks go
 * out with skipPreflight and the payer is a long-lived wallet, so a failed
 * transaction in its history is ordinary. The completeness test must count the
 * skipped entries: `scanned + errored >= sigs.length` (p01-verify.mjs:557-566).
 * The regression this guards compared `scanned` alone against `sigs.length`,
 * so ONE errored entry anywhere in the history made `complete` false forever,
 * and P3 reported INCONCLUSIVE with advice ("raise --max-chunk-tx") that could
 * never help — the shortfall was not a cap. Both other fixtures happen to have
 * zero errored entries, so this fixture is the only place the regression turns
 * CI red: P3 is pinned PASS here.
 *
 * TWO errored entries, not one, on purpose: an off-by-one re-fix like
 * `scanned >= sigs.length - 1` survives one errored entry and dies on two.
 * And because errored entries are skipped, rpc.json holds NO getTransaction
 * response for them — a change that starts fetching errored transactions is a
 * replay miss (exit 2), so that drift goes red too.
 *
 * Deterministic on purpose: same bytes every run, so `node generate.mjs`
 * followed by `git diff` proves the committed fixture matches this source.
 *
 * COUPLINGS THIS FILE MUST TRACK (same list as ../v4-synthetic/generate.mjs):
 *  - discriminators: sha256("global:<name>")[..8], same rule as the verifier.
 *  - getSignaturesForAddress limit 201 = manifest flags.maxChunkTx (200) + 1,
 *    the "+1" completeness sentinel in scanProofChunks.
 *  - pool account byte offsets 72/120/121/169, `readPoolState` /
 *    `pool_v3.rs:53-98`.
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const sha256 = (b) => createHash('sha256').update(b).digest();
const disc = (name) => sha256(Buffer.from(`global:${name}`, 'utf8')).subarray(0, 8);

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

// Real program ids — the classifier matches on them, and they identify
// programs, not transactions, so using the live values misleads nobody.
const ZK_SHIELDED = 'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c';
const STARK_VERIFIER = 'DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs';

// Everything below is a repeated-byte pattern: obviously fake on sight in any
// explorer, impossible to collide with a real devnet account by accident, and
// distinct from every pattern in ../v4-synthetic so the two fixtures can never
// be mistaken for one another either.
const payer = b58encode(Buffer.alloc(32, 0xe5));
const pool = b58encode(Buffer.alloc(32, 0xf6));
const tree = b58encode(Buffer.alloc(32, 0xa7));
const bufferPDA = b58encode(Buffer.alloc(32, 0xb8));
const spendSig = b58encode(Buffer.alloc(64, 0x71));
const chunkSig1 = b58encode(Buffer.alloc(64, 0x72));
const chunkSig2 = b58encode(Buffer.alloc(64, 0x73));
const erroredSigA = b58encode(Buffer.alloc(64, 0x7e));
const erroredSigB = b58encode(Buffer.alloc(64, 0x7f));

// The v4 spend instruction: discriminator + nullifier[32] + root[32] +
// recipient[32] = 104 bytes, and NO commitment field anywhere — same shape as
// ../v4-synthetic, because P3's completeness arithmetic is what is under test
// here, not the clean-spend capability that fixture already pins.
const spendData = Buffer.concat([
  disc('unshield_denominated_stark_v4'),
  Buffer.alloc(32, 0x44), // nullifier
  Buffer.alloc(32, 0x55), // merkle root
  Buffer.alloc(32, 0x66), // recipient
]);

// Two proof chunks so P3 has bytes to scan (chunkCount 0 is INCONCLUSIVE-fail
// by design). Different constants from ../v4-synthetic's payload for the same
// reason as the address patterns.
const chunkPayload = (offset) =>
  Buffer.from(Array.from({ length: 512 }, (_, i) => ((offset + i) * 41 + 13) & 0xff));
const chunkData = (offset) =>
  Buffer.concat([disc('write_proof_chunk'), u32le(offset), u32le(512), chunkPayload(offset)]);

const txMeta = { err: null, loadedAddresses: null, logMessages: [] };

const spendTx = {
  slot: 2000,
  meta: txMeta,
  transaction: {
    message: {
      // numRequiredSignatures: 1 marks keys[0] (payer) as the fee payer —
      // verifySpend refuses to guess the payer without this header.
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 2 },
      accountKeys: [payer, pool, bufferPDA, ZK_SHIELDED],
      instructions: [{ programIdIndex: 3, accounts: [0, 1, 2], data: b58encode(spendData) }],
    },
  },
};

const chunkTx = (slot, offset) => ({
  slot,
  meta: txMeta,
  transaction: {
    message: {
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
      accountKeys: [payer, bufferPDA, STARK_VERIFIER],
      instructions: [{ programIdIndex: 2, accounts: [0, 1], data: b58encode(chunkData(offset)) }],
    },
  },
});

// Pool account bytes at the offsets `readPoolState` reads (`pool_v3.rs:53-98`):
// denomination u64 @72, tree_depth u8 @120, next_leaf_index u64 @121,
// unspent_notes u64 @169. Values are plausible and arbitrary.
const poolData = Buffer.alloc(177);
poolData.writeBigUInt64LE(1_000_000_000n, 72);
poolData[120] = 20;
poolData.writeBigUInt64LE(42n, 121);
poolData.writeBigUInt64LE(17n, 169);

const txOpts = { maxSupportedTransactionVersion: 0, encoding: 'json', commitment: 'confirmed' };

// A plausible err for a chunk write that lost a skipPreflight race: the
// program rejected it. The scan only tests truthiness of `err`, but a
// realistic shape keeps the fixture honest about what a real history returns.
const chunkRaceErr = { InstructionError: [0, { Custom: 6001 }] };

const calls = [
  { method: 'getTransaction', params: [spendSig, txOpts], result: spendTx },
  {
    // limit 201 = flags.maxChunkTx + 1 (see header). Newest-first, like the
    // real RPC: the spend, then the uploads that preceded it, with the two
    // errored entries interleaved — one mid-upload (a failed chunk write),
    // one older and unrelated. 5 entries, 3 scannable: the buggy arithmetic
    // sees 3 < 5 and calls the scan incomplete forever.
    // NOTE: no getTransaction entry exists for either errored signature —
    // they are skipped, and fetching them anyway is a replay miss (exit 2).
    method: 'getSignaturesForAddress',
    params: [payer, { limit: 201 }],
    result: [
      { signature: spendSig, err: null },
      { signature: chunkSig2, err: null },
      { signature: erroredSigA, err: chunkRaceErr },
      { signature: chunkSig1, err: null },
      { signature: erroredSigB, err: chunkRaceErr },
    ],
  },
  { method: 'getTransaction', params: [chunkSig2, txOpts], result: chunkTx(1998, 512) },
  { method: 'getTransaction', params: [chunkSig1, txOpts], result: chunkTx(1997, 0) },
  {
    method: 'getAccountInfo',
    params: [pool, { encoding: 'base64' }],
    result: { value: { data: [poolData.toString('base64'), 'base64'] } },
  },
];

const manifest = {
  synthetic: true,
  note:
    'SYNTHETIC fixture — hand-built by generate.mjs, never touched any chain. ' +
    'Same clean hypothetical v4 spend as fixtures/v4-synthetic, but the payer ' +
    'history carries two ERRORED signatures. It pins the P3 completeness ' +
    'arithmetic: errored entries are skipped, not scanned, and must still ' +
    'count toward completeness — the regression this guards forced P3 ' +
    'INCONCLUSIVE on any payer with one failed transaction in its history. ' +
    'It is NOT evidence about any real chain, spend, or privacy property.',
  spend: spendSig,
  kind: 'unshield_denominated_stark_v4',
  flags: { maxChunkTx: 200, depositLimit: 400 },
  pools: { [pool]: { label: 'SYNTHETIC 1 SOL (errored-history fixture)', tree } },
  // P3 PASS is the pin that bites: under the pre-fix arithmetic the two
  // errored entries make the scan "incomplete" and P3 drops to INCONCLUSIVE
  // (FAIL), a deviation from this map. The rest matches fixtures/v4-synthetic:
  // no commitment published, so P1/P2/P4 PASS; P3b stays FAIL by construction
  // until trace blinding ships.
  // Same pin set as the sibling fixture, and for the same reasons — see
  // ../v4-synthetic/generate.mjs. P6/P7/P8 were missing here too, so
  // regenerating this file turned CI red against its own README. Fixed
  // 2026-08-16.
  expect: { P1: 'PASS', P2: 'PASS', P3: 'PASS', P3b: 'FAIL', P4: 'PASS', P6: 'PASS', P7: 'FAIL', P8: 'FAIL' },
  measure: { P6: 0 },
};

writeFileSync(join(here, 'rpc.json'), JSON.stringify({ calls }, null, 1));
writeFileSync(join(here, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`wrote ${join(here, 'rpc.json')} (${calls.length} calls) and manifest.json`);
console.log(`  spend ${spendSig}`);
console.log(`  pool  ${pool}`);
console.log(`  errored ${erroredSigA}`);
console.log(`  errored ${erroredSigB}`);
