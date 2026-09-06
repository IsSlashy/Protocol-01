/**
 * MOBILE's v4 spend — the instruction, pinned independently of the two other
 * twins, and the prepare step that feeds it.
 *
 * ✅ MOBILE SPENDS v3-POOL NOTES ON v4 SINCE 2026-09-06. `stores/
 * denominatedPoolStore.ts` (`prepareUnshieldNoteV4` + `unshieldNoteStarkV4`)
 * drives a circuit-7 spend through `prepareUnshieldV4` / `unshieldDenominatedStarkV4`
 * below, and both unshield screens route to it through
 * `services/denominatedPool/spendRouting.ts`. The C1 + C3 pair — which
 * PUBLISHES the note commitment — is the per-note fallback, not the default.
 *
 * ⚠️ WHAT THE CUTOVER SHIPPED WITHOUT: the on-device circuit-7 timing. C7's
 * proving time is high variance in Node - 1,881 / 3,708 / 10,359 ms on an
 * identical witness (PoW grind) - and no phone number exists at all. The
 * "180 s" that used to circulate was a WebView HANG, retracted the evening it
 * was written (memory/measured-on-device-proving-exceeds-180s-2026-08-03.md).
 * A live v4 withdrawal from this app has not been executed on a device or on
 * devnet either. The `prepareUnshieldV4` describe below pins what the prepare
 * REFUSES and what it hands the prover; it says nothing about a proof landing.
 *
 * ⛔ NOT REDUNDANT WITH apps/web's copy, and the reason is measured history.
 * On 2026-08-21 the extension and the mobile app were found shipping a prover
 * blob the deployed verifier REJECTS, while the web app carried the right one.
 * Three surfaces, three copies, and only one of them was being checked. The v4
 * builder here is a copy of the web one and will drift the same way unless
 * something in this package asserts on it.
 *
 * What it checks is what the web copy checks: the wire layout, and the sweep
 * for anything that names the deposit.
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

import { PublicKey, SystemProgram, type Connection } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it, vi } from 'vitest';

import {
  buildUnshieldDenominatedStarkV4Ix,
  buildMerkleProofFromLeavesV3,
  goldilocksToLeBytes32,
  prepareUnshieldV4,
  recipientHashLimbs,
  whyCircuit7Cannot,
  C7_SUBTREE_DEPTH,
  LEGACY_BLINDING_CEILING,
  MERKLE_DEPTH,
  V4Unprovable,
  type PoolConfig,
  type ShieldReceipt,
  type SpendProver,
} from './index';
import { SPEND_SUBTREE_DEPTH } from '../stark/spendWitness';

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

describe('mobile: unshield_denominated_stark_v4 — the wire', () => {
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

describe('mobile: unshield_denominated_stark_v4 — the property', () => {
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

describe('mobile: recipientHashLimbs', () => {
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

// ---------------------------------------------------------------------------
// The prepare step — what it refuses, and what it hands the prover.
//
// No RPC and no WASM: the connection is a stub whose signature scan is empty
// (so the note sits at leaf 0 of an otherwise-empty tree and the builder's
// root is deterministic), and the prover is a closure that answers with
// whatever public inputs the test wants circuit 7 to have "published".
// ---------------------------------------------------------------------------

const GOLDILOCKS_P = (1n << 64n) - (1n << 32n) + 1n;

const POOL_CONFIG = {
  token: 'SOL',
  tokenMint: SystemProgram.programId,
  denomination: 1,
  decimals: 9,
  denominationAtomic: 1_000_000_000n,
  poolPDA: POOL,
  treePDA: TREE,
  version: 'v3',
} as unknown as PoolConfig;

/** A PRF-blinded receipt at leaf 0. `depositEpoch` is the blinding. */
const RECEIPT: ShieldReceipt = {
  secret: 22n,
  nullifierPreimage: 11n,
  depositEpoch: 7284991002338477113n,
  tokenMint: 0n,
  commitment: 0xdeadbeefcafebaben,
  leafIndex: 0,
  denomination: 1_000_000_000n,
  pool: POOL.toBase58(),
  token: 'SOL',
  denominationHuman: 1,
  shieldedAt: 0,
};

