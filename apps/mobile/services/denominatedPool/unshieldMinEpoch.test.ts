/**
 * Tests for the `min_epoch` argument of the unshield instructions.
 *
 * Why these exist (docs/C7_SPEND_CIRCUIT_PLAN.md Step 1):
 *
 * `min_epoch` sits at instruction-data byte offset 72 on BOTH unshield
 * instructions (`unshield_denominated_stark` v2 and
 * `unshield_denominated_stark_v3`) — 8 discriminator + 32 nullifier + 32
 * merkle_root. It is the same offset the web client writes it at.
 *
 * No unshield handler reads it:
 *   - v3: `let _ = (amount, unshield_fee, min_epoch, current_epoch,
 *     dynamic_delay, nullifier);` (unshield_denominated_stark_v3.rs:387)
 *   - v2: enforcement was deliberately removed
 *     (unshield_denominated_stark.rs:212-220)
 *   - p01_liquidity `prefund` only stores it on the record (prefund.rs:197);
 *     `settle` rebuilds the CPI with its own current_epoch (settle.rs:109-116)
 *
 * So anything note-derived written here is pure leakage. This client was
 * writing the CURRENT epoch (harmless — it is already public from the block
 * slot) while the extension was writing the note's DEPOSIT epoch (a real leak
 * that narrows the anonymity set to one ~7200-slot deposit window). Both now
 * write UNSHIELD_MIN_EPOCH = 0, which also makes the field useless as a
 * client fingerprint and pre-empts the far worse regression: once this client
 * adopts the PRF commitment blinding already shipped in apps/web
 * (apps/web/lib/privacy/pool/noteBlinding.ts), `ShieldReceipt.depositEpoch`
 * holds a 63-bit SECRET and publishing it here would defeat blinding entirely.
 *
 * `min_epoch` IS enforced on transfer / split / subscribe / escrow (e.g.
 * transfer_denominated_stark_v3.rs:167-173) — those paths are deliberately NOT
 * covered here and must keep passing a real epoch.
 *
 * Scope note: `@solana/web3.js` is aliased to test/__mocks__ in
 * vitest.config.ts, and the mock's `findProgramAddressSync` is a fake sha256
 * derivation. These tests therefore assert `ix.data` and `ix.programId` only —
 * never an address or the account list.
 *
 * If one of these fails, do not "fix" the test.
 */

import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  UNSHIELD_MIN_EPOCH,
  buildUnshieldDenominatedStarkIx,
  buildUnshieldDenominatedStarkV3Ix,
  ZK_SHIELDED_PROGRAM_ID,
} from './index';

const MIN_EPOCH_OFFSET = 72;

const nullifierBytes = new Array(32).fill(0x11);
const merkleRootBytes = new Array(32).fill(0x22);

/**
 * A plausible devnet deposit epoch (slot / 7200 was ~55k in mid-2026).
 * Deliberately distinctive so the leak scan below cannot match it by accident
 * against the 0x11 / 0x22 filler bytes.
 */
const FIXTURE_DEPOSIT_EPOCH = 123_456n;
const STARK_COMMITMENT = 0xdead_beef_cafe_f00dn;

// [C3-D12] The walk above the depth-12 C3 circuit. Three levels, because the
// pool tree is MERKLE_DEPTH (15) and the circuit covers its bottom twelve.
//
// ⚠️ These values are deliberately far from FIXTURE_DEPOSIT_EPOCH: the leak scan
// below reads EVERY 8-byte window of the instruction, and the walk is now inside
// that range. A sibling that happened to equal the epoch would fail the scan for
// a reason having nothing to do with min_epoch.
const SUBTREE_ROOT = 0x5151_5151_5151_5151n;
const SIBLINGS = [0xa1a1_a1a1_a1a1_a1a1n, 0xb2b2_b2b2_b2b2_b2b2n, 0xc3c3_c3c3_c3c3_c3c3n];
const DIRECTIONS = [1, 0, 1];

const payer = Keypair.generate().publicKey;
const recipient = Keypair.generate().publicKey;
const pool = Keypair.generate().publicKey;
const tree = Keypair.generate().publicKey;
const nullifierPDA = Keypair.generate().publicKey;
const bufA = Keypair.generate().publicKey;
const bufB = Keypair.generate().publicKey;

/** Every 8-byte little-endian window of a buffer. */
function u64Windows(data: Buffer): bigint[] {
  const out: bigint[] = [];
  for (let off = 0; off + 8 <= data.length; off++) out.push(data.readBigUInt64LE(off));
  return out;
}

describe('UNSHIELD_MIN_EPOCH', () => {
  it('is exactly zero', () => {
    expect(UNSHIELD_MIN_EPOCH).toBe(0n);
  });
});

