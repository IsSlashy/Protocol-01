/**
 * License key derivation for subscriptions — commitment scheme.
 *
 * EXACT mirror of `apps/mobile/services/license/derive.ts` and
 * `packages/merchant-sdk/src/license.ts`. The extension MUST produce the same
 * key + commitment byte-for-byte so a key generated here verifies on the
 * merchant side (`verifyLicenseKey` recomputes `blake3(decode(key))` and matches
 * it to the on-chain `SubscriptionVault.license_commitment`).
 *
 * ## The scheme (no shared secret, no on-chain hashing)
 *
 * The license key shown to the user encodes a per-subscriber 128-bit
 * `licenseSecret`. At subscribe time the client posts ONLY the
 * `blake3(licenseSecret)` commitment on-chain (stored verbatim — the chain never
 * hashes/verifies). Later the subscriber presents the key (= the preimage); the
 * merchant recomputes `blake3(decode(key))` and matches it to the commitment.
 *
 *   licenseSecret = HKDF-SHA256(ikm, info, 16 bytes)
 *   key string    = "P01-" + Crockford-base32(licenseSecret)   (16 bytes → 26 chars, grouped in 4s)
 *   commitment    = blake3(licenseSecret)                        (32 bytes, posted on-chain)
 *
 * Forgery is closed by preimage resistance: the only public artifact is the
 * blake3 commitment, and inverting it to recover `licenseSecret` is infeasible.
 * No per-merchant secret exists, so nothing has to be shipped to clients.
 *
 * ====================================================================
 * AUTHORITATIVE SCHEME CONSTANTS — keep byte-for-byte identical across
 * apps/mobile, apps/extension, and packages/merchant-sdk (LICENSE_SCHEME).
 * --------------------------------------------------------------------
 *   SECRET_BYTES   : 16                  (128-bit licenseSecret)
 *   HKDF           : HKDF-SHA256
 *   HKDF salt      : undefined (none)
 *   HKDF info      : utf8("p01-license-v1") || utf8(serviceId)
 *   ZK ikm         : utf8(masterNoteSecret.toString(10))    // receipt.secret
 *   Classic ikm    : ed25519 sign("p01-license-v1:" || serviceId)  // DEFERRED
 *   commitment     : blake3(licenseSecret) → 32 bytes
 *   key string     : "P01-" + Crockford-base32(licenseSecret), groups of 4
 *   Crockford alph : 0123456789ABCDEFGHJKMNPQRSTVWXYZ
 *
 * Test vector (serviceId-independent, secret = 0x000102..0f):
 *   licenseSecret = 000102030405060708090a0b0c0d0e0f
 *   key           = P01-000G-40R4-0M30-E209-185G-R38E-1W
 *   commitment    = a6a492965517a830cb75fdb713465aa465f2f098233896fea44c1d98268bf9e3
 * ====================================================================
 */

import { blake3 } from '@noble/hashes/blake3.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

/** Retained for backward-compat with callers that still type a mode. */
export type LicenseMode = 'standard' | 'zk';

export const LICENSE_SECRET_BYTES = 16;
export const LICENSE_COMMITMENT_BYTES = 32;
const INFO_LABEL = 'p01-license-v1';
const CLASSIC_SIGN_PREFIX = 'p01-license-v1:';
const CLASSIC_IDENTITY_DOMAIN = 'p01-license-classic-id-v1';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CROCKFORD_INV: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < CROCKFORD.length; i++) m[CROCKFORD[i]] = i;
  m['O'] = 0; m['I'] = 1; m['L'] = 1; // decode-only Crockford aliases
  return m;
})();

function encodeCrockford(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 0x1f];
  return out;
}

