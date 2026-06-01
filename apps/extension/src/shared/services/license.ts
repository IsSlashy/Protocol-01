/**
 * Protocol 01 subscription license keys.
 *
 * A license key is the anonymous, copy-pasteable credential a user hands to a
 * merchant after subscribing (Standard or ZK). It encodes only what the merchant
 * needs to VERIFY the subscription on-chain — never the user's wallet or any PII:
 *
 *   packed = [version:1][mode:1][retailer:32][subscriberId:32]   (66 bytes)
 *   key    = "p01lic_" + base64url(packed)
 *
 * `subscriberId` is the on-chain subscription identity:
 *   - ZK Private  → the vault's `subscriber_commitment` (a Goldilocks hash of a
 *                   secret only the user holds — NOT linkable to their wallet).
 *   - Standard    → the subscriber wallet pubkey (Standard is 0% privacy by design).
 *
 * The merchant (via @protocol-01/merchant-sdk `verifyLicenseKey`) looks up the
 * matching `SubscriptionVault`, confirms `retailer == self` and `is_active`,
 * then provisions an EPHEMERAL account keyed by `ephemeralAccountId(key)` —
 * a one-way hash of the subscriber id. No email, no wallet, no trace: the
 * merchant only ever sees an opaque, payment-backed handle.
 *
 * Note: the key carries on-chain-public data, so it is an IDENTIFIER, not a
 * secret. Its privacy guarantee is that for a ZK subscription the identifier
 * (a commitment) cannot be tied back to the paying wallet. Bearer-grade secrecy
 * (so a leaked key can't be replayed by a third party) is a future upgrade —
 * see [[stealth-view-spend-coupling]] for the same view/spend trade-off.
 */

import { PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';

const PREFIX = 'p01lic_';
const VERSION = 1;
const PACKED_LEN = 66;

export type LicenseMode = 'standard' | 'zk';

// ---------------------------------------------------------------------------
// base64url (browser-safe; the merchant SDK mirrors this with Buffer)
// ---------------------------------------------------------------------------

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

export interface ParsedLicense {
  version: number;
  mode: LicenseMode;
  retailer: PublicKey;
  subscriberId: Uint8Array; // 32 bytes
}

/** Encode a license key from the on-chain subscription identity. */
export function buildLicenseKey(params: {
  retailer: PublicKey | string;
  subscriberId: Uint8Array;
  mode: LicenseMode;
}): string {
  const retailer =
    typeof params.retailer === 'string' ? new PublicKey(params.retailer) : params.retailer;
  if (params.subscriberId.length !== 32) {
    throw new Error('subscriberId must be exactly 32 bytes');
  }
  const packed = new Uint8Array(PACKED_LEN);
  packed[0] = VERSION;
  packed[1] = params.mode === 'zk' ? 1 : 0;
  packed.set(retailer.toBytes(), 2);
  packed.set(params.subscriberId, 34);
  return PREFIX + bytesToBase64Url(packed);
}

/** Decode + validate a license key. Throws on malformed input. */
export function parseLicenseKey(key: string): ParsedLicense {
  const trimmed = key.trim();
  if (!trimmed.startsWith(PREFIX)) throw new Error('not a Protocol 01 license key');
  const packed = base64UrlToBytes(trimmed.slice(PREFIX.length));
  if (packed.length !== PACKED_LEN) throw new Error('malformed license key');
  return {
    version: packed[0],
    mode: packed[1] === 1 ? 'zk' : 'standard',
    retailer: new PublicKey(packed.slice(2, 34)),
    subscriberId: packed.slice(34, 66),
  };
}

/**
 * Deterministic, PII-free account handle the merchant keys its ephemeral
 * account on. One-way (sha256) so the merchant cannot recover the subscriber
 * id, and stable so the same license always maps to the same account.
 */
export function ephemeralAccountId(key: string): string {
  const { subscriberId } = parseLicenseKey(key);
  const h = sha256(subscriberId);
  return Array.from(h.slice(0, 12))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
