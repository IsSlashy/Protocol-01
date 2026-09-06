/**
 * poolLeavesIndex — server side of the leaf indexer behind
 * `/api/pool-leaves/[pool]`.
 *
 * Keeps, per pool, the dense array of leaf commitments (index → decimal u64
 * string, "0" for a gap) in KV, and advances it INCREMENTALLY: each refresh
 * reads only the signatures newer than the last one it processed, fetches
 * those transactions, and decodes their `LeafInserted` events with the SAME
 * decoder the client scan uses (`decodeLeafInsertionLogs`), so the two can
 * never disagree on a byte offset.
 *
 * ── STORAGE ─────────────────────────────────────────────────────────────────
 * Values are chunked (`CHUNK` leaves per key) so a full depth-19 pool
 * (524 288 leaves ≈ 11 MB of decimal strings) never has to fit one KV value;
 * a refresh touches only the chunks its new leaves land in.
 *
 *   pool-leaves:v1:<pool>:meta   PoolLeavesMeta
 *   pool-leaves:v1:<pool>:c<n>   string[] of CHUNK leaves (dense, "0" gaps)
 *   pool-leaves:v1:<pool>:lock   refresh mutex, NX + short TTL
 *
 * ── WHY `lastSignature` ONLY ADVANCES PAST FETCHED TRANSACTIONS ──────────────
 * `getTransaction` at `confirmed` can answer null for a signature the
 * signature list already shows (RPC indexing lag, measured on devnet). If
 * the cursor jumped past such a transaction its leaf would be a permanent
 * gap: a "0" where the chain has a commitment, and every later root rebuilt
 * from this array would be one the pool never published. So signatures are
 * processed oldest → newest and the cursor stops at the first one whose
 * transaction could not be read; the rest is picked up next refresh.
 *
 * ── NO KV ───────────────────────────────────────────────────────────────────
 * Without `KV_REST_API_URL`/`KV_REST_API_TOKEN` (or the `UPSTASH_*` pair) the
 * store is a process-global Map: correct for one `next dev` process, and it
 * says so in `meta.source` so a caller can tell.
 */

import { createClient, type VercelKV } from '@vercel/kv';
import { decodeLeafInsertionLogs } from './denominatedPool';

export const CHUNK = 4096;
/** A snapshot older than this is re-read before it is served (unless locked). */
export const STALE_AFTER_MS = 20_000;
/** Forced refreshes (`?refresh=1`, POST) are rate-limited to one per this. */
export const FORCED_REFRESH_MIN_INTERVAL_MS = 3_000;
const LOCK_TTL_SEC = 20;
/** Transactions fetched concurrently by one refresh. Server RPC, no pacing. */
const TX_CONCURRENCY = 25;
/** Hard cap of new signatures walked in one refresh (≈ 5 chunk-writes). */
const MAX_NEW_SIGNATURES = 5_000;

export interface PoolLeavesMeta {
  version: 1;
  pool: string;
  /** Dense length: highest known leaf index + 1. */
  leafCount: number;
  /** Newest signature whose transaction has been decoded into the array. */
  lastSignature: string | null;
  /** ms since epoch, last successful refresh (even when nothing was new). */
  updatedAt: number;
  /** Where this snapshot lives. */
  source: 'kv' | 'memory';
}

export interface LeafStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { ex?: number; nx?: boolean }): Promise<unknown>;
  mget<T>(...keys: string[]): Promise<(T | null)[]>;
  del(key: string): Promise<unknown>;
  readonly kind: 'kv' | 'memory';
}

/** The subset of `Connection` a refresh needs. Injectable for tests. */
export interface LeafRpc {
  getSignaturesForAddress(
    address: { toBase58(): string },
    opts: { limit: number; before?: string; until?: string },
  ): Promise<Array<{ signature: string; err: unknown }>>;
  getTransaction(
    signature: string,
    opts: { maxSupportedTransactionVersion: number; commitment: 'confirmed' },
  ): Promise<{ meta: { logMessages?: string[] | null } | null } | null>;
}

// ── Store ───────────────────────────────────────────────────────────────────

class MemoryLeafStore implements LeafStore {
  readonly kind = 'memory' as const;
  private m = new Map<string, { v: unknown; exp: number | null }>();
  private live(k: string) {
    const e = this.m.get(k);
    if (!e) return null;
    if (e.exp !== null && e.exp <= Date.now()) {
      this.m.delete(k);
      return null;
    }
    return e;
  }
  async get<T>(key: string): Promise<T | null> {
    const e = this.live(key);
    return e ? (e.v as T) : null;
  }
  async set(key: string, value: unknown, opts?: { ex?: number; nx?: boolean }): Promise<unknown> {
    if (opts?.nx && this.live(key)) return null;
    this.m.set(key, { v: value, exp: opts?.ex ? Date.now() + opts.ex * 1000 : null });
    return 'OK';
  }
  async mget<T>(...keys: string[]): Promise<(T | null)[]> {
    return keys.map((k) => {
      const e = this.live(k);
      return e ? (e.v as T) : null;
    });
  }
  async del(key: string): Promise<unknown> {
    return this.m.delete(key) ? 1 : 0;
  }
  clear() {
    this.m.clear();
  }
}

