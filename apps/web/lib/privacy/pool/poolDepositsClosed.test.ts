/**
 * PORTE 3 — a pool closed to NEW deposits, enforced where the deposit is built.
 *
 * WHY THIS FILE EXISTS, AND WHAT THE PREVIOUS ROUND SHIPPED
 * ────────────────────────────────────────────────────────
 * A `deposits: 'closed'` flag was added once before and only a React chip read
 * it. The deposit ENGINE never looked at it, so the flag was fail-OPEN for every
 * caller that was not that one view — a script, the live devnet harness, a
 * future client, or the same page reached through a different button. A guard
 * that one view honours is not a guard; it is a label.
 *
 * So the assertions here are deliberately made against
 * `handlePoolRequest({ kind: 'poolShieldPrepare' })` — the worker handler that
 * every deposit path goes through — and NOT against any component. The first
 * test additionally pins that `prepareShield` is never reached, because a
 * refusal that happens after the tree read and the ~2-minute C6 proof is a
 * refusal the user pays for.
 *
 * ⛔ THE OTHER HALF, WHICH IS FUND LOSS IF IT REGRESSES. Closing the entrance
 * must not close the exit. The 0.1 SOL pool holds 10 UNSPENT notes (1.0 SOL,
 * measured on chain 2026-08-20) and the 100/500/1000 SOL pools are still
 * addressable objects on chain. Scanning, note-blob resolution, spending,
 * subscribing and float recovery MUST keep enumerating every pool, open or
 * closed — `handleRecover` in PoolPanel was once keyed to the denomination
 * selector and told a user with ~1 SOL stranded in the 0.1 pool that nothing
 * was stranded. Tests 2-4 below are that half.
 *
 * Everything that touches the chain is stubbed; what is asserted is which pool
 * reached which call. Runs under `vitest.pool.config.mts` (node).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';

import {
  ALL_POOLS_V3,
  SOL_POOLS_V3,
  USDC_POOLS_V3,
  findPoolV3,
  getPoolsForTokenV3,
  type PoolConfig,
} from './denominatedPool';
// Namespace import ON PURPOSE: the closure helpers do not exist yet, and a
// named import of a missing export fails the whole module link — every test in
// the file would error identically instead of each one failing for its own
// reason. Reading them off the namespace keeps the failures granular.
import * as denominatedPool from './denominatedPool';

// ---------------------------------------------------------------------------
// Fixtures — the live V3 SOL pools, read on chain 2026-08-20
// ---------------------------------------------------------------------------

/** 39 leaves, 10 UNSPENT notes (1.0 SOL). CLOSED to new deposits, and its
 *  notes must stay visible and spendable forever. */
const POOL_0_1 = 'HfSsGRgVFJGBiiEtRXrHocNPw5dyTQ78hEZH8GWpXaAG';
/** 34 leaves, 11 UNSPENT notes. THE DEMO POOL — the one pool that stays open. */
const POOL_1 = '6NUS4E5PhQLxnYca6mCVGs3HcwXcgF1qEZtzm392jrBS';
/** 0 leaves, and over the relay's 2.5 SOL cap: a deposit here takes the money
 *  and delivers nothing, 100% of the time. */
const POOL_10 = 'H91CcAemoNktnW785XfnMjQqwThRNe127X5c2XuwtvwQ';

const SIGNATURE = new Uint8Array(64);
for (let i = 0; i < 64; i++) SIGNATURE[i] = (i * 7 + 3) & 0xff;

const META = 'meta-under-test';
const OWNER = new PublicKey('7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU');

/** `deposits` read defensively: the field does not exist yet, so this reports
 *  the truth today (nothing is closed) instead of failing to compile. */
function isClosed(pool: PoolConfig): boolean {
  return (pool as { deposits?: string }).deposits === 'closed';
}

/** Which pool reached which stubbed entry point, by pool PDA, in call order. */
const seen = {
  prepareShield: [] as string[],
  scanned: [] as string[],
  stuckFloat: [] as string[],
};

// ---------------------------------------------------------------------------
// Chain stubs
// ---------------------------------------------------------------------------

vi.mock('./poolNotes', () => ({
  scanPoolForSeed: async (_c: unknown, pool: PoolConfig) => {
    seen.scanned.push(pool.poolPDA.toBase58());
    return { notes: [] };
  },
  recoverNotes: async () => [],
}));

vi.mock('./recoverFloat', () => ({
  recoverStuckFloat: async (
    _c: unknown,
    pool: PoolConfig,
    _seed: Uint8Array,
    owner: { toBase58(): string },
  ) => {
    seen.stuckFloat.push(pool.poolPDA.toBase58());
    return [{ lamports: 1000, closedBuffers: 1, destination: owner.toBase58() }];
  },
  refusalSentence: () => 'mocked',
}));

