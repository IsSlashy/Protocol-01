/**
 * poolHandlers — progressive scan plumbing.
 *
 * `denominatedPool.test.ts` proves the CRYPTO of the two passes (the blinded
 * single hash finds a current-scheme note, only the epoch search finds a
 * legacy one). This file proves the WIRING: `handlePoolScan` emits the blinded
 * pass's notes as an interim result BEFORE the legacy epoch search runs, marks
 * every interim `complete: false`, and only the terminal response — the one
 * that has run the legacy pass — says `complete: true`.
 *
 * That ordering is the entire fix for the measured 41-82 s page-load scan
 * (0.1158 ms per hash x 6000 epochs x 59 foreign leaves per derivation), and
 * the `complete` flags are what keep the fast paint honest: an interim
 * presented as the full picture would make a legacy note read as lost money.
 *
 * Everything that touches the chain is stubbed, mirroring
 * `poolHandlersDerivation.test.ts`. Runs under `vitest.pool.config.mts` (node).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PoolConfig } from './denominatedPool';
import type { RecoveredNote } from './poolNotes';
import type { PoolScanResponse } from '../worker/poolHandlers';

const SIGNATURE = new Uint8Array(64);
for (let i = 0; i < 64; i++) SIGNATURE[i] = (i * 7 + 3) & 0xff;

const META = 'progressive-scan-meta';
const DENOM = 0.1;

/** Every pool owns a current-scheme note at leaf 5 and a legacy one at leaf 9. */
const BLINDED_LEAF = 5;
const LEGACY_LEAF = 9;

/** Call order across the stubbed scan passes and the interim emissions. */
const events: string[] = [];

function note(pool: PoolConfig, leafIndex: number): RecoveredNote {
  return {
    counter: leafIndex,
    spent: false,
    receipt: {
      secret: BigInt(leafIndex * 1000 + 1),
      nullifierPreimage: BigInt(leafIndex * 1000 + 2),
      noteBlinding: 7n,
      tokenMint: 0n,
      commitment: BigInt(leafIndex * 1000 + 3),
      leafIndex,
      denomination: pool.denominationAtomic,
      pool: pool.poolPDA.toBase58(),
      token: pool.token,
      denominationHuman: pool.denomination,
      shieldedAt: 0,
      source: 'shielded',
    },
  };
}

vi.mock('./poolNotes', () => ({
  // The phase behaviour under test: the blinded pass can only see the
  // current-scheme note; the full pass (with the legacy epoch search) sees
  // both — including the blinded one AGAIN, which is what makes the handler's
  // leaf dedupe observable.
  scanPoolForSeed: async (
    _c: unknown,
    pool: PoolConfig,
    _seed: Uint8Array,
    opts?: { blindedOnly?: boolean },
  ) => {
    events.push(`scan:${pool.denomination}:${opts?.blindedOnly ? 'blinded' : 'full'}`);
    return {
      notes: opts?.blindedOnly
        ? [note(pool, BLINDED_LEAF)]
        : [note(pool, BLINDED_LEAF), note(pool, LEGACY_LEAF)],
    };
  },
  recoverNotes: async () => [],
}));

vi.mock('./recoverFloat', () => ({
  recoverStuckFloat: async () => [],
}));

vi.mock('./shieldEphemeral', () => ({
  readTreeLeafCount: async () => 30,
  prepareShield: async () => {
    throw new Error('not exercised');
  },
  executeShield: async () => {
    throw new Error('not exercised');
  },
  recordShieldBreadcrumb: async () => undefined,
}));

vi.mock('./noteCrypto', () => ({
  createNoteEncryptionAddress: () => 'addr',
  encryptNote: () => 'blob',
  decryptNote: () => {
    throw new Error('not ours');
  },
  isEncryptedNoteBlob: (s: string) => s.startsWith('p01enc1:'),
  isNoteEncryptionAddress: (s: string) => s.startsWith('p01pq:'),
}));

vi.mock('./unshieldEphemeral', () => ({
  prepareUnshieldJob: async () => {
    throw new Error('not exercised');
  },
  executeUnshield: async () => {
    throw new Error('not exercised');
  },
}));

vi.mock('./denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./denominatedPool')>();
  return {
    ...actual,
    fetchPoolCommitments: async () => new Map(),
    fetchSpentNullifierSet: async () => new Set<string>(),
    readPoolUnspentCount: async () => 7,
    // ⚠️ The default scan was narrowed to 1 SOL on 2026-08-28, and this file
    // measures a property that needs MORE THAN ONE pool to exist: that the
    // first paint lands after ONE pool's blinded pass, and that no legacy
    // search starts before the last blinded one. Left alone, every multi-pool
    // test here would go green while proving nothing — which its own
    // `expect(pools.length).toBeGreaterThan(1)` says out loud.
    //
    // So the SELECTOR is widened here, never the loop under test. Which pools
    // the policy actually picks is pinned in poolDepositsClosed.test.ts; this
    // file is about the order the loop walks them in.
    getPoolsToScanByDefault: (token: 'SOL' | 'USDC') => actual.getPoolsForTokenV3(token),
  };
});

