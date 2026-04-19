/**
 * Spending-key identity primitives (P11.D decision, 2026-04-18).
 *
 * `PrivacySDK` requires a caller-supplied 32-byte `spendingKey`. The SDK
 * ships `deriveSpendingKeyFromSignature(signer, { domain })` as a safe
 * default ceremony integrators can opt into, but never derives one
 * implicitly.
 *
 * Rationale:
 *   - Hashing the wallet pubkey is insecure (links all stealth payments).
 *   - Forcing a single async derivation ceremony in the SDK would break
 *     integrators who use hardware wallets, seed-derived keys, or
 *     user-imported keys.
 *   - The branded type prevents accidentally passing a `PublicKey.toBytes()`
 *     (which type-checks as `Uint8Array`) through the constructor.
 */

import type { Signer, WalletAdapter } from '../types';
import type { Keypair } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { PrivacyError, PrivacyErrorCode } from '../errors';

/**
 * Branded 32-byte spending key. Construct with {@link asSpendingKey} or
 * {@link deriveSpendingKeyFromSignature}. Do not cast from a raw `Uint8Array`.
 */
export type SpendingKey = Uint8Array & { readonly __brand: 'SpendingKey' };

/** Canonical SDK domain string for the signed-message ceremony. */
export const SPENDING_KEY_DOMAIN = 'protocol01:spending_key:v1' as const;

/**
 * Wrap a 32-byte buffer as a {@link SpendingKey}. Throws if the length is
 * wrong; the resulting object shares memory with the input, so the caller
 * should not mutate the buffer afterwards.
 */
export function asSpendingKey(bytes: Uint8Array): SpendingKey {
  if (!(bytes instanceof Uint8Array)) {
    throw new PrivacyError(
      PrivacyErrorCode.INVALID_CONFIG,
      'spendingKey must be a Uint8Array of 32 bytes.',
    );
  }
  if (bytes.length !== 32) {
    throw new PrivacyError(
      PrivacyErrorCode.INVALID_CONFIG,
      `spendingKey must be exactly 32 bytes (received ${bytes.length}).`,
    );
  }
  return bytes as SpendingKey;
}

/**
 * Internal: is this a Keypair (has `secretKey`) rather than a WalletAdapter?
 */
function isKeypair(signer: Signer): signer is Keypair {
  return 'secretKey' in signer && signer.secretKey instanceof Uint8Array;
}

/**
 * Derive a 32-byte spending key from a wallet signature over a fixed,
 * domain-separated message.
 *
 * Flow:
 *   1. `message = utf8(domain)`                       (default: `protocol01:spending_key:v1`)
 *   2. `signature = signer.signMessage(message)`      — for WalletAdapters
 *      `signature = ed25519.sign(signer.secretKey, message)` — for Keypairs
 *   3. `spendingKey = sha256(signature)`
 *
 * This yields a deterministic key that lives only in memory (not on-chain),
 * so the same user can reproduce their spending key across devices/apps by
 * re-signing the same message — making shielded notes created in app A
 * spendable in app B.
 *
 * Integrators who want a different derivation (hardware-wallet-backed, seed-
 * derived, user-imported) can skip this helper entirely and construct the
 * {@link SpendingKey} themselves via {@link asSpendingKey}.
 */
export async function deriveSpendingKeyFromSignature(
  signer: Signer,
  options: { domain?: string } = {},
): Promise<SpendingKey> {
  const domain = options.domain ?? SPENDING_KEY_DOMAIN;
  const message = utf8ToBytes(domain);

  let signature: Uint8Array;

  if (isKeypair(signer)) {
    // Keypair path — dynamic import so the SDK doesn't pull @noble/curves
    // into environments that never use this helper.
    const { ed25519 } = await import('@noble/curves/ed25519.js');
    const secretKey = signer.secretKey.slice(0, 32);
    signature = ed25519.sign(message, secretKey);
  } else {
    // WalletAdapter path — most adapters expose signMessage(message).
    const adapter = signer as WalletAdapter & {
      signMessage?: (msg: Uint8Array) => Promise<Uint8Array>;
    };
    if (typeof adapter.signMessage !== 'function') {
      throw new PrivacyError(
        PrivacyErrorCode.WALLET_NOT_CONNECTED,
        'WalletAdapter does not expose signMessage. Derive the spending key ' +
        'off-SDK and pass it to `new PrivacySDK({ spendingKey })` directly.',
      );
    }
    signature = await adapter.signMessage(message);
    if (!(signature instanceof Uint8Array)) {
      throw new PrivacyError(
        PrivacyErrorCode.WALLET_NOT_CONNECTED,
        'WalletAdapter.signMessage returned a non-Uint8Array value.',
      );
    }
  }

  const digest = sha256(signature);
  return asSpendingKey(new Uint8Array(digest));
}
