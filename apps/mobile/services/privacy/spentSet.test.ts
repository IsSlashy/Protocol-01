/**
 * The pool's spent set, and the counter rule that rides on it.
 *
 * WHY THIS MODULE EXISTS. Before it, the phone asked the RPC about ONE note at
 * a time: `findSafeShieldCounter` read `[g16Pda, starkPda]` per candidate (up
 * to 1,024 candidates), `refreshNoteStatuses` read two PDAs per held note on
 * every mount, and three spend pre-flights read one PDA each. A nullifier PDA
 * does not exist until the note is spent, so those reads hand the provider a
 * list of addresses that will be created LATER, from the phone's IP, with no
 * spend following. Days later one of them appears on chain and the provider
 * joins the two. `storeNullifierReads.test.ts` pins that the five call sites in
 * `stores/denominatedPoolStore.ts` no longer do it; this file pins what they
 * call instead.
 *
 * WHAT IT DOES NOT SHOW. No RPC and no chain: `getProgramAccounts` is a stub,
 * and `PublicKey.findProgramAddressSync` is the mobile test mock's FAKE sha256
 * derivation (test/__mocks__/@solana/web3.js.ts), not ed25519 off-curve. The
 * addresses here are therefore not devnet addresses. What is being measured is
 * the RULE — which addresses are asked for, how many requests carry them, and
 * what happens when the request fails — and that rule is identical under either
 * derivation because both sides of the comparison use the same one.
 */
import { describe, expect, it } from 'vitest';
import { PublicKey, type Connection } from '@solana/web3.js';

import {
  ZK_SHIELDED_PROGRAM_ID,
  bigintToLeBytes32,
  createNullifier,
  deriveNoteMaterial,
  deriveNullifierPDA,
} from '../denominatedPool';
import {
  computeGoldilocksPoolNullifier,
  goldilocksNullifierToBytes,
} from '../zk/goldilocks-poseidon';
import {
  NULLIFIER_RECORD_LEN,
  NULLIFIER_RECORD_POOL_OFFSET,
  type SpentCandidate,
  fetchPoolSpentSet,
  fetchSpentNoteIds,
  findFirstUnspentCounter,
  firstUnspentCounter,
  isGoldilocksNullifierSpentInSet,
  isNoteSpentInSet,
  isNullifierSpentPoolWide,
  nullifierPDAsForNote,
  spentNoteIds,
} from './spentSet';

const POOL = new PublicKey('11111111111111111111111111111112');
const OTHER_POOL = new PublicKey('11111111111111111111111111111113');
const SEED = new Uint8Array(32).map((_, i) => (i * 5 + 1) & 0xff);

/**
 * The two PDAs a counter would write if its note were spent — derived HERE,
 * from the store's own helpers, so the fixture does not depend on the module
 * under test.
 */
function pdasForCounter(counter: number, pool: PublicKey = POOL): { g16: string; stark: string } {
  const { secret, nullifierPreimage } = deriveNoteMaterial(SEED, pool, counter);
  const g16 = deriveNullifierPDA(
    pool,
    bigintToLeBytes32(createNullifier(nullifierPreimage, secret)),
  )[0].toBase58();
  const stark = deriveNullifierPDA(
    pool,
    goldilocksNullifierToBytes(computeGoldilocksPoolNullifier(nullifierPreimage, secret)),
  )[0].toBase58();
  return { g16, stark };
}

function materialFor(counter: number, pool: PublicKey = POOL) {
  return deriveNoteMaterial(SEED, pool, counter);
}

interface Recorder {
  connection: Connection;
  programAccountCalls: Array<{ programId: unknown; config: unknown }>;
  /** Reads that name one account: the channel this module exists to remove. */
  pointedReads: string[];
}

