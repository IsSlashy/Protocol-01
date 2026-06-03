/**
 * P01 shielded-identity derivation (tiered, HKDF-based) — Privy removal, 2026-06-03.
 *
 * Produces a { spendingKey, viewingKey } pair from a wallet, with the input
 * keying material (IKM) chosen by signer kind:
 *
 *   - seed/local : IKM = ed25519 seed (secretKey[0..32))            — offline, deterministic (gold path)
 *   - software   : IKM = signMessage(IDENTITY_DOMAIN)              — deterministic ONLY for software ed25519,
 *                                                                     enforced by a twice-sign gate
 *   - hardware   : NOT derivable from a signature. Use
 *                  {@link deriveP01IdentityFromSeed} with an app-managed,
 *                  encrypted random spending seed.
 *
 * IMPORTANT (R-01, ~64-bit on-chain ceiling): downstream, only the LOW 8 BYTES
 * of `spendingKey` reach the Goldilocks circuit (`bytesToGoldilocks` reads
 * bytes[0..8)). On-chain owner identity is therefore ~64 bits regardless of the
 * 32-byte derivation, and the spend/view separation here is real at 32 bytes but
 * does NOT survive to the circuit. Never market these as 256-bit on-chain, and
 * never imply on-chain spend/view separation. See docs/privy-removal-spec.md §1.4.
 *
 * IMPORTANT (R-05, NON-INTERCHANGEABLE): this is a NEW key, distinct from the
 * legacy `deriveSpendingKeyFromSignature` (sha256(sig)). Do not swap one for the
 * other on an existing account — it orphans notes.
 *
 * No-at-rest policy (R-08): derived keys live only in the in-memory cache and are
 * zeroized on {@link clearP01Identity} / {@link clearAllP01Identities}. IKM is
 * zeroized immediately after use.
 */

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import type { Signer, WalletAdapter } from '../types';
import { PrivacyError, PrivacyErrorCode } from '../errors';
import {
  asSpendingKey,
  asViewingKey,
  type SpendingKey,
  type ViewingKey,
} from './spendingKey';
import { isKeypair } from './signer';
import {
  IDENTITY_DOMAIN,
  HKDF_SALT,
  SPEND_INFO,
  VIEW_INFO,
  IDENTITY_KEY_LENGTH,
} from './constants';

/** A derived shielded identity: a spending key and a (watch-only) viewing key. */
export interface P01Identity {
  spendingKey: SpendingKey;
  viewingKey: ViewingKey;
}

/** In-memory only, keyed by `publicKey.toBase58()`. Never persisted (R-08). */
const identityCache = new Map<string, P01Identity>();

/** Constant-ish equality for two same-message signatures (non-secret compare). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** Run the HKDF-SHA256 split over a 32-byte IKM into spend/view sub-keys. */
function hkdfIdentity(ikm: Uint8Array): P01Identity {
  const sk = hkdf(sha256, ikm, HKDF_SALT, SPEND_INFO, IDENTITY_KEY_LENGTH);
  const vk = hkdf(sha256, ikm, HKDF_SALT, VIEW_INFO, IDENTITY_KEY_LENGTH);
  return {
    spendingKey: asSpendingKey(new Uint8Array(sk)),
    viewingKey: asViewingKey(new Uint8Array(vk)),
  };
}

/**
 * Derive a P01 identity directly from 32 bytes of high-entropy seed material.
 *
 * Used for:
 *   - the local-seed gold path (ikm = `keypair.secretKey.slice(0, 32)`), and
 *   - the hardware tier (ikm = an app-managed, CSPRNG, encrypted-at-rest seed).
 *
 * Deterministic and offline. The caller owns `seed`; this function does not
 * mutate or retain it (it is copied into the HKDF input).
 */
export function deriveP01IdentityFromSeed(seed: Uint8Array): P01Identity {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) {
    throw new PrivacyError(
      PrivacyErrorCode.INVALID_CONFIG,
      `seed must be exactly 32 bytes (received ${
        seed instanceof Uint8Array ? seed.length : typeof seed
      }).`,
    );
  }
  return hkdfIdentity(seed);
}

