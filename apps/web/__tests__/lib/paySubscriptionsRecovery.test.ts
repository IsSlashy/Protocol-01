/**
 * `recoverSubscriptions` — the main-thread half of the #11 vault recovery.
 *
 * The SCAN itself (enumeration, matching, the leak-regression contract) is
 * pinned in `lib/privacy/pool/subscriptionRecovery.test.ts` under the pool
 * suite. This file is about what the page does with the wire result:
 *
 *   - a recovered vault becomes a real store record, with the serviceTag the
 *     worker VERIFIED against the vault's license commitment when the wire
 *     carries one, else (older worker, or nothing matched) the registry join
 *     by (retailer, mint) and the retailer-address fallback `licenseServiceTag`
 *     defines, as a label the Reveal path re-checks before showing a key;
 *   - the roster reaches the worker as public strings, names left behind;
 *   - a vault this browser already tracks is NOT overwritten — the recovered
 *     record has no cosmetics, and clobbering serviceName/openTxSig would turn
 *     a recovery into a small loss;
 *   - an empty scan writes nothing and does not throw;
 *   - a version-skewed worker (no `subscriptions` field in the response, or a
 *     worker so old the handler is unknown) surfaces as `StaleWorkerError` —
 *     NEVER as "nothing found": the panel turns an empty result into "no open
 *     subscription vault on chain belongs to this wallet's notes", which a
 *     worker that never scanned cannot honestly claim (task #12).
 *
 * The worker is faked with the real noteCrypto primitives, the same pattern as
 * `paySubscriptions.test.ts`.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex as nobleHex, utf8ToBytes } from '@noble/hashes/utils.js';

import { createNoteEncryptionAddress, decryptNote } from '@/lib/privacy/pool/noteCrypto';

function seedFor(meta: string): Uint8Array {
  return sha256(utf8ToBytes(`test-seed:${meta}`));
}

/** What the fake worker answers to `poolRecoverSubscriptions`; tests set it.
 *  An `Error` value is THROWN instead, for the worker-predates-the-handler
 *  skew case. */
let recoverResponse: Record<string, unknown> | Error = { kind: 'poolRecoverSubscriptions' };
/** Blobs the last recovery request carried, for the pass-through assertion. */
let lastRecoverBlobs: string[] | undefined;
/** Registry listings the last recovery request carried. */
let lastRecoverServices: unknown;

vi.mock('@/lib/privacy/workerClient', () => ({
  poolRequest: vi.fn(async (req: { kind: string; meta: string; blobs?: string[]; services?: unknown }) => {
    const seed = seedFor(req.meta);
    if (req.kind === 'poolStoreLabel') {
      return {
        kind: 'poolStoreLabel',
        label: nobleHex(sha256(seed)).slice(0, 32),
        legacyAddress: createNoteEncryptionAddress(seed),
      };
    }
    if (req.kind === 'poolNoteAddress') {
      return { kind: 'poolNoteAddress', address: createNoteEncryptionAddress(seed) };
    }
    if (req.kind === 'poolOpenRecords') {
      const subscriptions: unknown[] = [];
      for (const blob of req.blobs ?? []) {
        try {
          const rec = JSON.parse(new TextDecoder().decode(decryptNote(seed, blob)));
          if (rec.p01store === 1 && rec.kind === 'subscription') subscriptions.push(rec);
        } catch {
          // not this identity's blob
        }
      }
      return {
        kind: 'poolOpenRecords',
        payouts: [],
        spentKeys: [],
        handoffs: [],
        subscriptions,
        skipped: 0,
      };
    }
    if (req.kind === 'poolRecoverSubscriptions') {
      lastRecoverBlobs = req.blobs;
      lastRecoverServices = req.services;
      if (recoverResponse instanceof Error) throw recoverResponse;
      return recoverResponse;
    }
    throw new Error(`unexpected pool request: ${req.kind}`);
  }),
}));

import {
  loadSubscriptions,
  recordSubscription,
  recoverSubscriptions,
} from '@/lib/pay/subscriptions';
import { StaleWorkerError } from '@/lib/privacy/sealedStore';

const META = 'meta-recovery';
const WALLET = 'wallet-recovery';