/** A connection that records every read. `rows` may be an error to throw. */
function recordingConnection(rows: string[] | Error): Recorder {
  const programAccountCalls: Array<{ programId: unknown; config: unknown }> = [];
  const pointedReads: string[] = [];
  const connection = {
    getProgramAccounts: async (programId: unknown, config: unknown) => {
      programAccountCalls.push({ programId, config });
      if (rows instanceof Error) throw rows;
      // The pubkey must REPORT the planted address. The mobile mock PublicKey
      // does not round-trip a base58 string: it sha256s whatever it is handed
      // (test/__mocks__/@solana/web3.js.ts), so constructing one here would
      // answer a different address than the one planted, and every membership
      // case would read as not-spent whatever the module did. A real
      // getProgramAccounts row carries a PublicKey whose toBase58() IS the
      // account address; that is what this models.
      return rows.map((r) => ({
        pubkey: { toBase58: () => r } as unknown as PublicKey,
        account: { data: Buffer.alloc(0) },
      }));
    },
    getAccountInfo: async (key: PublicKey) => {
      pointedReads.push(String(key));
      return null;
    },
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      for (const k of keys) pointedReads.push(String(k));
      return keys.map(() => null);
    },
  } as unknown as Connection;
  return { connection, programAccountCalls, pointedReads };
}

