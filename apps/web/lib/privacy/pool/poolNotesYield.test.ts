/**
 * [flow-speed X1 2026-09-23] The page-load scan's legacy pass gives the worker
 * back between leaves, so a click's prepare is not frozen behind it.
 *
 * Run: cd apps/web && pnpm test:pool
 *
 * The legacy epoch search in `recoverNotes` is synchronous hashing with no await
 * in its loop: while it ran, a Withdraw or Subscribe clicked during the scan
 * could not even process its RPC answers (the worker awaits each message
 * concurrently on one thread). The yield is a pure local macrotask:
 *   - only in the scan's legacy pass (`blindedOnly` false AND no `onlyLeaf`);
 *     a spend's own locate (`onlyLeaf`) and the blinded pass never yield;
 *   - on a schedule of public counts only (every leaf position), never on a
 *     hit, a skipped search or an epoch value; it sends nothing;
 *   - the notes found are the same with it;
 *   - after each yield the caller's `stillLive` is asked, and a key set that
 *     was wiped or replaced meanwhile ends the pass with an error instead of a
 *     short "complete" list.
 */
import { describe, it, expect } from 'vitest';
import { Keypair, SystemProgram, type Connection } from '@solana/web3.js';

import { recoverNotes } from './poolNotes';
import * as dp from './denominatedPool';
import type { OnChainCommitment, PoolConfig } from './denominatedPool';

const SLOTS_PER_EPOCH = 7200;
const poolPDA = Keypair.generate().publicKey;
const poolConfig = {
  token: 'SOL',
  tokenMint: SystemProgram.programId,
  denomination: 1,
  decimals: 9,
  poolPDA,
} as unknown as PoolConfig;
const seed = new Uint8Array(32).fill(7);
const mintField = dp.pubkeyToField(poolConfig.tokenMint);
const E = 8000n;

function legacyEntry(counter: number, epoch: bigint): OnChainCommitment {
  const { secret, nullifierPreimage } = dp.deriveNoteMaterial(seed, poolPDA, counter);
  const commitment = dp.createCommitmentV3(nullifierPreimage, secret, epoch, mintField);
  return { commitment, leafIndex: counter, depositPayer: null, depositSlot: null, signature: `sig${counter}` };
}

/** Thirty foreign leaves with no deposit slot (the full window) and one legacy note of ours at 7. */
function pool(): Map<string, OnChainCommitment> {
  const m = new Map<string, OnChainCommitment>();
  const mine = legacyEntry(7, E - 3n);
  m.set(mine.commitment.toString(), mine);
  for (let c = 0; c < 30; c++) {
    if (c === 7) continue;
    const e = { commitment: 20_000_000n + BigInt(c), leafIndex: c, depositPayer: null, depositSlot: null, signature: `sig${c}` };
    m.set(e.commitment.toString(), e);
  }
  return m;
}

const conn = { getSlot: async () => Number(E) * SLOTS_PER_EPOCH } as unknown as Connection;

/** Whether another macrotask got to run between the call and its resolution. */
async function ranBesideIt(run: () => Promise<unknown>): Promise<{ beside: boolean; result: unknown }> {
  let tick = false;
  setImmediate(() => {
    tick = true;
  });
  const result = await run();
  const beside = tick;
  return { beside, result };
}

