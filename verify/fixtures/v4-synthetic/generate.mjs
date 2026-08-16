#!/usr/bin/env node
/**
 * Generator for the SYNTHETIC v4 fixture — see README.md in this directory.
 *
 * Nothing here ever touched a chain. Every address is a repeated-byte pattern,
 * every "signature" is a repeated-byte pattern, and the whole point is to
 * describe a spend whose instruction carries NO commitment, so that
 * `p01-verify.mjs --self-test --replay` can assert P1/P2/P4 PASS on it. That
 * is the positive half of the control pair: without it, a tool that hard-fails
 * everything would sail through the negative control (fixtures/v3-subscribe)
 * and a future green on a real v4 would be unfalsifiable.
 *
 * Deterministic on purpose: same bytes every run, so `node generate.mjs`
 * followed by `git diff` proves the committed fixture matches this source.
 *
 * COUPLINGS THIS FILE MUST TRACK (the replay self-test catches drift in all):
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
// explorer, and impossible to collide with a real devnet account by accident.
const payer = b58encode(Buffer.alloc(32, 0xa1));
const pool = b58encode(Buffer.alloc(32, 0xb2));
const tree = b58encode(Buffer.alloc(32, 0xc3));
const bufferPDA = b58encode(Buffer.alloc(32, 0xd4));
const spendSig = b58encode(Buffer.alloc(64, 0x51));
const chunkSig1 = b58encode(Buffer.alloc(64, 0x52));
const chunkSig2 = b58encode(Buffer.alloc(64, 0x53));

// The v4 spend instruction: discriminator + nullifier[32] + root[32] +
// recipient[32] = 104 bytes, and NO commitment field anywhere. This is the
// shape SPEND_KINDS reserves as `unshield_denominated_stark_v4` with
// commitmentOffset: null — P1 passes because there is nothing to read.
const spendData = Buffer.concat([
  disc('unshield_denominated_stark_v4'),
  Buffer.alloc(32, 0x11), // nullifier
  Buffer.alloc(32, 0x22), // merkle root
  Buffer.alloc(32, 0x33), // recipient
]);

// Two proof chunks so P3 has bytes to scan (chunkCount 0 is INCONCLUSIVE-fail
// by design). Payload is a fixed pseudo-random pattern; with no published
// commitment there is no target value to avoid, but all-zeros would be a
// suspiciously unrealistic proof.
const chunkPayload = (offset) =>
  Buffer.from(Array.from({ length: 512 }, (_, i) => ((offset + i) * 37 + 11) & 0xff));
const chunkData = (offset) =>
  Buffer.concat([disc('write_proof_chunk'), u32le(offset), u32le(512), chunkPayload(offset)]);

const txMeta = { err: null, loadedAddresses: null, logMessages: [] };

const spendTx = {
  slot: 1000,
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
    'It describes a hypothetical v4 spend whose instruction carries no commitment, ' +
    'so the self-test can prove the tool is CAPABLE of reporting a clean result. ' +
    'It is NOT evidence that any v4 exists, shipped, or is private.',
  spend: spendSig,
  kind: 'unshield_denominated_stark_v4',
  flags: { maxChunkTx: 200, depositLimit: 400 },
  pools: { [pool]: { label: 'SYNTHETIC 1 SOL (v4 fixture)', tree } },
  // P1/P2/P4 PASS: no commitment is published, nothing correlates. P3 PASS:
  // chunks were found, fully scanned, no target to hunt. P3b stays FAIL — it
  // is inconclusive by construction until trace blinding ships, and pinning it
  // here means a well-meaning "fix" that makes it pass turns CI red first.
  expect: { P1: 'PASS', P2: 'PASS', P3: 'PASS', P3b: 'FAIL', P4: 'PASS' },
};

writeFileSync(join(here, 'rpc.json'), JSON.stringify({ calls }, null, 1));
writeFileSync(join(here, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`wrote ${join(here, 'rpc.json')} (${calls.length} calls) and manifest.json`);
console.log(`  spend ${spendSig}`);
console.log(`  pool  ${pool}`);