/** The root the builder produces for a tree holding nothing but leaf 0. */
const EMPTY_TREE_ROOT = buildMerkleProofFromLeavesV3({ leavesByIndex: [], targetLeafIndex: 0 }).root;

/** A `DenominatedPool` account whose current root is `root` and whose ring is empty. */
function poolAccountBytes(root: bigint): Buffer {
  const buf = Buffer.alloc(183);
  Buffer.from(goldilocksToLeBytes32(root)).copy(buf, 88);
  buf.writeUInt32LE(0, 178);
  buf[182] = 100;
  return buf;
}

function stubConnection(poolAccount: Buffer | null): Connection {
  return {
    getSignaturesForAddress: async () => [],
    getTransaction: async () => null,
    getAccountInfo: async () => (poolAccount ? { data: poolAccount } : null),
  } as unknown as Connection;
}

/** A prover that publishes exactly what circuit 7 publishes, unless told otherwise. */
function stubProver(over: {
  nullifier?: bigint;
  felts?: number;
  limbTamper?: number;
} = {}): { prove: SpendProver; calls: Parameters<SpendProver>[] } {
  const calls: Parameters<SpendProver>[] = [];
  const prove: SpendProver = async (...args) => {
    calls.push(args);
    const rh = args[6].map((s) => BigInt(s));
    if (over.limbTamper !== undefined) rh[over.limbTamper] = rh[over.limbTamper] ^ 1n;
    const publicInputs = [over.nullifier ?? 0x1122334455667788n, EMPTY_TREE_ROOT, ...rh].map(String);
    return {
      proofHex: 'ab'.repeat(64),
      publicInputs: over.felts === undefined ? publicInputs : publicInputs.slice(0, over.felts),
      proofSize: 64,
    };
  };
  return { prove, calls };
}

describe('mobile: whyCircuit7Cannot', () => {
  it('refuses a note whose third input is a real epoch, and says why', () => {
    const why = whyCircuit7Cannot({ depositEpoch: 67838n });
    expect(why).toMatch(/circuit 7 needs at least/);
    expect(why).toMatch(/predates commitment blinding/);
    expect(why).toContain('67838');
  });

  it('admits a PRF-blinded note', () => {
    expect(whyCircuit7Cannot({ depositEpoch: RECEIPT.depositEpoch })).toBeNull();
  });

  it('puts the threshold where the two populations actually are', () => {
    expect(LEGACY_BLINDING_CEILING).toBe(2n ** 32n);
    expect(67838n).toBeLessThan(LEGACY_BLINDING_CEILING); // every real epoch
    expect(LEGACY_BLINDING_CEILING).toBeLessThan(2n ** 63n); // every PRF draw's range
    expect(whyCircuit7Cannot({ depositEpoch: LEGACY_BLINDING_CEILING })).toBeNull();
    expect(whyCircuit7Cannot({ depositEpoch: LEGACY_BLINDING_CEILING - 1n })).not.toBeNull();
  });
});

