/**
 * Goldilocks field helpers — conversions, packing, randomness.
 *
 * Mirrors the helpers in `apps/mobile/services/zk/index.ts` (lines 107–196)
 * so that bytes flowing between the SDK and the mobile/extension clients
 * produce identical on-chain commitments and nullifiers.
 */

import { GOLDILOCKS_MODULUS, goldilocksHash2to1 } from './goldilocks-poseidon';

/** Reduce an arbitrary bigint into [0, p) where p = 2^64 - 2^32 + 1. */
export function truncateToGoldilocks(value: bigint): bigint {
  const r = value % GOLDILOCKS_MODULUS;
  return r < 0n ? r + GOLDILOCKS_MODULUS : r;
}

/**
 * Treat the first 8 bytes of the input as a little-endian u64 and reduce mod
 * Goldilocks. Any trailing bytes are ignored. This mirrors how on-chain code
 * interprets 32-byte pubkey/mint inputs for circuit public inputs (bytes 0..8
 * as the Goldilocks element, 8..32 expected to be zero).
 */
export function bytesToGoldilocks(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[i] ?? 0);
  }
  return truncateToGoldilocks(v);
}

/**
 * Pack a Goldilocks u64 into a 32-byte buffer:
 *   bytes[0..8]  = u64 little-endian
 *   bytes[8..32] = 0
 * This is the canonical on-chain commitment / root / nullifier layout.
 */
export function packGoldilocksU64(n: bigint): Uint8Array {
  const g = truncateToGoldilocks(n);
  const bytes = new Uint8Array(32);
  let temp = g;
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number(temp & 0xffn);
    temp >>= 8n;
  }
  return bytes;
}

/**
 * Convert a Solana PublicKey's raw 32 bytes to a Goldilocks element using the
 * low-8-bytes-LE convention above. Use this when you need the "mint field" or
 * similar pubkey-derived Goldilocks input for circuit 5 (transfer).
 */
export function pubkeyBytesToGoldilocks(pubkeyBytes: Uint8Array): bigint {
  return bytesToGoldilocks(pubkeyBytes);
}

/**
 * Environment-agnostic CSPRNG: returns an 8-byte little-endian Goldilocks
 * element. Uses `globalThis.crypto.getRandomValues` (available in browsers,
 * Node 20+, React Native via `expo-crypto` polyfill, and Bun).
 */
export function randomGoldilocksU64(): bigint {
  const getRandom = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto);
  if (!getRandom) {
    throw new Error(
      'privacy-sdk: globalThis.crypto.getRandomValues is unavailable. ' +
      'Polyfill `crypto.getRandomValues` before instantiating PrivacySDK.',
    );
  }
  const bytes = new Uint8Array(8);
  getRandom(bytes);
  let v = 0n;
  for (let i = 7; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[i]!);
  }
  return truncateToGoldilocks(v);
}

/**
 * Build a circuit-5-compatible note commitment:
 *   commitment = hash2(hash2(amount, randomness), hash2(ownerPubkeyGl, tokenMintGl))
 *
 * `ownerPubkeyGl` MUST be `hash2(spending_key_gl, 0)` — exactly what circuit 5
 * reconstructs in cycle 0. All inputs must already be Goldilocks elements.
 */
export function computeGoldilocksCommitment(
  amountGl: bigint,
  ownerPubkeyGl: bigint,
  randomnessGl: bigint,
  tokenMintGl: bigint,
): bigint {
  const leftHash = goldilocksHash2to1(amountGl, randomnessGl);
  const rightHash = goldilocksHash2to1(ownerPubkeyGl, tokenMintGl);
  return goldilocksHash2to1(leftHash, rightHash);
}

/**
 * Compute a Goldilocks nullifier: `hash2(commitment, ownerPubkeyGl)`.
 * Matches circuit 5's `nullifier = Poseidon(commitment, owner)`.
 */
export function computeGoldilocksNullifier(
  commitmentGl: bigint,
  ownerPubkeyGl: bigint,
): bigint {
  return goldilocksHash2to1(commitmentGl, ownerPubkeyGl);
}
