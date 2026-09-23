/**
 * [flow-speed X1 2026-09-23] A click that lands while the page-load scan is
 * walking the same pool's history JOINS that walk instead of starting a second
 * one beside it, then runs its OWN full call.
 *
 * Run: cd apps/web && pnpm test:pool
 *
 * Why: the worker awaits each message concurrently, so the scan's walk and the
 * click's walk used to run side by side on one paced connection. On a first
 * visit both were COLD (the IndexedDB row is written only when a walk ends).
 *
 * The rule, from the privacy and correctness reviews:
 *   - opt-in (`joinInFlight`), for the browser worker's callers only; the server
 *     routes, which share this function over the KV store, never join;
 *   - only a call with the same `incremental`, `maxSignatures` and `batchSize`
 *     joins: the 3000-signature refetch never joins a 1000 walk, nor the reverse,
 *     and `incremental: false` joins nothing;
 *   - a joiner waits ONCE, ignores the leader's result or error, then always
 *     runs its own full call: its requests are exactly those of a click made
 *     after the scan finished, and its `onWalked` report is its own;
 *   - the in-flight entry is removed only by the walk that set it;
 *   - a waiting joiner reports progress at least every 10 s;
 *   - a store change forgets every walk in flight.
 * The chain here is the backfill test's fake: real `LeafInserted` bytes, real
 * `before` / `until` paging, a pool account `parsePoolV3Account` parses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fetchPoolCommitments } from './denominatedPool';
import { memoryPoolHistoryStore, setPoolHistoryStore, type PoolHistoryStore } from './poolHistoryCache';

const POOL = Keypair.generate().publicKey;
const PAYER = Keypair.generate().publicKey;

function leafInsertedEvent(leafIndex: number, commitment: bigint): string {
  const data = new Uint8Array(144);
  data.set(sha256(new TextEncoder().encode('event:LeafInserted')).subarray(0, 8), 0);
  data.set(POOL.toBytes(), 8);
  new DataView(data.buffer).setBigUint64(40, BigInt(leafIndex), true);
  let c = commitment;
  for (let i = 0; i < 32; i++) {
    data[48 + i] = Number(c & 0xffn);
    c >>= 8n;
  }
  return Buffer.from(data).toString('base64');
}

/** A pool of `n` leaves, a request log, and an optional gate on the first listing. */
class FakeChain {
  log: string[] = [];
  txs: Array<{ signature: string; leafIndex: number; commitment: bigint }> = [];
  /** signature -> how many more reads of it answer null. */
  nulls = new Map<string, number>();
  /** Held open until released: the first `getSignaturesForAddress` waits on it. */
  gate: Promise<void> | null = null;
  /** When set, every `getSignaturesForAddress` rejects with it (and clears it). */
  listFailure: Error | null = null;
  /** The n-th `getSignaturesForAddress` (1-based, counted from the start) waits on `holds.get(n)`. */
  holds = new Map<number, Promise<void>>();
  private listings = 0;
  rpcEndpoint = 'https://fake.rpc/?api-key=NOT-A-REAL-KEY';

  constructor(n: number) {
    for (let i = 0; i < n; i++) this.push(i);
  }

  push(leafIndex: number): void {
    this.txs.unshift({ signature: `sig_${leafIndex}`, leafIndex, commitment: 50_000n + BigInt(leafIndex) });
  }

  async getSignaturesForAddress(_pk: PublicKey, o: { before?: string; until?: string; limit?: number } = {}) {
    this.log.push(`list ${o.before ?? '-'} ${o.until ?? '-'} ${o.limit ?? '-'}`);
    this.listings += 1;
    const hold = this.holds.get(this.listings);
    if (hold) await hold;
    if (this.gate) {
      const g = this.gate;
      this.gate = null;
      await g;
    }
    if (this.listFailure) {
      const e = this.listFailure;
      this.listFailure = null;
      throw e;
    }
    let list = this.txs;
    if (o.before) {
      const i = list.findIndex((t) => t.signature === o.before);
      list = i >= 0 ? list.slice(i + 1) : list;
    }
    if (o.until) {
      const i = list.findIndex((t) => t.signature === o.until);
      if (i >= 0) list = list.slice(0, i);
    }
    return list.slice(0, o.limit ?? 1000).map((t) => ({ signature: t.signature, err: null }));
  }

  async getTransaction(signature: string) {
    this.log.push(`tx ${signature}`);
    const left = this.nulls.get(signature) ?? 0;
    if (left > 0) {
      this.nulls.set(signature, left - 1);
      return null;
    }
    const t = this.txs.find((x) => x.signature === signature);
    if (!t) return null;
    return {
      slot: 1000 + t.leafIndex,
      meta: { err: null, logMessages: [`Program data: ${leafInsertedEvent(t.leafIndex, t.commitment)}`] },
      transaction: { message: { accountKeys: [PAYER] } },
    };
  }

