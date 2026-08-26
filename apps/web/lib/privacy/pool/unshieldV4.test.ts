/**
 * unshieldV4.test.ts — the v4 spend instruction publishes nothing that names
 * the deposit.
 *
 * WHAT v3 LEAKS
 * ─────────────
 * `unshield_denominated_stark_v3` spends on a C1 + C3 pair. The two proofs are
 * independent, so something ties them together, and that something is
 * `stark_commitment` — the note commitment, PUBLISHED IN THE CLEAR as an
 * instruction argument. A withdrawal therefore NAMES the leaf it spends, and
 * anyone holding the deposit events matches it to a `LeafInserted` and walks
 * back to the deposit that funded it. Nothing is broken; the linkage is printed
 * on the wire.
 *
 * 🚨 THE LEAK TEST BELOW IS THE ONLY ONE HERE THAT CHECKS THE PROPERTY. The
 * others check that v4 is wired correctly, which is necessary and not
 * sufficient: a wiring bug produces a failed transaction, and a leak produces a
 * SUCCESSFUL one that quietly identifies the depositor. It sweeps every 8-byte
 * window of the serialised instruction rather than asserting on named fields,
 * because a field can be renamed, reordered, or folded into another and the
 * bytes would still be there.
 *
 * ⚠️ WHAT THIS FILE CANNOT SAY. It never touches an RPC, a worker or the WASM,
 * so a green run says nothing about whether a circuit-7 proof verifies. That is
 * `packages/stark-prover/scripts/c7-live-proof.ts`, which asks the deployed
 * program. Do not read this suite as a gate on the proof.
 */

import { PublicKey, SystemProgram } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';

import {
  buildUnshieldDenominatedStarkV4Ix,
  recipientHashLimbs,
  C7_SUBTREE_DEPTH,
} from './denominatedPool';

const PAYER = new PublicKey('7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU');
const RECIPIENT = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const POOL = new PublicKey('11111111111111111111111111111112');
const TREE = new PublicKey('11111111111111111111111111111113');
const NULLIFIER_PDA = new PublicKey('11111111111111111111111111111114');
const BUFFER = new PublicKey('11111111111111111111111111111115');

const le32 = (v: bigint): number[] => {
  const out = new Array<number>(32).fill(0);
  for (let i = 0; i < 8; i++) out[i] = Number((v >> BigInt(8 * i)) & 0xffn);
  return out;
};

const NULLIFIER = 0x1122334455667788n;
const POOL_ROOT = 0x99aabbccddeeff00n;
const SUBTREE_ROOT = 0x0123456789abcdefn;
const SIBLINGS = [0xaaaaaaaaaaaaaaaan, 0xbbbbbbbbbbbbbbbbn, 0xccccccccccccccccn];
const DIRECTIONS = [1, 0, 1];

/** The two values a v4 instruction must never contain. */
const NOTE_COMMITMENT = 0xdeadbeefcafebaben;
const NOTE_BLINDING = 0x7fedcba987654321n;

function buildIx() {
  return buildUnshieldDenominatedStarkV4Ix(
    PAYER, RECIPIENT, POOL, TREE, NULLIFIER_PDA, BUFFER,
    le32(NULLIFIER), le32(POOL_ROOT),
    SUBTREE_ROOT, SIBLINGS, DIRECTIONS,
  );
}

