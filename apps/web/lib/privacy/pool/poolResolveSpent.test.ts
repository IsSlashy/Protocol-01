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
 * as shield writes them. Only `isNullifierSpent` is stubbed — it is the one
 * chain read.
 *
 * Runs under `vitest.pool.config.mts` (node).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import { derivePoolSeedLegacy, derivePoolSeedSalted } from './seedDerivation';
import { findPoolV3 } from './denominatedPool';
import { createNoteEncryptionAddress, encryptNote } from './noteCrypto';
import { licenseKeyForPrivate } from '../license';

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

/** Mutable chain state the `isNullifierSpent` stub answers from. */
const chain = {
  spentPreimages: new Set<string>(),
  failingPreimages: new Set<string>(),
  calls: [] as string[],
};

vi.mock('./denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./denominatedPool')>();
  return {
    ...actual,
    isNullifierSpent: async (
      _conn: unknown,
      _pool: unknown,
      nullifierPreimage: bigint,
      _secret: bigint,
    ) => {
      const key = nullifierPreimage.toString();
      chain.calls.push(key);
      if (chain.failingPreimages.has(key)) throw new Error('rpc 429');
      return chain.spentPreimages.has(key);
    },
  };
});

// Imported after the mock so the handlers bind to the stub.
const { clearPoolState, configurePoolHandlers, handlePoolRequest, setPoolSeed } = await import(
  '../worker/poolHandlers'
);

beforeEach(() => {
  clearPoolState();
  chain.spentPreimages = new Set([SPENT_NOTE.nullifierPreimage.toString()]);
  chain.failingPreimages = new Set();
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
    chain.spentPreimages.add(LEGACY_NOTE.nullifierPreimage.toString());
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
    // The foreign note was never checked against the chain.
    expect(chain.calls).toEqual([LIVE_NOTE.nullifierPreimage.toString()]);
  });

  it('a failed chain read is unresolved and ABSENT from the map, not guessed', async () => {
    chain.failingPreimages.add(LIVE_NOTE.nullifierPreimage.toString());
    const res = await handlePoolRequest({
      kind: 'poolResolveSpent',
      meta: META,
      blobs: [blobFor(SALTED_SEED, SPENT_NOTE), blobFor(SALTED_SEED, LIVE_NOTE)],
    });
    expect(res.unresolved).toBe(1);
    expect(res.checked).toBe(1);
    expect(`${POOL_58}:${LIVE_NOTE.leafIndex}` in res.spent).toBe(false);
    expect(res.spent[`${POOL_58}:${SPENT_NOTE.leafIndex}`]).toBe(true);
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
