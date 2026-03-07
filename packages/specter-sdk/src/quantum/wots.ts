/**
 * Winternitz One-Time Signature (WOTS+) client-side implementation
 *
 * Quantum-safe hash-based signatures using SHA-256. Each key signs exactly
 * one message. After signing, the key MUST be rotated.
 *
 * Parameters:
 *   - w = 16 (Winternitz parameter: 4 bits per chain)
 *   - n = 32 (SHA-256 output size)
 *   - chains = 32 (one per nibble of the 128-bit message hash)
 *
 * Security:
 *   - 128-bit classical (SHA-256 preimage)
 *   - ~112-bit quantum (Grover halves hash security)
 */

import { sha256 } from '@noble/hashes/sha256';

// ── Constants ─────────────────────────────────────────────────────

export const WOTS_CHAINS = 32;
export const WOTS_W = 16; // w=16: nibble-based
export const WOTS_MAX_VAL = WOTS_W - 1; // 15
export const HASH_SIZE = 32;
export const WOTS_SIG_SIZE = WOTS_CHAINS * HASH_SIZE; // 1024 bytes
export const WOTS_PUBKEY_SIZE = WOTS_CHAINS * HASH_SIZE; // 1024 bytes

// ── Types ─────────────────────────────────────────────────────────

export interface WotsKeypair {
  /** Secret key: 32 chain secrets (each 32 bytes) */
  secretKey: Uint8Array; // 1024 bytes
  /** Public key: 32 chain endpoints (each 32 bytes) */
  publicKey: Uint8Array; // 1024 bytes
  /** SHA-256 hash of public key (stored on-chain) */
  publicKeyHash: Uint8Array; // 32 bytes
}

export interface WotsSignature {
  /** 32 chain values (each 32 bytes) */
  signature: Uint8Array; // 1024 bytes
  /** The full public key (needed for on-chain verification) */
  publicKey: Uint8Array; // 1024 bytes
}

// ── Key Generation ────────────────────────────────────────────────

/**
 * Generate a WOTS+ keypair from a seed.
 *
 * The seed should be derived deterministically from the user's master secret
 * and a key index, so keypairs can be regenerated if needed:
 *   seed = HKDF(master_secret, info="wots-key-" + index)
 */
export function generateWotsKeypair(seed: Uint8Array): WotsKeypair {
  if (seed.length < 32) {
    throw new Error('WOTS+ seed must be at least 32 bytes');
  }

  const secretKey = new Uint8Array(WOTS_CHAINS * HASH_SIZE);
  const publicKey = new Uint8Array(WOTS_CHAINS * HASH_SIZE);

  for (let i = 0; i < WOTS_CHAINS; i++) {
    // Derive chain secret: SHA-256(seed || chain_index)
    const indexBuf = new Uint8Array(4);
    new DataView(indexBuf.buffer).setUint32(0, i, true);
    const chainSecret = new Uint8Array(sha256(concatBytes(seed, indexBuf)));
    secretKey.set(chainSecret, i * HASH_SIZE);

    // Compute chain endpoint: hash^15(chain_secret)
    let current: Uint8Array = chainSecret;
    for (let step = 0; step < WOTS_MAX_VAL; step++) {
      current = new Uint8Array(sha256(current));
    }
    publicKey.set(current, i * HASH_SIZE);
  }

  // Public key hash = SHA-256(all chain endpoints concatenated)
  const publicKeyHash = new Uint8Array(sha256(publicKey));

  return { secretKey, publicKey, publicKeyHash };
}

// ── Signing ───────────────────────────────────────────────────────

/**
 * Sign a message with a WOTS+ keypair.
 *
 * CRITICAL: Each keypair MUST only sign ONE message. After signing, the
 * secret key should be securely erased and the vault's public key rotated.
 *
 * @param message - The message hash to sign (32 bytes, pre-hashed)
 * @param keypair - The WOTS+ keypair
 * @returns The signature (1024 bytes) + public key (1024 bytes)
 */