describe('unshield_denominated_stark_v4 — the wire', () => {
  it('serialises to exactly 147 bytes with a 3-level tail', () => {
    // 8 disc + 32 nullifier + 32 merkle_root + 8 subtree_root
    //   + (4 + 3*8) siblings + (4 + 3) directions + 32 recipient
    // The same 147 `verify/p01-verify.mjs` pins for this instruction.
    expect(buildIx().data.length).toBe(147);
  });

  it('puts the recipient in the last 32 bytes', () => {
    const data = buildIx().data;
    expect(Buffer.from(RECIPIENT.toBytes()).equals(data.subarray(115, 147))).toBe(true);
  });

  it('lays the fields out in the order the Rust declares them', () => {
    const data = buildIx().data;
    expect(Buffer.from(data.subarray(8, 40))).toEqual(Buffer.from(le32(NULLIFIER)));
    expect(Buffer.from(data.subarray(40, 72))).toEqual(Buffer.from(le32(POOL_ROOT)));
    expect(data.readBigUInt64LE(72)).toBe(SUBTREE_ROOT);
    // Borsh Vec<T> is a u32 length prefix then the elements.
    expect(data.readUInt32LE(80)).toBe(SIBLINGS.length);
    for (let i = 0; i < SIBLINGS.length; i++) {
      expect(data.readBigUInt64LE(84 + i * 8)).toBe(SIBLINGS[i]);
    }
    expect(data.readUInt32LE(108)).toBe(DIRECTIONS.length);
    for (let i = 0; i < DIRECTIONS.length; i++) {
      expect(data.readUInt8(112 + i)).toBe(DIRECTIONS[i]);
    }
  });

  it('names ONE proof buffer, where v3 named two', () => {
    const keys = buildIx().keys;
    expect(keys.filter((k) => k.pubkey.equals(BUFFER))).toHaveLength(1);
    // payer, pool, tree, nullifier, buffer, system, token, vault, ata, escrow,
    // then recipient as remaining_accounts[0].
    expect(keys).toHaveLength(11);
    expect(keys[0].isSigner).toBe(true);
    expect(keys[keys.length - 1].pubkey.equals(RECIPIENT)).toBe(true);
    // The recipient is the LAST key, not a named one: an IDL-driven indexer
    // resolves named accounts, and this one has no name to resolve.
    expect(keys[keys.length - 1].isSigner).toBe(false);
  });

  it('rejects a siblings/directions length mismatch', () => {
    expect(() => buildUnshieldDenominatedStarkV4Ix(
      PAYER, RECIPIENT, POOL, TREE, NULLIFIER_PDA, BUFFER,
      le32(NULLIFIER), le32(POOL_ROOT), SUBTREE_ROOT, SIBLINGS, [1, 0],
    )).toThrow(/same length/);
  });
});

describe('unshield_denominated_stark_v4 — the property', () => {
  it('THE LEAK TEST: no 8-byte window holds the commitment or the blinding', () => {
    const data = buildIx().data;
    const forbidden = new Map<string, bigint>([
      ['the note commitment', NOTE_COMMITMENT],
      ['the note blinding', NOTE_BLINDING],
    ]);

    for (const [label, value] of forbidden) {
      for (let off = 0; off + 8 <= data.length; off++) {
        // Both endiannesses. A field written the other way round is still the
        // same secret sitting on the wire.
        expect(
          data.readBigUInt64LE(off),
          `${label} appears little-endian at byte ${off} of the v4 instruction`,
        ).not.toBe(value);
        expect(
          data.readBigUInt64BE(off),
          `${label} appears big-endian at byte ${off} of the v4 instruction`,
        ).not.toBe(value);
      }
    }
  });

  it('the leak test can actually fail', () => {
    // Anti-vacuity, and not optional: the assertion above passes trivially on
    // any instruction that happens not to contain two arbitrary constants.
    // Prove the sweep finds a value that IS there — the subtree root, which is
    // published on purpose.
    const data = buildIx().data;
    let found = false;
    for (let off = 0; off + 8 <= data.length; off++) {
      if (data.readBigUInt64LE(off) === SUBTREE_ROOT) found = true;
    }
    expect(found, 'the 8-byte sweep did not find a value known to be present').toBe(true);
  });

  it('carries no min_epoch field at all', () => {
    // v3 had one, pinned to 0 on every path because `depositEpoch` became a
    // 63-bit secret once commitments gained a PRF blinding. v4 drops the field,
    // so it cannot be set wrong. 147 bytes is 8 short of the 155 an extra u64
    // would make it.
    expect(buildIx().data.length).toBe(147);
    expect(buildIx().data.length).not.toBe(155);
  });
});

