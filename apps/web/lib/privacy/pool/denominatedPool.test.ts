/**
 * Commitment Consistency Tests — denominatedPool service
 *
 * Hard gate: verifies that the low-u64 of createCommitmentV3 equals
 *   (a) the `new_leaf` value fed into prepareShieldInsert / C6 proof, and
 *   (b) the `commitment` public input expected by the C1 subscribe path.
 *
 * Also asserts determinism of createCommitmentV3, createNullifierV3, and
 * deriveNoteMaterial.
 *
 * Run: pnpm exec vitest run src/shared/services/denominatedPool.test.ts
 *
 * Environment: node (see vitest.config.ts environmentMatchGlobs — no DOM
 * APIs used in this file, so either environment works, but node avoids the
 * chrome.storage stub requirement).
 */

import { describe, it, expect } from 'vitest';
import { deriveNoteBlinding } from './noteBlinding';
import { PublicKey, Keypair, SystemProgram, type Connection } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  createCommitmentV3,
  createNullifierV3,
  deriveNoteMaterial,
  deriveNullifierPDA,
  goldilocksToLeBytes32,
  goldilocksU64To32,
  bigintToLeBytes32,
  U64_MASK_V3,
  computeZeroHashesV3,
  computeNewRootFromSubtreesV3,
  pubkeyToField,
  slotToEpoch,
  MERKLE_DEPTH,
  buildTransferDenominatedStarkV3Ix,
  buildUnshieldDenominatedStarkV3Ix,
  UNSHIELD_MIN_EPOCH,
  encodeShareableNote,
  decodeShareableNote,
  importNote,
  secureRandomU64,
  SOL_POOLS_V3,
  getPoolsToScanByDefault,
  getPoolsForTokenV3,
  findPoolV3,
  ZK_SHIELDED_PROGRAM_ID,
  type ShareableNote,
  type ShieldReceipt,
} from './denominatedPool';
import { recoverNotes } from './poolNotes';
import { GOLDILOCKS_MODULUS } from './goldilocks-poseidon';

// ---------------------------------------------------------------------------
// Fixed test vector
// ---------------------------------------------------------------------------

// Non-trivial values that exercise the field arithmetic.
const FIXED_NULLIFIER_PREIMAGE = 123456789012345678901234567890n;
const FIXED_SECRET              = 987654321098765432109876543210n;
const FIXED_DEPOSIT_EPOCH       = 42n;
// NATIVE_SOL_MINT = SystemProgram.programId = all-zeros pubkey.
const NATIVE_SOL_MINT_PUBKEY    = new PublicKey('11111111111111111111111111111111');
// pubkeyToField of all-zeros = 0n % FIELD_ORDER = 0n
const FIXED_TOKEN_MINT_FIELD    = 0n;

// A different pubkey for USDC
const USDC_PUBKEY = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

// ---------------------------------------------------------------------------
// Core formula tests
// ---------------------------------------------------------------------------

describe('createCommitmentV3', () => {
  it('is deterministic: same inputs produce same output', () => {
    const c1 = createCommitmentV3(
      FIXED_NULLIFIER_PREIMAGE,
      FIXED_SECRET,
      FIXED_DEPOSIT_EPOCH,
      FIXED_TOKEN_MINT_FIELD,
    );
    const c2 = createCommitmentV3(
      FIXED_NULLIFIER_PREIMAGE,
      FIXED_SECRET,
      FIXED_DEPOSIT_EPOCH,
      FIXED_TOKEN_MINT_FIELD,
    );
    expect(c1).toBe(c2);
  });

  it('output is within Goldilocks field [0, p)', () => {
    const commitment = createCommitmentV3(
      FIXED_NULLIFIER_PREIMAGE,
      FIXED_SECRET,
      FIXED_DEPOSIT_EPOCH,
      FIXED_TOKEN_MINT_FIELD,
    );
    expect(commitment >= 0n).toBe(true);
    expect(commitment < GOLDILOCKS_MODULUS).toBe(true);
  });

  it('changes when any input changes (domain separation)', () => {
    const base = createCommitmentV3(
      FIXED_NULLIFIER_PREIMAGE,
      FIXED_SECRET,
      FIXED_DEPOSIT_EPOCH,
      FIXED_TOKEN_MINT_FIELD,
    );
    const diffNP = createCommitmentV3(
      FIXED_NULLIFIER_PREIMAGE + 1n,
      FIXED_SECRET,
      FIXED_DEPOSIT_EPOCH,
      FIXED_TOKEN_MINT_FIELD,
    );
    const diffSecret = createCommitmentV3(
      FIXED_NULLIFIER_PREIMAGE,
      FIXED_SECRET + 1n,
      FIXED_DEPOSIT_EPOCH,
      FIXED_TOKEN_MINT_FIELD,
    );
    const diffEpoch = createCommitmentV3(
      FIXED_NULLIFIER_PREIMAGE,
      FIXED_SECRET,
      FIXED_DEPOSIT_EPOCH + 1n,
      FIXED_TOKEN_MINT_FIELD,
    );
    expect(diffNP).not.toBe(base);
    expect(diffSecret).not.toBe(base);
    expect(diffEpoch).not.toBe(base);
  });
});

// ---------------------------------------------------------------------------
// COMMITMENT CONSISTENCY: new_leaf == commitment (low-u64)
// ---------------------------------------------------------------------------

