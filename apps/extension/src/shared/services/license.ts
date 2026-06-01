/**
 * License key derivation — EXACT mirror of the mobile app
 * (`apps/mobile/services/license/derive.ts`). The extension MUST produce the
 * same key scheme as mobile so merchant verification is unified and a user sees
 * a consistent credential whatever client they used.
 *
 * Format: "P01-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" — 24 Crockford base32 chars from a
 * domain-separated BLAKE3(15) hash of (domain || identity || serviceId).
 *
 * `identity` is a 32-byte opaque value:
 *   - Private (vault-backed) subscription → the SubscriptionVault PDA bytes.
 *   - Classic subscription → deriveClassicIdentity(walletPubkey, streamId).
 *     (Never the raw wallet — pre-hashed so the key can't be reversed to it,
 *     and two of a user's classic subs across services stay unlinkable.)
 *
 * The merchant re-derives the key from the on-chain vault state + serviceId and
 * matches — no off-chain identity database. See @protocol-01/merchant-sdk.
 */

import { blake3 } from '@noble/hashes/blake3.js';

export type LicenseMode = 'standard' | 'zk';

const KEY_BYTES = 15;
const KEY_DOMAIN = 'p01-license-v1';
const CLASSIC_IDENTITY_DOMAIN = 'p01-license-classic-id-v1';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

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
  if (bits > 0) {
    out += CROCKFORD[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

export interface LicenseKeyArgs {
  /** Service identifier (registry slug, e.g. 'spotify'). For custom recipients
   *  without a registered service, pass the stream id / a stable tag. */
  serviceId: string;
  /** 32-byte opaque identity (vault PDA bytes, or deriveClassicIdentity). */
  identity: Uint8Array;
}

/** Derive the deterministic, human-readable license key. Mirrors mobile. */
export function deriveLicenseKey(args: LicenseKeyArgs): string {
  const enc = new TextEncoder();
  const domain = enc.encode(KEY_DOMAIN);
  const svc = enc.encode(args.serviceId);
  const buf = new Uint8Array(domain.length + args.identity.length + svc.length);
  let off = 0;
  buf.set(domain, off); off += domain.length;
  buf.set(args.identity, off); off += args.identity.length;
  buf.set(svc, off);
  const digest = blake3(buf, { dkLen: KEY_BYTES });
  const encoded = encodeCrockford(digest);
  const groups = encoded.match(/.{4}/g) ?? [];
  return 'P01-' + groups.join('-');
}

/** Build the 32-byte opaque identity for a classic (no-vault) subscription. */
export function deriveClassicIdentity(
  walletPubkey: Uint8Array,
  streamId: string,
): Uint8Array {
  const enc = new TextEncoder();
  const domain = enc.encode(CLASSIC_IDENTITY_DOMAIN);
  const sid = enc.encode(streamId);
  const buf = new Uint8Array(domain.length + walletPubkey.length + sid.length);
  let off = 0;
  buf.set(domain, off); off += domain.length;
  buf.set(walletPubkey, off); off += walletPubkey.length;
  buf.set(sid, off);
  return blake3(buf, { dkLen: 32 });
}
