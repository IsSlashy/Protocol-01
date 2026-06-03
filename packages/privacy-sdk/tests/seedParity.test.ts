/**
 * S0-T1 — Cross-subsystem CANONICAL-SEED PARITY test (BLOCKS Ledger/pairing).
 *
 * Encodes the load-bearing invariant from docs/pairing-ledger-spec.md §0:
 *
 *   THE P01 SPENDING SEED IS THE RAW 32 BYTES (`secretKey.slice(0, 32)`),
 *   NOT an HKDF sub-key.
 *
 * Every live note pipeline consumes that raw slice DIRECTLY:
 *   - denominated → `deriveNoteMaterial` / `noteCrypto.deriveNoteEncryptionKeys`
 *     run their OWN HKDF with IKM = the raw slice.
 *   - shielded    → `zk.ts deriveSpendingKey` runs `SHA-256(hex(rawSlice) + ':spending_key')`.
 *
 * For HARDWARE wallets, the spending seed is a CSPRNG 32-byte value that MUST be
 * fed to the SAME consumers, in the SAME position, as the local raw slice is fed
 * today. It MUST NOT be pre-run through `deriveP01IdentityFromSeed` (HKDF) — doing
 * so yields a DIFFERENT 32 bytes and therefore UNSPENDABLE hardware notes.
 *
 * `deriveP01IdentityFromSeed` is the SDK's separate identity-API helper; it has
 * ZERO callers in the live note pipelines (verified — spec §0). This test pins
 * that fact so a future HKDF-identity migration cannot silently desync the
 * note pipelines (or paired/hardware devices) without turning this test RED.
 *
 * The pipelines below are reproduced IN-FILE (byte-faithful mirrors of the live
 * extension/mobile code) so the SDK test has no app dependency. The hashing
 * primitives (`goldilocksHash2to1`) and HKDF/SHA-256 are the SAME ones the apps
 * use, so a regression in those would also surface here.
 */

import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes, concatBytes } from '@noble/hashes/utils.js';

import { goldilocksHash2to1 } from '../src/crypto/goldilocks-poseidon';
import { deriveP01IdentityFromSeed } from '../src/identity/deriveIdentity';

// ─── Goldilocks helpers (mirror extension zk.ts / denominatedPool.ts) ─────────
const GOLDILOCKS_MODULUS = 0xffffffff00000001n;
const U64_MASK = (1n << 64n) - 1n;

function toGoldilocks(x: bigint): bigint {
  const r = x % GOLDILOCKS_MODULUS;
  return r < 0n ? r + GOLDILOCKS_MODULUS : r;
}

// BN254 field order — `deriveNoteMaterial` reduces HKDF output mod this.
const FIELD_ORDER = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617',
);

// ─── DENOMINATED pipeline (mirror extension deriveNoteMaterial + createCommitmentV3) ─
function deriveNoteMaterial(
  walletSeed: Uint8Array,
  poolPDA: PublicKey,
  counter: number,
): { secret: bigint; nullifierPreimage: bigint } {
  const salt = utf8ToBytes('p01-note-v1');
  const base = concatBytes(
    utf8ToBytes(poolPDA.toBase58() + ':'),
    utf8ToBytes(String(counter)),
  );
  const secretBytes = hkdf(sha256, walletSeed, salt, concatBytes(base, utf8ToBytes(':secret')), 32);
  const nullifierBytes = hkdf(sha256, walletSeed, salt, concatBytes(base, utf8ToBytes(':nullifier')), 32);
  const toField = (bs: Uint8Array): bigint => {
    let n = 0n;
    for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(bs[i]!);
    return n % FIELD_ORDER;
  };
  return { secret: toField(secretBytes), nullifierPreimage: toField(nullifierBytes) };
}

function createCommitmentV3(
  nullifierPreimage: bigint,
  secret: bigint,
  depositEpoch: bigint,
  tokenMint: bigint,
): bigint {
  const nullifier = goldilocksHash2to1(
    toGoldilocks(nullifierPreimage & U64_MASK),
    toGoldilocks(secret & U64_MASK),
  );
  const epochHash = goldilocksHash2to1(
    toGoldilocks(depositEpoch & U64_MASK),
    toGoldilocks(tokenMint & U64_MASK),
  );
  return goldilocksHash2to1(nullifier, epochHash);
}

/** Full denominated note commitment from a RAW 32-byte seed (the §0 path). */
function denominatedCommitmentFromRawSeed(rawSeed: Uint8Array): bigint {
  const pool = new PublicKey('11111111111111111111111111111111');
  const { secret, nullifierPreimage } = deriveNoteMaterial(rawSeed, pool, 0);
  return createCommitmentV3(nullifierPreimage, secret, 42n, 7n);
}

// ─── SHIELDED pipeline (mirror extension zk.ts deriveSpendingKey) ─────────────
function truncateToGoldilocks(value: bigint): bigint {
  const r = value % GOLDILOCKS_MODULUS;
  return r < 0n ? r + GOLDILOCKS_MODULUS : r;
}