class KvLeafStore implements LeafStore {
  readonly kind = 'kv' as const;
  constructor(private kv: VercelKV) {}
  get<T>(key: string) {
    return this.kv.get<T>(key);
  }
  set(key: string, value: unknown, opts?: { ex?: number; nx?: boolean }) {
    if (opts?.nx && opts.ex) return this.kv.set(key, value, { nx: true, ex: opts.ex });
    if (opts?.nx) return this.kv.set(key, value, { nx: true });
    if (opts?.ex) return this.kv.set(key, value, { ex: opts.ex });
    return this.kv.set(key, value);
  }
  mget<T>(...keys: string[]) {
    return this.kv.mget<(T | null)[]>(...keys);
  }
  del(key: string) {
    return this.kv.del(key);
  }
}

const globalRef = globalThis as unknown as { __p01PoolLeavesMem?: MemoryLeafStore };

/** KV when configured, else one process-global memory store. */
export function getLeafStore(): LeafStore {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return new KvLeafStore(createClient({ url, token }));
  if (!globalRef.__p01PoolLeavesMem) globalRef.__p01PoolLeavesMem = new MemoryLeafStore();
  return globalRef.__p01PoolLeavesMem;
}

/** Tests: drop the process-global memory store. */
export function resetMemoryLeafStoreForTests(): void {
  globalRef.__p01PoolLeavesMem?.clear();
  delete globalRef.__p01PoolLeavesMem;
}

export const K = {
  meta: (pool: string) => `pool-leaves:v1:${pool}:meta`,
  chunk: (pool: string, n: number) => `pool-leaves:v1:${pool}:c${n}`,
  lock: (pool: string) => `pool-leaves:v1:${pool}:lock`,
  forced: (pool: string) => `pool-leaves:v1:${pool}:forced`,
};

// ── RPC choice ──────────────────────────────────────────────────────────────

/**
 * The RPC the SERVER reads with. `P01_POOL_LEAVES_RPC` (dedicated) or
 * `P01_FUNDER_RPC` (the funder's, already provisioned) win; else Helius devnet
 * with whichever Helius key is present; else the public devnet endpoint, which
 * rate-limits and is only acceptable for a local run.
 */
export function chooseServerRpc(env: NodeJS.ProcessEnv = process.env): string {
  if (env.P01_POOL_LEAVES_RPC) return env.P01_POOL_LEAVES_RPC;
  if (env.P01_FUNDER_RPC) return env.P01_FUNDER_RPC;
  const key = env.HELIUS_API_KEY || env.NEXT_PUBLIC_HELIUS_API_KEY;
  if (key) return `https://devnet.helius-rpc.com/?api-key=${key}`;
  return 'https://api.devnet.solana.com';
}

// ── Read ────────────────────────────────────────────────────────────────────

export async function readPoolLeavesMeta(store: LeafStore, pool: string): Promise<PoolLeavesMeta | null> {
  const meta = await store.get<PoolLeavesMeta>(K.meta(pool));
  if (!meta || meta.version !== 1 || typeof meta.leafCount !== 'number') return null;
  return meta;
}

/**
 * Read leaves `[from, from + limit)` of the dense array. Chunks that were
 * never written read as all-"0" (they can exist between a sparse write and a
 * later one only transiently, but the shape must hold regardless).
 */
export async function readPoolLeavesRange(
  store: LeafStore,
  pool: string,
  meta: PoolLeavesMeta,
  from: number,
  limit: number,
): Promise<string[]> {
  const start = Math.max(0, Math.min(from, meta.leafCount));
  const end = Math.max(start, Math.min(meta.leafCount, start + limit));
  if (end === start) return [];
  const firstChunk = Math.floor(start / CHUNK);
  const lastChunk = Math.floor((end - 1) / CHUNK);
  const keys: string[] = [];
  for (let n = firstChunk; n <= lastChunk; n++) keys.push(K.chunk(pool, n));
  const chunks = await store.mget<string[]>(...keys);
  const out: string[] = [];
  for (let i = start; i < end; i++) {
    const c = chunks[Math.floor(i / CHUNK) - firstChunk];
    const v = c ? c[i % CHUNK] : undefined;
    out.push(typeof v === 'string' ? v : '0');
  }
  return out;
}

// ── Refresh ─────────────────────────────────────────────────────────────────