vi.mock('./shieldEphemeral', () => ({
  readTreeLeafCount: async () => 30,
  prepareShield: async (pool: PoolConfig) => {
    seen.prepareShield.push(pool.poolPDA.toBase58());
    return {
      jobId: `shield:${pool.poolPDA.toBase58()}:30`,
      poolConfig: pool,
      ephemeral: { publicKey: { toBase58: () => 'EPHEMERAL' } },
      requiredLamports: 1_573_486_080,
      valueLamports: 1_003_475_300,
      prepared: {
        insertParams: { leafIndex: 30 },
        merklePath: { pathElements: [1n, 2n], pathIndices: [0, 1], root: 5n },
      },
    };
  },
  executeShield: async () => {
    throw new Error('not exercised');
  },
  recordShieldBreadcrumb: async () => undefined,
}));

vi.mock('./noteCrypto', () => ({
  createNoteEncryptionAddress: () => 'addr:test',
  encryptNote: (address: string) => `blob-for:${address}`,
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
  };
});

// Imported after the mocks so the handler binds to the stubs.
const { clearPoolState, configurePoolHandlers, handlePoolRequest, setPoolSeed } =
  await import('../worker/poolHandlers');

beforeEach(() => {
  clearPoolState();
  seen.prepareShield = [];
  seen.scanned = [];
  seen.stuckFloat = [];
  configurePoolHandlers('http://localhost:8899');
  setPoolSeed(META, SIGNATURE);
});

// ---------------------------------------------------------------------------
// 1. The refusal lives in the engine, not in a view
// ---------------------------------------------------------------------------

describe('the deposit engine refuses a closed pool', () => {
  it('rejects poolShieldPrepare for the closed 0.1 SOL pool, before any work', async () => {
    const err = await handlePoolRequest({
      kind: 'poolShieldPrepare',
      meta: META,
      token: 'SOL',
      denomination: 0.1,
    }).then(
      () => null,
      (e: Error) => e,
    );

    expect(err, 'a closed pool must refuse the deposit, not prepare one').not.toBeNull();
    // Typed and NAMED: callers across the worker boundary see a string, not an
    // instanceof, so the name is the contract.
    expect(err!.name).toBe('PoolClosedToDepositsError');
    // The message has two jobs, and the second is the one that stops a user
    // believing their existing notes died with the entrance.
    expect(err!.message).toMatch(/closed to new deposits/i);
    expect(err!.message).toMatch(/spend|spendable|withdraw/i);

    // The refusal must cost nothing: no tree read, no ~2-minute C6 proof, no
    // ephemeral derived, no breadcrumb written.
    expect(seen.prepareShield).toEqual([]);
  });

  it('rejects every closed SOL denomination and every USDC one', async () => {
    for (const denomination of [10, 100, 500, 1000]) {
      const err = await handlePoolRequest({
        kind: 'poolShieldPrepare',
        meta: META,
        token: 'SOL',
        denomination,
      }).then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.name, `${denomination} SOL must be refused`).toBe(
        'PoolClosedToDepositsError',
      );
    }

    // USDC has no funded relay leg at all — every USDC pool is closed.
    for (const pool of USDC_POOLS_V3) {
      const err = await handlePoolRequest({
        kind: 'poolShieldPrepare',
        meta: META,
        token: 'USDC',
        denomination: pool.denomination,
      }).then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.name, `${pool.denomination} USDC must be refused`).toBe(
        'PoolClosedToDepositsError',
      );
    }

    expect(seen.prepareShield).toEqual([]);
  });

  it('still prepares a deposit into the 1 SOL pool — the frozen demo journey', async () => {
    const res = await handlePoolRequest({
      kind: 'poolShieldPrepare',
      meta: META,
      token: 'SOL',
      denomination: 1,
    });

    expect(res.kind).toBe('poolShieldPrepare');
    expect(res.denomination).toBe(1);
    // The one pool that stays open must reach the real preparation path. A
    // blanket refusal would pass every other test in this file and break the
    // only journey proven on chain (shield 5DiMyNkJdZxa…, leaf 33).
    expect(seen.prepareShield).toEqual([POOL_1]);
  });
});

// ---------------------------------------------------------------------------
// 2. Read side: the scan still enumerates closed pools
// ---------------------------------------------------------------------------

