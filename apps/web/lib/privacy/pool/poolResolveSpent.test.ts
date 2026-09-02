/**
 * poolResolveSpent + poolLicenseKey — the two read-only resolution handlers.
 *
 * What is worth testing:
 *
 *   1. `poolResolveSpent` answers from the CHAIN, per local note: a nullifier
 *      that exists reports spent, one that does not reports unspent, and the
 *      handler checks exactly the notes this identity's blobs describe.
 *   2. Failure honesty: a blob this identity cannot open is `skipped`, a note
 *      whose RPC read fails is `unresolved` and ABSENT from the map — never
 *      guessed in either direction. Absence is what lets the consumer keep its
 *      one-way rule (unspent -> spent only).
 *   3. `poolLicenseKey` re-derives the exact key the subscribe flow returned:
 *      pinned against `licenseKeyForPrivate` from the license module, which is
 *      itself pinned to the cross-client frozen vector. And when the paying
 *      note's blob is absent, the error says so WITHOUT leaking any key
 *      material.
 *   4. Both handlers search every seed derivation, active first, so notes
 *      shielded before a passphrase was adopted stay reachable.
 *
 * `noteCrypto` and the license derivation are deliberately NOT mocked: the
 * blobs are sealed and opened by the real hybrid X25519 + ML-KEM-768, exactly
 * as shield writes them. Only `fetchSpentNullifierSet` is stubbed — it is the
 * one chain read. `isNullifierSpentInSet` stays real, so these tests exercise
 * the production membership derivation rather than a copy of it.
 *
 * 🚨 Point 1 changed shape on 2026-08-12 and the change is the privacy fix
 * itself: the handler asks ONE pool-wide question instead of one question per
 * note. Resolving spent-ness note by note handed the RPC the list of notes this
 * browser owned and had not yet spent; when one of those PDAs later appeared on
 * chain, joining the two recovered the querying IP. Two tests below pin the new
 * shape directly, and the failure-granularity test asserts per-POOL rather than
 * per-note because that is now the truth.
 *
 * Runs under `vitest.pool.config.mts` (node).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicKey } from '@solana/web3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import { derivePoolSeedLegacy, derivePoolSeedSalted } from './seedDerivation';
import { findPoolV3 } from './denominatedPool';
import { createNoteEncryptionAddress, encryptNote } from './noteCrypto';
import {
  decodeLicenseKey,
  deriveLicenseSecret,
  licenseCommitment,
  licenseKeyForPrivate,
} from '../license';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIGNATURE = new Uint8Array(64);
for (let i = 0; i < 64; i++) SIGNATURE[i] = (i * 11 + 5) & 0xff;

const PASSPHRASE = 'six quiet otters file taxes';
const LEGACY_SEED = derivePoolSeedLegacy(SIGNATURE);
const SALTED_SEED = derivePoolSeedSalted(SIGNATURE, PASSPHRASE);

const POOL = findPoolV3('SOL', 0.1)!;
const POOL_58 = POOL.poolPDA.toBase58();
const META = 'meta-under-test';

interface FixtureNote {
  leafIndex: number;
  secret: bigint;
  nullifierPreimage: bigint;
}

function fixtureNote(leafIndex: number): FixtureNote {
  return {
    leafIndex,
    secret: BigInt(leafIndex * 1_000_003 + 1),
    nullifierPreimage: BigInt(leafIndex * 1_000_003 + 2),
  };
}

/** A blob EXACTLY as the shield writes it (poolHandlers.ts:761-785), minus the
 *  Merkle path, which neither handler reads. */
function blobFor(seed: Uint8Array, n: FixtureNote): string {
  return encryptNote(
    createNoteEncryptionAddress(seed),
    utf8ToBytes(
      JSON.stringify({
        version: 1,
        pool: POOL_58,
        secret: n.secret.toString(),
        nullifier_preimage: n.nullifierPreimage.toString(),
        deposit_epoch: '12345',
        commitment: '999',
        leafIndex: n.leafIndex,
        token: 'SOL',
        denominationHuman: 0.1,
      }),
    ),
  );
}

const SPENT_NOTE = fixtureNote(7); // nullifier PDA exists on chain
const LIVE_NOTE = fixtureNote(8); // no nullifier PDA
const LEGACY_NOTE = fixtureNote(3); // shielded before the passphrase

