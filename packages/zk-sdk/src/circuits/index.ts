/**
 * Circuit utilities for ZK operations — Goldilocks edition.
 *
 * Implements Goldilocks-Poseidon (t=3, x^7 S-box, 30 full rounds) used by
 * the STARK circuits 5 (transfer) and 6 (merkle_update). The hash functions
 * here are byte-for-byte identical to:
 *
 *   - `packages/privacy-sdk/src/crypto/goldilocks-poseidon.ts`
 *   - `apps/mobile/services/zk/goldilocks-poseidon.ts`
 *   - `stark/src/poseidon/{mod,constants}.rs`
 *
 * Any drift breaks on-chain verification, so the constants are kept in sync
 * via the parity tests in privacy-sdk (`P1.5`). Do NOT edit them here.
 */

import { poseidon1, poseidon2, poseidon3, poseidon4 } from 'poseidon-lite';
import { FIELD_MODULUS } from '../constants';

// ─── Goldilocks-Poseidon (t=3, x^7, 30 rounds) ───────────────────────────────

const P = FIELD_MODULUS;

function mod(v: bigint): bigint {
  const r = v % P;
  return r < 0n ? r + P : r;
}

function gadd(a: bigint, b: bigint): bigint {
  return mod(a + b);
}

function gmul(a: bigint, b: bigint): bigint {
  return mod(a * b);
}

function sbox(x: bigint): bigint {
  const x2 = gmul(x, x);
  const x4 = gmul(x2, x2);
  const x3 = gmul(x2, x);
  return gmul(x4, x3);
}

const ROUND_CONSTANTS_T3: readonly bigint[] = [
  0xa98e4673f9036e0bn, 0x3db4a488e825c32an, 0x60de653e0ed43e20n,
  0x8b4f0d2b6ea19313n, 0x2f97e83e60e2c4ddn, 0xacea6e9af6c2c725n,
  0xd5604eef12e3cabcn, 0x1eb9db12a1e71b79n, 0x7ad5966d3a790d0dn,
  0xbfae604e2c72e1d9n, 0x5fa21f2143c2f72an, 0xc3ae00cf4d83d5b8n,
  0x9e8d1423cd728e2fn, 0x45d8e40e789c13abn, 0x6b9e0d183d0b0e71n,
  0x8a15b14c28d50c0an, 0xd1eef5afe2c45c82n, 0x3c914bfff61cc9d3n,
  0xf7d2a1f9ab51e8c4n, 0x2e4d3b16c89f0a55n, 0xb8f0e1d7a3c24b96n,
  0x5169e0d4f3812c47n, 0x0af31e8bc2d57698n, 0x94b6e123d8f40c49n,
  0xe2c9f5670ab18d3an, 0x7b30e894f1d26c0bn, 0x14a3d7c6e810fb5cn,
  0xad76e0b1f934ca0dn, 0x46d9e3825c01a9ben, 0xe01c67da3f24586fn,
  0x799fe120d347b680n, 0x12028bcda6f0e531n, 0xab45c7feb9132482n,
  0x4468e041dc360373n, 0xdd8bf16e0f590264n, 0x76aee291325c0155n,
  0x0fd1d3b465bf0046n, 0xa804e4c798020f37n, 0x4127f5ea0b256e28n,
  0xda4ae60d3e480d19n, 0x736dd73071bb4c0an, 0x0c90c8439ede8afbn,
  0xa5c3d966d2019becn, 0x3ef6ea89050490ddn, 0xd829fb0c382b5fcen,
  0x715d0c2f6b4e7ebfn, 0x0a801d528a719db0n, 0xa3b32e75bdb4bca1n,
  0x3ce63f98f0d7db92n, 0xd6194abd2400fa83n, 0x6f4c5be057241974n,
  0x087f6ce38a473865n, 0xa1a27e06bd6a5756n, 0x3ad58f29f08d7647n,
  0xd408a04d239067b8n, 0x6d3bb170568340a9n, 0x066ed293899c5f9an,
  0x9fa1e3b6bcbf7e8bn, 0x38d4f4d9efe29d7cn, 0xd20805fd13057c6dn,
  0x6b3b17202a282b5en, 0x046e2843540b4a4fn, 0x9da13966872e6940n,
  0x36d44a89ba516831n, 0xcf075bacfd745722n, 0x683a6cd020574613n,
  0x016d7df353ba3504n, 0x9aa08f1686dd13f5n, 0x33d3a039b90032e6n,
  0xcd06b15cec6351d7n, 0x6639c28019a670c8n, 0xff6cd3a34cc94fb9n,
  0x989fe4c67fec6eaan, 0x31d2f5e9b30f4d9bn, 0xcb060d0ce6326c8cn,
  0x6439180fe231ab7dn, 0xfd6c29261546ca6en, 0x969f3a84487be95fn,
  0x2fd24ac7b8c50850n, 0xc90555eaeb981741n, 0x62386b17de5c3632n,
  0xfb5b7448e86c4523n, 0x94ae8524217f3414n, 0x2dd19647549a2305n,
  0xc6f4a76a879d01f6n, 0x5f17b18dbac0e0e7n, 0xf83acbb0ede3bfd8n,
  0x915ddc43210c9ec9n, 0x2a80ed66544fbdban, 0xc3a3fe8987b2bcabn,
];

