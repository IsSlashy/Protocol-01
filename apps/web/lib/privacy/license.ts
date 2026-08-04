/**
 * License-key derivation for the web client.
 *
 * ====================================================================
 * MIRROR — NOT AN IMPLEMENTATION CHOICE.
 *
 * This is the fourth implementation of one scheme. The authoritative
 * description is `LICENSE_SCHEME` in `packages/merchant-sdk/src/license.ts`;
 * `apps/mobile/services/license/derive.ts` and
 * `apps/extension/src/shared/services/license.ts` are the other two. A key
 * minted here must verify against a merchant that has never seen this file, so
 * every constant below is copied, not decided.
 *
 *   ZK ikm         : utf8(masterNoteSecret.toString(10))
 *   HKDF           : SHA-256, no salt, info = utf8("p01-license-v1" || serviceId)
 *   licenseSecret  : 16 bytes
 *   commitment     : blake3(licenseSecret) -> 32 bytes, posted on chain
 *   key string     : "P01-" + Crockford-base32(licenseSecret), groups of 4
 *   Crockford alph : 0123456789ABCDEFGHJKMNPQRSTVWXYZ
 *
 * Frozen test vector, shared with the other three implementations and asserted
 * at the bottom of this file at module load:
 *   licenseSecret = 000102030405060708090a0b0c0d0e0f
 *   key           = P01-000G-40R4-0M30-E209-185G-R38E-1W
 *   commitment    = a6a492965517a830cb75fdb713465aa465f2f098233896fea44c1d98268bf9e3
 *
 * `packages/merchant-sdk/src/license-parity.test.ts` runs all implementations
 * against one table. Add this module there rather than trusting the copy.
 * ====================================================================
 */

import { blake3 } from '@noble/hashes/blake3.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

export const LICENSE_SECRET_BYTES = 16;
export const LICENSE_COMMITMENT_BYTES = 32;

const INFO_LABEL = 'p01-license-v1';
const CLASSIC_SIGN_PREFIX = 'p01-license-v1:';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const CROCKFORD_INV: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < CROCKFORD.length; i++) m[CROCKFORD[i]!] = i;
  // Decode-only Crockford aliases, so a human transcribing a key cannot fail on
  // the characters the alphabet deliberately omits.
  m['O'] = 0;
  m['I'] = 1;
  m['L'] = 1;
  return m;
})();

function licenseInfo(serviceId: string): Uint8Array {
  const label = utf8ToBytes(INFO_LABEL);
  const svc = utf8ToBytes(serviceId);
  const buf = new Uint8Array(label.length + svc.length);
  buf.set(label, 0);
  buf.set(svc, label.length);
  return buf;
}

function encodeCrockford(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
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
 * The string the key is scoped to: the registry `serviceId` when there is one,
 * otherwise the retailer address.
 *
 * No trimming and no case folding. This reproduces the exact bytes already
 * committed by every vault on chain; normalising here would silently orphan
 * every key ever issued.
 */
export function licenseServiceTag(
  serviceId: string | null | undefined,
  retailerAddress: string,
): string {
  return serviceId ? serviceId : retailerAddress;
}

/**
 * Derive the 16-byte `licenseSecret` for a PRIVATE (ZK) subscription from the
 * subscriber's master note secret — the same secret family the vault's
 * `subscriber_commitment` comes from. Deterministic, so the key is reproducible
 * on any device holding the note secret, which is what makes it recoverable
 * rather than something the user must store.
 */
export function deriveLicenseSecret(
  masterNoteSecret: bigint | string,
  serviceId: string,
): Uint8Array {
  const decimal =
    typeof masterNoteSecret === 'bigint' ? masterNoteSecret.toString(10) : masterNoteSecret.trim();
  const ikm = utf8ToBytes(decimal);
  return hkdf(sha256, ikm, undefined, licenseInfo(serviceId), LICENSE_SECRET_BYTES);
}

/**
 * Derive the 16-byte `licenseSecret` for a CLASSIC subscription from a
 * deterministic ed25519 signature over `"p01-license-v1:" || serviceId`.
 *
 * ⚠ DEFERRED, exactly as on mobile. ed25519 signing is deterministic by RFC 8032
 * but wallet `signMessage` adapters do not promise the caller a stable signature,
 * so a key derived this way is not reliably reproducible. The ZK private path
 * above is the one that ships. This exists so the web client is a COMPLETE
 * implementation in the parity table rather than a partial one that silently
 * skips a row.
 */
export function deriveClassicLicenseSecret(
  deterministicSignature: Uint8Array,
  serviceId: string,
): Uint8Array {
  return hkdf(sha256, deterministicSignature, undefined, licenseInfo(serviceId), LICENSE_SECRET_BYTES);
}

/** The exact message a classic signer must sign for {@link deriveClassicLicenseSecret}. */
export function classicLicenseSignMessage(serviceId: string): Uint8Array {
  return utf8ToBytes(CLASSIC_SIGN_PREFIX + serviceId);
}

/**
 * `license_commitment = blake3(licenseSecret)`, the 32 bytes posted on chain as
 * a `subscribe_private_stark` argument. The merchant compares it against
 * `blake3(decode(presentedKey))`; nothing is verified on chain.
 */
export function licenseCommitment(licenseSecret: Uint8Array): Uint8Array {
  if (licenseSecret.length !== LICENSE_SECRET_BYTES) {
    throw new Error(`licenseSecret must be ${LICENSE_SECRET_BYTES} bytes, got ${licenseSecret.length}`);
  }
  return blake3(licenseSecret);
}

/** Encode a 16-byte `licenseSecret` into the user-facing "P01-…" key string. */
export function encodeLicenseKey(licenseSecret: Uint8Array): string {
  if (licenseSecret.length !== LICENSE_SECRET_BYTES) {
    throw new Error(`licenseSecret must be ${LICENSE_SECRET_BYTES} bytes, got ${licenseSecret.length}`);
  }
  const groups = encodeCrockford(licenseSecret).match(/.{1,4}/g) ?? [];
  return 'P01-' + groups.join('-');
}

/** Decode a presented "P01-…" key back to the 16-byte `licenseSecret`. */
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

/** The displayable key for a private subscription, from note secret + service. */
export function licenseKeyForPrivate(
  masterNoteSecret: bigint | string,
  serviceId: string,
): string {
  return encodeLicenseKey(deriveLicenseSecret(masterNoteSecret, serviceId));
}

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Load-time self-check against the frozen vector.
//
// A mirror that has drifted is worse than a missing one: it produces a key the
// user believes in and no merchant accepts. The cost here is two hashes at
// module load, and it fails loudly at the point of drift rather than at the
// point of presentation.
// ---------------------------------------------------------------------------
{
  const v = new Uint8Array(16);
  for (let i = 0; i < 16; i++) v[i] = i;
  const key = encodeLicenseKey(v);
  const commit = toHex(licenseCommitment(v));
  if (key !== 'P01-000G-40R4-0M30-E209-185G-R38E-1W') {
    throw new Error(`license codec drift: key vector is ${key}`);
  }
  if (commit !== 'a6a492965517a830cb75fdb713465aa465f2f098233896fea44c1d98268bf9e3') {
    throw new Error(`license codec drift: commitment vector is ${commit}`);
  }
}
