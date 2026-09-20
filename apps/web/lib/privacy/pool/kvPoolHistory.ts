/**
 * [CACHE-1 2026-09-18] The server's pool-history snapshot, shared by every
 * serverless isolate through the deployment's KV.
 *
 * WHY. `getPoolHistoryStore()` finds no IndexedDB on the server and falls back
 * to a per-isolate memory map, so a cold isolate re-walked the pool's whole
 * history (one `getTransaction` per signature) inside a buyer's
 * `/api/issue-note`, `/api/contribute-note` or `/api/claim-for-payment`
 * request. With this store a cold isolate reads one KV row instead: 193
 * `getTransaction` calls become 0 on the 193-leaf fixture
 * (`kvPoolHistory.test.ts`, "cold isolate re-walks nothing"; red on the memory
 * store: wp-logs/CACHE-1-red.log).
 *
 * WHAT THE ROW HOLDS, AND WHAT IT DOES NOT. One row per pool,
 * `p01:pool-history:<pool>`. It is the snapshot the walk saves, minus:
 *   - `key`, which names the RPC host;
 *   - `savedAt`, the clock of the request that walked;
 *   - the order the walks happened to decode the leaves in (entries are
 *     written in leaf order).
 * No expiry is set either, because an expiry set at write time dates the
 * write. What is left is public chain data (commitments, leaf indices, the
 * deposits' fee payers, slots and signatures) plus the walk's own bookkeeping.
 * Measured rather than listed: the same walk run under another endpoint,
 * another clock, and walks spread differently over isolates and over the
 * chain's growth writes byte-identical KV (`kvPoolHistory.test.ts`, "the row
 * is a function of the chain alone…"; "KV never holds the endpoint…"; the
 * verbatim-store and expiry controls beside them).
 *
 * WHEN IT WRITES. Only when the row would change, and through `after()`, so a
 * reply never waits for the SET ("writes only when the snapshot changed…";
 * "the write is handed to after()…"). Outside a request scope `after()`
 * throws, and the write then runs inline, as `issue-note`'s sweep does.
 *
 * WHAT IT TRUSTS. A row that does not parse as exactly this shape is ignored
 * and the walk goes cold, as it did before; it is never thrown into a route
 * ("an unreadable, unwritable, malformed or foreign row never breaks the
 * walk…"). A well-formed row is trusted like the IndexedDB snapshot a client
 * keeps: whoever can write this KV can also mint claim codes, so the row adds
 * no power a KV writer lacked.
 *
 * WARM ISOLATES. A snapshot this isolate already holds is served from memory,
 * so a warm walk makes no KV read (the path it had before this store).
 */
import { after } from 'next/server';
import { getStore, type KvLike } from '@/lib/waitlist/store';
import {
  MAX_HISTORY_READ_ATTEMPTS,
  POOL_HISTORY_VERSION,
  memoryPoolHistoryStore,
  setPoolHistoryStore,
  type CachedCommitmentEntry,
  type PoolHistoryGap,
  type PoolHistoryRetry,
  type PoolHistorySnapshot,
  type PoolHistoryStore,
} from './poolHistoryCache';

export const KV_POOL_HISTORY_PREFIX = 'p01:pool-history:';

/**
 * The largest row sent in one SET. The 193-leaf fixture's row is logged by
 * "writes only when the snapshot changed…"; a row past this is not sent, and
 * the isolate keeps serving its snapshot from memory, as before this store.
 */
export const MAX_KV_POOL_HISTORY_BYTES = 900_000;

/** The row layout. A row of any other layout is ignored, never migrated. */
const KV_ROW_FORMAT = 1;

export interface KvPoolHistoryOptions {
  /** How a write is run. Default: `after()`, or inline outside a request scope. */
  schedule?: (task: () => Promise<void>) => void | Promise<void>;
  /** The largest row sent in one SET; default `MAX_KV_POOL_HISTORY_BYTES`. */
  maxRowBytes?: number;
}