/** Newest-first signatures strictly newer than `until`, capped. */
async function listNewSignatures(
  rpc: LeafRpc,
  pool: { toBase58(): string },
  until: string | null,
): Promise<Array<{ signature: string; err: unknown }>> {
  const PAGE = 1000;
  const sigs: Array<{ signature: string; err: unknown }> = [];
  let before: string | undefined;
  while (sigs.length < MAX_NEW_SIGNATURES) {
    const page = await rpc.getSignaturesForAddress(pool, {
      limit: Math.min(PAGE, MAX_NEW_SIGNATURES - sigs.length),
      before,
      until: until ?? undefined,
    });
    if (page.length === 0) break;
    sigs.push(...page);
    if (page.length < PAGE) break;
    before = page[page.length - 1].signature;
  }
  return sigs;
}

export interface RefreshResult {
  meta: PoolLeavesMeta;
  /** Signatures walked this refresh. */
  newSignatures: number;
  /** Leaves written this refresh. */
  newLeaves: number;
  /** True when the cursor stopped early on an unreadable transaction. */
  truncated: boolean;
}

/**
 * Advance the pool's array to the chain. Idempotent; safe to call
 * concurrently only under `withRefreshLock`.
 */
export async function refreshPoolLeaves(
  store: LeafStore,
  rpc: LeafRpc,
  pool: { toBase58(): string },
  now: () => number = Date.now,
): Promise<RefreshResult> {
  const poolStr = pool.toBase58();
  const prev = await readPoolLeavesMeta(store, poolStr);
  const newestFirst = await listNewSignatures(rpc, pool, prev?.lastSignature ?? null);
  // Oldest → newest, so the cursor never skips a transaction it did not read.
  const oldestFirst = [...newestFirst].reverse();

  const found = new Map<number, string>(); // leafIndex → commitment (decimal)
  let cursor = prev?.lastSignature ?? null;
  let truncated = false;
  let walked = 0;

  for (let i = 0; i < oldestFirst.length && !truncated; i += TX_CONCURRENCY) {
    const batch = oldestFirst.slice(i, i + TX_CONCURRENCY);
    const txs = await Promise.all(
      batch.map((s) =>
        s.err
          ? Promise.resolve({ meta: null }) // a failed transaction inserted nothing
          : rpc
              .getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
              .catch(() => null),
      ),
    );
    for (let t = 0; t < batch.length; t++) {
      const tx = txs[t];
      if (tx === null) {
        // Not readable yet: stop here, keep everything before it.
        truncated = true;
        break;
      }
      const logs = tx.meta?.logMessages ?? [];
      for (const { commitment, leafIndex } of decodeLeafInsertionLogs(logs)) {
        found.set(leafIndex, commitment.toString());
      }
      cursor = batch[t].signature;
      walked += 1;
    }
  }

  let leafCount = prev?.leafCount ?? 0;
  for (const idx of found.keys()) if (idx + 1 > leafCount) leafCount = idx + 1;

  if (found.size > 0) {
    // Group by chunk, read-modify-write only the chunks touched.
    const byChunk = new Map<number, Array<[number, string]>>();
    for (const [idx, v] of found) {
      const n = Math.floor(idx / CHUNK);
      const arr = byChunk.get(n) ?? [];
      arr.push([idx % CHUNK, v]);
      byChunk.set(n, arr);
    }
    const chunkIds = [...byChunk.keys()].sort((a, b) => a - b);
    const existing = await store.mget<string[]>(...chunkIds.map((n) => K.chunk(poolStr, n)));
    for (let k = 0; k < chunkIds.length; k++) {
      const n = chunkIds[k];
      const arr = existing[k] && Array.isArray(existing[k]) ? [...existing[k]!] : new Array<string>(CHUNK).fill('0');
      while (arr.length < CHUNK) arr.push('0');
      for (const [off, v] of byChunk.get(n)!) arr[off] = v;
      await store.set(K.chunk(poolStr, n), arr);
    }
  }

  const meta: PoolLeavesMeta = {
    version: 1,
    pool: poolStr,
    leafCount,
    lastSignature: cursor,
    updatedAt: now(),
    source: store.kind,
  };
  await store.set(K.meta(poolStr), meta);
  return { meta, newSignatures: walked, newLeaves: found.size, truncated };
}

/**
 * Run `fn` only if no other refresh of this pool is in flight. Returns `null`
 * when the lock is held (the caller serves what it has).
 */
export async function withRefreshLock<T>(
  store: LeafStore,
  pool: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const ok = await store.set(K.lock(pool), '1', { nx: true, ex: LOCK_TTL_SEC });
  if (ok !== 'OK') return null;
  try {
    return await fn();
  } finally {
    await store.del(K.lock(pool)).catch(() => undefined);
  }
}

/** Forced refreshes are rate-limited per pool; returns false when too soon. */
export async function claimForcedRefresh(store: LeafStore, pool: string): Promise<boolean> {
  const ok = await store.set(K.forced(pool), '1', {
    nx: true,
    ex: Math.max(1, Math.ceil(FORCED_REFRESH_MIN_INTERVAL_MS / 1000)),
  });
  return ok === 'OK';
}