/** One recovered vault, as the worker whitelists it. */
const WIRE = {
  vaultPDA: '7WaBm7Kq5WDYa5ykFgaUes1ZCXHXqkyfquJEkmBxzyqw',
  retailer: 'q8R2oNtnCH1Y3Pgjm8okR1Vz6wuxwMwPyoCxm5emLdr',
  tokenMint: '11111111111111111111111111111111',
  token: 'SOL',
  denomination: 0.1,
  rate: '100000000',
  intervalSlots: '1500',
  pool: 'HfSsGRgVFJGBiiEtRXrHocNPw5dyTQ78hEZH8GWpXaAG',
  leafIndex: 7,
};

beforeEach(() => {
  localStorage.clear();
  recoverResponse = { kind: 'poolRecoverSubscriptions', subscriptions: [], vaultsScanned: 0 };
  lastRecoverBlobs = undefined;
  lastRecoverServices = undefined;
});

describe('recoverSubscriptions: the serviceTag is the one verified against the chain', () => {
  const TWO_SLUGS = [
    { slug: 'acme-basic', name: 'Acme Basic', retailer: WIRE.retailer, tokenMint: WIRE.tokenMint },
    { slug: 'acme-pro', name: 'Acme Pro', retailer: WIRE.retailer, tokenMint: WIRE.tokenMint },
  ];

  it('stores the tag the worker verified, not the join\'s first match, and its name', async () => {
    // Two listings on one (retailer, mint). The join takes acme-basic; the
    // worker, holding the note secret and the vault's commitment, says acme-pro.
    recoverResponse = {
      kind: 'poolRecoverSubscriptions',
      subscriptions: [{ ...WIRE, licenseCommitment: 'ab'.repeat(32), serviceTag: 'acme-pro' }],
      vaultsScanned: 1,
    };
    const res = await recoverSubscriptions(META, WALLET, { services: TWO_SLUGS });
    expect(res.recovered[0].serviceTag).toBe('acme-pro');
    expect(res.recovered[0].serviceName).toBe('Acme Pro');

    const listed = (await loadSubscriptions(META, WALLET)).records;
    expect(listed[0]).toMatchObject({ serviceTag: 'acme-pro', serviceName: 'Acme Pro' });

    // The roster reached the worker as public strings; names stayed here.
    expect(lastRecoverServices).toEqual([
      { slug: 'acme-basic', retailer: WIRE.retailer, tokenMint: WIRE.tokenMint },
      { slug: 'acme-pro', retailer: WIRE.retailer, tokenMint: WIRE.tokenMint },
    ]);
  });

  it('a verified tag outside the roster (retailer address, no registry) is stored as is', async () => {
    recoverResponse = {
      kind: 'poolRecoverSubscriptions',
      subscriptions: [{ ...WIRE, licenseCommitment: 'ab'.repeat(32), serviceTag: WIRE.retailer }],
      vaultsScanned: 1,
    };
    const res = await recoverSubscriptions(META, WALLET, { services: TWO_SLUGS });
    expect(res.recovered[0].serviceTag).toBe(WIRE.retailer);
    expect(res.recovered[0].serviceName).toBeUndefined();
  });

  it('a worker that matched nothing (null) leaves the join as a label; Reveal re-checks it', async () => {
    recoverResponse = {
      kind: 'poolRecoverSubscriptions',
      subscriptions: [{ ...WIRE, licenseCommitment: null, serviceTag: null }],
      vaultsScanned: 1,
    };
    const res = await recoverSubscriptions(META, WALLET, { services: TWO_SLUGS });
    expect(res.recovered[0].serviceTag).toBe('acme-basic');
    expect(res.recovered[0].serviceName).toBe('Acme Basic');
    // The record still carries what Reveal needs to verify against the chain.
    expect(res.recovered[0]).toMatchObject({ pool: WIRE.pool, leafIndex: WIRE.leafIndex });
  });
});