interface KvPoolHistoryRow {
  format: typeof KV_ROW_FORMAT;
  version: typeof POOL_HISTORY_VERSION;
  newestSignature: string | null;
  oldestSignature: string | null;
  reachedOldest: boolean;
  complete: boolean;
  retry: PoolHistoryRetry[];
  dropped: number;
  gaps: PoolHistoryGap[];
  rewalkAt: number | null;
  entries: CachedCommitmentEntry[];
}

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;
const PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DECIMAL = /^[0-9]{1,78}$/;
const MAX_LEAF_INDEX = 2 ** 32;

const isSignature = (v: unknown): v is string => typeof v === 'string' && SIGNATURE.test(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The pool a snapshot key names, or null for a key that spells an endpoint. */
function poolOfKey(key: string): string | null {
  const bar = key.lastIndexOf('|');
  if (bar <= 0) return null;
  // `poolHistoryKey` puts the RPC host before the bar. A '/' there is the
  // pre-HIST-1 key, which spelled the whole endpoint: `loadPoolHistory` asks
  // for it and deletes whatever answers, so the shared row must not
  // ("a key that spells the endpoint never reaches the shared row").
  if (key.slice(0, bar).includes('/')) return null;
  const pool = key.slice(bar + 1);
  return PUBKEY.test(pool) ? pool : null;
}

/** The snapshot as the row holds it: no key, no clock, entries in leaf order. */
function rowOf(s: PoolHistorySnapshot): KvPoolHistoryRow {
  return {
    format: KV_ROW_FORMAT,
    version: POOL_HISTORY_VERSION,
    newestSignature: s.newestSignature,
    oldestSignature: s.oldestSignature,
    reachedOldest: s.reachedOldest,
    complete: s.complete,
    retry: s.retry
      .map((r) => ({ signature: r.signature, attempts: r.attempts }))
      .sort((a, b) => cmp(a.signature, b.signature)),
    dropped: s.dropped,
    gaps: s.gaps.map((g) => ({ before: g.before, until: g.until })),
    rewalkAt: s.rewalkAt,
    entries: s.entries
      .map((e) => ({
        commitment: e.commitment,
        leafIndex: e.leafIndex,
        depositPayer: e.depositPayer,
        depositSlot: e.depositSlot,
        signature: e.signature,
      }))
      .sort((a, b) => a.leafIndex - b.leafIndex || cmp(a.commitment, b.commitment) || cmp(a.signature, b.signature)),
  };
}

function isEntry(v: unknown): v is CachedCommitmentEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.commitment === 'string' &&
    DECIMAL.test(e.commitment) &&
    isCount(e.leafIndex) &&
    e.leafIndex < MAX_LEAF_INDEX &&
    (e.depositPayer === null || (typeof e.depositPayer === 'string' && PUBKEY.test(e.depositPayer))) &&
    (e.depositSlot === null || isCount(e.depositSlot)) &&
    isSignature(e.signature)
  );
}

function isRetry(v: unknown): v is PoolHistoryRetry {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    isSignature(r.signature) &&
    typeof r.attempts === 'number' &&
    Number.isInteger(r.attempts) &&
    r.attempts >= 1 &&
    r.attempts < MAX_HISTORY_READ_ATTEMPTS
  );
}

function isGap(v: unknown): v is PoolHistoryGap {
  if (!v || typeof v !== 'object') return false;
  const g = v as Record<string, unknown>;
  return isSignature(g.before) && isSignature(g.until);
}

/** A row read back from KV, as a snapshot under `key`, or null if it is not exactly a row. */
function snapshotOfRow(raw: unknown, key: string): PoolHistorySnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.format !== KV_ROW_FORMAT || r.version !== POOL_HISTORY_VERSION) return null;
  const { newestSignature, oldestSignature, reachedOldest, complete, dropped, rewalkAt, retry, gaps, entries } = r;
  if (!(newestSignature === null || isSignature(newestSignature))) return null;
  if (!(oldestSignature === null || isSignature(oldestSignature))) return null;
  if (typeof reachedOldest !== 'boolean' || typeof complete !== 'boolean') return null;
  if (!isCount(dropped)) return null;
  if (!(rewalkAt === null || isCount(rewalkAt))) return null;
  if (!Array.isArray(retry) || !retry.every(isRetry)) return null;
  if (!Array.isArray(gaps) || !gaps.every(isGap)) return null;
  if (!Array.isArray(entries) || !entries.every(isEntry)) return null;
  return {
    version: POOL_HISTORY_VERSION,
    key,
    newestSignature,
    oldestSignature,
    reachedOldest,
    complete,
    retry: retry as PoolHistoryRetry[],
    dropped,
    gaps: gaps as PoolHistoryGap[],
    rewalkAt,
    entries: entries as CachedCommitmentEntry[],
    savedAt: 0,
  };
}

