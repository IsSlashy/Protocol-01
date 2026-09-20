/**
 * [CACHE-1] THE SERVER'S POOL HISTORY, SHARED BY EVERY ISOLATE THROUGH KV.
 *
 * The problem, re-read on 2026-09-18 at today's line numbers: on the server,
 * `getPoolHistoryStore()` finds no IndexedDB and falls back to a per-isolate
 * memory map (`poolHistoryCache.ts`, `memoryPoolHistoryStore`). So every cold
 * serverless isolate re-walks the pool's whole history, one
 * `getSignaturesForAddress` page plus one `getTransaction` per signature,
 * inside a buyer's `/api/issue-note`, `/api/contribute-note` or
 * `/api/claim-for-payment` request, and the next cold isolate does it again.
 *
 * The change (`kvPoolHistory.ts`): one KV row per pool,
 * `p01:pool-history:<pool>`, holding the snapshot WITHOUT its `key` (which
 * names the RPC host) and WITHOUT its `savedAt` clock, with the entries in
 * leaf order. It is written only when the snapshot changed, the write is
 * handed to `after()` so the reply does not wait for it, and each of the three
 * routes installs the store when its module loads.
 *
 * The adversary of the privacy cases is whoever holds a dump of this
 * deployment's KV and this public repository. The row must hold public chain
 * data and nothing a request adds, and that is MEASURED the way
 * `__tests__/lib/kvRowsAtRest.test.ts` measures rows (wp-logs/PROTOCOL.md, "a
 * test that measures a leak instead of listing its spellings"): the same walk
 * runs in worlds that differ in one thing each (the RPC endpoint and its
 * credential, the clock, how the walks were spread over isolates and over the
 * chain's growth) and the dump must not move. A world with other leaves must
 * move it, or the comparison reads nothing. A verbatim store is flagged on
 * each of those axes (the positive controls below).
 *
 * The chain is a fixture: real `LeafInserted` event bytes, base58 signatures
 * the fake RPC validates the way a real one refuses a malformed `until`, and a
 * pool account `parsePoolV3Account` parses. Every value is synthetic;
 * `SECRET123` and the other credentials are fixtures, and no real endpoint is
 * read.
 *
 * NOT CLOSED HERE, stated so a green is not read as more:
 *   - the row's newest signature says the last walk that changed it ran after
 *     that transaction. That dates some request to one of the three routes,
 *     never which note it handed out (wp-logs/CACHE-1-report.md);
 *   - `retry[].attempts` counts the walks since a read failed;
 *   - nothing is timed on Vercel: the counts below are RPC calls on the fake.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PublicKey, type Connection } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { KvLike } from '@/lib/waitlist/store';
import { fetchPoolCommitments, type OnChainCommitment } from './denominatedPool';
import {
  loadPoolHistory,
  setPoolHistoryStore,
  type CachedCommitmentEntry,
  type PoolHistoryStore,
} from './poolHistoryCache';
import { KV_POOL_HISTORY_PREFIX, MAX_KV_POOL_HISTORY_BYTES, kvPoolHistoryStore } from './kvPoolHistory';

/** The store the routes resolve through `getStore()`, swapped per test. */
const h = vi.hoisted(() => ({ kv: null as unknown }));

vi.mock('@/lib/waitlist/store', () => ({
  getStore: () => h.kv,
  rateLimitExceeded: async () => false,
}));

const enc = (s: string) => new TextEncoder().encode(s);
const POOL = new PublicKey(sha256(enc('cache-1/pool')));
const PAYER = new PublicKey(sha256(enc('cache-1/payer')));
const ROW_KEY = KV_POOL_HISTORY_PREFIX + POOL.toBase58();
/** The 1 SOL pool's signature count on 2026-09-15 (`scratchpad/probe-stale-root-2026-09-15.log`). */
const LEAVES = 193;