const NUM_ROUNDS = 30;

function mdsMultiplyT3(state: [bigint, bigint, bigint]): void {
  // MDS = circulant [[3,1,1],[1,3,1],[1,1,3]]
  const [s0, s1, s2] = state;
  const r0 = gadd(gadd(gmul(3n, s0), s1), s2);
  const r1 = gadd(gadd(s0, gmul(3n, s1)), s2);
  const r2 = gadd(gadd(s0, s1), gmul(3n, s2));
  state[0] = r0;
  state[1] = r1;
  state[2] = r2;
}

function poseidonPermutationT3(state: [bigint, bigint, bigint]): [bigint, bigint, bigint] {
  state[0] = mod(state[0]);
  state[1] = mod(state[1]);
  state[2] = mod(state[2]);

  for (let round = 0; round < NUM_ROUNDS; round++) {
    state[0] = gadd(state[0], ROUND_CONSTANTS_T3[round * 3 + 0]!);
    state[1] = gadd(state[1], ROUND_CONSTANTS_T3[round * 3 + 1]!);
    state[2] = gadd(state[2], ROUND_CONSTANTS_T3[round * 3 + 2]!);
    state[0] = sbox(state[0]);
    state[1] = sbox(state[1]);
    state[2] = sbox(state[2]);
    mdsMultiplyT3(state);
  }
  return state;
}

/**
 * Goldilocks-Poseidon `hash2` — `H(a, b)`. Mirrors `goldilocksHash2to1` from
 * privacy-sdk and the Rust reference. Use this as the building block for
 * commitments, nullifiers, and Merkle parent hashes.
 */
export function goldilocksHash2to1(a: bigint, b: bigint): bigint {
  const state: [bigint, bigint, bigint] = [mod(a), mod(b), 0n];
  poseidonPermutationT3(state);
  return state[0];
}

/**
 * Goldilocks-Poseidon `hash1` — `H(x)` (single-input domain).
 */
export function goldilocksHash1(x: bigint): bigint {
  const state: [bigint, bigint, bigint] = [mod(x), 0n, 0n];
  poseidonPermutationT3(state);
  return state[0];
}

/**
 * Export field modulus
 */
export { FIELD_MODULUS };

// ─── Hash dispatchers ────────────────────────────────────────────────────────

/**
 * Generic Poseidon hash dispatcher (Goldilocks). Folds the inputs through
 * `goldilocksHash2to1` in a balanced binary tree — identical layout to
 * `computeCommitmentHash` in privacy-sdk.
 *
 * @param inputs Array of field elements (bigint or number). Must be non-empty.
 * @returns Hash as bigint reduced mod Goldilocks.
 * @throws If inputs array is empty or not provided
 */
