/**
 * licenseTagMatch: the tag a license key is scoped to is VERIFIED against the
 * vault's `license_commitment`, never guessed from a registry join.
 *
 * The defect this pins: recovery and track-by-address rebuilt the tag as the
 * first registry slug on (retailer, mint). A merchant with two slugs on one
 * retailer, a paused or removed listing, or an empty roster produced a key
 * whose blake3 is on no vault, so `verifyMerchantLicense` refused a paid-for
 * subscription. The check here is exactly the merchant's: blake3 of the
 * decoded key must equal the on-chain commitment.
 *
 * Runs under `vitest.pool.config.mts` (node). Nothing is mocked; the
 * derivation is the frozen mirror in `license.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  decodeLicenseKey,
  deriveLicenseSecret,
  deriveLicenseSecretV2,
  encodeLicenseKey,
  licenseCommitment,
} from './license';
import {
  KEY_NOT_RECOVERABLE,
  deriveLicenseSecretUnder,
  licenseTagCandidates,
  matchLicense,
  matchLicenseServiceTag,
} from './licenseTagMatch';

const SECRET = 123_456_789_012_345_678_901_234_567_890n;
const RETAILER = 'q8R2oNtnCH1Y3Pgjm8okR1Vz6wuxwMwPyoCxm5emLdr';
const SOL = '11111111111111111111111111111111';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** What the subscribe path posts on chain for a purchase under `tag`. */
function commitmentFor(tag: string): Uint8Array {
  return licenseCommitment(deriveLicenseSecret(SECRET, tag));
}

const TWO_SLUGS = [
  { slug: 'acme-basic', retailer: RETAILER, tokenMint: SOL },
  { slug: 'acme-pro', retailer: RETAILER, tokenMint: SOL },
];

describe('licenseTagCandidates: stored tag, registry slugs on (retailer, mint), retailer', () => {
  it('keeps the fixed order and drops duplicates and empties', () => {
    expect(
      licenseTagCandidates({
        storedTag: 'acme-pro',
        services: [
          ...TWO_SLUGS,
          // Same retailer, other mint: not a candidate for a SOL vault.
          { slug: 'acme-usdc', retailer: RETAILER, tokenMint: USDC },
          // Another merchant entirely.
          { slug: 'other', retailer: 'SomeOtherRetailer111111111111111111111111111', tokenMint: SOL },
          // No mint on the listing: matches any vault of the retailer.
          { slug: 'acme-any', retailer: RETAILER },
        ],
        retailer: RETAILER,
        tokenMint: SOL,
      }),
    ).toEqual(['acme-pro', 'acme-basic', 'acme-any', RETAILER]);
  });

  it('with no stored tag and no roster, the retailer address is the only candidate', () => {
    expect(licenseTagCandidates({ retailer: RETAILER, tokenMint: SOL })).toEqual([RETAILER]);
    expect(licenseTagCandidates({ storedTag: '', services: [], retailer: RETAILER })).toEqual([
      RETAILER,
    ]);
  });
});

