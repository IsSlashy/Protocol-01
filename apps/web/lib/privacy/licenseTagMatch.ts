/**
 * licenseTagMatch: which service tag a vault's license key is scoped to, and
 * the on-chain check that decides it.
 *
 * ## Why this exists
 *
 * A vault stores `license_commitment = blake3(deriveLicenseSecret(secret, tag))`
 * and nothing else about the tag: the registry slug the buyer chose at purchase
 * is written to the LOCAL record only. When that record is lost, recovery and
 * track-by-address used to rebuild the tag from a (retailer, mint) join on the
 * current registry and re-derive the key under it, unchecked. One merchant with
 * two slugs on one (retailer, mint), a paused or deregistered listing, or a
 * registry read that failed, and the key shown hashed to nothing on chain: the
 * merchant's `verifyMerchantLicense` refused a paid-for subscription.
 *
 * So the tag is never trusted, only VERIFIED: every path that re-derives a key
 * builds the candidate list below and accepts a tag only when the key it yields
 * hashes to the vault's stored commitment. No match, no key.
 *
 * ## Two schemes, one arbiter
 *
 * Since 2026-09-02 a new subscription mints its key under v2
 * (`deriveLicenseSecretV2`: the note secret plus the identity seed of the
 * note's identity, so the treasury cannot recompute the key of a note it
 * issued). Every vault opened before that carries a v1 commitment. The vault
 * stores no scheme marker, so the matcher tries v2 then v1 for each candidate
 * tag and reports which one reproduced the commitment: a stored scheme is
 * treated exactly like a stored tag, a hint the chain is asked to confirm.
 *
 * ## Candidate order (fixed)
 *
 *   1. the tag the local record stores, if any (right for every record written
 *      at purchase, so the common case costs one derivation);
 *   2. every registry slug whose listing has the same retailer and mint, in
 *      registry order;
 *   3. the retailer address, the fallback `licenseServiceTag` uses when there
 *      is no slug (what a client without a registry commits under).
 *
 * The derivation itself is `lib/privacy/license.ts`, a frozen mirror of the
 * cross-client scheme; nothing here re-implements a byte of it. This module
 * imports nothing but that mirror, so both the pool Worker (recovery, reveal)
 * and the main thread (the Subscriptions panel) can use it, and jsdom tests
 * that mock `@solana/web3.js` can too.
 */

import {
  deriveLicenseSecret,
  deriveLicenseSecretV2,
  licenseCommitment,
  licenseServiceTag,
  type LicenseScheme,
} from './license';

export type { LicenseScheme } from './license';

/** A registry listing reduced to the three strings the candidate rule reads. */
export interface LicenseTagListing {
  /** Registry slug, the string a license key is scoped to. */
  slug: string;
  /** Payment recipient, base58: the join key to a vault. */
  retailer: string;
  /** Mint of the listing, base58 (the system program for SOL, the same string
   *  a SOL vault carries). Absent means the listing matches any mint. */
  tokenMint?: string;
}

/**
 * The user-facing verdict when no candidate reproduces the vault's commitment.
 * Callers show this rather than a key that no merchant would accept.
 */
export const KEY_NOT_RECOVERABLE = 'key not recoverable for this subscription';

/**
 * The tags worth trying for one vault, in the order the module header fixes.
 * Deduplicated, empty strings dropped, so a caller can pass what it has.
 */
export function licenseTagCandidates(input: {
  /** The tag the local record stores, if the record exists. */
  storedTag?: string | null;
  /** The registry roster, already reduced to strings. */
  services?: LicenseTagListing[];
  /** The vault's retailer, base58. */
  retailer: string;
  /** The vault's mint, base58. Absent means every listing of the retailer qualifies. */
  tokenMint?: string;
}): string[] {
  const out: string[] = [];
  const push = (tag: string | null | undefined) => {
    if (tag && !out.includes(tag)) out.push(tag);
  };
  push(input.storedTag);
  for (const s of input.services ?? []) {
    if (s.retailer !== input.retailer) continue;
    if (s.tokenMint !== undefined && input.tokenMint !== undefined && s.tokenMint !== input.tokenMint) {
      continue;
    }
    push(s.slug);
  }
  push(licenseServiceTag(null, input.retailer));
  return out;
}

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * The 16-byte license secret under one scheme. v2 needs the identity seed;
 * asking for v2 without one is a caller bug, never a silent fall back to v1.
 */
export function deriveLicenseSecretUnder(
  scheme: LicenseScheme,
  masterNoteSecret: bigint | string,
  serviceTag: string,
  identitySeed?: Uint8Array | null,
): Uint8Array {
  if (scheme === 'v1') return deriveLicenseSecret(masterNoteSecret, serviceTag);
  if (!identitySeed) {
    throw new Error("a v2 license key needs the identity seed of the note's identity");
  }
  return deriveLicenseSecretV2(masterNoteSecret, serviceTag, identitySeed);
}

/** A verified pair: the key derived under (tag, scheme) hashes to the vault's commitment. */
export interface LicenseMatch {
  serviceTag: string;
  scheme: LicenseScheme;
  /** The seed the v2 derivation used. Absent for a v1 match. */
  identitySeed?: Uint8Array;
}

function seedList(seeds: Uint8Array | Uint8Array[] | null | undefined): Uint8Array[] {
  if (!seeds) return [];
  return Array.isArray(seeds) ? seeds : [seeds];
}

/**
 * The first (candidate tag, scheme) under which the note secret derives the
 * key the vault's `license_commitment` was computed from, or null when none
 * does.
 *
 * Trial order: for each candidate tag, v2 under each identity seed given
 * (pass the identity's active seed first, then its legacy seed, the same
 * search order the note store uses), then v1. The chain decides between the
 * schemes exactly as it decides between the tags.
 *
 * `commitment` is the on-chain field, as bytes or lowercase hex; null means the
 * vault stores none, and a vault with no commitment verifies no key at all (a
 * merchant reads it as `no_license_commitment`), so the answer is null.
 *
 * Runs wherever the note secret is: the pool Worker. Neither the secret nor a
 * seed enters any error; the seed in the result is the caller's own object.
 */
export function matchLicense(
  masterNoteSecret: bigint | string,
  identitySeeds: Uint8Array | Uint8Array[] | null | undefined,
  commitment: Uint8Array | string | null | undefined,
  candidates: string[],
): LicenseMatch | null {
  if (commitment === null || commitment === undefined) return null;
  const want = (typeof commitment === 'string' ? commitment : toHex(commitment)).toLowerCase();
  if (want.length === 0) return null;
  const seeds = seedList(identitySeeds);
  for (const tag of candidates) {
    if (!tag) continue;
    for (const seed of seeds) {
      const got = toHex(licenseCommitment(deriveLicenseSecretV2(masterNoteSecret, tag, seed)));
      if (got === want) return { serviceTag: tag, scheme: 'v2', identitySeed: seed };
    }
    const got = toHex(licenseCommitment(deriveLicenseSecret(masterNoteSecret, tag)));
    if (got === want) return { serviceTag: tag, scheme: 'v1' };
  }
  return null;
}

/**
 * The tag half of {@link matchLicense}, for callers that only need the tag.
 * With no identity seeds only v1 is tried, which is exactly what every caller
 * from before v2 existed asked for.
 */
export function matchLicenseServiceTag(
  masterNoteSecret: bigint | string,
  commitment: Uint8Array | string | null | undefined,
  candidates: string[],
  identitySeeds?: Uint8Array | Uint8Array[] | null,
): string | null {
  return matchLicense(masterNoteSecret, identitySeeds, commitment, candidates)?.serviceTag ?? null;
}