describe('buildUnshieldDenominatedStarkV3Ix — min_epoch@72 is always zero', () => {
  // The builder takes NO min_epoch parameter — it writes UNSHIELD_MIN_EPOCH
  // itself, so no call site can reintroduce a note-derived value.
  const ix = buildUnshieldDenominatedStarkV3Ix(
    payer, recipient, pool, tree, nullifierPDA, bufA, bufB,
    nullifierBytes, merkleRootBytes, STARK_COMMITMENT,
    SUBTREE_ROOT, SIBLINGS, DIRECTIONS,
  );

  it('targets zk_shielded with the right discriminator', () => {
    expect(ix.programId.equals(ZK_SHIELDED_PROGRAM_ID)).toBe(true);
    const expected = Buffer.from(
      sha256(utf8ToBytes('global:unshield_denominated_stark_v3')).slice(0, 8),
    );
    expect(Buffer.from(ix.data.subarray(0, 8)).equals(expected)).toBe(true);
  });

  it('has the exact data length — the fixed head plus the C3-D12 walk', () => {
    // [C3-D12] 120 -> 163 for a three-level walk. The head is UNCHANGED at 120
    // bytes and the walk is appended, which is the whole point of the argument
    // ordering: every offset asserted below still means what it meant.
    const head = 8 + 32 + 32 + 8 + 8 + 32;
    const walk = 8 + (4 + SIBLINGS.length * 8) + (4 + DIRECTIONS.length);
    expect(head).toBe(120);
    expect(ix.data.length).toBe(head + walk);
  });

  it('appends the walk after the head, and the head keeps its length', () => {
    let off = 120;
    expect(ix.data.readBigUInt64LE(off)).toBe(SUBTREE_ROOT); off += 8;
    expect(ix.data.readUInt32LE(off)).toBe(SIBLINGS.length); off += 4;
    for (const sib of SIBLINGS) {
      expect(ix.data.readBigUInt64LE(off)).toBe(sib); off += 8;
    }
    expect(ix.data.readUInt32LE(off)).toBe(DIRECTIONS.length); off += 4;
    for (const dir of DIRECTIONS) {
      expect(ix.data.readUInt8(off)).toBe(dir); off += 1;
    }
    expect(off).toBe(ix.data.length);
  });

  it('refuses a walk whose two halves disagree, before it reaches the chain', () => {
    // The on-chain failure is `WrongSiblingCount`, at the END of two proof
    // uploads. This is the same refusal, for free.
    expect(() => buildUnshieldDenominatedStarkV3Ix(
      payer, recipient, pool, tree, nullifierPDA, bufA, bufB,
      nullifierBytes, merkleRootBytes, STARK_COMMITMENT,
      SUBTREE_ROOT, SIBLINGS, [1, 0],
    )).toThrow(/equal length/);
    expect(() => buildUnshieldDenominatedStarkV3Ix(
      payer, recipient, pool, tree, nullifierPDA, bufA, bufB,
      nullifierBytes, merkleRootBytes, STARK_COMMITMENT,
      SUBTREE_ROOT, SIBLINGS, [1, 0, 2],
    )).toThrow(/0 or 1/);
  });

  it('writes eight zero bytes at offset 72 — the same offset as the web client', () => {
    expect(ix.data.readBigUInt64LE(MIN_EPOCH_OFFSET)).toBe(0n);
    expect(Array.from(ix.data.subarray(MIN_EPOCH_OFFSET, MIN_EPOCH_OFFSET + 8)))
      .toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('leaves every other arg at its locked offset', () => {
    expect(Array.from(ix.data.subarray(8, 40))).toEqual(nullifierBytes);
    expect(Array.from(ix.data.subarray(40, 72))).toEqual(merkleRootBytes);
    expect(ix.data.readBigUInt64LE(80)).toBe(STARK_COMMITMENT); // stark_commitment
    expect(Array.from(ix.data.subarray(88, 120))).toEqual(Array.from(recipient.toBytes()));
  });

  it('does not carry an epoch in ANY 8-byte window of ix.data', () => {
    expect(u64Windows(ix.data)).not.toContain(FIXTURE_DEPOSIT_EPOCH);
  });

  it('the leak scan is not vacuous: the old byte layout DOES trip it', () => {
    const leaky = Buffer.from(ix.data);
    leaky.writeBigUInt64LE(FIXTURE_DEPOSIT_EPOCH, MIN_EPOCH_OFFSET);
    expect(u64Windows(leaky)).toContain(FIXTURE_DEPOSIT_EPOCH);
  });
});

describe('buildUnshieldDenominatedStarkIx (v2) — min_epoch@72 is always zero', () => {
  // Same contract on the v2 instruction, which the classic and instant
  // (p01_liquidity prefund) paths both build.
  const ix = buildUnshieldDenominatedStarkIx(
    payer, recipient, pool, tree, nullifierPDA, bufA,
    nullifierBytes, merkleRootBytes, STARK_COMMITMENT,
  );

  it('targets zk_shielded with the right discriminator', () => {
    expect(ix.programId.equals(ZK_SHIELDED_PROGRAM_ID)).toBe(true);
    const expected = Buffer.from(
      sha256(utf8ToBytes('global:unshield_denominated_stark')).slice(0, 8),
    );
    expect(Buffer.from(ix.data.subarray(0, 8)).equals(expected)).toBe(true);
  });

  it('has the exact data length (8+32+32+8+8 = 88)', () => {
    expect(ix.data.length).toBe(8 + 32 + 32 + 8 + 8);
    expect(ix.data.length).toBe(88);
  });

  it('writes eight zero bytes at offset 72', () => {
    expect(ix.data.readBigUInt64LE(MIN_EPOCH_OFFSET)).toBe(0n);
    expect(Array.from(ix.data.subarray(MIN_EPOCH_OFFSET, MIN_EPOCH_OFFSET + 8)))
      .toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('leaves every other arg at its locked offset', () => {
    expect(Array.from(ix.data.subarray(8, 40))).toEqual(nullifierBytes);
    expect(Array.from(ix.data.subarray(40, 72))).toEqual(merkleRootBytes);
    expect(ix.data.readBigUInt64LE(80)).toBe(STARK_COMMITMENT);
  });

  it('does not carry an epoch in ANY 8-byte window of ix.data', () => {
    expect(u64Windows(ix.data)).not.toContain(FIXTURE_DEPOSIT_EPOCH);
  });

  it('the leak scan is not vacuous: the old byte layout DOES trip it', () => {
    const leaky = Buffer.from(ix.data);
    leaky.writeBigUInt64LE(FIXTURE_DEPOSIT_EPOCH, MIN_EPOCH_OFFSET);
    expect(u64Windows(leaky)).toContain(FIXTURE_DEPOSIT_EPOCH);
  });
});
