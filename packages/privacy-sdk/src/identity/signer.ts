/**
 * Unified signer abstraction for the tiered wallet model (Privy removal, 2026-06-03).
 *
 * A P01 wallet can be backed by one of three signer kinds; the kind decides how
 * the shielded identity is derived (see `deriveIdentity.ts`) and must be a
 * STABLE, persisted per-account property so it can never silently flip (spec R-02).
 *
 *   - `seed`     — a local Keypair / BIP39-derived secret. Identity = HKDF over
 *                  the 32-byte ed25519 seed (offline, deterministic). Gold path.
 *   - `software` — an injected/external wallet (Phantom, Solflare, Android MWA)
 *                  exposing `signMessage`. Identity = HKDF over a deterministic
 *                  signature, guarded by a twice-sign reproducibility gate.
 *   - `hardware` — a wallet that can sign transactions but not (reliably)
 *                  off-chain messages (Ledger). It NEVER derives a long-lived
 *                  key from a signature; the app manages a random encrypted
 *                  spending seed and feeds it to `deriveP01IdentityFromSeed`.
 *
 * See docs/privy-removal-spec.md §1.2 / §0.2.
 */

import type { Keypair, PublicKey } from '@solana/web3.js';
import type { Signer, WalletAdapter } from '../types';
import { PrivacyError, PrivacyErrorCode } from '../errors';

/** The three supported wallet-signer kinds (watch-only handled at app layer). */
export type SignerKind = 'seed' | 'software' | 'hardware';

/**
 * A normalized signer: carries the resolved `kind`, a transaction signer, and
 * an optional message signer. `signMessage` is present for `seed` (synthesized
 * from the keypair) and for `software` adapters that expose it; it is absent
 * for `hardware`.
 */
export interface UnifiedSigner {
  publicKey: PublicKey;
  kind: SignerKind;
  signTransaction: (tx: any) => Promise<any>;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
}

/** Is this signer a local Keypair (has a usable 32+ byte secretKey)? */
export function isKeypair(signer: Signer): signer is Keypair {
  return (
    'secretKey' in signer &&
    (signer as Keypair).secretKey instanceof Uint8Array
  );
}

/**
 * Classify a raw {@link Signer} into a {@link SignerKind}.
 *
 * Keypair → `seed`. WalletAdapter exposing a `signMessage` function → `software`.
 * WalletAdapter without `signMessage` → `hardware`.
 */
export function classifySigner(signer: Signer): SignerKind {
  if (isKeypair(signer)) return 'seed';
  const adapter = signer as WalletAdapter & { signMessage?: unknown };
  return typeof adapter.signMessage === 'function' ? 'software' : 'hardware';
}

/**
 * Normalize a raw {@link Signer} (Keypair | WalletAdapter) into a
 * {@link UnifiedSigner}. For a Keypair, `signTransaction` duck-types between a
 * legacy `Transaction` (`partialSign`) and a `VersionedTransaction` (`sign`),
 * and `signMessage` is synthesized via deterministic ed25519.
 */
export function toUnifiedSigner(signer: Signer): UnifiedSigner {
  const kind = classifySigner(signer);

  if (isKeypair(signer)) {
    const kp = signer;
    return {
      publicKey: kp.publicKey,
      kind,
      signTransaction: async (tx: any) => {
        if (typeof tx?.partialSign === 'function') {
          tx.partialSign(kp);
        } else if (typeof tx?.sign === 'function') {
          tx.sign([kp]);
        } else {
          throw new PrivacyError(
            PrivacyErrorCode.INVALID_CONFIG,
            'Unsupported transaction type for a Keypair signer.',
          );
        }
        return tx;
      },
      signMessage: async (message: Uint8Array) => {
        const { ed25519 } = await import('@noble/curves/ed25519.js');
        return ed25519.sign(message, kp.secretKey.slice(0, 32));
      },
    };
  }

  const adapter = signer as WalletAdapter & {
    signMessage?: (m: Uint8Array) => Promise<Uint8Array>;
  };
  return {
    publicKey: adapter.publicKey,
    kind,
    signTransaction: (tx: any) => adapter.signTransaction(tx),
    signMessage: adapter.signMessage
      ? (m: Uint8Array) => adapter.signMessage!(m)
      : undefined,
  };
}