export async function poseidonHash(inputs: (bigint | number)[]): Promise<bigint> {
  if (!inputs || inputs.length === 0) {
    throw new Error(
      'poseidonHash: inputs array must be non-empty. ' +
      'Provide at least one field element to hash.'
    );
  }

  const reduced = inputs.map(x => mod(BigInt(x)));

  if (reduced.length === 1) return goldilocksHash1(reduced[0]!);
  if (reduced.length === 2) return goldilocksHash2to1(reduced[0]!, reduced[1]!);

  // Balanced binary tree fold for >2 inputs.
  let layer = reduced;
  while (layer.length > 1) {
    const next: bigint[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const right = i + 1 < layer.length ? layer[i + 1]! : 0n;
      next.push(goldilocksHash2to1(layer[i]!, right));
    }
    layer = next;
  }
  return layer[0]!;
}

/**
 * Synchronous Goldilocks Poseidon hash. The Goldilocks implementation has
 * no async initialization step (unlike the old circomlibjs path), so this
 * is just a thin sync wrapper that mirrors `poseidonHash`.
 */
export function poseidonHashLite(inputs: (bigint | number)[]): bigint {
  if (!inputs || inputs.length === 0) {
    throw new Error(
      'poseidonHashLite: inputs array must be non-empty. ' +
      'Provide at least one field element to hash.'
    );
  }

  const reduced = inputs.map(x => mod(BigInt(x)));

  if (reduced.length === 1) return goldilocksHash1(reduced[0]!);
  if (reduced.length === 2) return goldilocksHash2to1(reduced[0]!, reduced[1]!);

  let layer = reduced;
  while (layer.length > 1) {
    const next: bigint[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const right = i + 1 < layer.length ? layer[i + 1]! : 0n;
      next.push(goldilocksHash2to1(layer[i]!, right));
    }
    layer = next;
  }
  return layer[0]!;
}

/**
 * BN254 Poseidon (poseidon-lite) — kept ONLY for the legacy viewing-key
 * code path in `keys/viewKeys.ts`. New code must NOT use this.
 *
 * @internal
 */
export function poseidonHashBn254Lite(inputs: (bigint | number)[]): bigint {
  if (!inputs || inputs.length === 0) {
    throw new Error('poseidonHashBn254Lite: inputs array must be non-empty.');
  }
  const bigInputs = inputs.map(x => BigInt(x));
  switch (bigInputs.length) {
    case 1: return poseidon1(bigInputs);
    case 2: return poseidon2(bigInputs);
    case 3: return poseidon3(bigInputs);
    case 4: return poseidon4(bigInputs);
    default:
      throw new Error(
        `poseidonHashBn254Lite: unsupported input length ${bigInputs.length}. ` +
        'poseidon-lite supports 1-4 inputs.'
      );
  }
}

// ─── Commitment / nullifier / key helpers ───────────────────────────────────

/**
 * Goldilocks note commitment matching circuit 5 (transfer):
 *
 *   commitment = hash2(hash2(amount, randomness), hash2(ownerPubkey, tokenMint))
 *
 * `ownerPubkey` MUST already be the circuit-5 owner identity (i.e.
 * `hash2(spending_key, 0)`). All inputs are reduced mod Goldilocks.
 */
export async function computeCommitment(
  amount: bigint,
  ownerPubkey: bigint,
  randomness: bigint,
  tokenMint: bigint
): Promise<bigint> {
  if (amount === undefined || amount === null) {
    throw new Error('computeCommitment: amount is required.');
  }
  if (ownerPubkey === undefined || ownerPubkey === null) {
    throw new Error('computeCommitment: ownerPubkey is required.');
  }
  if (randomness === undefined || randomness === null) {
    throw new Error('computeCommitment: randomness is required.');
  }
  if (tokenMint === undefined || tokenMint === null) {
    throw new Error('computeCommitment: tokenMint is required.');
  }

  return computeGoldilocksCommitment(amount, ownerPubkey, randomness, tokenMint);
}

/**
 * Synchronous variant of {@link computeCommitment}. Provided alongside the
 * async version for back-compat with tests that mock this name; the
 * Goldilocks implementation is fully synchronous.
 */