describe('matchLicenseServiceTag: the chain decides', () => {
  it('two listings on one (retailer, mint): picks the one the vault was bought under', () => {
    // Bought under acme-pro. The join would have picked acme-basic (sorts first).
    const onChain = commitmentFor('acme-pro');
    const candidates = licenseTagCandidates({
      services: TWO_SLUGS,
      retailer: RETAILER,
      tokenMint: SOL,
    });
    expect(candidates[0]).toBe('acme-basic'); // the guess the defect shipped

    const tag = matchLicenseServiceTag(SECRET, onChain, candidates);
    expect(tag).toBe('acme-pro');

    // The merchant's own check on the key this tag yields.
    const key = encodeLicenseKey(deriveLicenseSecret(SECRET, tag!));
    expect(hex(licenseCommitment(decodeLicenseKey(key)))).toBe(hex(onChain));
  });

  it('a wrong stored tag is rejected and the right slug found behind it', () => {
    const onChain = commitmentFor('acme-pro');
    const candidates = licenseTagCandidates({
      storedTag: 'acme-basic', // what a rebuilt record carried
      services: TWO_SLUGS,
      retailer: RETAILER,
      tokenMint: SOL,
    });
    expect(candidates).toEqual(['acme-basic', 'acme-pro', RETAILER]);
    expect(matchLicenseServiceTag(SECRET, onChain, candidates)).toBe('acme-pro');
    // Hex input is accepted too, in either case.
    expect(matchLicenseServiceTag(SECRET, hex(onChain).toUpperCase(), candidates)).toBe('acme-pro');
    // And the secret as the decimal string the blob stores.
    expect(matchLicenseServiceTag(SECRET.toString(), onChain, candidates)).toBe('acme-pro');
  });

  it('no candidate matches: null, never a guess', () => {
    const onChain = commitmentFor('acme-pro'); // the listing was removed since
    const candidates = licenseTagCandidates({
      storedTag: 'acme-basic',
      services: [TWO_SLUGS[0]!],
      retailer: RETAILER,
      tokenMint: SOL,
    });
    expect(matchLicenseServiceTag(SECRET, onChain, candidates)).toBeNull();
    // Another note's secret matches nothing either.
    expect(matchLicenseServiceTag(SECRET + 1n, onChain, ['acme-pro'])).toBeNull();
  });

  it('a vault storing no commitment verifies no key', () => {
    expect(matchLicenseServiceTag(SECRET, null, ['acme-pro', RETAILER])).toBeNull();
    expect(matchLicenseServiceTag(SECRET, undefined, ['acme-pro'])).toBeNull();
    expect(matchLicenseServiceTag(SECRET, '', ['acme-pro'])).toBeNull();
  });

  it('the verdict callers show is a fixed phrase', () => {
    expect(KEY_NOT_RECOVERABLE).toBe('key not recoverable for this subscription');
  });
});

// ---------------------------------------------------------------------------
// Two schemes. A vault opened before 2026-09-02 stores blake3 of a v1 secret;
// one opened since stores blake3 of a v2 secret (note secret + identity seed).
// The vault says nothing about which, so the matcher tries v2 then v1 for each
// candidate tag and reports the pair that reproduced the commitment.
// ---------------------------------------------------------------------------