/**
 * Mutable chain state the `fetchSpentNullifierSet` stub answers from.
 *
 * The stub is POOL-WIDE on purpose: the handler no longer asks the chain about
 * individual nullifiers, because doing so handed the RPC the list of notes this
 * browser owns and had not yet spent. `calls` therefore records POOL reads, not
 * note reads, and `failingPools` fails a whole pool — that is the real failure
 * granularity now, and the tests below assert it as such.
 *
 * `isNullifierSpentInSet` is deliberately NOT stubbed: it is pure, so the tests
 * exercise the production membership logic instead of a reimplementation of it.
 */
const chain = {
  spentNotes: [] as FixtureNote[],
  failingPools: new Set<string>(),
  calls: [] as string[],
};

vi.mock('./denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./denominatedPool')>();
  return {
    ...actual,
    fetchSpentNullifierSet: async (_conn: unknown, poolPDA: PublicKey) => {
      const pool58 = poolPDA.toBase58();
      chain.calls.push(pool58);
      if (chain.failingPools.has(pool58)) throw new Error('rpc 429');
      // Build the PDA set the real fetch would return, through the SAME
      // derivation the handler uses to test membership. A stub that shortcut
      // that derivation would pass while production disagreed.
      const set = new Set<string>();
      for (const n of chain.spentNotes) {
        const nullifier = actual.createNullifierV3(n.nullifierPreimage, n.secret);
        const [pda] = actual.deriveNullifierPDA(poolPDA, actual.goldilocksU64To32(nullifier));
        set.add(pda.toBase58());
      }
      return set;
    },
  };
});

// Imported after the mock so the handlers bind to the stub.
const { clearPoolState, configurePoolHandlers, handlePoolRequest, setPoolSeed } = await import(
  '../worker/poolHandlers'
);

beforeEach(() => {
  clearPoolState();
  chain.spentNotes = [SPENT_NOTE];
  chain.failingPools = new Set();
  chain.calls = [];
  configurePoolHandlers('http://localhost:8899');
  setPoolSeed(META, SIGNATURE, PASSPHRASE); // holds the salted AND legacy seeds
});

// ---------------------------------------------------------------------------

describe('poolResolveSpent', () => {
  it('answers spent/unspent from the chain, per local note', async () => {
    const res = await handlePoolRequest({
      kind: 'poolResolveSpent',
      meta: META,
      blobs: [blobFor(SALTED_SEED, SPENT_NOTE), blobFor(SALTED_SEED, LIVE_NOTE)],
    });

    expect(res.spent[`${POOL_58}:${SPENT_NOTE.leafIndex}`]).toBe(true);
    expect(res.spent[`${POOL_58}:${LIVE_NOTE.leafIndex}`]).toBe(false);
    expect(res.checked).toBe(2);
    expect(res.skipped).toBe(0);
    expect(res.unresolved).toBe(0);
  });

  it('reaches notes shielded before the passphrase, via the legacy seed', async () => {
    chain.spentNotes = [...chain.spentNotes, LEGACY_NOTE];
    const res = await handlePoolRequest({
      kind: 'poolResolveSpent',
      meta: META,
      blobs: [blobFor(LEGACY_SEED, LEGACY_NOTE)],
    });
    expect(res.spent[`${POOL_58}:${LEGACY_NOTE.leafIndex}`]).toBe(true);
    expect(res.checked).toBe(1);
  });

  it('skips blobs this identity cannot open, and says how many', async () => {
    const foreign = blobFor(new Uint8Array(32).fill(0x42), LIVE_NOTE);
    const res = await handlePoolRequest({
      kind: 'poolResolveSpent',
      meta: META,
      blobs: [foreign, blobFor(SALTED_SEED, LIVE_NOTE)],
    });
    expect(res.skipped).toBe(1);
    expect(res.checked).toBe(1);
    // A blob this identity cannot open never reaches the chain at all. The read
    // that does happen is POOL-wide, so it says nothing about which notes are
    // being resolved — that is the whole point of the shape.
    expect(chain.calls).toEqual([POOL_58]);
  });

  it('a failed chain read is unresolved and ABSENT from the map, not guessed', async () => {
    // Failure granularity is the POOL, not the note: one pool-wide read serves
    // every note in it, so when that read fails every note in that pool is
    // unknown. Absence from the map is what lets the consumer keep its one-way
    // rule (unspent -> spent only).
    chain.failingPools.add(POOL_58);
    const res = await handlePoolRequest({
      kind: 'poolResolveSpent',
      meta: META,
      blobs: [blobFor(SALTED_SEED, SPENT_NOTE), blobFor(SALTED_SEED, LIVE_NOTE)],
    });
    expect(res.unresolved).toBe(2);
    expect(res.checked).toBe(0);
    expect(`${POOL_58}:${LIVE_NOTE.leafIndex}` in res.spent).toBe(false);
    expect(`${POOL_58}:${SPENT_NOTE.leafIndex}` in res.spent).toBe(false);
  });

  it('reads a failing pool ONCE, not once per note', async () => {
    // Without a remembered failure the handler would retry the dead RPC for
    // every note in the pool, which is both slow and a burst the provider reads
    // as one client hammering one pool.
    chain.failingPools.add(POOL_58);
    await handlePoolRequest({
      kind: 'poolResolveSpent',
      meta: META,
      blobs: [blobFor(SALTED_SEED, SPENT_NOTE), blobFor(SALTED_SEED, LIVE_NOTE)],
    });
    expect(chain.calls).toEqual([POOL_58]);
  });

  it('checks a duplicated blob once', async () => {
    const blob = blobFor(SALTED_SEED, LIVE_NOTE);
    const res = await handlePoolRequest({
      kind: 'poolResolveSpent',
      meta: META,
      blobs: [blob, blob],
    });
    expect(res.checked).toBe(1);
    expect(chain.calls).toHaveLength(1);
  });

  it('asks the chain about the POOL, never about a note', async () => {
    // The regression this pins: resolving N notes must cost ONE pool-wide read,
    // not N nullifier-PDA lookups. The old shape handed the RPC the list of
    // notes this browser owned and had not yet spent, and days later one of
    // those PDAs appeared on chain — joining the two recovers the querying IP.
    const notes = [fixtureNote(11), fixtureNote(12), fixtureNote(13), fixtureNote(14)];
    const res = await handlePoolRequest({
      kind: 'poolResolveSpent',
      meta: META,
      blobs: notes.map((n) => blobFor(SALTED_SEED, n)),
    });
    expect(res.checked).toBe(4);
    expect(chain.calls).toEqual([POOL_58]);
  });
});