describe('mobile: prepareUnshieldV4', () => {
  it('hands the prover exactly the circuit depth, and keeps the rest for the chain', async () => {
    const { prove, calls } = stubProver();
    const prepared = await prepareUnshieldV4(
      RECEIPT, RECIPIENT, POOL_CONFIG, stubConnection(poolAccountBytes(EMPTY_TREE_ROOT)), prove,
    );
    expect(calls).toHaveLength(1);
    const [np, secret, blinding, mint, pathElements, pathIndices, recipientHash] = calls[0];
    expect(np).toBe('11');
    expect(secret).toBe('22');
    // The commitment's third input travels as the blinding — the same field
    // the pair sends to C1 as `depositEpoch`.
    expect(blinding).toBe(RECEIPT.depositEpoch.toString());
    expect(mint).toBe('0');
    // ⛔ 11, NOT 12 and NOT 15. The two depths are declared twice on purpose
    // (index.ts and spendWitness.ts); this is the tie.
    expect(C7_SUBTREE_DEPTH).toBe(SPEND_SUBTREE_DEPTH);
    expect(pathElements).toHaveLength(C7_SUBTREE_DEPTH);
    expect(pathIndices).toHaveLength(C7_SUBTREE_DEPTH);
    expect(recipientHash.map(BigInt)).toEqual(recipientHashLimbs(RECIPIENT));
    // The levels above the circuit are walked on chain.
    expect(prepared.siblings).toHaveLength(MERKLE_DEPTH - C7_SUBTREE_DEPTH);
    expect(prepared.directions).toHaveLength(MERKLE_DEPTH - C7_SUBTREE_DEPTH);
    expect(prepared.merkleRoot).toBe(EMPTY_TREE_ROOT);
    expect(prepared.subtreeRoot).toBe(EMPTY_TREE_ROOT);
    expect(prepared.nullifierGoldilocks).toBe(0x1122334455667788n);
    expect(prepared.recipient.equals(RECIPIENT)).toBe(true);
    // No commitment travels with the result. Its absence is the property.
    expect(Object.keys(prepared)).not.toContain('starkCommitment');
  });

  it('is V4Unprovable — not Error — when the rebuilt root is not in the ring, before proving', async () => {
    const { prove, calls } = stubProver();
    const someOtherRoot = 0x99aabbccddeeff00n;
    const err = await prepareUnshieldV4(
      RECEIPT, RECIPIENT, POOL_CONFIG, stubConnection(poolAccountBytes(someOtherRoot)), prove,
    ).then(
      () => { throw new Error('the prepare did NOT refuse'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(V4Unprovable);
    expect((err as Error).message).toMatch(/PRE-FLIGHT FAIL/);
    // Nothing proved, so nothing to upload: the refusal is free.
    expect(calls).toHaveLength(0);
  });

  it('skips the pre-flight when the pool account cannot be read, like the twins', async () => {
    const { prove } = stubProver();
    await expect(
      prepareUnshieldV4(RECEIPT, RECIPIENT, POOL_CONFIG, stubConnection(null), prove),
    ).resolves.toBeDefined();
  });

  // ⛔ THE THREE BELOW FAIL CLOSED. "The prover published 5 felts" is a defect
  // to surface, not a reason to republish the commitment on the pair.
  it('a wrong felt count is a plain Error, never V4Unprovable', async () => {
    const { prove } = stubProver({ felts: 5 });
    const err = await prepareUnshieldV4(RECEIPT, RECIPIENT, POOL_CONFIG, stubConnection(null), prove)
      .then(() => { throw new Error('did not throw'); }, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(V4Unprovable);
    expect((err as Error).message).toMatch(/exactly 6 felts, got 5/);
  });

  it('a transcript bound to another payee is a plain Error, never V4Unprovable', async () => {
    const { prove } = stubProver({ limbTamper: 2 });
    const err = await prepareUnshieldV4(RECEIPT, RECIPIENT, POOL_CONFIG, stubConnection(null), prove)
      .then(() => { throw new Error('did not throw'); }, (e: unknown) => e);
    expect(err).not.toBeInstanceOf(V4Unprovable);
    expect((err as Error).message).toMatch(/recipient hash that does not match .* at limb 2/);
  });

  it('a non-canonical nullifier is a plain Error, never V4Unprovable', async () => {
    // The chain refuses any nullifier >= p: below 2**32 - 1 every value had a
    // second encoding n + p seeding a distinct nullifier PDA.
    const { prove } = stubProver({ nullifier: GOLDILOCKS_P });
    const err = await prepareUnshieldV4(RECEIPT, RECIPIENT, POOL_CONFIG, stubConnection(null), prove)
      .then(() => { throw new Error('did not throw'); }, (e: unknown) => e);
    expect(err).not.toBeInstanceOf(V4Unprovable);
    expect((err as Error).message).toMatch(/non-canonical nullifier/);
    // And the boundary itself is accepted: p - 1 is the largest canonical felt.
    const ok = stubProver({ nullifier: GOLDILOCKS_P - 1n });
    await expect(
      prepareUnshieldV4(RECEIPT, RECIPIENT, POOL_CONFIG, stubConnection(null), ok.prove),
    ).resolves.toMatchObject({ nullifierGoldilocks: GOLDILOCKS_P - 1n });
  });

  it('reports progress, so a two-minute proof is not a frozen screen', async () => {
    const steps: string[] = [];
    const { prove } = stubProver();
    await prepareUnshieldV4(RECEIPT, RECIPIENT, POOL_CONFIG, stubConnection(null), prove, (s) => steps.push(s));
    expect(steps.join(' | ')).toMatch(/Proving ownership and membership in one trace/);
  });
});