function decodeCrockford(s: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const v = CROCKFORD_INV[ch];
    if (v === undefined) throw new Error(`invalid Crockford character: ${ch}`);
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/**
 * HKDF info = utf8(INFO_LABEL) || utf8(serviceId). Binds the licenseSecret to
 * the specific service so two subscriptions of the same user produce unrelated
 * keys (and a key for service A cannot be replayed against service B).
 */
function licenseInfo(serviceId: string): Uint8Array {
  const label = utf8ToBytes(INFO_LABEL);
  const svc = utf8ToBytes(serviceId);
  const buf = new Uint8Array(label.length + svc.length);
  buf.set(label, 0);
  buf.set(svc, label.length);
  return buf;
}

/**
 * Derive the 16-byte `licenseSecret` for a PRIVATE (ZK) subscription from the
 * subscriber's master note secret (`receipt.secret`) — the SAME secret family
 * from which the vault's `subscriber_commitment` is derived. Deterministic, so
 * the key is reproducible on any device that holds the note secret.
 *
 * @param masterNoteSecret the note secret as bigint (receipt.secret) or its
 *        canonical decimal string. Either form yields the identical ikm.
 */
export function deriveLicenseSecret(
  masterNoteSecret: bigint | string,
  serviceId: string,
): Uint8Array {
  const decimal = typeof masterNoteSecret === 'bigint'
    ? masterNoteSecret.toString(10)
    : masterNoteSecret.trim();
  const ikm = utf8ToBytes(decimal);
  return hkdf(sha256, ikm, undefined, licenseInfo(serviceId), LICENSE_SECRET_BYTES);
}

/**
 * Derive the 16-byte `licenseSecret` for a CLASSIC subscription from a
 * deterministic ed25519 signature over `"p01-license-v1:" || serviceId`.
 *
 * DEFERRED: the classic license path is intentionally left unwired until a
 * deterministic signer is confirmed (mirrors mobile). This helper documents the
 * intended derivation for when that lands.
 */
export function deriveClassicLicenseSecret(
  deterministicSignature: Uint8Array,
  serviceId: string,
): Uint8Array {
  return hkdf(sha256, deterministicSignature, undefined, licenseInfo(serviceId), LICENSE_SECRET_BYTES);
}

/** The exact message a classic signer must sign for `deriveClassicLicenseSecret`. */
export function classicLicenseSignMessage(serviceId: string): Uint8Array {
  return utf8ToBytes(CLASSIC_SIGN_PREFIX + serviceId);
}

/**
 * `license_commitment = blake3(licenseSecret)` (32 bytes). This is the value
 * posted on-chain as the subscribe arg; the merchant compares it to
 * `blake3(decode(presentedKey))`.
 */
export function licenseCommitment(licenseSecret: Uint8Array): Uint8Array {
  if (licenseSecret.length !== LICENSE_SECRET_BYTES) {
    throw new Error(`licenseSecret must be ${LICENSE_SECRET_BYTES} bytes, got ${licenseSecret.length}`);
  }
  return blake3(licenseSecret);
}

/** Encode a 16-byte `licenseSecret` into the user-facing "P01-..." key string. */
export function encodeLicenseKey(licenseSecret: Uint8Array): string {
  if (licenseSecret.length !== LICENSE_SECRET_BYTES) {
    throw new Error(`licenseSecret must be ${LICENSE_SECRET_BYTES} bytes, got ${licenseSecret.length}`);
  }
  const groups = encodeCrockford(licenseSecret).match(/.{1,4}/g) ?? [];
  return 'P01-' + groups.join('-');
}

/** Decode a presented "P01-..." key back to the 16-byte `licenseSecret`. */
export function decodeLicenseKey(key: string): Uint8Array {
  let s = key.trim().toUpperCase().replace(/-/g, '').replace(/\s+/g, '');
  if (s.startsWith('P01')) s = s.slice(3);
  if (s.length === 0) throw new Error('empty license key');
  const bytes = decodeCrockford(s);
  if (bytes.length < LICENSE_SECRET_BYTES) {
    throw new Error(`license key decodes to ${bytes.length} bytes, need ${LICENSE_SECRET_BYTES}`);
  }
  return bytes.subarray(0, LICENSE_SECRET_BYTES);
}

/**
 * Convenience: derive the displayable license key for a PRIVATE subscription
 * straight from the master note secret + serviceId.
 */
export function licenseKeyForPrivate(
  masterNoteSecret: bigint | string,
  serviceId: string,
): string {
  return encodeLicenseKey(deriveLicenseSecret(masterNoteSecret, serviceId));
}

/**
 * Build an opaque 32-byte identity for a classic subscription. Retained for the
 * deferred classic path; hashing wallet + streamId means a license key cannot be
 * reversed to the raw wallet, and two classic subs across services stay
 * unlinkable. NOTE: under the commitment scheme this is no longer the input to
 * the key; it is kept only as a helper for the deferred classic derivation.
 */
export function deriveClassicIdentity(
  walletPubkey: Uint8Array,
  streamId: string,
): Uint8Array {
  const domain = utf8ToBytes(CLASSIC_IDENTITY_DOMAIN);
  const sid = utf8ToBytes(streamId);
  const buf = new Uint8Array(domain.length + walletPubkey.length + sid.length);
  let off = 0;
  buf.set(domain, off); off += domain.length;
  buf.set(walletPubkey, off); off += walletPubkey.length;
  buf.set(sid, off);
  return blake3(buf, { dkLen: 32 });
}