/** A Helius-shaped endpoint with its credential in the query. */
const E1 = 'https://devnet.helius-rpc.com/?api-key=SECRET123';
/** Another host, with a credential in the userinfo, the path and the query. */
const E2 = 'https://USERNAME9:PASSWORD9@rpc.example.org:8899/PATHSECRET9?token=TOKEN9';
/** Nothing of an endpoint may reach KV: not its credential, path, query, user or host. */
const ENDPOINT_TOKENS = [
  'api-key',
  'SECRET123',
  'helius',
  'devnet.helius-rpc.com',
  'USERNAME9',
  'PASSWORD9',
  'PATHSECRET9',
  'TOKEN9',
  'rpc.example.org',
];

const T1 = Date.UTC(2026, 8, 18, 12, 0, 0);
const T2 = T1 + 7 * 3_600_000 + 1234;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}
const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;

function signatureFor(seed: string, i: number): string {
  const out = new Uint8Array(64);
  out.set(sha256(enc(`${seed}/sig/${i}/a`)), 0);
  out.set(sha256(enc(`${seed}/sig/${i}/b`)), 32);
  return base58(out);
}

function commitmentFor(seed: string, i: number): bigint {
  let n = 0n;
  for (const b of sha256(enc(`${seed}/cm/${i}`))) n = n * 256n + BigInt(b);
  return n >> 2n;
}

/** The V3 `LeafInserted` layout the walk decodes: disc | pool | idx@40 | commitment@48. */
function leafInsertedEvent(leafIndex: number, commitment: bigint): string {
  const data = new Uint8Array(144);
  data.set(sha256(enc('event:LeafInserted')).subarray(0, 8), 0);
  data.set(POOL.toBytes(), 8);
  new DataView(data.buffer).setBigUint64(40, BigInt(leafIndex), true);
  let c = commitment;
  for (let i = 0; i < 32; i++) {
    data[48 + i] = Number(c & 0xffn);
    c >>= 8n;
  }
  return Buffer.from(data).toString('base64');
}

interface Tx {
  signature: string;
  slot: number;
  leafIndex: number;
  commitment: bigint;
}

/** Newest-first history paged like `getSignaturesForAddress`, plus the pool account. */
class Chain {
  txs: Tx[] = [];
  signatureCalls: Array<{ before?: string; until?: string; limit?: number }> = [];
  getTransactionCalls = 0;

  constructor(
    readonly seed: string,
    readonly rpcEndpoint: string,
  ) {}

  depositUpTo(count: number): void {
    while (this.txs.length < count) {
      const i = this.txs.length;
      this.txs.unshift({
        signature: signatureFor(this.seed, i),
        slot: 5000 + 3 * i,
        leafIndex: i,
        commitment: commitmentFor(this.seed, i),
      });
    }
  }

  resetCounts(): void {
    this.signatureCalls = [];
    this.getTransactionCalls = 0;
  }

  async getSignaturesForAddress(_pk: PublicKey, opts: { before?: string; until?: string; limit?: number } = {}) {
    this.signatureCalls.push({ ...opts });
    // A real RPC refuses a cursor that is not a signature.
    for (const cursor of [opts.before, opts.until]) {
      if (cursor !== undefined && !BASE58_SIGNATURE.test(cursor)) throw new Error('Invalid param: WrongSize (fake)');
    }
    let list = this.txs;
    if (opts.before) {
      const i = list.findIndex((t) => t.signature === opts.before);
      list = i >= 0 ? list.slice(i + 1) : list;
    }
    if (opts.until) {
      const i = list.findIndex((t) => t.signature === opts.until);
      if (i >= 0) list = list.slice(0, i);
    }
    return list.slice(0, opts.limit ?? 1000).map((t) => ({ signature: t.signature, err: null }));
  }

  async getTransaction(signature: string, _opts?: unknown) {
    this.getTransactionCalls++;
    const t = this.txs.find((x) => x.signature === signature);
    if (!t) return null;
    return {
      slot: t.slot,
      meta: { err: null, logMessages: [`Program data: ${leafInsertedEvent(t.leafIndex, t.commitment)}`] },
      transaction: { message: { accountKeys: [PAYER] } },
    };
  }

