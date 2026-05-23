/**
 * License key derivation for subscriptions (classic + private).
 *
 * The key shown on the user's subscription UI is a deterministic, human-readable
 * 24-character Crockford base32 string derived from a domain-separated BLAKE3
 * hash. Both classic and private subscriptions use the same format so the UI
 * is consistent and the merchant verification logic is unified.
 *
 * Privacy properties:
 *   - The key reveals nothing about the merchant address or the client wallet
 *     directly. Both inputs are pre-hashed (private case: SubscriberVault PDA;
 *     classic case: BLAKE3(wallet || streamId)) before being mixed into the
 *     final hash.
 *   - The key is deterministic. The merchant verifies by re-deriving from the
 *     on-chain SubscriberVault state and matching, with no off-chain database
 *     of subscriber identities.
 *   - Different services produce different keys for the same user — the
 *     serviceId is mixed into the hash, so a third party seeing two keys
 *     cannot conclude they belong to the same user.
 *
 * Format: "P01-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" (24 chars + dashes + prefix).
 */

import { blake3 } from '@noble/hashes/blake3.js';

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
  /** Service identifier (Service Registry slot, e.g. 'disney-plus'). For
   *  custom recipients without a registered service, pass the stream id. */
  serviceId: string;
  /** 32-byte opaque identity. For private (vault-backed) subscriptions, this
   *  is the SubscriberVault PDA bytes. For classic subscriptions, this is
   *  `deriveClassicIdentity(walletPubkey, streamId)`. Never the raw wallet. */
  identity: Uint8Array;
}

/** Derive a deterministic, human-readable license key for a subscription. */
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

/** Build an opaque 32-byte identity for a classic subscription (no on-chain
 *  vault). Hashing the wallet pubkey with the local stream id means an
 *  attacker who sees the resulting license key cannot brute-force back to the
 *  wallet, and cannot link two of the user's classic subscriptions across
 *  services (different streamId → different identity → different key). */
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