describe('matchLicense: v2 then v1 for each candidate tag, and the scheme comes back', () => {
  const SEED = new Uint8Array(32).fill(7); // the identity that bought
  const LEGACY = new Uint8Array(32).fill(8); // its pre-passphrase seed, or a stranger's
  const candidates = licenseTagCandidates({
    services: TWO_SLUGS,
    retailer: RETAILER,
    tokenMint: SOL,
  });

  /** What the subscribe path posts on chain since v2 for a purchase under `tag`. */
  function commitmentV2(tag: string, seed: Uint8Array = SEED): Uint8Array {
    return licenseCommitment(deriveLicenseSecretV2(SECRET, tag, seed));
  }

  it('a v1 commitment, the vault of a purchase from before v2, is recovered as v1', () => {
    const onChain = commitmentFor('acme-pro');
    const m = matchLicense(SECRET, SEED, onChain, candidates);
    expect(m).toEqual({ serviceTag: 'acme-pro', scheme: 'v1' });
    // The key under that pair IS the key the merchant accepted at purchase.
    const key = encodeLicenseKey(deriveLicenseSecretUnder(m!.scheme, SECRET, m!.serviceTag, SEED));
    expect(key).toBe(encodeLicenseKey(deriveLicenseSecret(SECRET, 'acme-pro')));
    expect(hex(licenseCommitment(decodeLicenseKey(key)))).toBe(hex(onChain));
  });

  it('a v2 commitment is recovered as v2, with the seed that reproduced it', () => {
    const onChain = commitmentV2('acme-pro');
    // Both seeds of a passphrase identity are offered, legacy first here to
    // show the order among seeds does not matter: the commitment decides.
    const m = matchLicense(SECRET, [LEGACY, SEED], onChain, candidates);
    expect(m?.serviceTag).toBe('acme-pro');
    expect(m?.scheme).toBe('v2');
    expect(m?.identitySeed).toBe(SEED);
    const key = encodeLicenseKey(
      deriveLicenseSecretUnder(m!.scheme, SECRET, m!.serviceTag, m!.identitySeed),
    );
    expect(key).toBe(encodeLicenseKey(deriveLicenseSecretV2(SECRET, 'acme-pro', SEED)));
    expect(hex(licenseCommitment(decodeLicenseKey(key)))).toBe(hex(onChain));
    // A single seed is accepted as well as a list.
    expect(matchLicense(SECRET, SEED, onChain, candidates)?.scheme).toBe('v2');
  });

  it('a v2 vault under another seed, or with no seed offered, matches nothing: never a v1 guess', () => {
    const onChain = commitmentV2('acme-pro');
    expect(matchLicense(SECRET, LEGACY, onChain, candidates)).toBeNull();
    expect(matchLicense(SECRET, null, onChain, candidates)).toBeNull();
    expect(matchLicense(SECRET, [], onChain, candidates)).toBeNull();
    // And a v1 vault is found whether or not seeds are offered.
    expect(matchLicense(SECRET, null, commitmentFor('acme-pro'), candidates)?.scheme).toBe('v1');
  });

  it('a wrong stored tag is rejected under both schemes and the right slug found behind it', () => {
    const withStored = licenseTagCandidates({
      storedTag: 'acme-basic',
      services: TWO_SLUGS,
      retailer: RETAILER,
      tokenMint: SOL,
    });
    expect(matchLicense(SECRET, SEED, commitmentV2('acme-pro'), withStored)).toMatchObject({
      serviceTag: 'acme-pro',
      scheme: 'v2',
    });
    expect(matchLicense(SECRET, SEED, commitmentFor('acme-pro'), withStored)).toEqual({
      serviceTag: 'acme-pro',
      scheme: 'v1',
    });
    // Hex input, either case, and the decimal-string secret, as before.
    expect(
      matchLicense(SECRET.toString(), SEED, hex(commitmentV2('acme-pro')).toUpperCase(), withStored)
        ?.scheme,
    ).toBe('v2');
  });

  it('matchLicenseServiceTag keeps its contract: v1 only without seeds, both schemes with', () => {
    expect(matchLicenseServiceTag(SECRET, commitmentV2('acme-pro'), candidates)).toBeNull();
    expect(matchLicenseServiceTag(SECRET, commitmentV2('acme-pro'), candidates, SEED)).toBe(
      'acme-pro',
    );
    expect(matchLicenseServiceTag(SECRET, commitmentFor('acme-pro'), candidates, SEED)).toBe(
      'acme-pro',
    );
  });

  it('a vault storing no commitment verifies no key under either scheme', () => {
    expect(matchLicense(SECRET, SEED, null, candidates)).toBeNull();
    expect(matchLicense(SECRET, SEED, undefined, candidates)).toBeNull();
    expect(matchLicense(SECRET, SEED, '', candidates)).toBeNull();
  });

  it('deriveLicenseSecretUnder refuses v2 without a seed rather than falling back to v1', () => {
    expect(() => deriveLicenseSecretUnder('v2', SECRET, 'acme-pro')).toThrow(/identity seed/);
    expect(() => deriveLicenseSecretUnder('v2', SECRET, 'acme-pro', null)).toThrow(/identity seed/);
    expect(hex(deriveLicenseSecretUnder('v1', SECRET, 'acme-pro', SEED))).toBe(
      hex(deriveLicenseSecret(SECRET, 'acme-pro')),
    );
  });
});