describe('poolLicenseKey', () => {
  const SERVICE_TAG = 'bitwarden-test';

  it('re-derives the exact key the subscribe flow returned', async () => {
    const res = await handlePoolRequest({
      kind: 'poolLicenseKey',
      meta: META,
      blobs: [blobFor(SALTED_SEED, LIVE_NOTE)],
      pool: POOL_58,
      leafIndex: LIVE_NOTE.leafIndex,
      serviceTag: SERVICE_TAG,
    });
    // Pinned against the license module, which is itself pinned to the frozen
    // cross-client vector: the same secret and tag must yield the same key a
    // merchant already accepted at purchase time.
    expect(res.licenseKey).toBe(licenseKeyForPrivate(LIVE_NOTE.secret, SERVICE_TAG));
    expect(res.licenseKey.startsWith('P01-')).toBe(true);
    expect(res.serviceTag).toBe(SERVICE_TAG);
  });

  it('scopes the key to the tag: a different tag yields a different key', async () => {
    const req = {
      kind: 'poolLicenseKey' as const,
      meta: META,
      blobs: [blobFor(SALTED_SEED, LIVE_NOTE)],
      pool: POOL_58,
      leafIndex: LIVE_NOTE.leafIndex,
    };
    const a = await handlePoolRequest({ ...req, serviceTag: 'service-a' });
    const b = await handlePoolRequest({ ...req, serviceTag: 'service-b' });
    expect(a.licenseKey).not.toBe(b.licenseKey);
  });

  it('finds the paying note under the legacy seed too', async () => {
    const res = await handlePoolRequest({
      kind: 'poolLicenseKey',
      meta: META,
      blobs: [blobFor(LEGACY_SEED, LEGACY_NOTE)],
      pool: POOL_58,
      leafIndex: LEGACY_NOTE.leafIndex,
      serviceTag: SERVICE_TAG,
    });
    expect(res.licenseKey).toBe(licenseKeyForPrivate(LEGACY_NOTE.secret, SERVICE_TAG));
  });

  it('a missing note fails with an explanation and leaks no key material', async () => {
    await expect(
      handlePoolRequest({
        kind: 'poolLicenseKey',
        meta: META,
        blobs: [blobFor(SALTED_SEED, LIVE_NOTE)],
        pool: POOL_58,
        leafIndex: 999, // no such local note
        serviceTag: SERVICE_TAG,
      }),
    ).rejects.toThrow(/does not hold the note/i);

    try {
      await handlePoolRequest({
        kind: 'poolLicenseKey',
        meta: META,
        blobs: [],
        pool: POOL_58,
        leafIndex: LIVE_NOTE.leafIndex,
        serviceTag: SERVICE_TAG,
      });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toMatch(/P01-/);
    }
  });
});