  /** next_leaf_index at 121, depth at 120, active at 177, no historical roots. */
  async getAccountInfo(_pk: PublicKey, _commitment?: unknown) {
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

/**
 * What an Upstash KV would hold: each value as the JSON text it serialises to,
 * and its expiry as an absolute time. The expiry is part of the dump because a
 * backup carries it, and an expiry set at write time dates the write.
 */
class FakeKv {
  rows = new Map<string, { value: string; exp: number | null }>();
  getCalls = 0;
  setCalls = 0;
  delCalls: string[] = [];
  failGet = false;
  failSet = false;

  constructor(private readonly now: () => number = () => Date.now()) {}

  async get<T>(key: string): Promise<T | null> {
    this.getCalls++;
    if (this.failGet) throw new Error('KV unreachable (fake)');
    const row = this.rows.get(key);
    return row === undefined ? null : (JSON.parse(row.value) as T);
  }

  async set(key: string, value: unknown, opts?: { ex?: number }): Promise<void> {
    this.setCalls++;
    if (this.failSet) throw new Error('KV unreachable (fake)');
    this.rows.set(key, { value: JSON.stringify(value), exp: opts?.ex ? this.now() + opts.ex * 1000 : null });
  }

  async del(key: string): Promise<void> {
    this.delCalls.push(key);
    this.rows.delete(key);
  }

  async incr(): Promise<number> {
    return 1;
  }
  async expire(): Promise<void> {}
  async sadd(): Promise<void> {}
  async srem(): Promise<void> {}
  async scard(): Promise<number> {
    return 0;
  }
  async smembers(): Promise<string[]> {
    return [];
  }
  async mget(keys: string[]): Promise<(number | null)[]> {
    return keys.map(() => null);
  }

  /** Every key, value and expiry, in key order. */
  dump(): string {
    return JSON.stringify([...this.rows.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  asKv(): KvLike {
    return this as unknown as KvLike;
  }
}

/** The number of entries in the pool's row, or -1 when there is no readable row. */
function rowEntries(kv: FakeKv): number {
  const row = kv.rows.get(ROW_KEY);
  if (!row) return -1;
  try {
    const v = JSON.parse(row.value) as { entries?: unknown };
    return Array.isArray(v?.entries) ? v.entries.length : -1;
  } catch {
    return -1;
  }
}

function rowEntriesOfDump(dump: string): number {
  const rows = JSON.parse(dump) as Array<[string, { value: string }]>;
  const row = rows.find(([k]) => k === ROW_KEY);
  if (!row) return -1;
  const v = JSON.parse(row[1].value) as { entries?: unknown };
  return Array.isArray(v?.entries) ? v.entries.length : -1;
}

/** The endpoint tokens a dump spells, in their fixed order. Neutral on an empty dump. */
function endpointFindings(dump: string): string[] {
  return ENDPOINT_TOKENS.filter((t) => dump.includes(t));
}

/** The walk, never thrown into a test: a walk that failed is `null`, read as size -1. */
async function walk(
  f: typeof fetchPoolCommitments,
  chain: Chain,
): Promise<Map<string, OnChainCommitment> | null> {
  try {
    return await f(chain.asConnection(), POOL);
  } catch {
    return null;
  }
}

/** A walk's result, order-free, for comparing two isolates. */
function summary(m: Map<string, OnChainCommitment> | null): string {
  if (!m) return 'none';
  return [...m.values()]
    .map((c) => `${c.leafIndex}:${c.commitment}:${c.signature}:${c.depositSlot}:${c.depositPayer}`)
    .sort()
    .join('\n');
}

/**
 * Synthetic control: a store that writes the snapshot as it is handed over,
 * under the same row key, PLUS the two things the walk used to hand over with
 * it. `legacyKey` writes the pre-HIST-1 key, which spelled the whole endpoint.
 *
 * [SWEEP4 round 1, storage lane] Why it plants them itself now. This control
 * exists to prove the world comparison can SEE a row that dates the write or
 * records how the walks were spread; until this sweep it got both for free,
 * because `fetchPoolCommitments` saved `savedAt: Date.now()` and kept the
 * entries in the order the walks decoded them. The device's IndexedDB row read
 * that as "this device last walked at T, and held N leaves at each earlier
 * walk", so the walk now saves `savedAt: 0` and files the leaves in leaf order
 * (`denominatedPool.ts`; `poolHistoryCache.test.ts`, "[SWEEP4-STORAGE] …
 * carries no clock" / "… files the leaves in leaf order"). With the source
 * gone this control compared two rows that were already a function of the
 * chain and proved nothing, so it re-plants exactly what it used to receive:
 * the writing request's own clock, and the pre-fix order — the leaves a walk
 * newly decoded appended newest-first, after the ones already filed.
 */
function verbatimStore(kv: FakeKv, opts: { legacyKey?: boolean } = {}): PoolHistoryStore {
  /** Filed in walk order, exactly as the pre-sweep snapshot kept them. */
  let filed: CachedCommitmentEntry[] = [];
  return {
    async load() {
      const row = kv.rows.get(ROW_KEY);
      if (!row) return null;
      const parsed = JSON.parse(row.value) as { entries?: CachedCommitmentEntry[] };
      filed = [...(parsed.entries ?? [])];
      return parsed as never;
    },
    async save(snapshot) {
      const key = opts.legacyKey ? `${E1}|${POOL.toBase58()}` : snapshot.key;
      const known = new Set(filed.map((e) => e.commitment));
      filed = [
        ...filed,
        ...snapshot.entries
          .filter((e) => !known.has(e.commitment))
          .sort((a, b) => b.leafIndex - a.leafIndex),
      ];
      await kv.set(ROW_KEY, { ...snapshot, key, savedAt: Date.now(), entries: [...filed] });
    },
    async clear() {},
  };
}

/** Synthetic control: public entries only, in leaf order, but written with an expiry. */
function expiringStore(kv: FakeKv): PoolHistoryStore {
  return {
    async load() {
      return null;
    },
    async save(snapshot) {
      const entries = [...snapshot.entries].sort((a, b) => a.leafIndex - b.leafIndex);
      await kv.set(ROW_KEY, { entries }, { ex: 86_400 });
    },
    async clear() {},
  };
}

interface WorldSpec {
  seed?: string;
  endpoint?: string;
  now?: number;
  /** Chain lengths at which a walk runs, each in a new isolate unless `warm`. */
  schedule?: number[];
  warm?: boolean;
  store?: (kv: FakeKv) => PoolHistoryStore;
}

/** One world: the chain grows along `schedule`, a walk runs at each step, the KV is dumped. */
async function world(spec: WorldSpec): Promise<{ dump: string; sizes: number[] }> {
  const now = spec.now ?? T1;
  const kv = new FakeKv(() => now);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const make = spec.store ?? ((k: FakeKv) => kvPoolHistoryStore(() => k.asKv()));
  const chain = new Chain(spec.seed ?? 'base', spec.endpoint ?? E1);
  const sizes: number[] = [];
  try {
    let store = make(kv);
    for (const upto of spec.schedule ?? [LEAVES]) {
      chain.depositUpTo(upto);
      if (!spec.warm) store = make(kv);
      setPoolHistoryStore(store);
      sizes.push((await walk(fetchPoolCommitments, chain))?.size ?? -1);
    }
    return { dump: kv.dump(), sizes };
  } finally {
    clock.mockRestore();
    setPoolHistoryStore(null);
  }
}

const ROUTES = ['issue-note', 'contribute-note', 'claim-for-payment'] as const;
type Route = (typeof ROUTES)[number];

/**
 * A cold serverless isolate: fresh module state, one route loaded, and the
 * walk that route's module graph uses. The sibling route a route imports is
 * replaced by a stub, so what is measured is the route's OWN registration and
 * not one it inherits through an import.
 */
async function coldIsolate(route: Route): Promise<typeof fetchPoolCommitments> {
  vi.resetModules();
  vi.doUnmock('@/app/api/issue-note/route');
  vi.doUnmock('@/app/api/contribute-note/route');
  if (route === 'contribute-note') {
    vi.doMock('@/app/api/issue-note/route', () => ({ recordInventoryLeaf: async () => false }));
  }
  if (route === 'claim-for-payment') {
    vi.doMock('@/app/api/contribute-note/route', () => ({ treasuryCommitmentFor: () => 0n }));
  }
  if (route === 'issue-note') await import('@/app/api/issue-note/route');
  else if (route === 'contribute-note') await import('@/app/api/contribute-note/route');
  else await import('@/app/api/claim-for-payment/route');
  return (await import('./denominatedPool')).fetchPoolCommitments;
}

afterEach(() => {
  setPoolHistoryStore(null);
  h.kv = null;
  vi.restoreAllMocks();
});

describe('[CACHE-1] the server pool history is shared through KV, keyed by pool, public chain data only', () => {
  it.each(ROUTES)(
    'cold isolate re-walks nothing: %s registers the shared store when it loads',
    async (route) => {
      const kv = new FakeKv(() => T1);
      h.kv = kv.asKv();
      const chain = new Chain('base', E1);
      chain.depositUpTo(LEAVES);

      // Isolate A pays for the whole history once, as every isolate does today.
      const a = await walk(await coldIsolate(route), chain);
      expect(a?.size ?? -1).toBe(LEAVES);
      expect(chain.getTransactionCalls).toBe(LEAVES);

      // Isolate B: new module state, the same KV. The memory store made 193
      // getTransaction here.
      chain.resetCounts();
      const b = await walk(await coldIsolate(route), chain);
      expect(chain.getTransactionCalls).toBe(0);
      expect(chain.signatureCalls.length).toBeLessThanOrEqual(1);
      expect(summary(b)).toBe(summary(a));

      // Isolate C: reading the row did not consume it.
      chain.resetCounts();
      const c = await walk(await coldIsolate(route), chain);
      expect(chain.getTransactionCalls).toBe(0);
      expect(summary(c)).toBe(summary(a));
      expect(rowEntries(kv)).toBe(LEAVES);
    },
    180_000,
  );

  it('KV never holds the endpoint: no api-key, credential, path, user or host in any key or value', async () => {
    for (const endpoint of [E1, E2]) {
      const w = await world({ endpoint });
      // An empty KV would pass the next line, so the row must be there.
      expect(rowEntriesOfDump(w.dump)).toBe(LEAVES);
      expect(endpointFindings(w.dump)).toEqual([]);
    }
  });

  it('the endpoint detector flags a verbatim store under today\'s key and the legacy one (positive control)', async () => {
    expect(endpointFindings('[]')).toEqual([]);
    const today = await world({ store: (kv) => verbatimStore(kv) });
    expect(rowEntriesOfDump(today.dump)).toBe(LEAVES);
    expect(endpointFindings(today.dump)).toEqual(['helius', 'devnet.helius-rpc.com']);
    const other = await world({ store: (kv) => verbatimStore(kv), endpoint: E2 });
    expect(endpointFindings(other.dump)).toEqual(['rpc.example.org']);
    const legacy = await world({ store: (kv) => verbatimStore(kv, { legacyKey: true }) });
    expect(endpointFindings(legacy.dump)).toEqual(['api-key', 'SECRET123', 'helius', 'devnet.helius-rpc.com']);
  });

  it('the row is a function of the chain alone: endpoint, clock and how the walks were spread leave its bytes unchanged', async () => {
    const base = await world({});
    // Determinism control: an unseeded source would make every world differ.
    expect((await world({})).dump).toBe(base.dump);
    expect(base.sizes).toEqual([LEAVES]);
    expect(rowEntriesOfDump(base.dump)).toBe(LEAVES);

    const moved: Record<string, string> = {
      endpoint: (await world({ endpoint: E2 })).dump,
      clock: (await world({ now: T2 })).dump,
      'two isolates, chain grew between': (await world({ schedule: [100, LEAVES] })).dump,
      'one isolate, chain grew between': (await world({ schedule: [100, LEAVES], warm: true })).dump,
      'three isolates': (await world({ schedule: [40, 150, LEAVES] })).dump,
    };
    expect(Object.keys(moved).filter((axis) => moved[axis] !== base.dump)).toEqual([]);

    // Control: other leaves must move the row, or the comparison reads nothing.
    expect((await world({ seed: 'other' })).dump).not.toBe(base.dump);
  });

  it('the world comparison flags a verbatim store on every axis it reads, and an expiry on the clock (positive control)', async () => {
    const verbatim = (kv: FakeKv) => verbatimStore(kv);
    const base = await world({ store: verbatim });
    expect(rowEntriesOfDump(base.dump)).toBe(LEAVES);
    expect((await world({ store: verbatim })).dump).toBe(base.dump);
    // The key names the host.
    expect((await world({ store: verbatim, endpoint: E2 })).dump).not.toBe(base.dump);
    // savedAt is the clock of the request that walked.
    expect((await world({ store: verbatim, now: T2 })).dump).not.toBe(base.dump);
    // Insertion order records how the walks were spread over the chain's growth.
    expect((await world({ store: verbatim, schedule: [100, LEAVES] })).dump).not.toBe(base.dump);

    // Public entries in leaf order, but with an expiry: the expiry dates the write.
    const expiring = await world({ store: expiringStore });
    expect(rowEntriesOfDump(expiring.dump)).toBe(LEAVES);
    expect((await world({ store: expiringStore, endpoint: E2 })).dump).toBe(expiring.dump);
    expect((await world({ store: expiringStore, now: T2 })).dump).not.toBe(expiring.dump);
  });

  it('writes only when the snapshot changed; a warm isolate reads KV no more', async () => {
    const kv = new FakeKv(() => T1);
    const chain = new Chain('base', E1);
    chain.depositUpTo(LEAVES);

    const a = kvPoolHistoryStore(() => kv.asKv());
    setPoolHistoryStore(a);
    expect((await walk(fetchPoolCommitments, chain))?.size ?? -1).toBe(LEAVES);
    expect(kv.setCalls).toBe(1);
    const bytes = kv.rows.get(ROW_KEY)?.value.length ?? -1;
    console.info(`[CACHE-1] row bytes for ${LEAVES} synthetic leaves: ${bytes}`);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(MAX_KV_POOL_HISTORY_BYTES);

    // Warm, nothing new: no read, no write.
    const readsBefore = kv.getCalls;
    chain.resetCounts();
    expect((await walk(fetchPoolCommitments, chain))?.size ?? -1).toBe(LEAVES);
    expect(chain.getTransactionCalls).toBe(0);
    expect(kv.getCalls).toBe(readsBefore);
    expect(kv.setCalls).toBe(1);

    // Cold, nothing new: one read, no write.
    const b = kvPoolHistoryStore(() => kv.asKv());
    setPoolHistoryStore(b);
    chain.resetCounts();
    expect((await walk(fetchPoolCommitments, chain))?.size ?? -1).toBe(LEAVES);
    expect(chain.getTransactionCalls).toBe(0);
    expect(kv.setCalls).toBe(1);

    // One new deposit: one transaction read, one write.
    chain.depositUpTo(LEAVES + 1);
    chain.resetCounts();
    expect((await walk(fetchPoolCommitments, chain))?.size ?? -1).toBe(LEAVES + 1);
    expect(chain.getTransactionCalls).toBe(1);
    expect(kv.setCalls).toBe(2);
    expect(rowEntries(kv)).toBe(LEAVES + 1);
  });

  it('the write is handed to after(), so the walk returns before it', async () => {
    const queue: Array<() => unknown> = [];
    vi.resetModules();
    vi.doMock('next/server', async (importOriginal) => ({
      ...(await importOriginal<typeof import('next/server')>()),
      after: (task: () => unknown) => {
        queue.push(task);
      },
    }));
    try {
      const kv = new FakeKv(() => T1);
      h.kv = kv.asKv();
      const fresh = await import('./kvPoolHistory');
      const pool = await import('./denominatedPool');
      fresh.installKvPoolHistory();
      const chain = new Chain('base', E1);
      chain.depositUpTo(LEAVES);

      expect((await walk(pool.fetchPoolCommitments, chain))?.size ?? -1).toBe(LEAVES);
      expect(queue.length).toBe(1);
      expect(kv.setCalls).toBe(0);

      for (const task of queue.splice(0)) await task();
      expect(kv.setCalls).toBe(1);
      expect(rowEntries(kv)).toBe(LEAVES);
    } finally {
      vi.doUnmock('next/server');
      vi.resetModules();
    }
  });

  it('an unreadable, unwritable, malformed or foreign row never breaks the walk, and is replaced', async () => {
    const chain = new Chain('base', E1);
    chain.depositUpTo(LEAVES);

    // Unreadable: a cold walk, as today.
    const kv = new FakeKv(() => T1);
    kv.failGet = true;
    setPoolHistoryStore(kvPoolHistoryStore(() => kv.asKv()));
    expect((await walk(fetchPoolCommitments, chain))?.size ?? -1).toBe(LEAVES);
    kv.failGet = false;

    // Unwritable: the walk still answers, and the next walk writes what failed.
    const kv2 = new FakeKv(() => T1);
    kv2.failSet = true;
    const store2 = kvPoolHistoryStore(() => kv2.asKv());
    setPoolHistoryStore(store2);
    expect((await walk(fetchPoolCommitments, chain))?.size ?? -1).toBe(LEAVES);
    kv2.failSet = false;
    expect((await walk(fetchPoolCommitments, chain))?.size ?? -1).toBe(LEAVES);
    expect(rowEntries(kv2)).toBe(LEAVES);

    // The row as this work package writes it, by hand: a cold isolate trusts it.
    const oldestFirst = [...chain.txs].reverse();
    const good = {
      format: 1,
      version: 2,
      newestSignature: chain.txs[0]!.signature,
      oldestSignature: oldestFirst[0]!.signature,
      reachedOldest: true,
      complete: true,
      retry: [] as unknown[],
      dropped: 0,
      gaps: [] as unknown[],
      rewalkAt: null as number | null,
      entries: oldestFirst.map((t) => ({
        commitment: t.commitment.toString(),
        leafIndex: t.leafIndex,
        depositPayer: PAYER.toBase58(),
        depositSlot: t.slot,
        signature: t.signature,
      })),
    };
    const kvGood = new FakeKv(() => T1);
    await kvGood.set(ROW_KEY, good);
    setPoolHistoryStore(kvPoolHistoryStore(() => kvGood.asKv()));
    chain.resetCounts();
    const fromRow = await walk(fetchPoolCommitments, chain);
    expect(chain.getTransactionCalls).toBe(0);
    expect(fromRow?.size ?? -1).toBe(LEAVES);

    const clone = () => JSON.parse(JSON.stringify(good)) as typeof good & Record<string, unknown>;
    // A row with one leaf missing: the walk's "cache already whole" shortcut
    // does not fire, so a gap or a backfill cursor in it is really paged
    // (added after the red; mutants M9 and M16 in web-run/logs2/CACHE-1-mutants.log).
    const incomplete = () => {
      const r = clone();
      r.entries.splice(50, 1);
      r.complete = false;
      return r;
    };
    const planted: Record<string, unknown> = {
      'a string, not a row': 'garbage',
      'entries not a list': { ...clone(), entries: 'x' },
      'a commitment that is not a number': (() => {
        const r = clone();
        (r.entries[5] as Record<string, unknown>).commitment = 'not-a-number';
        return r;
      })(),
      'a negative leaf index': (() => {
        const r = clone();
        (r.entries[7] as Record<string, unknown>).leafIndex = -3;
        return r;
      })(),
      'an entry signature that is not one': (() => {
        const r = clone();
        (r.entries[9] as Record<string, unknown>).signature = 'bad signature!';
        return r;
      })(),
      'a newest signature the RPC would refuse': { ...clone(), newestSignature: 'bad signature!' },
      'another snapshot version': { ...clone(), version: 1 },
      'another row format': { ...clone(), format: 99 },
      // A count that is not a number never reaches the drop limit, so a
      // signature the RPC never serves would be re-read on every walk.
      'a retry count that is not one': { ...clone(), retry: [{ signature: signatureFor('elsewhere', 0), attempts: 'x' }] },
      'a gap with no signatures': { ...incomplete(), gaps: [{ before: 'nope', until: 'nope' }] },
      'an oldest signature the RPC would refuse': {
        ...incomplete(),
        oldestSignature: 'bad signature!',
        reachedOldest: false,
      },
    };
    const notReplaced: string[] = [];
    for (const [name, row] of Object.entries(planted)) {
      const k = new FakeKv(() => T1);
      await k.set(ROW_KEY, row);
      const plantedText = k.rows.get(ROW_KEY)?.value;
      setPoolHistoryStore(kvPoolHistoryStore(() => k.asKv()));
      const m = await walk(fetchPoolCommitments, chain);
      const replaced = (m?.size ?? -1) === LEAVES && rowEntries(k) === LEAVES && k.rows.get(ROW_KEY)?.value !== plantedText;
      // And the next walk is quiet: nothing the planted row carried is still re-read.
      chain.resetCounts();
      const again = await walk(fetchPoolCommitments, chain);
      const quiet = (again?.size ?? -1) === LEAVES && chain.getTransactionCalls === 0;
      if (!replaced || !quiet) notReplaced.push(name);
    }
    expect(notReplaced).toEqual([]);
  });

  it('a key that spells the endpoint never reaches the shared row', async () => {
    const kv = new FakeKv(() => T1);
    const chain = new Chain('base', E1);
    chain.depositUpTo(LEAVES);
    const store = kvPoolHistoryStore(() => kv.asKv());
    setPoolHistoryStore(store);
    await walk(fetchPoolCommitments, chain);
    expect(kv.rows.has(ROW_KEY)).toBe(true);

    // `loadPoolHistory` asks for the pre-HIST-1 key and deletes what it finds
    // there: the shared row must not answer to it.
    const legacyKey = `${E1}|${POOL.toBase58()}`;
    expect(await store.load(legacyKey)).toBeNull();
    await store.clear(legacyKey);
    expect(kv.rows.has(ROW_KEY)).toBe(true);

    const cold = kvPoolHistoryStore(() => kv.asKv());
    const { snapshot } = await loadPoolHistory(cold, E1, POOL.toBase58());
    expect(snapshot?.entries.length ?? -1).toBe(LEAVES);
    expect(kv.rows.has(ROW_KEY)).toBe(true);
    expect(kv.delCalls).toEqual([]);
  });

  it('a row too large for one request is not sent, and the isolate still serves it warm', async () => {
    const kv = new FakeKv(() => T1);
    const chain = new Chain('base', E1);
    chain.depositUpTo(LEAVES);
    setPoolHistoryStore(kvPoolHistoryStore(() => kv.asKv(), { maxRowBytes: 2_000 }));
    expect((await walk(fetchPoolCommitments, chain))?.size ?? -1).toBe(LEAVES);
    expect(kv.setCalls).toBe(0);
    chain.resetCounts();
    expect((await walk(fetchPoolCommitments, chain))?.size ?? -1).toBe(LEAVES);
    expect(chain.getTransactionCalls).toBe(0);
  });
});