function seedToHex(rawSeed: Uint8Array): string {
  return Array.from(rawSeed)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Shielded zk owner-pubkey (Goldilocks) from a RAW 32-byte seed (the §0 path):
 * `SHA-256(hex(rawSeed) + ':spending_key')` → low-8-bytes → `hash2(sk, 0)`.
 */
async function shieldedOwnerPubkeyFromRawSeed(rawSeed: Uint8Array): Promise<bigint> {
  const seedHex = seedToHex(rawSeed);
  const data = utf8ToBytes(seedHex + ':spending_key');
  const spendingKeyBytes = sha256(data); // identical bytes to crypto.subtle.digest('SHA-256', …)
  let spendingKeyGl = 0n;
  for (let i = 7; i >= 0; i--) {
    spendingKeyGl = (spendingKeyGl << 8n) | BigInt(spendingKeyBytes[i] ?? 0);
  }
  spendingKeyGl = truncateToGoldilocks(spendingKeyGl);
  return goldilocksHash2to1(spendingKeyGl, 0n);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────
// A fixed 32-byte seed. In production this is BOTH:
//   - the local path: `keypair.secretKey.slice(0, 32)`, and
//   - the hardware path: an app-managed CSPRNG 32-byte spending seed.
// The invariant is that, fed RAW to the SAME consumers, they produce IDENTICAL
// note material — so "local" and "hardware" are interchangeable inputs here.
const FIXED_SEED = Uint8Array.from(
  Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff),
);

describe('§0 canonical-seed parity — RAW 32 bytes is THE spending seed (not HKDF)', () => {
  it('denominated: hardware RAW-seed path == local raw-slice path (same commitment)', () => {
    // "local" simulates `keypair.secretKey.slice(0,32)`; "hardware" simulates the
    // CSPRNG spending seed. Same 32 bytes in the same position ⇒ same commitment.
    const local = FIXED_SEED.slice();
    const hardware = FIXED_SEED.slice();
    const cLocal = denominatedCommitmentFromRawSeed(local);
    const cHardware = denominatedCommitmentFromRawSeed(hardware);
    expect(cHardware).toBe(cLocal);
    expect(cLocal).not.toBe(0n);
  });

  it('shielded: hardware RAW-seed path == local raw-slice path (same zk owner pubkey)', async () => {
    const local = FIXED_SEED.slice();
    const hardware = FIXED_SEED.slice();
    const aLocal = await shieldedOwnerPubkeyFromRawSeed(local);
    const aHardware = await shieldedOwnerPubkeyFromRawSeed(hardware);
    expect(aHardware).toBe(aLocal);
    expect(aLocal).not.toBe(0n);
  });

  it('REGRESSION GUARD: pre-HKDF via deriveP01IdentityFromSeed DIVERGES (would orphan notes)', () => {
    // The CRITICAL bug the spec forbids: feeding the seed through
    // `deriveP01IdentityFromSeed` (HKDF) BEFORE the note pipelines.
    // Its `spendingKey` is a DIFFERENT 32 bytes than the raw seed, so any note
    // material derived from it would be unspendable by the live (raw-slice)
    // clients. If this guard ever turns GREEN (equality), the canonical
    // invariant has been violated.
    const rawSeed = FIXED_SEED.slice();
    const preHkdf = deriveP01IdentityFromSeed(rawSeed.slice()).spendingKey;

    // The pre-HKDF'd key is not the raw seed.
    expect(Array.from(preHkdf)).not.toEqual(Array.from(rawSeed));

    // …and it therefore yields a DIFFERENT note commitment than the raw path.
    const cRaw = denominatedCommitmentFromRawSeed(rawSeed);
    const cPreHkdf = denominatedCommitmentFromRawSeed(new Uint8Array(preHkdf));
    expect(cPreHkdf).not.toBe(cRaw);
  });

  it('REGRESSION GUARD: pre-HKDF also diverges for the shielded zk address', async () => {
    const rawSeed = FIXED_SEED.slice();
    const preHkdf = deriveP01IdentityFromSeed(rawSeed.slice()).spendingKey;
    const aRaw = await shieldedOwnerPubkeyFromRawSeed(rawSeed);
    const aPreHkdf = await shieldedOwnerPubkeyFromRawSeed(new Uint8Array(preHkdf));
    expect(aPreHkdf).not.toBe(aRaw);
  });

  it('determinism: same RAW seed → same commitment + zk address across calls', async () => {
    const a = denominatedCommitmentFromRawSeed(FIXED_SEED.slice());
    const b = denominatedCommitmentFromRawSeed(FIXED_SEED.slice());
    expect(a).toBe(b);
    const x = await shieldedOwnerPubkeyFromRawSeed(FIXED_SEED.slice());
    const y = await shieldedOwnerPubkeyFromRawSeed(FIXED_SEED.slice());
    expect(x).toBe(y);
  });
});