describe('[X1] the scan legacy pass yields; nothing else does', () => {
  it('T10: another task runs while the scan legacy pass searches, and the notes are unchanged', async () => {
    // RED at HEAD: the whole pass ran in one synchronous stretch after getSlot.
    const { beside, result } = await ranBesideIt(() =>
      recoverNotes(conn, poolConfig, seed, { commitments: pool(), spentSet: new Set(), epochWindow: 64 }),
    );
    expect(beside, 'nothing else could run during the legacy pass').toBe(true);
    expect((result as Array<{ counter: number; receipt: { noteBlinding: bigint } }>).map((n) => [n.counter, n.receipt.noteBlinding])).toEqual([
      [7, E - 3n],
    ]);
  });

  it('control: a spend locating ONE leaf never yields', async () => {
    const { beside } = await ranBesideIt(() =>
      recoverNotes(conn, poolConfig, seed, { commitments: pool(), spentSet: new Set(), epochWindow: 64, onlyLeaf: 7 }),
    );
    expect(beside).toBe(false);
  });

  it('control: the blinded pass never yields', async () => {
    const { beside } = await ranBesideIt(() =>
      recoverNotes(conn, poolConfig, seed, { commitments: pool(), spentSet: new Set(), blindedOnly: true }),
    );
    expect(beside).toBe(false);
  });

  it('T11: a key set that is no longer live after a yield ends the pass with an error', async () => {
    let asked = 0;
    await expect(
      recoverNotes(conn, poolConfig, seed, {
        commitments: pool(),
        spentSet: new Set(),
        epochWindow: 64,
        stillLive: () => {
          asked += 1;
          return asked < 3;
        },
      }),
    ).rejects.toThrow(/keys changed/);
    expect(asked).toBe(3);
  });

  it('the yield schedule is a public count: one per leaf position, whoever owns what', async () => {
    let asked = 0;
    await recoverNotes(conn, poolConfig, seed, {
      commitments: pool(),
      spentSet: new Set(),
      epochWindow: 64,
      // No slice runs long enough to yield inside a search: only the per-position yields.
      yieldSliceMs: Number.POSITIVE_INFINITY,
      stillLive: () => {
        asked += 1;
        return true;
      },
    });
    // 30 leaf positions: one check per position, hit or miss.
    expect(asked).toBe(30);
  });
});

/**
 * [flow-speed X1, correctness C9] A leaf the walk carried no deposit slot for
 * keeps the FULL epoch window (6,000 epochs; ~41 s per derivation measured
 * 2026-08-13 before SCAN-EPOCH narrowed the others). A yield between leaves only
 * would leave that one search as one synchronous stretch, so the search itself
 * gives the thread back once it has run for `yieldSliceMs` (16 ms by default):
 * by elapsed time, a function of work already done and never of which epoch or
 * leaf matched. The seeds are checked after each of those yields too (C10).
 */
describe('[X1] a long legacy search yields inside itself, by elapsed time', () => {
  /** ONE foreign leaf with no deposit slot: a single full-window search. */
  function oneLongLeaf(): Map<string, OnChainCommitment> {
    const m = new Map<string, OnChainCommitment>();
    const e = { commitment: 30_000_000n, leafIndex: 3, depositPayer: null, depositSlot: null, signature: 'sig3' };
    m.set(e.commitment.toString(), e);
    return m;
  }

  it('C9: a search that outlasts its slice yields and re-checks the keys before it ends', async () => {
    // RED before C9: one leaf = one yield, before its search; the search itself never yielded.
    let asked = 0;
    await recoverNotes(conn, poolConfig, seed, {
      commitments: oneLongLeaf(),
      spentSet: new Set(),
      epochWindow: 64,
      yieldSliceMs: 0,
      stillLive: () => {
        asked += 1;
        return true;
      },
    });
    expect(asked).toBeGreaterThan(1);
  });

  it('C10: keys wiped DURING one long search end the pass with an error', async () => {
    // RED before C9: the only check ran before the search; the wiped keys went unseen.
    let asked = 0;
    await expect(
      recoverNotes(conn, poolConfig, seed, {
        commitments: oneLongLeaf(),
        spentSet: new Set(),
        epochWindow: 64,
        yieldSliceMs: 0,
        stillLive: () => {
          asked += 1;
          return asked < 2;
        },
      }),
    ).rejects.toThrow(/keys changed/);
  });

  it('the notes found are the same whatever the slice', async () => {
    const run = (yieldSliceMs: number) =>
      recoverNotes(conn, poolConfig, seed, { commitments: pool(), spentSet: new Set(), epochWindow: 64, yieldSliceMs });
    const pick = (ns: Array<{ counter: number; receipt: { noteBlinding: bigint } }>) =>
      ns.map((n) => [n.counter, n.receipt.noteBlinding]);
    expect(pick(await run(0))).toEqual([[7, E - 3n]]);
    expect(pick(await run(Number.POSITIVE_INFINITY))).toEqual([[7, E - 3n]]);
  });

  it('control: a spend locating ONE leaf never yields, even inside a long search', async () => {
    let asked = 0;
    const { beside } = await ranBesideIt(() =>
      recoverNotes(conn, poolConfig, seed, {
        commitments: oneLongLeaf(),
        spentSet: new Set(),
        epochWindow: 64,
        onlyLeaf: 3,
        yieldSliceMs: 0,
        stillLive: () => {
          asked += 1;
          return true;
        },
      }),
    );
    expect(beside).toBe(false);
    expect(asked).toBe(0);
  });
});