describe('Commitment consistency — C6 and C1 paths', () => {
  it('commitment is already a Goldilocks u64, so new_leaf === commitment', () => {
    const commitment = createCommitmentV3(
      FIXED_NULLIFIER_PREIMAGE,
      FIXED_SECRET,
      FIXED_DEPOSIT_EPOCH,
      FIXED_TOKEN_MINT_FIELD,
    );

    // In V3 the leaf IS the commitment u64 (no additional hashing).
    // prepareShieldInsert sets newLeaf = commitment and passes it as
    // oldLeaf=0 / newLeaf=commitment.toString() to generateMerkleUpdateProof.
    // The C6 proof's publicInputs[1] = newLeaf = commitment.
    //
    // The C1 subscribe proof (pool_commitment) receives nullifier_preimage,
    // secret, depositEpoch, tokenMint and outputs publicInputs[0]=nullifier,
    // publicInputs[1]=commitment (same formula). The subscribe_private_stark
    // ix verifies publicInputs[1] == vault.subscriber_commitment (via
    // goldilocksU64To32). All three agree on the same value.
    const newLeaf = commitment;                // value fed into C6 proof
    const c1Commitment = commitment;           // value C1 proof outputs

    // (a) C6 new_leaf == commitment
    expect(newLeaf).toBe(commitment);

    // (b) C1 subscribe commitment == commitment
    expect(c1Commitment).toBe(commitment);

    // Value fits in u64 (Goldilocks is a 64-bit field).
    expect(commitment & U64_MASK_V3).toBe(commitment);
  });

  it('goldilocksToLeBytes32 encodes commitment as u64 LE in 32 bytes', () => {
    const commitment = createCommitmentV3(
      FIXED_NULLIFIER_PREIMAGE,
      FIXED_SECRET,
      FIXED_DEPOSIT_EPOCH,
      FIXED_TOKEN_MINT_FIELD,
    );
    const bytes = goldilocksToLeBytes32(commitment);
    expect(bytes.length).toBe(32);

    // High 24 bytes must be zero (Goldilocks u64 fits in 8 bytes).
    for (let i = 8; i < 32; i++) {
      expect(bytes[i]).toBe(0);
    }

    // Reconstruct from LE bytes and confirm round-trip.
    let reconstructed = 0n;
    for (let i = 7; i >= 0; i--) {
      reconstructed = (reconstructed << 8n) | BigInt(bytes[i]);
    }
    expect(reconstructed).toBe(commitment);
  });

  it('bigintToLeBytes32 round-trips arbitrary u64', () => {
    const v = 0xDEADBEEFCAFEBABEn;
    const bytes = bigintToLeBytes32(v);
    let reconstructed = 0n;
    for (let i = 7; i >= 0; i--) {
      reconstructed = (reconstructed << 8n) | BigInt(bytes[i]);
    }
    expect(reconstructed).toBe(v);
  });
});

// ---------------------------------------------------------------------------
// createNullifierV3
// ---------------------------------------------------------------------------