/**
 * Derive (and cache) a P01 identity from a connected wallet.
 *
 * @param signer Keypair (`seed`) or WalletAdapter (`software` if it exposes
 *               `signMessage`, else `hardware`).
 * @param opts.cache        cache the result in memory (default: true).
 * @param opts.forceRefresh re-derive even if cached (default: false).
 *
 * @throws if the signer is `hardware` (no `signMessage`) — the app must instead
 *         call {@link deriveP01IdentityFromSeed} with its random spending seed.
 * @throws if a `software` signer is non-deterministic (twice-sign mismatch).
 */
export async function deriveP01Identity(
  signer: Signer,
  opts: { cache?: boolean; forceRefresh?: boolean } = {},
): Promise<P01Identity> {
  const useCache = opts.cache ?? true;
  const cacheKey = signer.publicKey.toBase58();

  if (useCache && !opts.forceRefresh) {
    const hit = identityCache.get(cacheKey);
    if (hit) return hit;
  }

  let ikm: Uint8Array;

  if (isKeypair(signer)) {
    // Gold path: IKM = the 32-byte ed25519 seed. Offline, deterministic,
    // portable (same BIP39 phrase → same key). A fresh copy we will zeroize.
    ikm = signer.secretKey.slice(0, 32);
  } else {
    const adapter = signer as WalletAdapter & {
      signMessage?: (msg: Uint8Array) => Promise<Uint8Array>;
    };
    if (typeof adapter.signMessage !== 'function') {
      throw new PrivacyError(
        PrivacyErrorCode.WALLET_NOT_CONNECTED,
        'This wallet cannot sign off-chain messages (hardware tier). Derive the ' +
          'identity from an app-managed random spending seed via ' +
          'deriveP01IdentityFromSeed(seed), not from a signature.',
      );
    }
    const message = utf8ToBytes(IDENTITY_DOMAIN);
    // Twice-sign determinism gate (R-04): hardware/MPC signers may hedge their
    // ed25519 nonce, yielding non-reproducible signatures that would strand
    // notes next session. Refuse to derive from such a signer.
    const sig1 = await adapter.signMessage(message);
    const sig2 = await adapter.signMessage(message);
    if (!(sig1 instanceof Uint8Array) || !(sig2 instanceof Uint8Array)) {
      throw new PrivacyError(
        PrivacyErrorCode.WALLET_NOT_CONNECTED,
        'WalletAdapter.signMessage returned a non-Uint8Array value.',
      );
    }
    if (!bytesEqual(sig1, sig2)) {
      sig1.fill(0);
      sig2.fill(0);
      throw new PrivacyError(
        PrivacyErrorCode.INVALID_CONFIG,
        'This wallet produced a non-deterministic signature (twice-signed ' +
          'message differs). Shielded identity derivation is unavailable for ' +
          'this wallet; use a seed/local wallet or the hardware random-seed tier.',
      );
    }
    sig2.fill(0);
    ikm = sig1;
  }

  const identity = hkdfIdentity(ikm);
  ikm.fill(0); // zeroize IKM immediately after use (R-08)

  if (useCache) identityCache.set(cacheKey, identity);
  return identity;
}

/**
 * Zeroize and drop one cached identity (by `publicKey.toBase58()`), or all of
 * them when called with no argument. Filling the buffers also zeroizes any
 * reference a caller still holds — intended (no secret survives a lock/logout).
 */
export function clearP01Identity(pubkey?: string): void {
  if (!pubkey) {
    clearAllP01Identities();
    return;
  }
  const id = identityCache.get(pubkey);
  if (id) {
    id.spendingKey.fill(0);
    id.viewingKey.fill(0);
    identityCache.delete(pubkey);
  }
}

/** Zeroize and drop every cached identity (call on lock/logout). */
export function clearAllP01Identities(): void {
  for (const id of identityCache.values()) {
    id.spendingKey.fill(0);
    id.viewingKey.fill(0);
  }
  identityCache.clear();
}
