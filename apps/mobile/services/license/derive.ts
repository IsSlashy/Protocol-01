/**
 * License key derivation for subscriptions (commitment scheme).
 *
 * ## The scheme (no shared secret, no on-chain hashing)
 *
 * The license key shown to the user encodes a per-subscriber 128-bit
 * `licenseSecret`. At subscribe time the client posts ONLY the
 * `blake3(licenseSecret)` commitment on-chain (`SubscriptionVault
 * .license_commitment`, stored verbatim — the chain never hashes/verifies).
 * Later the subscriber presents the key (= the preimage); the merchant
 * recomputes `blake3(decode(key))` and matches it to the on-chain commitment.
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
 * THE service tag that goes into the HKDF `info`. One rule, one function, for
 * every caller: the screen that posts `license_commitment` on-chain and the
 * screen that re-derives the key for display must agree on this string or the
 * displayed key verifies against nothing.
 *
 * They did not agree. The subscribe screens tagged on `serviceId || retailer
 * base58`, while `LicenseKeyCard` fell back to the local `streamId` — a value
 * the chain has never seen — so every subscription to a recipient without a
 * Service Registry slug showed a key the merchant was bound to reject. Vaults
 * synthesised by `upsertStreamFromVault` were worse: it sets no `serviceId` at
 * all and mints a fresh random stream id, so the fallback was wrong 100% of the
 * time there.
 *
 * This function alone does not close that. It fixes the RULE; the INPUTS are
 * fixed by recording the committed tag on the record — see
 * `licenseScopeForStream`. And one case stays open: a vault recovered on a
 * device that never saw the registry slug cannot reproduce a slug-scoped tag,
 * because the SubscriptionVault account does not carry one.
 *
 * @param serviceId Service Registry slug, when the recipient has one.
 * @param retailerAddress The retailer's base58 address — the fallback tag for a
 *        free-form recipient with no slug.
 *
 * No trimming, no case folding: this reproduces the exact `serviceId ||
 * retailerAddress` bytes already committed by every vault on chain. Normalising
 * here would silently orphan any key already issued.
 */
export function licenseServiceTag(
  serviceId: string | null | undefined,
  retailerAddress: string,
): string {
  return serviceId ? serviceId : retailerAddress;
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
 * ⚠ DEFERRED: ed25519 is NOT deterministic per the standard (RFC 8032 uses a
 * deterministic nonce, but most wallet `signMessage` adapters — Privy, mobile
 * keypair — do not guarantee the caller a stable signature, and our classic
 * signer path is not reliably available offline). The ZK private subscribe is
 * the headline flow and ships fully; classic license keys are intentionally
 * left unwired until a deterministic signer is confirmed. This helper documents
 * the intended derivation for when that lands.
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
 * The subscription scope a license key is derived under. Both halves of the
 * flow take this same object, so there is no second place to spell the fallback
 * rule differently.
 */
export interface LicenseScope {
  /** Service Registry slug, when the recipient has one. */
  serviceId?: string | null;
  /** Retailer base58 address — the tag when there is no slug. */
  retailerAddress: string;
}

/**
 * The key to SHOW for a private subscription. This is the function the
 * LicenseKeyCard calls; nothing else may re-implement the tag rule.
 */
export function licenseKeyForSubscription(
  masterNoteSecret: bigint | string,
  scope: LicenseScope,
): string {
  return licenseKeyForPrivate(masterNoteSecret, licenseServiceTag(scope.serviceId, scope.retailerAddress));
}

/**
 * The minimum a persisted subscription record must carry for the display side
 * to reproduce the tag that was committed. Structural on purpose so this module
 * keeps no dependency on the streams service — the cross-client parity fixture
 * imports it directly.
 */
export interface LicenseStreamRecord {
  /**
   * The tag that was actually hashed into `license_commitment` at subscribe
   * time, recorded verbatim. Authoritative when present: it is the only field
   * that cannot be re-derived wrongly later.
   */
  licenseServiceTag?: string;
  /** Service Registry slug, when the record carries one. */
  serviceId?: string;
  /** Retailer base58 address. */
  recipientAddress: string;
}

/**
 * The scope a persisted subscription's license key must be derived under.
 *
 * This exists because `licenseServiceTag` being correct is not enough: the
 * display side has to be handed the right INPUTS, and that hand-off is where
 * the shipped defect lived. Every path that renders a key goes through this one
 * function, so a record can be wrong in exactly one place instead of at every
 * call site.
 *
 * Precedence: the recorded tag, then the slug, then the retailer address.
 * A record synthesised from an on-chain vault carries no slug — the vault
 * account does not store one — so a subscription made under a registry slug and
 * recovered on a device that never saw that slug still cannot be reproduced.
 * That gap is real and is asserted in `stream-scope.test.ts` rather than
 * papered over.
 */
export function licenseScopeForStream(stream: LicenseStreamRecord): LicenseScope {
  return {
    serviceId: stream.licenseServiceTag || stream.serviceId,
    retailerAddress: stream.recipientAddress,
  };
}

/**
 * The `license_commitment` to POST for a private subscription. Counterpart of
 * `licenseKeyForSubscription`; they cannot disagree because they share
 * `licenseServiceTag`.
 *
 * NOTE: the mobile subscribe screens do not call this — they resolve the tag
 * with `licenseServiceTag` and hand the string to `subscriptionVaultStore`,
 * which hashes it. Both routes are the same derivation, but only the store's
 * route is on the wire today.
 */
export function licenseCommitmentForSubscription(
  masterNoteSecret: bigint | string,
  scope: LicenseScope,
): Uint8Array {
  return licenseCommitment(
    deriveLicenseSecret(masterNoteSecret, licenseServiceTag(scope.serviceId, scope.retailerAddress)),
  );
}

/**
 * Build an opaque 32-byte identity for a classic subscription. Retained for the
 * deferred classic path; hashing wallet + streamId means a license key cannot be
 * reversed to the raw wallet, and two classic subs across services stay unlinkable.
 *
 * NOTE: under the commitment scheme this is no longer the input to the key; it
 * is kept only as a helper for the deferred classic derivation tooling.
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