export function computeGoldilocksCommitment(
  amount: bigint,
  ownerPubkey: bigint,
  randomness: bigint,
  tokenMint: bigint
): bigint {
  const left = goldilocksHash2to1(mod(amount), mod(randomness));
  const right = goldilocksHash2to1(mod(ownerPubkey), mod(tokenMint));
  return goldilocksHash2to1(left, right);
}

/**
 * Goldilocks nullifier matching circuit 5: `nullifier = hash2(commitment, owner)`.
 * Note: BN254 used `hash2(commitment, spending_key_hash)` — the Goldilocks
 * variant binds to the OWNER identity directly (cycle-0 derivation) since
 * the spending key never crosses the proof boundary in plaintext.
 */
export async function computeNullifier(
  commitment: bigint,
  ownerPubkey: bigint
): Promise<bigint> {
  if (commitment === undefined || commitment === null) {
    throw new Error('computeNullifier: commitment is required.');
  }
  if (ownerPubkey === undefined || ownerPubkey === null) {
    throw new Error('computeNullifier: ownerPubkey is required.');
  }

  return computeGoldilocksNullifier(commitment, ownerPubkey);
}

/**
 * Synchronous variant of {@link computeNullifier}.
 */
export function computeGoldilocksNullifier(
  commitment: bigint,
  ownerPubkey: bigint
): bigint {
  return goldilocksHash2to1(mod(commitment), mod(ownerPubkey));
}

/**
 * Derive the circuit-5 owner identity from a Goldilocks-reduced spending key:
 *   owner_pubkey = hash2(spending_key_gl, 0)
 *
 * This matches the cycle-0 derivation performed inside the circuit trace.
 */
export async function deriveOwnerPubkey(spendingKey: bigint): Promise<bigint> {
  return goldilocksHash2to1(mod(spendingKey), 0n);
}

/**
 * Compute the legacy "spending key hash" used by BN254 nullifiers. Kept for
 * symmetry with the previous SDK shape — Goldilocks circuits do NOT use
 * this; nullifiers bind to `ownerPubkey` directly. Domain tag 1 mirrors
 * the privacy-sdk convention.
 *
 * @deprecated Use {@link computeNullifier} with the owner pubkey directly.
 */
export async function computeSpendingKeyHash(spendingKey: bigint): Promise<bigint> {
  return goldilocksHash2to1(mod(spendingKey), 1n);
}

// ─── Field <-> bytes helpers (Goldilocks layout) ─────────────────────────────

/**
 * Convert a 32-byte buffer to a Goldilocks element. Reads bytes 0..8 as a
 * little-endian u64 and reduces mod Goldilocks. Bytes 8..32 are ignored —
 * this matches the on-chain layout where commitment / nullifier / root
 * bytes are `u64_le | [0; 24]`.
 */
export function bytesToField(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[i] ?? 0);
  }
  return mod(v);
}

/**
 * Pack a Goldilocks element into a 32-byte buffer:
 *   bytes[0..8]  = u64 little-endian
 *   bytes[8..32] = 0
 */
export function fieldToBytes(field: bigint): Uint8Array {
  const g = mod(field);
  const bytes = new Uint8Array(32);
  let v = g;
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

/**
 * Generate a random Goldilocks field element (8 random bytes, reduced mod p).
 */
export function randomFieldElement(): bigint {
  const getRandom = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto);
  if (!getRandom) {
    throw new Error(
      'randomFieldElement: globalThis.crypto.getRandomValues is unavailable. ' +
      'Polyfill `crypto.getRandomValues` before calling.'
    );
  }
  const bytes = new Uint8Array(8);
  getRandom(bytes);
  let v = 0n;
  for (let i = 7; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[i]!);
  }
  return mod(v);
}

/**
 * Convert a Solana public key to a Goldilocks element (low 8 bytes LE,
 * reduced mod Goldilocks). Matches the on-chain `tokenMint -> Goldilocks`
 * convention used by circuit 5.
 */
export function pubkeyToField(pubkey: Uint8Array): bigint {
  return bytesToField(pubkey);
}