/** `after()` inside a request; inline outside one, where `after()` throws. */
async function afterResponse(task: () => Promise<void>): Promise<void> {
  try {
    after(task);
  } catch {
    await task();
  }
}

/**
 * A `PoolHistoryStore` over the KV `resolveKv` returns (resolved on every
 * call, so a store swapped under it is followed). Never rejects: a KV that
 * cannot be read serves nothing, one that cannot be written keeps the row
 * pending for the next change.
 */
export function kvPoolHistoryStore(
  resolveKv: () => KvLike | null,
  options: KvPoolHistoryOptions = {},
): PoolHistoryStore {
  const schedule = options.schedule ?? afterResponse;
  const maxRowBytes = options.maxRowBytes ?? MAX_KV_POOL_HISTORY_BYTES;
  /** Keys that are not host|pool: never the shared row. */
  const local = memoryPoolHistoryStore();
  /** pool -> the snapshot this isolate holds. */
  const warm = new Map<string, PoolHistorySnapshot>();
  /** pool -> the row text KV is known to hold (read or written by this isolate). */
  const known = new Map<string, string>();
  /** pool -> the newest row waiting for its write. */
  const pending = new Map<string, KvPoolHistoryRow>();

  const write = async (pool: string): Promise<void> => {
    const row = pending.get(pool);
    if (!row) return;
    pending.delete(pool);
    const kv = resolveKv();
    try {
      if (!kv) throw new Error('no KV');
      await kv.set(KV_POOL_HISTORY_PREFIX + pool, row);
    } catch {
      // Not written: forget what KV holds, so the next save sends it again.
      known.delete(pool);
    }
  };

  return {
    async load(key) {
      const pool = poolOfKey(key);
      if (!pool) return local.load(key);
      const held = warm.get(pool);
      if (held) return { ...held, key };
      const kv = resolveKv();
      if (!kv) return null;
      let raw: unknown;
      try {
        raw = await kv.get<unknown>(KV_POOL_HISTORY_PREFIX + pool);
      } catch {
        return null;
      }
      const snapshot = snapshotOfRow(raw, key);
      if (!snapshot) return null;
      known.set(pool, JSON.stringify(rowOf(snapshot)));
      warm.set(pool, snapshot);
      return snapshot;
    },

    async save(snapshot) {
      const pool = poolOfKey(snapshot.key);
      if (!pool) return local.save(snapshot);
      warm.set(pool, snapshot);
      const row = rowOf(snapshot);
      const text = JSON.stringify(row);
      if (known.get(pool) === text) return;
      if (Buffer.byteLength(text, 'utf8') > maxRowBytes) return;
      known.set(pool, text);
      pending.set(pool, row);
      try {
        await schedule(() => write(pool));
      } catch {
        known.delete(pool);
      }
    },

    async clear(key) {
      const pool = poolOfKey(key);
      if (!pool) return local.clear(key);
      warm.delete(pool);
      known.delete(pool);
      pending.delete(pool);
      const kv = resolveKv();
      if (!kv) return;
      try {
        await kv.del(KV_POOL_HISTORY_PREFIX + pool);
      } catch {
        // Best effort: a row left behind is public chain data and is
        // overwritten by the next change.
      }
    },
  };
}

let installed: PoolHistoryStore | null = null;

/**
 * Make the KV-backed store the one `fetchPoolCommitments` uses in this
 * isolate. Each of the three routes that walk the pool calls it when its
 * module loads ("cold isolate re-walks nothing: <route> registers the shared
 * store when it loads"). Idempotent: one store, and so one warm snapshot, per
 * isolate. `getStore()` is read on every call, never here.
 */
export function installKvPoolHistory(): PoolHistoryStore {
  installed ??= kvPoolHistoryStore(() => getStore());
  setPoolHistoryStore(installed);
  return installed;
}