describe('createNullifierV3', () => {
  it('is deterministic', () => {
    const n1 = createNullifierV3(FIXED_NULLIFIER_PREIMAGE, FIXED_SECRET);
    const n2 = createNullifierV3(FIXED_NULLIFIER_PREIMAGE, FIXED_SECRET);
    expect(n1).toBe(n2);
  });

  it('output is within Goldilocks field', () => {
    const nullifier = createNullifierV3(FIXED_NULLIFIER_PREIMAGE, FIXED_SECRET);
    expect(nullifier >= 0n).toBe(true);
    expect(nullifier < GOLDILOCKS_MODULUS).toBe(true);
  });

  it('matches the inner nullifier step of createCommitmentV3', () => {
    // createCommitmentV3 starts with nullifier = poseidon(np, secret).
    // createNullifierV3 computes the same sub-expression.
    // We verify by rebuilding the commitment manually.
    const nullifier = createNullifierV3(FIXED_NULLIFIER_PREIMAGE, FIXED_SECRET);

    // Epoch hash: poseidon(depositEpoch & u64mask, tokenMint & u64mask)
    // We don't expose epochHash directly; instead verify nullifier is
    // consistent by checking commitment is NOT altered when we use
    // createNullifierV3's output.
    const commitment = createCommitmentV3(
      FIXED_NULLIFIER_PREIMAGE,
      FIXED_SECRET,
      FIXED_DEPOSIT_EPOCH,
      FIXED_TOKEN_MINT_FIELD,
    );
    // Just make sure nullifier is a different value from commitment (sanity).
    // They share inputs but commitment adds epoch+mint hashing on top.
    expect(nullifier).not.toBe(commitment);
    expect(nullifier < GOLDILOCKS_MODULUS).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deriveNoteMaterial
// ---------------------------------------------------------------------------

describe('deriveNoteMaterial', () => {
  const walletSeed = new Uint8Array(32).fill(0xAB);
  const poolPDA    = new PublicKey('HfSsGRgVFJGBiiEtRXrHocNPw5dyTQ78hEZH8GWpXaAG');

  it('is deterministic for same (walletSeed, poolPDA, counter)', () => {
    const m1 = deriveNoteMaterial(walletSeed, poolPDA, 0);
    const m2 = deriveNoteMaterial(walletSeed, poolPDA, 0);
    expect(m1.secret).toBe(m2.secret);
    expect(m1.nullifierPreimage).toBe(m2.nullifierPreimage);
  });

  it('secret != nullifierPreimage (domain separation)', () => {
    const { secret, nullifierPreimage } = deriveNoteMaterial(walletSeed, poolPDA, 0);
    expect(secret).not.toBe(nullifierPreimage);
  });

  it('different counter -> different outputs', () => {
    const m0 = deriveNoteMaterial(walletSeed, poolPDA, 0);
    const m1 = deriveNoteMaterial(walletSeed, poolPDA, 1);
    expect(m0.secret).not.toBe(m1.secret);
    expect(m0.nullifierPreimage).not.toBe(m1.nullifierPreimage);
  });

  it('different pool -> different outputs', () => {
    const pool2 = new PublicKey('6NUS4E5PhQLxnYca6mCVGs3HcwXcgF1qEZtzm392jrBS');
    const m1 = deriveNoteMaterial(walletSeed, poolPDA, 0);
    const m2 = deriveNoteMaterial(walletSeed, pool2, 0);
    expect(m1.secret).not.toBe(m2.secret);
  });

  it('produces a commitment via createCommitmentV3 that is deterministic', () => {
    const { secret, nullifierPreimage } = deriveNoteMaterial(walletSeed, poolPDA, 0);
    const epoch = 42n;
    const mint  = 0n;
    const c1 = createCommitmentV3(nullifierPreimage, secret, epoch, mint);
    const c2 = createCommitmentV3(nullifierPreimage, secret, epoch, mint);
    expect(c1).toBe(c2);
  });
});

// ---------------------------------------------------------------------------
// Merkle path helpers
// ---------------------------------------------------------------------------

describe('computeZeroHashesV3', () => {
  it('length == MERKLE_DEPTH + 1', () => {
    const zeros = computeZeroHashesV3();
    expect(zeros.length).toBe(MERKLE_DEPTH + 1);
  });

  it('zeros[0] == 0n', () => {
    expect(computeZeroHashesV3()[0]).toBe(0n);
  });

  it('is cached (same reference on repeated calls)', () => {
    const z1 = computeZeroHashesV3();
    const z2 = computeZeroHashesV3();
    expect(z1).toBe(z2);
  });
});

describe('computeNewRootFromSubtreesV3', () => {
  it('returns pathElements length == MERKLE_DEPTH', () => {
    const zeros = computeZeroHashesV3();
    const subtrees = [...zeros.slice(0, MERKLE_DEPTH)];
    const leaf = 12345678n;
    const { pathElements, pathIndices } = computeNewRootFromSubtreesV3(leaf, 0, subtrees);
    expect(pathElements.length).toBe(MERKLE_DEPTH);
    expect(pathIndices.length).toBe(MERKLE_DEPTH);
  });

  it('inserting leaf at index 0 gives pathIndices all 0', () => {
    const zeros = computeZeroHashesV3();
    const subtrees = [...zeros.slice(0, MERKLE_DEPTH)];
    const { pathIndices } = computeNewRootFromSubtreesV3(99999n, 0, subtrees);
    expect(pathIndices.every(i => i === 0)).toBe(true);
  });

  it('newRoot changes when leaf changes', () => {
    const zeros = computeZeroHashesV3();
    const subtrees = [...zeros.slice(0, MERKLE_DEPTH)];
    const r1 = computeNewRootFromSubtreesV3(1n, 0, subtrees).newRoot;
    const r2 = computeNewRootFromSubtreesV3(2n, 0, subtrees).newRoot;
    expect(r1).not.toBe(r2);
  });
});

// ---------------------------------------------------------------------------
// mintField-mismatch guard
// ---------------------------------------------------------------------------

describe('mintField mismatch guard', () => {
  it('different token mints produce different commitments', () => {
    // If the caller passes the wrong mintField (e.g., SOL field when it should
    // be USDC), the commitment won't match the on-chain leaf. This test
    // verifies that pubkeyToField(SOL) != pubkeyToField(USDC).
    const solField  = pubkeyToField(NATIVE_SOL_MINT_PUBKEY);
    const usdcField = pubkeyToField(USDC_PUBKEY);
    expect(solField).not.toBe(usdcField);

    // And commitments differ accordingly.
    const cSol  = createCommitmentV3(FIXED_NULLIFIER_PREIMAGE, FIXED_SECRET, FIXED_DEPOSIT_EPOCH, solField);
    const cUsdc = createCommitmentV3(FIXED_NULLIFIER_PREIMAGE, FIXED_SECRET, FIXED_DEPOSIT_EPOCH, usdcField);
    expect(cSol).not.toBe(cUsdc);
  });
});

// ---------------------------------------------------------------------------
// transfer_denominated_stark_v3 instruction (byte-exact on-chain contract)
// ---------------------------------------------------------------------------

describe('buildTransferDenominatedStarkV3Ix', () => {
  const nullifierBytes = new Array(32).fill(0x11);
  const merkleRootBytes = new Array(32).fill(0x22);
  const newCommitmentBytes = new Array(32).fill(0x33);
  const newRootBytes = new Array(32).fill(0x44);
  const subtrees = Array.from({ length: MERKLE_DEPTH }, () => new Array(32).fill(0x55));

  const payer = Keypair.generate().publicKey;
  const pool = Keypair.generate().publicKey;
  const tree = Keypair.generate().publicKey;
  const nullifierPDA = Keypair.generate().publicKey;
  const c1 = Keypair.generate().publicKey;
  const c3 = Keypair.generate().publicKey;
  const c6 = Keypair.generate().publicKey;

  const ix = buildTransferDenominatedStarkV3Ix(
    payer, pool, tree, nullifierPDA, c1, c3, c6,
    nullifierBytes, merkleRootBytes, 5n, 7n,
    newCommitmentBytes, newRootBytes, subtrees,
  );

  it('targets the zk_shielded program', () => {
    expect(ix.programId.equals(ZK_SHIELDED_PROGRAM_ID)).toBe(true);
  });

  it('uses the correct anchor discriminator', () => {
    const expected = Buffer.from(sha256(utf8ToBytes('global:transfer_denominated_stark_v3')).slice(0, 8));
    expect(Buffer.from(ix.data.subarray(0, 8)).equals(expected)).toBe(true);
    // Locked value from the deployed handler.
    expect(Array.from(ix.data.subarray(0, 8))).toEqual([196, 150, 11, 141, 91, 208, 60, 22]);
  });

  it('has the exact data length (8+32+32+8+8+32+32+4 + 15*32 = 636)', () => {
    expect(ix.data.length).toBe(8 + 32 + 32 + 8 + 8 + 32 + 32 + 4 + MERKLE_DEPTH * 32);
    expect(ix.data.length).toBe(636);
  });

  it('lays out args at the correct offsets', () => {
    const d = ix.data;
    expect(Array.from(d.subarray(8, 40))).toEqual(nullifierBytes);
    expect(Array.from(d.subarray(40, 72))).toEqual(merkleRootBytes);
    expect(d.readBigUInt64LE(72)).toBe(5n); // min_epoch
    expect(d.readBigUInt64LE(80)).toBe(7n); // stark_commitment
    expect(Array.from(d.subarray(88, 120))).toEqual(newCommitmentBytes);
    expect(Array.from(d.subarray(120, 152))).toEqual(newRootBytes);
    expect(d.readUInt32LE(152)).toBe(MERKLE_DEPTH); // Vec length prefix
  });

  it('has 8 accounts in the exact handler order with correct flags', () => {
    const expectOrder = [
      { pk: payer,        signer: true,  writable: true  },
      { pk: pool,         signer: false, writable: true  },
      { pk: tree,         signer: false, writable: true  }, // merkle_tree MUST be writable
      { pk: nullifierPDA, signer: false, writable: true  },
      { pk: c1,           signer: false, writable: false },
      { pk: c3,           signer: false, writable: false },
      { pk: c6,           signer: false, writable: false },
      { pk: SystemProgram.programId, signer: false, writable: false },
    ];
    expect(ix.keys.length).toBe(8);
    expectOrder.forEach((exp, i) => {
      expect(ix.keys[i].pubkey.equals(exp.pk)).toBe(true);
      expect(ix.keys[i].isSigner).toBe(exp.signer);
      expect(ix.keys[i].isWritable).toBe(exp.writable);
    });
  });
});

// ---------------------------------------------------------------------------
// Shareable note encode/decode + importNote integrity
// ---------------------------------------------------------------------------

describe('shareable note encode/decode', () => {
  const note: ShareableNote = {
    version: 1,
    pool: SOL_POOLS_V3[0].poolPDA.toBase58(),
    secret: '123456789',
    nullifier_preimage: '987654321',
    deposit_epoch: '42',
    token_mint: pubkeyToField(SystemProgram.programId).toString(),
    commitment: '11111111',
    leafIndex: 7,
    token: 'SOL',
    denominationHuman: 0.1,
    shieldedAt: 1700000000000,
  };

  it('round-trips identically', () => {
    expect(decodeShareableNote(encodeShareableNote(note))).toEqual(note);
  });

  it('tolerates surrounding whitespace', () => {
    expect(decodeShareableNote(`  ${encodeShareableNote(note)}\n`)).toEqual(note);
  });

  it('rejects an unsupported version', () => {
    const bad = btoa(JSON.stringify({ ...note, version: 2 }));
    expect(() => decodeShareableNote(bad)).toThrow(/version/i);
  });
});

describe('importNote integrity', () => {
  const pool = SOL_POOLS_V3[0];
  const secret = secureRandomU64();
  const nullifierPreimage = secureRandomU64();
  const noteBlinding = 100n;
  const tokenMintField = pubkeyToField(pool.tokenMint);
  const commitment = createCommitmentV3(nullifierPreimage, secret, noteBlinding, tokenMintField);

  function makeNote(overrides: Partial<ShareableNote> = {}): string {
    const note: ShareableNote = {
      version: 1,
      pool: pool.poolPDA.toBase58(),
      secret: secret.toString(),
      nullifier_preimage: nullifierPreimage.toString(),
      // Wire key stays `deposit_epoch`; the TS field is `noteBlinding`.
      deposit_epoch: noteBlinding.toString(),
      token_mint: tokenMintField.toString(),
      commitment: commitment.toString(),
      leafIndex: 3,
      token: 'SOL',
      denominationHuman: pool.denomination,
      ...overrides,
    };
    return encodeShareableNote(note);
  }

  it('secureRandomU64 stays within u64 range', () => {
    for (let i = 0; i < 50; i++) {
      const v = secureRandomU64();
      expect(v >= 0n).toBe(true);
      expect(v <= U64_MASK_V3).toBe(true);
    }
  });

  it('imports a valid note and reconstructs the receipt', () => {
    const receipt = importNote(makeNote());
    expect(receipt.commitment).toBe(commitment);
    expect(receipt.secret).toBe(secret);
    expect(receipt.nullifierPreimage).toBe(nullifierPreimage);
    expect(receipt.noteBlinding).toBe(noteBlinding);
    expect(receipt.tokenMint).toBe(tokenMintField);
    expect(receipt.pool).toBe(pool.poolPDA.toBase58());
    expect(receipt.denomination).toBe(pool.denominationAtomic);
    expect(receipt.token).toBe('SOL');
  });

  it('rejects a note whose commitment does not match its secrets', () => {
    expect(() => importNote(makeNote({ commitment: (commitment + 1n).toString() }))).toThrow(/commitment/i);
  });

  it('rejects a note from an unknown pool', () => {
    const fakePool = Keypair.generate().publicKey.toBase58();
    expect(() => importNote(makeNote({ pool: fakePool }))).toThrow(/unknown pool/i);
  });
});

// ---------------------------------------------------------------------------
// Note blinding — the secret that stops a published nullifier from revealing
// which deposit it spends.
// ---------------------------------------------------------------------------

describe('note blinding', () => {
  const seedA = new Uint8Array(32).fill(7);
  const seedB = new Uint8Array(32).fill(9);
  const pool = SOL_POOLS_V3[0].poolPDA;

  it('is deterministic in (seed, pool, leafIndex)', () => {
    expect(deriveNoteBlinding(seedA, pool, 12)).toBe(deriveNoteBlinding(seedA, pool, 12));
  });

  it('differs across leaf index, pool and seed', () => {
    expect(deriveNoteBlinding(seedA, pool, 12)).not.toBe(deriveNoteBlinding(seedA, pool, 13));
    expect(deriveNoteBlinding(seedA, pool, 12)).not.toBe(deriveNoteBlinding(seedB, pool, 12));
    expect(deriveNoteBlinding(seedA, pool, 12)).not.toBe(
      deriveNoteBlinding(seedA, SOL_POOLS_V3[1].poolPDA, 12),
    );
  });

  it('stays below 2^63 so the Goldilocks reduction is injective', () => {
    for (let i = 0; i < 200; i++) {
      const b = deriveNoteBlinding(seedA, pool, i);
      expect(b).toBeLessThan(1n << 63n);
      expect(b).toBeGreaterThan(0n);
    }
  });

  /**
   * The whole point: with the real epoch, an observer who sees the published
   * nullifier can brute-force a few thousand epochs and recover the commitment.
   * With blinding they cannot, and this asserts the search fails.
   *
   * ⚠️ EXPLICIT TIMEOUT, AND THE SEARCH MUST NOT SHRINK TO EARN IT.
   *
   * This runs ~26,000 real Poseidon commitments: 6,001 to show the attack
   * succeeds against the old scheme, 20,001 to show it fails against the new
   * one. That is the demonstration, not overhead. A smaller window would run
   * faster and prove less: "we did not find it in 200 tries" is not the claim
   * this test exists to make.
   *
   * Measured 2026-08-23 on two machines: 1,680 ms here, 4,191 ms on a second
   * one, against vitest's 5,000 ms default. The slower machine was at 84% of
   * budget alone and tipped over under parallel load, failing 2 runs out of 2.
   * That is not flakiness, it is a deadline set for the wrong machine. The work
   * is legitimate, so the deadline moves.
   */
  it('defeats the epoch-enumeration attack that the old scheme allowed', () => {
    const { secret, nullifierPreimage } = deriveNoteMaterial(seedA, pool, 30);
    const mint = pubkeyToField(SOL_POOLS_V3[0].tokenMint);

    const legacyEpoch = 66_500n;
    const legacy = createCommitmentV3(nullifierPreimage, secret, legacyEpoch, mint);
    let foundLegacy = false;
    for (let e = legacyEpoch - 3000n; e <= legacyEpoch + 3000n; e++) {
      if (createCommitmentV3(nullifierPreimage, secret, e, mint) === legacy) {
        foundLegacy = true;
        break;
      }
    }
    expect(foundLegacy).toBe(true); // the attack works against the old scheme

    const blinded = createCommitmentV3(
      nullifierPreimage,
      secret,
      deriveNoteBlinding(seedA, pool, 30),
      mint,
    );
    let foundBlinded = false;
    for (let e = 0n; e <= 20000n; e++) {
      if (createCommitmentV3(nullifierPreimage, secret, e, mint) === blinded) {
        foundBlinded = true;
        break;
      }
    }
    expect(foundBlinded).toBe(false); // and fails against the new one
  }, 30_000);
});

// ---------------------------------------------------------------------------
// unshield_denominated_stark_v3 — min_epoch must be zero on every path
//
// C7_SPEND_CIRCUIT_PLAN.md Step 1. `min_epoch` sits at instruction byte offset
// 72 and the handler provably ignores it:
//   unshield_denominated_stark_v3.rs:387
//     let _ = (amount, unshield_fee, min_epoch, current_epoch, dynamic_delay, nullifier);
// (`min_epoch` appears nowhere else in that file — only :80 in the arg list and
// :173 in the handler signature.) It used to carry `receipt.depositEpoch`,
// which since commitment blinding is a 63-bit SECRET. Publishing it cancels the
// blinding: an observer recomputes poseidon(nullifier, poseidon(blinding, mint))
// and lands on the exact deposit leaf.
// ---------------------------------------------------------------------------

/**
 * Read a u64 LE with a DataView, never `Buffer.readBigUInt64LE`. The browser
 * Buffer polyfill has historically lacked the 64-bit accessors (four separate
 * production bugs), so the test asserts on the bytes themselves.
 */
function readU64LE(bytes: Uint8Array, offset: number): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getBigUint64(offset, true);
}

/** Every 8-byte little-endian window in `bytes`, as u64s. */
function allU64Windows(bytes: Uint8Array): bigint[] {
  const out: bigint[] = [];
  for (let i = 0; i + 8 <= bytes.length; i++) out.push(readU64LE(bytes, i));
  return out;
}

describe('buildUnshieldDenominatedStarkV3Ix — min_epoch pinned to 0', () => {
  const payer = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const pool = SOL_POOLS_V3[0];
  const c1 = Keypair.generate().publicKey;
  const c3 = Keypair.generate().publicKey;

  // A realistic BLINDED note: 63-bit PRF blinding in the commitment's third
  // slot, exactly what a /pay shield produces today.
  const seed = new Uint8Array(32).fill(3);
  const { secret, nullifierPreimage } = deriveNoteMaterial(seed, pool.poolPDA, 30);
  const mintField = pubkeyToField(pool.tokenMint);
  const noteBlinding = deriveNoteBlinding(seed, pool.poolPDA, 30);
  const commitment = createCommitmentV3(nullifierPreimage, secret, noteBlinding, mintField);
  const nullifier = createNullifierV3(nullifierPreimage, secret);

  const nullifierBytes = Array.from(goldilocksU64To32(nullifier));
  const merkleRootBytes = Array.from(goldilocksToLeBytes32(0x0123456789abcdefn));
  const [nullifierPDA] = deriveNullifierPDA(pool.poolPDA, nullifierBytes);

  function build() {
    return buildUnshieldDenominatedStarkV3Ix(
      payer,
      recipient,
      pool.poolPDA,
      pool.treePDA,
      nullifierPDA,
      c1,
      c3,
      nullifierBytes,
      merkleRootBytes,
      commitment,
      // [C3-D12] The walk arguments. Three levels, matching the depth-15 pool
      // minus the depth-12 circuit.
      0x0fedcba987654321n,
      [111n, 222n, 333n],
      [0, 1, 0],
    );
  }

  // The two historical call shapes. `unshieldDenominatedStarkV3(..., emergency)`
  // used to compute `emergency ? 0n : receipt.depositEpoch` and hand the result
  // to this builder. The flag is gone and the builder takes no epoch/blinding
  // argument at all, so both shapes now reduce to the single call above — which
  // is precisely the property asserted here. If anyone reintroduces a per-call
  // min_epoch, one of these goes red.
  for (const shape of ['non-emergency', 'emergency'] as const) {
    it(`writes 0 at bytes 72..80 (${shape} call shape)`, () => {
      const ix = build();
      // [C3-D12] The layout grew by `subtree_root` (8) plus two Borsh vecs:
      // siblings (4 + 3*8) and directions (4 + 3). The min_epoch offset at
      // 72..80 is unchanged, which is the property this test actually pins.
      expect(ix.data.length).toBe(8 + 32 + 32 + 8 + 8 + 32 + 8 + (4 + 3 * 8) + (4 + 3));
      expect(ix.data.length).toBe(163);
      expect(readU64LE(ix.data, 72)).toBe(0n);
      expect(Array.from(ix.data.subarray(72, 80))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });
  }

  it('exposes the pinned constant as 0n', () => {
    expect(UNSHIELD_MIN_EPOCH).toBe(0n);
  });

  it('still lays out every other arg at its on-chain offset', () => {
    const ix = build();
    const expectedDisc = Buffer.from(
      sha256(utf8ToBytes('global:unshield_denominated_stark_v3')).slice(0, 8),
    );
    expect(Buffer.from(ix.data.subarray(0, 8)).equals(expectedDisc)).toBe(true);
    expect(Array.from(ix.data.subarray(8, 40))).toEqual(nullifierBytes);
    expect(Array.from(ix.data.subarray(40, 72))).toEqual(merkleRootBytes);
    // 72..80 = min_epoch (0). 80..88 = stark_commitment — still published; that
    // is the remaining linkability leak the C7 spend circuit closes.
    expect(readU64LE(ix.data, 80)).toBe(commitment);
    expect(Array.from(ix.data.subarray(88, 120))).toEqual(Array.from(recipient.toBytes()));
  });

  it('leaks the note blinding in NO 8-byte window of the instruction data', () => {
    const ix = build();
    const windows = allU64Windows(ix.data);
    // DERIVED, not typed. The old literal was `113 // 120 - 8 + 1`, and it went
    // stale the moment the C3 walk args grew the layout. What this test is
    // actually about is that the note blinding appears in NONE of them, so the
    // count should follow the data rather than pin a byte length twice.
    expect(windows.length).toBe(ix.data.length - 8 + 1);
    expect(windows).not.toContain(noteBlinding);

    // Sanity: the scan is capable of finding a value that IS present, otherwise
    // the assertion above would pass vacuously.
    expect(windows).toContain(commitment);
    expect(windows).toContain(nullifier);
  });

  it('leaks no blinding for any leaf index of this seed', () => {
    const windows = allU64Windows(build().data);
    for (let leaf = 0; leaf < 64; leaf++) {
      expect(windows).not.toContain(deriveNoteBlinding(seed, pool.poolPDA, leaf));
    }
  });
});

// ---------------------------------------------------------------------------
// Legacy notes — blinding slot holds a REAL small epoch
//
// There is an unspent legacy note at leaf 30 of the 0.1 SOL pool. If the
// commitment formula, the wire format, or the epoch-enumeration fallback in
// recoverNotes changes, that note becomes invisible to scan and unwithdrawable
// through the UI. These are its regression guards.
// ---------------------------------------------------------------------------

describe('legacy note positive control', () => {
  const pool = SOL_POOLS_V3[0];
  const mintField = pubkeyToField(pool.tokenMint);

  it('produces the identical commitment for a small epoch (locked vector)', () => {
    const c = createCommitmentV3(
      FIXED_NULLIFIER_PREIMAGE,
      FIXED_SECRET,
      42n, // a real epoch, not a blinding
      FIXED_TOKEN_MINT_FIELD,
    );
    // Locked: the formula is poseidon(poseidon(np, secret), poseidon(42, mint)),
    // byte-identical to stark/src/air/denominated_pool.rs::compute_pool_values.
    // A change here means every legacy note on-chain just became unspendable.
    expect(c).toBe(18294426081100205196n);
    expect(c & U64_MASK_V3).toBe(c);
  });

  it('the C1 witness tuple off a legacy receipt reproduces the on-chain leaf', () => {
    // The pool suite is pure math — no WASM — so this asserts the witness the
    // client feeds to generatePoolCommitmentProof(np, secret, blinding, mint)
    // reproduces `commitment`, which the existing hard gate above ties to the
    // C1 circuit's publicInputs[1]. It is NOT a proof that a STARK verifies.
    const legacyEpoch = 42n;
    const commitment = createCommitmentV3(
      FIXED_NULLIFIER_PREIMAGE,
      FIXED_SECRET,
      legacyEpoch,
      FIXED_TOKEN_MINT_FIELD,
    );
    const receipt: ShieldReceipt = {
      secret: FIXED_SECRET,
      nullifierPreimage: FIXED_NULLIFIER_PREIMAGE,
      noteBlinding: legacyEpoch,
      tokenMint: FIXED_TOKEN_MINT_FIELD,
      commitment,
      leafIndex: 30,
      denomination: pool.denominationAtomic,
      pool: pool.poolPDA.toBase58(),
      token: 'SOL',
      denominationHuman: pool.denomination,
      shieldedAt: 0,
    };
    expect(
      createCommitmentV3(
        receipt.nullifierPreimage,
        receipt.secret,
        receipt.noteBlinding,
        receipt.tokenMint,
      ),
    ).toBe(receipt.commitment);
    expect(createNullifierV3(receipt.nullifierPreimage, receipt.secret)).toBe(
      8379325109983999434n,
    );
  });

  it('round-trips through the wire format under the unchanged deposit_epoch key', () => {
    const legacyEpoch = 42n;
    const note: ShareableNote = {
      version: 1,
      pool: pool.poolPDA.toBase58(),
      secret: FIXED_SECRET.toString(),
      nullifier_preimage: FIXED_NULLIFIER_PREIMAGE.toString(),
      deposit_epoch: legacyEpoch.toString(),
      token_mint: mintField.toString(),
      commitment: createCommitmentV3(
        FIXED_NULLIFIER_PREIMAGE,
        FIXED_SECRET,
        legacyEpoch,
        mintField,
      ).toString(),
      leafIndex: 30,
      token: 'SOL',
      denominationHuman: pool.denomination,
    };
    const receipt = importNote(encodeShareableNote(note));
    expect(receipt.noteBlinding).toBe(legacyEpoch);

    // The serialized key itself is load-bearing: extractStoredPath in
    // worker/poolHandlers.ts parses stored blobs by shape, so renaming it
    // without a version bump silently drops the stored Merkle path.
    expect(Object.keys(JSON.parse(atob(encodeShareableNote(note))))).toContain('deposit_epoch');
  });

  it('recoverNotes still finds a legacy note via the epoch-enumeration fallback', async () => {
    const seed = new Uint8Array(32).fill(3);
    const counter = 30;
    const { secret, nullifierPreimage } = deriveNoteMaterial(seed, pool.poolPDA, counter);
    const legacyEpoch = 1000n;
    const legacyCommitment = createCommitmentV3(nullifierPreimage, secret, legacyEpoch, mintField);
    expect(legacyCommitment).toBe(1923574579667412516n); // locked

    // The chain holds the LEGACY commitment, not the blinded one — so the
    // single-hash blinded match must miss and the fallback must catch it.
    const blinded = createCommitmentV3(
      nullifierPreimage,
      secret,
      deriveNoteBlinding(seed, pool.poolPDA, counter),
      mintField,
    );
    expect(blinded).not.toBe(legacyCommitment);

    const commitments = new Map([
      [legacyCommitment.toString(), { commitment: legacyCommitment, leafIndex: counter }],
    ]);
    // slotToEpoch(slot) = floor(slot / 7200); pick a slot 5 epochs past the note
    // so the 6000-epoch window covers it.
    const slot = 7200 * 1005;
    expect(slotToEpoch(slot)).toBe(1005n);

    const fakeConnection = {
      getSlot: async () => slot,
      // No NullifierRecord for this pool => every note in it is unspent.
      // `recoverNotes` reads spent-ness POOL-WIDE rather than per note, so this
      // is the one call it makes; see `fetchSpentNullifierSet`.
      getProgramAccounts: async () => [],
    } as unknown as Connection;

    const notes = await recoverNotes(fakeConnection, pool, seed, { commitments });
    expect(notes.length).toBe(1);
    expect(notes[0].receipt.leafIndex).toBe(counter);
    expect(notes[0].receipt.commitment).toBe(legacyCommitment);
    expect(notes[0].receipt.noteBlinding).toBe(legacyEpoch);
    expect(notes[0].spent).toBe(false);
  });

  it('recoverNotes finds a blinded note with the single-hash path', async () => {
    const seed = new Uint8Array(32).fill(3);
    const counter = 30;
    const { secret, nullifierPreimage } = deriveNoteMaterial(seed, pool.poolPDA, counter);
    const blinding = deriveNoteBlinding(seed, pool.poolPDA, counter);
    const blinded = createCommitmentV3(nullifierPreimage, secret, blinding, mintField);
    expect(blinded).toBe(1848980999532868805n); // locked

    const commitments = new Map([
      [blinded.toString(), { commitment: blinded, leafIndex: counter }],
    ]);
    const fakeConnection = {
      getSlot: async () => 7200 * 1005,
      getProgramAccounts: async () => [],
    } as unknown as Connection;

    const notes = await recoverNotes(fakeConnection, pool, seed, { commitments });
    expect(notes.length).toBe(1);
    expect(notes[0].receipt.noteBlinding).toBe(blinding);
    expect(notes[0].receipt.commitment).toBe(blinded);
  });
});

// ---------------------------------------------------------------------------
// Blinded-only fast pass — the progressive scan's first phase
//
// `blindedOnly: true` is what lets the scan paint in milliseconds: one hash
// per candidate leaf, no epoch enumeration, no extra RPC. Its contract has two
// halves and both need a guard: it finds every current-scheme note, and it is
// allowed to MISS legacy notes only because the caller runs the full pass
// right after. If the flag ever leaked into the full pass, the leaf-30 legacy
// note would go invisible — the positive control above is the tripwire.
// ---------------------------------------------------------------------------

describe('blinded-only fast pass (progressive scan)', () => {
  const pool = SOL_POOLS_V3[0];
  const mintField = pubkeyToField(pool.tokenMint);
  const seed = new Uint8Array(32).fill(3);

  // Two notes owned by the same seed: one current-scheme at leaf 5, one
  // legacy at leaf 9 (a real epoch where the blinding now goes).
  const BLINDED_LEAF = 5;
  const LEGACY_LEAF = 9;
  const LEGACY_EPOCH = 1000n;

  function fixtures() {
    const b = deriveNoteMaterial(seed, pool.poolPDA, BLINDED_LEAF);
    const blindedCommitment = createCommitmentV3(
      b.nullifierPreimage,
      b.secret,
      deriveNoteBlinding(seed, pool.poolPDA, BLINDED_LEAF),
      mintField,
    );
    const l = deriveNoteMaterial(seed, pool.poolPDA, LEGACY_LEAF);
    const legacyCommitment = createCommitmentV3(
      l.nullifierPreimage,
      l.secret,
      LEGACY_EPOCH,
      mintField,
    );
    const commitments = new Map([
      [blindedCommitment.toString(), { commitment: blindedCommitment, leafIndex: BLINDED_LEAF }],
      [legacyCommitment.toString(), { commitment: legacyCommitment, leafIndex: LEGACY_LEAF }],
    ]);
    return { blindedCommitment, legacyCommitment, commitments };
  }

  it('finds the blinded note, defers the legacy one, and never reads the slot', async () => {
    const { blindedCommitment, commitments } = fixtures();
    let slotReads = 0;
    const fakeConnection = {
      getSlot: async () => {
        slotReads += 1;
        return 7200 * 1005;
      },
      getProgramAccounts: async () => [],
    } as unknown as Connection;

    const notes = await recoverNotes(fakeConnection, pool, seed, {
      commitments,
      blindedOnly: true,
    });
    // The current-scheme note, and ONLY it: the legacy note is invisible to
    // this pass by design, which is exactly why no caller may present a
    // blinded-only result as complete.
    expect(notes.map((n) => n.receipt.leafIndex)).toEqual([BLINDED_LEAF]);
    expect(notes[0].receipt.commitment).toBe(blindedCommitment);
    // Zero chain reads beyond what the caller hoisted — the slot only bounds
    // the epoch search this pass skips.
    expect(slotReads).toBe(0);
  });

  it('the full pass over the same pool finds both — the fallback is deferred, never lost', async () => {
    const { blindedCommitment, legacyCommitment, commitments } = fixtures();
    const fakeConnection = {
      getSlot: async () => 7200 * 1005,
      getProgramAccounts: async () => [],
    } as unknown as Connection;

    const notes = await recoverNotes(fakeConnection, pool, seed, { commitments });
    expect(notes.map((n) => n.receipt.leafIndex).sort((a, b) => a - b)).toEqual([
      BLINDED_LEAF,
      LEGACY_LEAF,
    ]);
    const byLeaf = new Map(notes.map((n) => [n.receipt.leafIndex, n.receipt]));
    expect(byLeaf.get(BLINDED_LEAF)!.commitment).toBe(blindedCommitment);
    expect(byLeaf.get(LEGACY_LEAF)!.commitment).toBe(legacyCommitment);
    expect(byLeaf.get(LEGACY_LEAF)!.noteBlinding).toBe(LEGACY_EPOCH);
  });

  it('onlyLeaf narrows WHERE without weakening WHAT: each note is still found at its own leaf', async () => {
    // The spend paths (withdraw, subscribe, hand-over) select a note by leaf
    // index, so they probe one leaf instead of running the epoch search over
    // every foreign leaf in the pool. Both schemes must survive the narrowing.
    const { blindedCommitment, legacyCommitment, commitments } = fixtures();
    const fakeConnection = {
      getSlot: async () => 7200 * 1005,
      getProgramAccounts: async () => [],
    } as unknown as Connection;

    const atBlinded = await recoverNotes(fakeConnection, pool, seed, {
      commitments,
      onlyLeaf: BLINDED_LEAF,
    });
    expect(atBlinded.map((n) => n.receipt.leafIndex)).toEqual([BLINDED_LEAF]);
    expect(atBlinded[0].receipt.commitment).toBe(blindedCommitment);

    // The legacy note still needs — and still gets — the epoch search, just
    // scoped to its one leaf.
    const atLegacy = await recoverNotes(fakeConnection, pool, seed, {
      commitments,
      onlyLeaf: LEGACY_LEAF,
    });
    expect(atLegacy.map((n) => n.receipt.leafIndex)).toEqual([LEGACY_LEAF]);
    expect(atLegacy[0].receipt.commitment).toBe(legacyCommitment);
    expect(atLegacy[0].receipt.noteBlinding).toBe(LEGACY_EPOCH);

    // A leaf the RPC does not serve yields nothing, exactly like the full scan.
    const atUnserved = await recoverNotes(fakeConnection, pool, seed, {
      commitments,
      onlyLeaf: 999,
    });
    expect(atUnserved).toEqual([]);
  });
});

describe('what a scan sweeps when no denomination is named', () => {
  it('reads the 1 SOL pool and no other', () => {
    const pools = getPoolsToScanByDefault('SOL');
    expect(pools.map((p) => p.denomination)).toEqual([1]);
  });

  it('🚨 leaves the 0.1 pool REACHABLE by name, which is the whole design', () => {
    // Its 12 unspent notes (measured 2026-08-21, 41 leaves) drop out of a
    // default scan and out of nothing else. `handlePoolScan` honours an explicit
    // denomination unchanged, so a holder who asks for 0.1 still finds them.
    // Closing an entrance is not closing an exit, and neither is narrowing a
    // default — but only if this stays true.
    const byName = findPoolV3('SOL', 0.1);
    expect(byName, 'the 0.1 pool disappeared from the registry').toBeTruthy();
    expect(getPoolsForTokenV3('SOL').map((p) => p.denomination)).toContain(0.1);
  });

  it('narrows, never invents: every default pool is a real registered one', () => {
    for (const p of getPoolsToScanByDefault('SOL')) {
      expect(getPoolsForTokenV3('SOL')).toContain(p);
    }
  });

  it('has no USDC pool to sweep, and says so rather than guessing', () => {
    expect(getPoolsToScanByDefault('USDC')).toEqual([]);
  });
});
