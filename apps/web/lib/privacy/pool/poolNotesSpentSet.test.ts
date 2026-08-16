/**
 * recoverNotes — the `spentSet` hoist (A5).
 *
 * `fetchSpentNullifierSet` is one pool-wide getProgramAccounts, and a
 * passphrase wallet runs `recoverNotes` once per seed derivation. Before this
 * option existed, the scan path re-issued that identical call per derivation —
 * the exact duplication `handlePoolScan` already hoists `commitments` to
 * avoid, and `handlePoolResolveSpent` memoizes per pool. What is pinned here
 * is the OPTION CONTRACT the two hoisting callers rely on: a caller-supplied
 * set suppresses the fetch entirely, and the fallback fetch still happens
 * exactly once when no set is given (the positive control that proves the
 * counter counts).
 *
 * Runs under `vitest.pool.config.mts` (node). The connection never sees the
 * network: with an empty commitment map there are no candidate leaves, so the
 * only calls recoverNotes makes are `getSlot` and (maybe) the mocked fetch.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from '@solana/web3.js';

const calls = vi.hoisted(() => ({ spentFetches: 0 }));

vi.mock('./denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./denominatedPool')>();
  return {
    ...actual,
    fetchSpentNullifierSet: async () => {
      calls.spentFetches += 1;
      return new Set<string>();
    },
  };
});

const { recoverNotes } = await import('./poolNotes');
const { findPoolV3 } = await import('./denominatedPool');

const POOL = findPoolV3('SOL', 0.1)!;
const CONN = { getSlot: async () => 1_000_000 } as unknown as Connection;
const SEED = new Uint8Array(32).fill(7);

beforeEach(() => {
  calls.spentFetches = 0;
});

describe('recoverNotes spentSet option', () => {
  it('a caller-supplied set suppresses the pool-wide fetch entirely', async () => {
    const notes = await recoverNotes(CONN, POOL, SEED, {
      commitments: new Map(),
      spentSet: new Set<string>(),
    });
    expect(notes).toEqual([]);
    expect(calls.spentFetches).toBe(0);
  });

  it('without one, the fetch happens exactly once — the positive control', async () => {
    await recoverNotes(CONN, POOL, SEED, { commitments: new Map() });
    expect(calls.spentFetches).toBe(1);
  });

  it('two derivations sharing one set cost zero fetches, not two', async () => {
    // The shape handlePoolScan and locateOwnedNote now use: one fetch by the
    // caller (not counted here — the set is constructed directly), then every
    // derivation reuses it.
    const shared = new Set<string>();
    await recoverNotes(CONN, POOL, SEED, { commitments: new Map(), spentSet: shared });
    await recoverNotes(CONN, POOL, new Uint8Array(32).fill(9), {
      commitments: new Map(),
      spentSet: shared,
    });
    expect(calls.spentFetches).toBe(0);
  });
});