describe('recoverSubscriptions — records what the scan found', () => {
  it('writes a store record with the registry serviceTag and name', async () => {
    recoverResponse = {
      kind: 'poolRecoverSubscriptions',
      subscriptions: [WIRE],
      vaultsScanned: 3,
    };
    const res = await recoverSubscriptions(META, WALLET, {
      blobs: ['blob-1', 'blob-2'],
      services: [
        // Same retailer, WRONG mint: must not match — the join is (retailer, mint).
        { slug: 'acme-usdc', retailer: WIRE.retailer, tokenMint: 'SomeUsdcMint111' },
        { slug: 'acme-sol', name: 'Acme SOL', retailer: WIRE.retailer, tokenMint: WIRE.tokenMint },
      ],
    });

    expect(res.vaultsScanned).toBe(3);
    expect(res.alreadyTracked).toBe(0);
    expect(res.recovered).toHaveLength(1);
    expect(res.recovered[0].serviceTag).toBe('acme-sol');
    expect(res.recovered[0].serviceName).toBe('Acme SOL');
    // The blobs reached the worker: without them a received-note subscription
    // is invisible to the scan.
    expect(lastRecoverBlobs).toEqual(['blob-1', 'blob-2']);

    const listed = (await loadSubscriptions(META, WALLET)).records;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      vaultPDA: WIRE.vaultPDA,
      retailer: WIRE.retailer,
      serviceTag: 'acme-sol',
      serviceName: 'Acme SOL',
      token: 'SOL',
      denomination: 0.1,
      rate: WIRE.rate,
      intervalSlots: WIRE.intervalSlots,
      pool: WIRE.pool,
      leafIndex: WIRE.leafIndex,
    });
    // The unrecoverable cosmetic stays absent rather than fabricated.
    expect(listed[0].openTxSig).toBeUndefined();
  });

  it('falls back to the retailer address as serviceTag when no listing matches', async () => {
    recoverResponse = {
      kind: 'poolRecoverSubscriptions',
      subscriptions: [WIRE],
      vaultsScanned: 1,
    };
    const res = await recoverSubscriptions(META, WALLET, { services: [] });
    expect(res.recovered[0].serviceTag).toBe(WIRE.retailer);
    expect(res.recovered[0].serviceName).toBeUndefined();
  });

  it('leaves an already-tracked vault untouched, cosmetics included', async () => {
    await recordSubscription(META, WALLET, {
      vaultPDA: WIRE.vaultPDA,
      retailer: WIRE.retailer,
      serviceTag: 'acme-sol',
      serviceName: 'Original Name',
      token: 'SOL',
      denomination: 0.1,
      rate: WIRE.rate,
      intervalSlots: WIRE.intervalSlots,
      openTxSig: 'OriginalTxSig',
      pool: WIRE.pool,
      leafIndex: WIRE.leafIndex,
      openedAt: 1_000,
    });
    recoverResponse = {
      kind: 'poolRecoverSubscriptions',
      subscriptions: [WIRE],
      vaultsScanned: 1,
    };

    const res = await recoverSubscriptions(META, WALLET, {});
    expect(res.recovered).toEqual([]);
    expect(res.alreadyTracked).toBe(1);

    const listed = (await loadSubscriptions(META, WALLET)).records;
    expect(listed).toHaveLength(1);
    expect(listed[0].serviceName).toBe('Original Name');
    expect(listed[0].openTxSig).toBe('OriginalTxSig');
    expect(listed[0].openedAt).toBe(1_000);
  });

  it('an empty scan writes nothing and does not throw', async () => {
    const res = await recoverSubscriptions(META, WALLET, {});
    expect(res).toEqual({ recovered: [], alreadyTracked: 0, vaultsScanned: 0 });
    expect((await loadSubscriptions(META, WALLET)).records).toEqual([]);
  });

  // The two skew shapes (task #12). The empty-scan test above is the contrast:
  // `subscriptions: []` from a current worker IS "nothing found"; the absence
  // of the field, or of the whole handler, is a worker that never scanned.
  it('a skewed worker answering without the field surfaces as StaleWorkerError, not "nothing found"', async () => {
    recoverResponse = { kind: 'poolRecoverSubscriptions' }; // old worker: no fields
    await expect(recoverSubscriptions(META, WALLET, {})).rejects.toThrow(StaleWorkerError);
    // The message is what the panel shows the user; it must carry the remedy.
    await expect(recoverSubscriptions(META, WALLET, {})).rejects.toThrow(/[Rr]eload the page/);
    expect((await loadSubscriptions(META, WALLET)).records).toEqual([]);
  });

  it('a worker predating the handler ("Unknown pool request") maps to the same stated error', async () => {
    recoverResponse = new Error('Unknown pool request: {"kind":"poolRecoverSubscriptions"}');
    await expect(recoverSubscriptions(META, WALLET, {})).rejects.toThrow(StaleWorkerError);
  });

  it('any other worker failure keeps its own message — skew must not swallow real errors', async () => {
    recoverResponse = new Error('RPC node returned 429');
    await expect(recoverSubscriptions(META, WALLET, {})).rejects.toThrow('RPC node returned 429');
  });
});