// ---------------------------------------------------------------------------
// The tag is verified against the vault's commitment, never trusted.
//
// A record rebuilt after a loss (recovery scan, track-by-address) guessed the
// tag from a (retailer, mint) registry join. Two slugs on one retailer, or a
// paused or removed listing, and the key derived under the guess hashed to
// nothing on chain: `verifyMerchantLicense` refused a paid-for subscription.
// With `licenseCommitment` on the request the handler tries the stored tag,
// then every candidate, and answers only under the one the chain confirms.
// ---------------------------------------------------------------------------

describe('poolLicenseKey verifies the tag against the vault commitment', () => {
  const RETAILER = 'q8R2oNtnCH1Y3Pgjm8okR1Vz6wuxwMwPyoCxm5emLdr';
  /** What the subscribe path posted on chain for a purchase under `tag`. */
  const onChainFor = (tag: string) =>
    bytesToHex(licenseCommitment(deriveLicenseSecret(LIVE_NOTE.secret, tag)));

  const base = {
    kind: 'poolLicenseKey' as const,
    meta: META,
    pool: POOL_58,
    leafIndex: LIVE_NOTE.leafIndex,
  };

  it('two listings on one (retailer, mint): the key comes back under the slug the vault was bought under', async () => {
    // Bought under acme-pro; the rebuilt record carries the join's first
    // match, acme-basic.
    const res = await handlePoolRequest({
      ...base,
      blobs: [blobFor(SALTED_SEED, LIVE_NOTE)],
      serviceTag: 'acme-basic',
      candidateTags: ['acme-basic', 'acme-pro', RETAILER],
      licenseCommitment: onChainFor('acme-pro'),
    });
    expect(res.serviceTag).toBe('acme-pro');
    expect(res.licenseKey).toBe(licenseKeyForPrivate(LIVE_NOTE.secret, 'acme-pro'));
    // The merchant's own check on the key shown: blake3 of the decoded key
    // equals the vault's commitment.
    expect(bytesToHex(licenseCommitment(decodeLicenseKey(res.licenseKey)))).toBe(
      onChainFor('acme-pro'),
    );
  });

  it('a stored tag that matches is accepted first', async () => {
    const res = await handlePoolRequest({
      ...base,
      blobs: [blobFor(SALTED_SEED, LIVE_NOTE)],
      serviceTag: 'acme-pro',
      candidateTags: ['acme-basic', 'acme-pro', RETAILER],
      licenseCommitment: onChainFor('acme-pro'),
    });
    expect(res.serviceTag).toBe('acme-pro');
    expect(res.licenseKey).toBe(licenseKeyForPrivate(LIVE_NOTE.secret, 'acme-pro'));
  });

  it('the retailer-address fallback is reached when no slug matches', async () => {
    const res = await handlePoolRequest({
      ...base,
      blobs: [blobFor(LEGACY_SEED, LIVE_NOTE)],
      serviceTag: 'acme-basic',
      candidateTags: [RETAILER],
      licenseCommitment: onChainFor(RETAILER),
    });
    expect(res.serviceTag).toBe(RETAILER);
  });

  it('no candidate matches: no key, a stated verdict, no key material in the message', async () => {
    const req = {
      ...base,
      blobs: [blobFor(SALTED_SEED, LIVE_NOTE)],
      serviceTag: 'acme-basic',
      candidateTags: ['acme-basic', RETAILER],
      licenseCommitment: onChainFor('acme-pro'), // the listing was removed since
    };
    await expect(handlePoolRequest(req)).rejects.toThrow(
      /^key not recoverable for this subscription/,
    );
    try {
      await handlePoolRequest(req);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toMatch(/P01-/);
      expect((e as Error).message).not.toContain(LIVE_NOTE.secret.toString());
    }
  });

  it('a vault storing no commitment verifies no key', async () => {
    await expect(
      handlePoolRequest({
        ...base,
        blobs: [blobFor(SALTED_SEED, LIVE_NOTE)],
        serviceTag: 'acme-basic',
        candidateTags: ['acme-basic', RETAILER],
        licenseCommitment: null,
      }),
    ).rejects.toThrow(/^key not recoverable for this subscription/);
  });

  it('an older caller that sends no commitment still derives under the stored tag', async () => {
    // Backward compatibility of the wire: the field is optional, and its
    // absence means "no chain value to check against", not "refuse".
    const res = await handlePoolRequest({
      ...base,
      blobs: [blobFor(SALTED_SEED, LIVE_NOTE)],
      serviceTag: 'acme-basic',
    });
    expect(res.serviceTag).toBe('acme-basic');
    expect(res.licenseKey).toBe(licenseKeyForPrivate(LIVE_NOTE.secret, 'acme-basic'));
  });
});