// Imported after the mocks so the handler binds to the stubs.
const { clearPoolState, configurePoolHandlers, handlePoolRequest, setPoolSeed } = await import(
  '../worker/poolHandlers'
);
const { getPoolsForTokenV3 } = await import('./denominatedPool');

beforeEach(() => {
  clearPoolState();
  events.length = 0;
  configurePoolHandlers('http://localhost:8899');
  setPoolSeed(META, SIGNATURE);
});

describe('progressive scan: blinded results are emitted before the legacy pass', () => {
  it('emits an incomplete interim after the blinded pass, before any legacy search runs', async () => {
    const interims: PoolScanResponse[] = [];
    const res = await handlePoolRequest(
      { kind: 'poolScan', meta: META, token: 'SOL', denomination: DENOM },
      undefined,
      (partial) => {
        events.push(`interim:${(partial as PoolScanResponse).complete}`);
        interims.push(partial as PoolScanResponse);
      },
    );

    // THE ordering under test: the first interim lands strictly before the
    // first full (legacy-searching) pass starts.
    const firstInterim = events.findIndex((e) => e.startsWith('interim:'));
    const firstFull = events.findIndex((e) => e.endsWith(':full'));
    expect(firstInterim).toBeGreaterThanOrEqual(0);
    expect(firstFull).toBeGreaterThanOrEqual(0);
    expect(firstInterim).toBeLessThan(firstFull);

    // The interim carries the blinded note, a real balance, and says of
    // ITSELF that it is not the full picture.
    expect(interims[0].complete).toBe(false);
    expect(interims[0].notes.map((n) => n.leafIndex)).toEqual([BLINDED_LEAF]);
    expect(interims[0].shieldedBalance).toBe(DENOM);

    // The terminal response has run the legacy pass: both notes, counted
    // once each (the full pass returned the blinded note a second time), and
    // only IT claims completeness.
    expect(res.complete).toBe(true);
    expect(res.notes.map((n) => n.leafIndex).sort((a, b) => a - b)).toEqual([
      BLINDED_LEAF,
      LEGACY_LEAF,
    ]);
    expect(res.shieldedBalance).toBeCloseTo(DENOM * 2, 10);

    // No interim ever claimed completeness.
    for (const p of interims) expect(p.complete).toBe(false);
  });

  it('interim payloads are snapshots — later passes must not mutate what was already painted', async () => {
    const interims: PoolScanResponse[] = [];
    await handlePoolRequest(
      { kind: 'poolScan', meta: META, token: 'SOL', denomination: DENOM },
      undefined,
      (partial) => interims.push(partial as PoolScanResponse),
    );
    // The first interim was emitted with exactly the blinded note; if the
    // handler had handed out its live array, the legacy pass would have
    // appended into the consumer's copy after the fact.
    expect(interims[0].notes.map((n) => n.leafIndex)).toEqual([BLINDED_LEAF]);
  });

  it('scanning every pool: the first paint needs ONE pool walked, and no legacy search precedes any blinded pass', async () => {
    const pools = getPoolsForTokenV3('SOL');
    expect(pools.length).toBeGreaterThan(1); // otherwise this proves nothing

    const interims: PoolScanResponse[] = [];
    const res = await handlePoolRequest(
      { kind: 'poolScan', meta: META, token: 'SOL' },
      undefined,
      (partial) => {
        events.push(`interim:${(partial as PoolScanResponse).complete}`);
        interims.push(partial as PoolScanResponse);
      },
    );

    // First interim after exactly one pool's blinded pass — the page paints
    // as soon as the first pool is walked, not after the last.
    const firstInterim = events.findIndex((e) => e.startsWith('interim:'));
    expect(events.slice(0, firstInterim)).toEqual([`scan:${pools[0].denomination}:blinded`]);

    // Phase separation holds across pools: every blinded pass runs before any
    // legacy search starts, so slow pools cannot delay the paint of fast ones.
    const lastBlinded = events.reduce(
      (acc, e, i) => (e.endsWith(':blinded') ? i : acc),
      -1,
    );
    const firstFull = events.findIndex((e) => e.endsWith(':full'));
    expect(lastBlinded).toBeLessThan(firstFull);

    // One interim per pool per phase, all incomplete; the terminal response
    // alone is complete, with both notes of every pool counted once.
    expect(interims.length).toBe(pools.length * 2);
    for (const p of interims) expect(p.complete).toBe(false);
    expect(res.complete).toBe(true);
    expect(res.notes.length).toBe(pools.length * 2);
  });
});