describe('recipientHashLimbs', () => {
  it('is sha256(recipient) split into four little-endian u64s', () => {
    // The contract `unshield_denominated_stark_v4.rs` relies on:
    // rh[i] = u64::from_le_bytes(digest[8i..8i+8]).
    const digest = sha256(RECIPIENT.toBytes());
    const limbs = recipientHashLimbs(RECIPIENT);
    expect(limbs).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(limbs[i]).toBe(Buffer.from(digest).readBigUInt64LE(i * 8));
    }
  });

  it('reassembles into the digest byte for byte', () => {
    // 🚨 THE IDENTITY THE ON-CHAIN SHORTCUT DEPENDS ON. The four felts are
    // carried RAW — no trace column, no constraint, nothing reduces them mod
    // the Goldilocks prime — so their concatenation IS the digest, which is why
    // `c7_pub_bytes` copies 32 bytes in one move instead of splitting and
    // re-joining. A change that published reduced felts would break this for
    // any limb >= the modulus, and this test is the guard on that.
    const limbs = recipientHashLimbs(RECIPIENT);
    const rebuilt = Buffer.alloc(32);
    limbs.forEach((l, i) => rebuilt.writeBigUInt64LE(l, i * 8));
    expect(rebuilt.equals(Buffer.from(sha256(RECIPIENT.toBytes())))).toBe(true);
  });

  it('separates two different recipients', () => {
    const other = recipientHashLimbs(SystemProgram.programId);
    const mine = recipientHashLimbs(RECIPIENT);
    expect(other).not.toEqual(mine);
  });

  it('reduction mod p would be INVISIBLE to sampling — so it is a code contract, not a test', () => {
    // 🚨 MEASURED, and the reason the comment on `recipientHashLimbs` has to
    // carry the weight instead of a test.
    //
    // A limb only differs raw-vs-reduced when it is >= the Goldilocks prime
    // p = 2^64 - 2^32 + 1. Exactly 2^32 - 1 of the 2^64 values qualify, so a
    // uniform digest limb lands there with probability ~2^-32 — about one in
    // 4.3 billion. 1,024 limbs are swept below and none do; that is the
    // expected outcome, not a weak search.
    //
    // ⛔ SO A PROVER THAT STARTED REDUCING FELTS WOULD PASS EVERY TEST IN THIS
    // FILE AND EVERY REALISTIC RUN, AND STILL BREAK `c7_pub_bytes`'s one-move
    // digest copy the first time a limb overflowed. The protection is that the
    // felts occupy no trace column and no constraint, so nothing is in a
    // position to reduce them. That is enforced by
    // `the_four_recipient_felts_reassemble_the_digest` on the Rust side, not by
    // sampling here.
    const P = (1n << 64n) - (1n << 32n) + 1n;
    let overflows = 0;
    for (let i = 0; i < 256; i++) {
      const seed = new Uint8Array(32);
      seed[0] = i & 0xff;
      seed[1] = (i >> 8) & 0xff;
      for (const limb of recipientHashLimbs(new PublicKey(seed))) {
        if (limb >= P) overflows += 1;
      }
    }
    // Not `toBe(0)`: an overflow here is legal and would be a 1-in-4-million
    // event across this sweep, not a defect. Assert the thing that matters —
    // the function returns full-width u64s and never clamps into [0, p).
    expect(overflows).toBeLessThanOrEqual(1);

    // The load-bearing assertion: the output is a pure little-endian re-read of
    // the digest with no arithmetic anywhere in it.
    for (let i = 0; i < 16; i++) {
      const seed = new Uint8Array(32);
      seed[0] = i;
      const key = new PublicKey(seed);
      const digest = Buffer.from(sha256(key.toBytes()));
      const limbs = recipientHashLimbs(key);
      for (let j = 0; j < 4; j++) expect(limbs[j]).toBe(digest.readBigUInt64LE(j * 8));
    }
  });
});