describe('closing the entrance does not close the exit', () => {
  it('marks 0.1 SOL closed and still scans it', async () => {
    const pool = findPoolV3('SOL', 0.1)!;
    expect(isClosed(pool), 'the 0.1 SOL pool must be closed to deposits').toBe(true);

    await handlePoolRequest({ kind: 'poolScan', meta: META, token: 'SOL' });

    // Every SOL pool, closed ones included. 10 unspent notes live in the 0.1
    // pool; a scan that skipped it would report them as gone.
    for (const p of SOL_POOLS_V3) {
      expect(seen.scanned, `${p.denomination} SOL must still be scanned`).toContain(
        p.poolPDA.toBase58(),
      );
    }
    expect(seen.scanned).toContain(POOL_0_1);
  });

  it('scans a closed pool when it is asked for by denomination', async () => {
    // The premise, asserted rather than assumed: without it this test would
    // pass while nothing is closed at all, and go on passing after a change
    // that closes the read path — a green test about a case that never occurs.
    expect(isClosed(findPoolV3('SOL', 0.1)!)).toBe(true);

    await handlePoolRequest({
      kind: 'poolScan',
      meta: META,
      token: 'SOL',
      denomination: 0.1,
    });
    expect(seen.scanned).toContain(POOL_0_1);
  });
});

// ---------------------------------------------------------------------------
// 3. Read side: a closed pool is still resolvable, both ways
// ---------------------------------------------------------------------------

describe('a closed pool stays resolvable', () => {
  it('resolves by (token, denomination)', () => {
    const pool = findPoolV3('SOL', 0.1);
    expect(pool).toBeDefined();
    expect(isClosed(pool!)).toBe(true);
    expect(pool!.poolPDA.toBase58()).toBe(POOL_0_1);

    // The over-cap pools too: `poolScanLocal` and `subscriptionRecovery` resolve
    // a note's pool this way, and an unresolvable pool drops the note silently.
    for (const denomination of [10, 100, 500, 1000]) {
      const p = findPoolV3('SOL', denomination);
      expect(p, `${denomination} SOL must still resolve`).toBeDefined();
      expect(isClosed(p!)).toBe(true);
    }
  });

  it('resolves by PDA out of the full table', () => {
    // This is the exact lookup `handlePoolScanLocal` (poolHandlers.ts:1218) and
    // `subscriptionRecovery` do to turn a stored blob back into a pool.
    for (const pda of [POOL_0_1, POOL_1, POOL_10]) {
      const pool = ALL_POOLS_V3.find((p) => p.poolPDA.toBase58() === pda);
      expect(pool, `${pda} must stay in ALL_POOLS_V3`).toBeDefined();
    }
    expect(ALL_POOLS_V3.length).toBe(SOL_POOLS_V3.length + USDC_POOLS_V3.length);
    expect(getPoolsForTokenV3('SOL').length).toBe(6);
    expect(getPoolsForTokenV3('USDC').length).toBe(7);

    // And the closed ones are the majority of that table, which is exactly why
    // filtering the shared enumerations would be a fund-loss change.
    expect(ALL_POOLS_V3.filter(isClosed).length).toBe(ALL_POOLS_V3.length - 1);
  });
});

// ---------------------------------------------------------------------------
// 4. Read side: recovery still sweeps closed pools
// ---------------------------------------------------------------------------

describe('float recovery still covers closed pools', () => {
  it('sweeps the closed 0.1 SOL pool when asked for it', async () => {
    // Same premise as the scan test: a recovery test about a "closed" pool is
    // worth nothing while no pool is closed.
    expect(isClosed(findPoolV3('SOL', 0.1)!)).toBe(true);

    const res = await handlePoolRequest({
      kind: 'poolRecover',
      meta: META,
      token: 'SOL',
      denomination: 0.1,
      ownerPubkey: OWNER.toBase58(),
    });

    expect(seen.stuckFloat).toContain(POOL_0_1);
    expect(res.keys).toBeGreaterThan(0);
  });

  it('offers every denomination for recovery, closed or not', () => {
    // The list PoolPanel's `handleRecover` maps over. It must stay the FULL
    // ladder: recovery is pool-scoped, and this list was once the denomination
    // selector — which is how a user with ~1 SOL stranded in the 0.1 pool was
    // told nothing was stranded.
    const forRecovery: number[] = denominatedPool.denominationsForRecovery('SOL');
    expect(forRecovery).toEqual([0.1, 1, 10, 100, 500, 1000]);

    // The deposit ladder is a strict subset — never the same array, never the
    // one recovery reads.
    const forDeposit = denominatedPool.poolsOpenForDeposit('SOL').map((p) => p.denomination);
    expect(forDeposit).toEqual([1]);
    for (const d of forDeposit) expect(forRecovery).toContain(d);
  });
});