export function wotsSign(message: Uint8Array, keypair: WotsKeypair): WotsSignature {
  if (message.length !== 32) {
    throw new Error('Message must be exactly 32 bytes (pre-hashed)');
  }

  const signature = new Uint8Array(WOTS_CHAINS * HASH_SIZE);

  for (let i = 0; i < WOTS_CHAINS; i++) {
    // Extract nibble from message
    const byteIdx = Math.floor(i / 2);
    const byte = message[byteIdx]!;
    const nibble = i % 2 === 0 ? (byte >> 4) & 0x0f : byte & 0x0f;

    // Signature value = hash^(15 - nibble)(secret_i)
    const stepsToHash = WOTS_MAX_VAL - nibble;
    let current: Uint8Array = keypair.secretKey.slice(i * HASH_SIZE, (i + 1) * HASH_SIZE);

    for (let step = 0; step < stepsToHash; step++) {
      current = new Uint8Array(sha256(current));
    }

    signature.set(current, i * HASH_SIZE);
  }

  return {
    signature,
    publicKey: keypair.publicKey,
  };
}

// ── Verification ──────────────────────────────────────────────────

/**
 * Verify a WOTS+ signature (client-side, mirrors on-chain logic).
 *
 * For each chain i:
 *   hash^(nibble_i)(signature_i) must equal publicKey_i
 */
export function wotsVerify(
  message: Uint8Array,
  sig: WotsSignature,
  publicKeyHash: Uint8Array
): boolean {
  if (message.length !== 32) return false;
  if (sig.signature.length !== WOTS_SIG_SIZE) return false;
  if (sig.publicKey.length !== WOTS_PUBKEY_SIZE) return false;

  // Verify public key hash
  const computedHash = new Uint8Array(sha256(sig.publicKey));
  if (!constantTimeEqual(computedHash, publicKeyHash)) return false;

  // Verify each chain
  for (let i = 0; i < WOTS_CHAINS; i++) {
    const byteIdx = Math.floor(i / 2);
    const byte = message[byteIdx]!;
    const nibble = i % 2 === 0 ? (byte >> 4) & 0x0f : byte & 0x0f;

    let current: Uint8Array = sig.signature.slice(i * HASH_SIZE, (i + 1) * HASH_SIZE);
    for (let step = 0; step < nibble; step++) {
      current = new Uint8Array(sha256(current));
    }

    const expected = sig.publicKey.slice(i * HASH_SIZE, (i + 1) * HASH_SIZE);
    if (!constantTimeEqual(current, expected)) return false;
  }

  return true;
}

// ── Withdrawal Message ────────────────────────────────────────────

/**
 * Compute the message hash for a Winternitz vault withdrawal.
 * Must match the on-chain computation exactly:
 *   SHA-256(amount_le || destination_pubkey || withdrawal_count_le)
 */
export function computeWithdrawMessage(
  amount: bigint,
  destination: Uint8Array, // 32-byte pubkey
  withdrawalCount: bigint
): Uint8Array {
  const amountBuf = new Uint8Array(8);
  new DataView(amountBuf.buffer).setBigUint64(0, amount, true);

  const countBuf = new Uint8Array(8);
  new DataView(countBuf.buffer).setBigUint64(0, withdrawalCount, true);

  return new Uint8Array(sha256(concatBytes(amountBuf, destination, countBuf)));
}

// ── Key Chain Management ──────────────────────────────────────────

/**
 * Derive a deterministic WOTS+ keypair for a given index.
 *
 * Usage pattern:
 *   - Key 0: initial vault key
 *   - Key 1: provided as next_wots_pubkey_hash during first withdrawal
 *   - Key N: provided as next_wots_pubkey_hash during Nth withdrawal
 *
 * The master seed should be the user's spending key or a derivative of it.
 */
export function deriveWotsKeypair(masterSeed: Uint8Array, index: number): WotsKeypair {
  const indexBuf = new Uint8Array(4);
  new DataView(indexBuf.buffer).setUint32(0, index, true);

  // Derive per-index seed: SHA-256("wots-key" || masterSeed || index)
  const keySeed = new Uint8Array(sha256(
    concatBytes(new TextEncoder().encode('wots-key'), masterSeed, indexBuf)
  ));

  return generateWotsKeypair(keySeed);
}

// ── Helpers ───────────────────────────────────────────────────────

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}