describe('mobile: the pool spent set', () => {
  it('answers for both nullifier kinds from one pool-wide read', async () => {
    // Two notes, spent through the two different paths that write DIFFERENT
    // PDAs: Groth16 (BN254 Poseidon) and STARK (Goldilocks Poseidon). A set
    // that only carried one kind would leave the other reading "unspent", which
    // is the bug the two-PDA probe was written for in the first place.
    const g16Spent = pdasForCounter(0);
    const starkSpent = pdasForCounter(1);
    const unspent = materialFor(2);

    const rec = recordingConnection([g16Spent.g16, starkSpent.stark]);
    const set = await fetchPoolSpentSet(rec.connection, POOL);

    const a = materialFor(0);
    const b = materialFor(1);
    expect(isNoteSpentInSet(set, POOL, a.nullifierPreimage, a.secret)).toBe(true);
    expect(isNoteSpentInSet(set, POOL, b.nullifierPreimage, b.secret)).toBe(true);
    expect(isNoteSpentInSet(set, POOL, unspent.nullifierPreimage, unspent.secret)).toBe(false);

    // The PDAs the module derives are the ones the store used to read one by one.
    const derived = nullifierPDAsForNote(POOL, a.nullifierPreimage, a.secret);
    expect(derived.g16).toBe(g16Spent.g16);
    expect(derived.stark).toBe(g16Spent.stark);
  });

  it('is scoped to its own pool, so another pool cannot answer for this one', async () => {
    const elsewhere = pdasForCounter(0, OTHER_POOL);
    const rec = recordingConnection([elsewhere.g16, elsewhere.stark]);
    const set = await fetchPoolSpentSet(rec.connection, POOL);
    const a = materialFor(0);
    // Same counter, same seed, DIFFERENT pool: the note in this pool is unspent.
    expect(isNoteSpentInSet(set, POOL, a.nullifierPreimage, a.secret)).toBe(false);
    const inOther = materialFor(0, OTHER_POOL);
    expect(isNoteSpentInSet(set, OTHER_POOL, inOther.nullifierPreimage, inOther.secret)).toBe(true);
  });

  it('keeps today counter rule: the first counter whose two PDAs are both absent', async () => {
    // g16 of counters 0 and 1 and the STARK of counter 2 are on chain, so 0, 1
    // and 2 are all taken and the answer is 3 — the same answer the 1,024-read
    // loop gave, decided from one response.
    const rows = [pdasForCounter(0).g16, pdasForCounter(1).g16, pdasForCounter(2).stark];
    const rec = recordingConnection(rows);
    const set = await fetchPoolSpentSet(rec.connection, POOL);
    expect(firstUnspentCounter(set, SEED, POOL, 0)).toBe(3);
    // Starting past a collision does not walk backwards.
    expect(firstUnspentCounter(set, SEED, POOL, 5)).toBe(5);
  });

  it('asks one question, filtered to this pool nullifier records, and names no note', async () => {
    const rows = [pdasForCounter(0).g16, pdasForCounter(1).stark];
    const rec = recordingConnection(rows);
    await fetchPoolSpentSet(rec.connection, POOL);

    expect(rec.programAccountCalls.length).toBe(1);
    expect(rec.pointedReads).toEqual([]);

    const call = rec.programAccountCalls[0] as {
      programId: PublicKey;
      config: {
        dataSlice?: { offset: number; length: number };
        filters?: Array<Record<string, unknown>>;
      };
    };
    expect(String(call.programId)).toBe(String(ZK_SHIELDED_PROGRAM_ID));
    // dataSlice 0: the bodies are the pool key we already filtered on, plus a
    // bump. Addresses are the whole answer.
    expect(call.config.dataSlice).toEqual({ offset: 0, length: 0 });
    const filters = call.config.filters ?? [];
    expect(filters).toContainEqual({ dataSize: NULLIFIER_RECORD_LEN });
    expect(filters).toContainEqual({
      memcmp: { offset: NULLIFIER_RECORD_POOL_OFFSET, bytes: POOL.toBase58() },
    });
    expect(NULLIFIER_RECORD_LEN).toBe(41); // 8 discriminator + 32 pool + 1 bump
    expect(NULLIFIER_RECORD_POOL_OFFSET).toBe(8);

    // The request must not carry a note-specific address in any corner of it:
    // the whole point is that every caller sends the SAME question.
    const wire = JSON.stringify(call, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
    for (const counter of [0, 1, 2]) {
      const { g16, stark } = pdasForCounter(counter);
      expect(wire.includes(g16)).toBe(false);
      expect(wire.includes(stark)).toBe(false);
    }
  });

  it('fails closed: a rejected read throws, and hands back no counter', async () => {
    const rec = recordingConnection(new Error('429 Too Many Requests'));
    let outcome = 'resolved';
    let counter: number | null = null;
    try {
      const set = await fetchPoolSpentSet(rec.connection, POOL);
      counter = firstUnspentCounter(set, SEED, POOL, 0);
    } catch {
      outcome = 'threw';
    }
    expect(outcome).toBe('threw');
    expect(counter).toBeNull();
  });

  it('shows what failing open would cost (positive control for the throw)', async () => {
    // The variant the change refuses: swallow the RPC error, call the pool
    // "nothing spent", and let the shield proceed. Counter 0 is already spent
    // here, so that variant hands back a counter whose nullifier is on chain —
    // a note that looks fine and can never be withdrawn.
    const rows = [pdasForCounter(0).g16, pdasForCounter(1).g16];
    const spent = new Set(rows);
    const failOpen = async (): Promise<Set<string>> => {
      try {
        const rec = recordingConnection(new Error('network down'));
        return await fetchPoolSpentSet(rec.connection, POOL);
      } catch {
        return new Set<string>(); // the defect
      }
    };
    expect(firstUnspentCounter(await failOpen(), SEED, POOL, 0)).toBe(0);
    expect(firstUnspentCounter(spent, SEED, POOL, 0)).toBe(2);
  });

  it('throws rather than return a colliding counter when the window is exhausted', () => {
    const rows: string[] = [];
    for (let c = 0; c < 4; c++) rows.push(pdasForCounter(c).g16);
    const set = new Set(rows);
    let outcome = 'returned';
    let got: number | null = null;
    try {
      got = firstUnspentCounter(set, SEED, POOL, 0, 4);
    } catch {
      outcome = 'threw';
    }
    expect(outcome).toBe('threw');
    expect(got).toBeNull();
    // One more attempt reaches the free counter, so the throw above is the
    // window ending and not a rule that refuses everything.
    expect(firstUnspentCounter(set, SEED, POOL, 0, 5)).toBe(4);
  });

  it('is pure once the set is in hand: the counter search performs no read', async () => {
    const rec = recordingConnection([pdasForCounter(0).g16]);
    const set = await fetchPoolSpentSet(rec.connection, POOL);
    const before = rec.programAccountCalls.length;
    for (let i = 0; i < 50; i++) firstUnspentCounter(set, SEED, POOL, 0);
    expect(rec.programAccountCalls.length).toBe(before);
    expect(rec.pointedReads).toEqual([]);
  });
  it('answers the pre-flight question: is THIS goldilocks nullifier on chain', async () => {
    // The three spend pre-flights hold the value the transaction is about to
    // publish — the proof's first public input — and not the receipt. Asking
    // with that value keeps the old semantics; asking the SET instead of the
    // PDA is the whole change.
    const a = materialFor(0);
    const onChain = computeGoldilocksPoolNullifier(a.nullifierPreimage, a.secret);
    const rec = recordingConnection([pdasForCounter(0).stark]);
    const set = await fetchPoolSpentSet(rec.connection, POOL);

    expect(isGoldilocksNullifierSpentInSet(set, POOL, onChain)).toBe(true);
    const b = materialFor(3);
    const free = computeGoldilocksPoolNullifier(b.nullifierPreimage, b.secret);
    expect(isGoldilocksNullifierSpentInSet(set, POOL, free)).toBe(false);
    // A pool that never saw it cannot answer for it.
    expect(isGoldilocksNullifierSpentInSet(set, OTHER_POOL, onChain)).toBe(false);
    // And the pre-flight named no account.
    expect(rec.pointedReads).toEqual([]);
  });
});

/**
 * A connection that answers per pool, the way the memcmp filter does on chain,
 * and records every read. `byPool` maps a pool's base58 to its spent PDAs.
 */
function poolAwareConnection(byPool: Map<string, string[]> | Error): Recorder {
  const programAccountCalls: Array<{ programId: unknown; config: unknown }> = [];
  const pointedReads: string[] = [];
  const connection = {
    getProgramAccounts: async (programId: unknown, config: unknown) => {
      programAccountCalls.push({ programId, config });
      if (byPool instanceof Error) throw byPool;
      const filters = (config as { filters?: Array<{ memcmp?: { bytes: string } }> }).filters ?? [];
      const pool = filters.find((f) => f.memcmp)?.memcmp?.bytes;
      // No pool filter means the whole program: every pool's records at once.
      const rows = pool === undefined ? [...byPool.values()].flat() : (byPool.get(pool) ?? []);
      return rows.map((r) => ({
        pubkey: { toBase58: () => r } as unknown as PublicKey,
        account: { data: Buffer.alloc(0) },
      }));
    },
    getAccountInfo: async (key: PublicKey) => {
      pointedReads.push(String(key));
      return null;
    },
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      for (const k of keys) pointedReads.push(String(k));
      return keys.map(() => null);
    },
  } as unknown as Connection;
  return { connection, programAccountCalls, pointedReads };
}