  async getAccountInfo() {
    this.log.push('account');
    const d = new Uint8Array(182);
    new DataView(d.buffer).setBigUint64(121, BigInt(this.txs.length), true);
    d[120] = 15;
    d[177] = 1;
    return { data: Buffer.from(d) };
  }

  asConnection(): Connection {
    return this as unknown as Connection;
  }
}

/** The IndexedDB store's shape: a memory store that declares itself per device. */
function perDeviceStore(): PoolHistoryStore {
  const base = memoryPoolHistoryStore();
  return { ...base, perDevice: true } as PoolHistoryStore;
}

const JOIN = { joinInFlight: true } as Record<string, unknown>;

async function settleAll(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

const STORES: Array<[string, () => PoolHistoryStore]> = [
  ['memory store', () => memoryPoolHistoryStore()],
  ['per-device store', perDeviceStore],
];

describe.each(STORES)('[X1] a joined walk, %s', (_name, makeStore) => {
  beforeEach(() => setPoolHistoryStore(makeStore()));

  it('T1+T2: two concurrent calls send one cold walk plus one delta, request for request what a later click sends', async () => {
    // The reference: the scan's walk, then a click made AFTER it settled.
    const ref = new FakeChain(40);
    await fetchPoolCommitments(ref.asConnection(), POOL, JOIN);
    await fetchPoolCommitments(ref.asConnection(), POOL, JOIN);

    setPoolHistoryStore(makeStore());
    const h = new FakeChain(40);
    const [a, b] = await Promise.all([
      fetchPoolCommitments(h.asConnection(), POOL, JOIN),
      fetchPoolCommitments(h.asConnection(), POOL, JOIN),
    ]);
    // RED at HEAD: two cold walks, 80 transaction reads instead of 40 (+ the delta's).
    expect(h.log.filter((l) => l.startsWith('tx ')).length).toBe(ref.log.filter((l) => l.startsWith('tx ')).length);
    // The privacy invariant: no request appears only in the joined run, and the
    // order is the same (the joiner starts when the leader has settled).
    expect(h.log).toEqual(ref.log);
    expect(a.size).toBe(40);
    expect(b.size).toBe(40);
  });

  it('T3: the joiner reports ITS OWN unread, never the leader\'s', async () => {
    const h = new FakeChain(12);
    h.nulls.set('sig_11', 1); // the leader's read of the newest insert fails once
    const reports: string[] = [];
    await Promise.all([
      fetchPoolCommitments(h.asConnection(), POOL, { ...JOIN, onWalked: (r: { unread: number }) => reports.push(`leader ${r.unread}`) }),
      fetchPoolCommitments(h.asConnection(), POOL, { ...JOIN, onWalked: (r: { unread: number }) => reports.push(`joiner ${r.unread}`) }),
    ]);
    // Each fired once; the joiner re-read what the leader could not, so its map is whole.
    expect(reports).toEqual(['leader 1', 'joiner 0']);
  });

  it('T4: a leader that rejects does not poison the joiner, and nothing stays in flight', async () => {
    const h = new FakeChain(10);
    h.listFailure = new Error('RPC 503 (fake)');
    const [a, b] = await Promise.allSettled([
      fetchPoolCommitments(h.asConnection(), POOL, JOIN),
      fetchPoolCommitments(h.asConnection(), POOL, JOIN),
    ]);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('fulfilled');
    expect((b as PromiseFulfilledResult<Map<string, unknown>>).value.size).toBe(10);
    // A later call walks at once (a warm delta), it does not wait on anything.
    const before = h.log.length;
    await fetchPoolCommitments(h.asConnection(), POOL, JOIN);
    expect(h.log.length).toBeGreaterThan(before);
  });

  it('T5: an old walk\'s end never removes a newer walk\'s entry (A settles, B runs, C joins B)', async () => {
    const h = new FakeChain(20);
    let releaseA!: () => void;
    h.gate = new Promise<void>((r) => {
      releaseA = r;
    });
    const order: string[] = [];
    const A = fetchPoolCommitments(h.asConnection(), POOL, JOIN).then(() => order.push('A done'));
    await settleAll();
    const B = fetchPoolCommitments(h.asConnection(), POOL, JOIN).then(() => order.push('B done'));
    releaseA();
    await A;
    // B is now running its own call; hold its first listing open.
    let releaseB!: () => void;
    h.gate = new Promise<void>((r) => {
      releaseB = r;
    });
    await settleAll();
    const C = fetchPoolCommitments(h.asConnection(), POOL, JOIN).then(() => order.push('C done'));
    await settleAll();
    const listingsBeforeReleaseB = h.log.filter((l) => l.startsWith('list')).length;
    releaseB();
    await Promise.all([B, C]);
    expect(order).toEqual(['A done', 'B done', 'C done']);
    // C sent nothing while B was in flight: it joined B.
    expect(listingsBeforeReleaseB).toBe(2); // A's and B's first listings
  });

  it('T5b: when two joiners of one leader both run, the first to end leaves the other entry in place (a later call joins it)', async () => {
    // A leads; B and C both wait on A. When A settles both run their own call, and
    // C's entry replaces B's. B's end must not remove C's entry: D, arriving while
    // C still runs, has to join C and send nothing until C has settled.
    const h = new FakeChain(20);
    let releaseA!: () => void;
    let releaseC!: () => void;
    h.holds.set(
      1,
      new Promise<void>((r) => {
        releaseA = r;
      }),
    );
    // Listing 2 is B's (it resumes first), listing 3 is C's: hold C's only.
    h.holds.set(
      3,
      new Promise<void>((r) => {
        releaseC = r;
      }),
    );
    const order: string[] = [];
    const A = fetchPoolCommitments(h.asConnection(), POOL, JOIN).then(() => order.push('A done'));
    await settleAll();
    const B = fetchPoolCommitments(h.asConnection(), POOL, JOIN).then(() => order.push('B done'));
    const C = fetchPoolCommitments(h.asConnection(), POOL, JOIN).then(() => order.push('C done'));
    await settleAll();
    expect(h.log.filter((l) => l.startsWith('list')).length).toBe(1); // B and C wait on A
    releaseA();
    await A;
    await B; // B's own call ran and ended; C is held on its first listing
    await settleAll();
    expect(order).toEqual(['A done', 'B done']);
    const listingsWhileCRuns = h.log.filter((l) => l.startsWith('list')).length;
    expect(listingsWhileCRuns).toBe(3);
    const D = fetchPoolCommitments(h.asConnection(), POOL, JOIN).then(() => order.push('D done'));
    await settleAll();
    // RED if B's end removed C's entry: D would not find C and would list at once.
    expect(h.log.filter((l) => l.startsWith('list')).length).toBe(listingsWhileCRuns);
    releaseC();
    await Promise.all([C, D]);
    expect(order).toEqual(['A done', 'B done', 'C done', 'D done']);
    expect(h.log.filter((l) => l.startsWith('list')).length).toBeGreaterThan(listingsWhileCRuns);
  });

  it('T6: the 3000 refetch never joins a 1000 walk, nor the reverse; incremental:false joins nothing', async () => {
    for (const [first, second] of [
      [{ ...JOIN }, { ...JOIN, maxSignatures: 3000 }],
      [{ ...JOIN, maxSignatures: 3000 }, { ...JOIN }],
      [{ ...JOIN }, { ...JOIN, incremental: false }],
      [{ ...JOIN, incremental: false }, { ...JOIN }],
    ] as Array<[Record<string, unknown>, Record<string, unknown>]>) {
      setPoolHistoryStore(makeStore());
      const h = new FakeChain(15);
      let release!: () => void;
      h.gate = new Promise<void>((r) => {
        release = r;
      });
      const a = fetchPoolCommitments(h.asConnection(), POOL, first);
      await settleAll();
      const b = fetchPoolCommitments(h.asConnection(), POOL, second);
      await settleAll();
      // The second call did not wait: it has already listed.
      expect(h.log.filter((l) => l.startsWith('list')).length, JSON.stringify([first, second])).toBe(2);
      release();
      await Promise.all([a, b]);
    }
  });

  it('T7: after a store change, a new call does not wait on a walk that never ends', async () => {
    const h = new FakeChain(5);
    h.gate = new Promise<void>(() => {}); // never released
    void fetchPoolCommitments(h.asConnection(), POOL, JOIN);
    await settleAll();
    setPoolHistoryStore(makeStore());
    const fresh = new FakeChain(5);
    const map = await fetchPoolCommitments(fresh.asConnection(), POOL, JOIN);
    expect(map.size).toBe(5);
  });

  it('T9: without the opt-in (the server routes), concurrent calls do not join', async () => {
    const h = new FakeChain(10);
    let release!: () => void;
    h.gate = new Promise<void>((r) => {
      release = r;
    });
    const a = fetchPoolCommitments(h.asConnection(), POOL);
    await settleAll();
    const b = fetchPoolCommitments(h.asConnection(), POOL);
    await settleAll();
    expect(h.log.filter((l) => l.startsWith('list')).length).toBe(2);
    release();
    await Promise.all([a, b]);
  });
});

describe('[X1] a waiting joiner is never silent', () => {
  afterEach(() => vi.useRealTimers());

  it('T8: it reports at least every 10 s while it waits, and stops once it runs', async () => {
    vi.useFakeTimers();
    setPoolHistoryStore(memoryPoolHistoryStore());
    const h = new FakeChain(5);
    let release!: () => void;
    h.gate = new Promise<void>((r) => {
      release = r;
    });
    const waits: number[] = [];
    const a = fetchPoolCommitments(h.asConnection(), POOL, JOIN);
    await vi.advanceTimersByTimeAsync(0);
    const b = fetchPoolCommitments(h.asConnection(), POOL, { ...JOIN, onJoinWait: (s: number) => waits.push(s) });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(waits).toEqual([10, 20]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([a, b]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(waits).toEqual([10, 20]);
  });
});