/** How a call ended, as a value: a thrown error is never re-thrown into a test. */
async function outcomeOf<T>(run: () => Promise<T>): Promise<string> {
  try {
    return `resolved:${String(await run())}`;
  } catch {
    return 'threw';
  }
}

function candidate(id: string, counter: number, pool: PublicKey): SpentCandidate {
  const { secret, nullifierPreimage } = materialFor(counter, pool);
  return { id, poolPDA: pool, nullifierPreimage, secret };
}

/**
 * The functions the store now DELEGATES to (fix round 1 of MOB-RPC). Before,
 * the store composed `fetchPoolSpentSet` with the pure rules itself, so the
 * fail-closed counter guard and the use of each verdict lived only in store
 * text; a store that swallowed the read, or fetched the set and ignored it,
 * kept `storeNullifierReads.test.ts` green (wp-logs/verify/MOB-RPC-r1-mutants.log).
 * Each composition is now one tested function here, and the store scan pins
 * that the store calls it and uses what it returns.
 */
describe('mobile: what the store delegates to', () => {
  it('the counter search the shield calls fails closed on a rejected read', async () => {
    const rejected = poolAwareConnection(new Error('429 Too Many Requests'));
    expect(await outcomeOf(() => findFirstUnspentCounter(rejected.connection, SEED, POOL, 0))).toBe(
      'threw',
    );

    // Positive control: the same assertion against the variant the guard
    // refuses — swallow the read, treat the pool as unspent. Counter 0 is
    // already spent in this pool, and that variant hands it back.
    const failOpen = async (connection: Connection): Promise<number> => {
      try {
        return await findFirstUnspentCounter(connection, SEED, POOL, 0);
      } catch {
        return firstUnspentCounter(new Set<string>(), SEED, POOL, 0);
      }
    };
    expect(await outcomeOf(() => failOpen(rejected.connection))).toBe('resolved:0');

    // And the real one, when the read succeeds, walks past the spent counters
    // from ONE pool-wide read and names no note.
    const ok = poolAwareConnection(
      new Map([[POOL.toBase58(), [pdasForCounter(0).g16, pdasForCounter(1).stark]]]),
    );
    expect(await outcomeOf(() => findFirstUnspentCounter(ok.connection, SEED, POOL, 0))).toBe(
      'resolved:2',
    );
    expect(ok.programAccountCalls.length).toBe(1);
    expect(ok.pointedReads).toEqual([]);
    // The window is passed through, not reset to the default.
    expect(await outcomeOf(() => findFirstUnspentCounter(ok.connection, SEED, POOL, 0, 2))).toBe(
      'threw',
    );
  });

  it('spentNoteIds: a Groth16-spent, a STARK-spent and an unspent note across two pools', () => {
    const inA = pdasForCounter(0, POOL);
    const inB = pdasForCounter(1, OTHER_POOL);
    const sets = new Map<string, ReadonlySet<string>>([
      [POOL.toBase58(), new Set([inA.g16])],
      [OTHER_POOL.toBase58(), new Set([inB.stark])],
    ]);
    const notes = [
      candidate('g16-spent-in-A', 0, POOL),
      candidate('stark-spent-in-B', 1, OTHER_POOL),
      candidate('unspent-in-A', 2, POOL),
      // Same counter as the note spent in A, but in B: a different note.
      candidate('same-counter-other-pool', 0, OTHER_POOL),
    ];
    expect([...spentNoteIds(notes, sets)].sort()).toEqual(['g16-spent-in-A', 'stark-spent-in-B']);

    // A note whose pool was never read is not called unspent: the helper
    // refuses, and the refresh leaves every status as it was.
    let outcome = 'returned';
    try {
      spentNoteIds(
        [candidate('pool-never-read', 0, OTHER_POOL)],
        new Map([[POOL.toBase58(), new Set<string>()]]),
      );
    } catch {
      outcome = 'threw';
    }
    expect(outcome).toBe('threw');
  });

  it('fetchSpentNoteIds asks once per distinct pool, names no note, and throws on a rejected read', async () => {
    const byPool = new Map([
      [POOL.toBase58(), [pdasForCounter(0, POOL).g16]],
      [OTHER_POOL.toBase58(), [pdasForCounter(1, OTHER_POOL).stark]],
    ]);
    const rec = poolAwareConnection(byPool);
    const notes = [
      candidate('g16-spent-in-A', 0, POOL),
      candidate('unspent-in-A', 2, POOL),
      candidate('stark-spent-in-B', 1, OTHER_POOL),
    ];
    const ids = await fetchSpentNoteIds(rec.connection, notes);
    expect([...ids].sort()).toEqual(['g16-spent-in-A', 'stark-spent-in-B']);
    expect(rec.programAccountCalls.length).toBe(2);
    expect(rec.pointedReads).toEqual([]);
    const asked = rec.programAccountCalls
      .map((c) => {
        const f = (c.config as { filters: Array<{ memcmp?: { bytes: string } }> }).filters;
        return f.find((x) => x.memcmp)?.memcmp?.bytes;
      })
      .sort();
    expect(asked).toEqual([POOL.toBase58(), OTHER_POOL.toBase58()].sort());

    const rejected = poolAwareConnection(new Error('network down'));
    expect(await outcomeOf(() => fetchSpentNoteIds(rejected.connection, notes))).toBe('threw');
  });

  it('isNullifierSpentPoolWide answers the pre-flight from one pool-wide read', async () => {
    const a = materialFor(0);
    const spentNull = computeGoldilocksPoolNullifier(a.nullifierPreimage, a.secret);
    const b = materialFor(3);
    const freeNull = computeGoldilocksPoolNullifier(b.nullifierPreimage, b.secret);
    const rec = poolAwareConnection(new Map([[POOL.toBase58(), [pdasForCounter(0).stark]]]));

    expect(await isNullifierSpentPoolWide(rec.connection, POOL, spentNull)).toBe(true);
    expect(await isNullifierSpentPoolWide(rec.connection, POOL, freeNull)).toBe(false);
    // Another pool's set cannot answer for this one.
    expect(await isNullifierSpentPoolWide(rec.connection, OTHER_POOL, spentNull)).toBe(false);
    expect(rec.programAccountCalls.length).toBe(3);
    expect(rec.pointedReads).toEqual([]);
    const wire = JSON.stringify(rec.programAccountCalls);
    expect(wire.includes(pdasForCounter(0).stark)).toBe(false);

    const rejected = poolAwareConnection(new Error('503'));
    expect(
      await outcomeOf(() => isNullifierSpentPoolWide(rejected.connection, POOL, spentNull)),
    ).toBe('threw');
  });
});
