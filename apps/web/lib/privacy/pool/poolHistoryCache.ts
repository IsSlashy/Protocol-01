/**
 * [HISTORY-CACHE 2026-09-13] The pool's leaf history, fetched ONCE and then
 * only extended.
 *
 * MEASURED 2026-09-13 (`docs/BENCHMARK-2026-09-13.md` §5): locating a note the
 * wallet had just deposited took 90+ s of "Still looking", all of it in
 * `fetchPoolCommitments` — `getSignaturesForAddress` over the pool's whole
 * history plus one `getTransaction` per signature, on every subscribe and every
 * withdrawal, with nothing kept between calls. The tree program persists only
 * `filled_subtrees[0]`, so the history walk is the only source of the leaves;
 * what is optional is walking it again.
 *
 * The cache keeps, per (RPC HOST, pool), the decoded leaf events, the NEWEST
 * signature seen and the OLDEST one. The next walk asks the RPC for signatures
 * `until` the newest and, while the history is not yet whole, for the page
 * before the oldest; the map is merged, never rebuilt. Every entry is public
 * on-chain data (a commitment and the signature that emitted it), so holding
 * it locally reveals nothing the chain does not.
 *
 * [HIST-1 2026-09-16] The key used to be `${rpcEndpoint}|${pool}`, and was
 * copied into the row as `key` as well, so every row on a device — and every
 * JSON file the live harness wrote — spelled a Helius URL's credential in
 * clear. It is the host alone now, and a row left under the old key is read
 * once, migrated and deleted. Pinned by the `[HIST-1]` block of
 * `poolHistoryCache.test.ts`; the walk that fills the new fields is pinned by
 * `poolHistoryBackfill.test.ts`.
 *
 * Storage is pluggable: IndexedDB when the runtime has it (the web worker),
 * memory otherwise, or whatever `setPoolHistoryStore` installs (the live devnet
 * harness uses a JSON file so a second run measures the incremental path).
 */

export interface CachedCommitmentEntry {
  commitment: string;
  leafIndex: number;
  depositPayer: string | null;
  depositSlot: number | null;
  signature: string;
}

/**
 * [close-v1, audit v1 F33 / F34 follow-up] 3 since the leaf-map fixes.
 *
 * Rows of version 1 and 2 were written by walks that filed leaves BY
 * COMMITMENT (F33: a commitment inserted twice overwrote its first leaf, a
 * hole in every rebuilt tree) and accepted a LeafInserted-shaped `Program
 * data:` line from ANY program in any transaction naming the pool (F34: a
 * foreign leaf at an index of the caller's choosing). A warm walk does not
 * re-read what a row already covers, so such a row kept serving the old
 * mistake after the fix. Every row of an earlier version is therefore
 * discarded (and deleted where the store can say so), never migrated, and the
 * next walk is cold: once per device and once for the shared KV twin. Pinned by
 * `closeV1L3PoolHistoryVersion.test.ts`.
 */
export const POOL_HISTORY_VERSION = 3;

/**
 * How many times one signature is asked for before the walk gives up on it and
 * counts it. Five, so a run of RPC 429s costs nothing permanent, while a
 * signature the RPC will never serve cannot be re-read for ever.
 */
export const MAX_HISTORY_READ_ATTEMPTS = 5;

/** The longest re-read list carried between calls; the overflow is counted, not forgotten. */
export const MAX_HISTORY_RETRY_ENTRIES = 256;

/**
 * The most unfinished middle stretches carried between calls. Past it, the two
 * oldest are merged into one stretch that also covers the signatures between
 * them: re-listed, never skipped.
 */
export const MAX_HISTORY_GAPS = 16;

/**
 * A stretch of history a warm walk listed only part of because its budget ran
 * out: the signatures older than `before` and newer than `until` (both
 * exclusive, the RPC's own paging bounds) have not been listed yet. Pinned by
 * `poolHistoryBackfill.test.ts`, "growth past maxSignatures between two warm
 * calls is completed, in a bounded number of pages".
 */
export interface PoolHistoryGap {
  before: string;
  until: string;
}

/** A signature whose transaction did not arrive, and how many times it has been asked for. */
export interface PoolHistoryRetry {
  signature: string;
  attempts: number;
}

export interface PoolHistorySnapshot {
  version: typeof POOL_HISTORY_VERSION;
  key: string;
  /** The newest signature whose transaction has been decoded, or null for an empty history. */
  newestSignature: string | null;
  /** The oldest signature this walk listed: where a capped walk resumes. */
  oldestSignature: string | null;
  /** True once a page older than `oldestSignature` came back short or empty. */
  reachedOldest: boolean;
  /** True when leaves 0..next_leaf_index-1 are all in hand and nothing is waiting to be re-read. */
  complete: boolean;
  retry: PoolHistoryRetry[];
  /** Signatures given up on, so a hole is a number rather than a silence. */
  dropped: number;
  /** Unfinished middle stretches, newest first. */
  gaps: PoolHistoryGap[];
  /** next_leaf_index when a hole nothing accounted for last scheduled a re-walk, or null. */
  rewalkAt: number | null;
  entries: CachedCommitmentEntry[];
  savedAt: number;
}

/**
 * The shape shipped on 2026-09-13. Recognised only so it can be discarded
 * (see `POOL_HISTORY_VERSION`); never served, never written.
 */
export interface PoolHistorySnapshotV1 {
  version: 1;
  key: string;
  newestSignature: string | null;
  entries: CachedCommitmentEntry[];
  savedAt: number;
}

export type StoredPoolHistory = PoolHistorySnapshot | PoolHistorySnapshotV1;

export interface PoolHistoryStore {
  load(key: string): Promise<StoredPoolHistory | null>;
  save(snapshot: PoolHistorySnapshot): Promise<void>;
  clear(key: string): Promise<void>;
  /**
   * Every key the store holds. Optional, so a store written before it existed
   * still satisfies the interface; a store that keeps rows on a USER'S DEVICE
   * must have it, because `loadPoolHistory` can only delete a row left under a
   * key it cannot recompute if it can list the keys. See `healForeignRows`.
   */
  keys?(): Promise<string[]>;
  /**
   * True for a store whose row belongs to ONE USER'S DEVICE and outlives the
   * page (IndexedDB). The walk then resumes at a public anchor instead of this
   * row's own newest signature, because what it asks the RPC would otherwise
   * name the moment this device last came (`fetchPoolCommitments`,
   * "[SWEEP round 1 of run logs8, network lens]"). A server's shared row (the
   * KV twin) and a memory map that dies with the page leave it unset: neither
   * is a person coming back.
   */
  readonly perDevice?: boolean;
}

export function memoryPoolHistoryStore(): PoolHistoryStore {
  const m = new Map<string, PoolHistorySnapshot>();
  return {
    async load(key) {
      return m.get(key) ?? null;
    },
    async save(snapshot) {
      m.set(snapshot.key, snapshot);
    },
    async clear(key) {
      m.delete(key);
    },
    async keys() {
      return [...m.keys()];
    },
  };
}

const IDB_NAME = 'p01-pool-history';
const IDB_STORE = 'snapshots';

/** IndexedDB-backed store; falls back to memory if the database cannot be opened. */
export function indexedDbPoolHistoryStore(idb: IDBFactory): PoolHistoryStore {
  const fallback = memoryPoolHistoryStore();
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = idb.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(IDB_STORE, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const run = async <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, mode);
        const req = f(tx.objectStore(IDB_STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    perDevice: true,
    async load(key) {
      try {
        const v = await run<StoredPoolHistory | undefined>('readonly', (s) => s.get(key) as IDBRequest<StoredPoolHistory | undefined>);
        // Only the current version is served: an earlier row is a pre-fix
        // walk's leaf map (`POOL_HISTORY_VERSION`), overwritten by the next save.
        return v && v.version === POOL_HISTORY_VERSION ? v : null;
      } catch {
        return fallback.load(key);
      }
    },
    async save(snapshot) {
      try {
        await run('readwrite', (s) => s.put(snapshot));
      } catch {
        await fallback.save(snapshot);
      }
    },
    async clear(key) {
      try {
        await run('readwrite', (s) => s.delete(key));
      } catch {
        await fallback.clear(key);
      }
    },
    async keys() {
      try {
        const all = await run<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
        return all.filter((k): k is string => typeof k === 'string');
      } catch {
        return fallback.keys!();
      }
    },
  };
}

let activeStore: PoolHistoryStore | null = null;

/**
 * [SWEEP4 repair r1, gate RED 6] Signatures the walk has GIVEN UP on: listed as
 * successful, read `MAX_HISTORY_READ_ATTEMPTS` times, never returned, counted
 * once into the row's `dropped`. In memory only — a raw signature written into
 * the stored row is a signature in a storage dump, and the ones that land there
 * newest-first are this device's own recent pool activity.
 *
 * ⛔ WHY IT HAD TO EXIST THE MOMENT THE RESUME POINT LEARNED TO SKIP UNREAD
 * SIGNATURES. The resume point is what the next walk lists FROM, so a signature
 * it skips is listed again for ever. A signature the RPC will not serve used to
 * BECOME the resume point and leave the walk's sight; now it does not, so
 * without this set it is re-queued and re-read on every walk and `dropped`
 * climbs without bound. Measured: `spendRootIsCurrent.test.ts`, "signatures the
 * walk gave up on keep a short map from being proved", read `dropped` 4 instead
 * of 2 with the skip in place and this set missing.
 *
 * ⚠️ IT LIVES HERE, NEXT TO THE STORE, SO THAT REPLACING THE STORE EMPTIES IT.
 * A module-scope set in `denominatedPool.ts` outlived a test's world and hid a
 * leaf from the next one (144 of 256 worlds in `spendRootIsCurrent.test.ts`).
 * "A new store is a new history" is the rule a test and a real client both obey,
 * and in a browser `setPoolHistoryStore` runs once.
 */
const gaveUpSignatures = new Set<string>();

/** Forgetting one costs a single re-read, the trade `leaflessSignatures` makes. */
const MAX_GIVEN_UP_REMEMBERED = 4096;

export function rememberGivenUpSignature(signature: string): void {
  if (gaveUpSignatures.size >= MAX_GIVEN_UP_REMEMBERED) gaveUpSignatures.clear();
  gaveUpSignatures.add(signature);
}

export function hasGivenUpOnSignature(signature: string): boolean {
  return gaveUpSignatures.has(signature);
}

/**
 * [SWEEP round 1 of run logs8, network lens] Signatures whose transaction THIS
 * PAGE LOAD has already read and decoded. In memory only, and beside the store
 * for the reason `gaveUpSignatures` is.
 *
 * A device's walk re-reads every transaction above the public anchor, held or
 * not, so that the set of reads says nothing about what the device held when
 * it arrived (`poolWalkPublicAnchor.test.ts`). Within one page load the RPC
 * already sees one connection from one address, so a second read of the same
 * transaction would buy nothing: each is read once a session ("a session reads
 * a transaction once").
 */
const readThisSession = new Set<string>();

/** Same trade as `gaveUpSignatures`: forgetting costs one re-read. */
const MAX_READ_REMEMBERED = 8192;

export function rememberReadThisSession(signature: string): void {
  if (readThisSession.size >= MAX_READ_REMEMBERED) readThisSession.clear();
  readThisSession.add(signature);
}

export function wasReadThisSession(signature: string): boolean {
  return readThisSession.has(signature);
}

/**
 * [flow-speed X1 2026-09-23] History walks in flight IN THIS WORKER, by
 * `poolHistoryKey` plus the walk's budget (`fetchPoolCommitments`'
 * `joinInFlight`). Memory only: never persisted, never sent to the main thread.
 *
 * Beside the store for the reason `gaveUpSignatures` is: a new store is a new
 * history, so `setPoolHistoryStore` empties it, and a call made after a store
 * change never waits on a walk of the old one (in a test, a walk left pending
 * by one world would otherwise hang the next).
 */
const inFlightWalks = new Map<string, Promise<unknown>>();

export function inFlightPoolWalks(): Map<string, Promise<unknown>> {
  return inFlightWalks;
}

export function setPoolHistoryStore(store: PoolHistoryStore | null): void {
  activeStore = store;
  // A new store is a new history: what the previous one gave up on says nothing
  // about this one. See `gaveUpSignatures`.
  gaveUpSignatures.clear();
  readThisSession.clear();
  inFlightWalks.clear();
}

export function getPoolHistoryStore(): PoolHistoryStore {
  if (activeStore) return activeStore;
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  activeStore = idb ? indexedDbPoolHistoryStore(idb) : memoryPoolHistoryStore();
  return activeStore;
}

/**
 * The endpoint's host, with no path, query, fragment or credentials. A Helius
 * URL carries its API key in the query and some providers carry it in the
 * path, so nothing but the host may reach a stored row.
 *
 * Two endpoints that differ only by their credential therefore share one
 * snapshot, which is right: same host, same chain, same public leaves. The
 * cost is that two clusters served from ONE host under different paths would
 * share a row too; no endpoint in this repo is of that shape.
 */
function rpcHostOf(rpcEndpoint: string): string {
  try {
    const host = new URL(rpcEndpoint).host;
    if (host) return host;
  } catch {
    // Not a URL. Fall through to the textual cut below.
  }
  const cut = rpcEndpoint.split(/[/?#]/)[0] ?? '';
  const afterCredentials = cut.includes('@') ? cut.slice(cut.lastIndexOf('@') + 1) : cut;
  return afterCredentials || 'rpc';
}

export function poolHistoryKey(rpcEndpoint: string, poolPDA: string): string {
  return `${rpcHostOf(rpcEndpoint)}|${poolPDA}`;
}

/** The key the 2026-09-13 walk wrote: the whole endpoint, credential and all. */
function legacyPoolHistoryKey(rpcEndpoint: string, poolPDA: string): string {
  return `${rpcEndpoint}|${poolPDA}`;
}

/** The signature that inserted the highest leaf the row holds, or null for a row with no leaf. */
function newestLeafSignature(entries: CachedCommitmentEntry[]): string | null {
  let top: CachedCommitmentEntry | null = null;
  for (const e of entries) {
    if (typeof e?.leafIndex !== 'number' || typeof e.signature !== 'string') continue;
    if (!top || e.leafIndex > top.leafIndex) top = e;
  }
  return top?.signature ?? null;
}

/**
 * The row as a current snapshot under `key`, or null when it is of an earlier
 * version: a pre-fix walk's leaf map is never served (`POOL_HISTORY_VERSION`).
 */
function currentSnapshot(raw: StoredPoolHistory, key: string): PoolHistorySnapshot | null {
  if (raw.version !== POOL_HISTORY_VERSION) return null;
  return {
    ...raw,
    key,
    oldestSignature: raw.oldestSignature ?? null,
    reachedOldest: raw.reachedOldest === true,
    complete: raw.complete === true,
    retry: Array.isArray(raw.retry) ? raw.retry : [],
    dropped: typeof raw.dropped === 'number' ? raw.dropped : 0,
    // A row the round-0 walk of this work package wrote has neither field.
    gaps: Array.isArray(raw.gaps) ? raw.gaps : [],
    rewalkAt: typeof raw.rewalkAt === 'number' ? raw.rewalkAt : null,
    entries: Array.isArray(raw.entries) ? raw.entries : [],
  };
}

/** `host|pool`: a host (a port is allowed), one bar, a base58 public key. Nothing a URL is made of. */
const WELL_FORMED_KEY = /^[^\s|/?#@]+\|[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Stores already healed this session: the pass lists every key, so once per store is enough. */
const healedStores = new WeakSet<PoolHistoryStore>();

/**
 * [SWEEP round 1 of run logs8, storage lens] Every row whose key is not
 * `host|pool` is healed into one that is, or deleted — found by LISTING the
 * store, never by recomputing the key it was written under.
 *
 * WHY. The build on origin/master keys the row `${rpcEndpoint}|${pool}`, and
 * the HIST-1 migration in `loadPoolHistory` looks only under the legacy key it
 * can rebuild from TODAY's endpoint. The day the RPC credential is rotated the
 * rebuilt key stops matching, and the row the old build left — its
 * `newestSignature` (the device's own withdrawal whenever its last walk was
 * the post-withdrawal rescan), its `savedAt` millisecond, its walk-order
 * entries, the old endpoint in the key — stays for the life of the profile. A
 * row of a pool this client never opens again is orphaned the same way.
 * Measured by `logs8/r1-storage/A-orphan-history-row.probe.ts`; pinned by
 * `poolHistoryCache.test.ts`, "[SWEEP-R1-STORAGE] a row left under a key that
 * spells an endpoint does not outlive one walk".
 *
 * Healed rather than dropped when the row parses: the leaves are public
 * on-chain data and a cold walk costs a returning user the 90 s this cache
 * exists to save. What is NOT carried over is what moved with the device — the
 * resume point becomes the newest leaf's signature, the clock 0, the re-read
 * list empty, the entries leaf order. A row already at the healed key wins.
 *
 * A store without `keys()` (the KV twin, a test literal) is left to the HIST-1
 * path: the KV row was never keyed by an endpoint (`kvPoolHistory.ts`).
 */
async function healForeignRows(store: PoolHistoryStore): Promise<void> {
  if (!store.keys || healedStores.has(store)) return;
  let keys: string[];
  try {
    keys = await store.keys();
  } catch {
    return; // Not marked healed: the next walk tries again.
  }
  for (const foreign of keys) {
    if (WELL_FORMED_KEY.test(foreign)) continue;
    const bar = foreign.lastIndexOf('|');
    const pool = bar >= 0 ? foreign.slice(bar + 1) : '';
    const target = bar > 0 && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pool)
      ? poolHistoryKey(foreign.slice(0, bar), pool)
      : null;
    if (target !== null && WELL_FORMED_KEY.test(target)) {
      const raw = await store.load(foreign).catch(() => null);
      const healed = raw ? currentSnapshot(raw, target) : null;
      if (healed && !(await store.load(target).catch(() => null))) {
        const entries = healed.entries
          .filter((e) => typeof e?.leafIndex === 'number' && typeof e.signature === 'string')
          .sort((a, b) => a.leafIndex - b.leafIndex);
        await store.save({
          ...healed,
          newestSignature: newestLeafSignature(entries),
          retry: [],
          entries,
          savedAt: 0,
        });
      }
    }
    await store.clear(foreign);
  }
  healedStores.add(store);
}

/**
 * The snapshot for (host, pool), with any row left under a key that spelled
 * an endpoint healed and DELETED first — every such row in the store, whatever
 * endpoint or pool it names (`healForeignRows`), so a row naming a credential
 * or a device's own transaction does not outlive one walk even after the
 * credential is rotated. A store that cannot list its keys gets the HIST-1
 * path alone: the one legacy key today's endpoint rebuilds. Pinned by
 * `poolHistoryCache.test.ts`, "a legacy row keyed by the whole endpoint is
 * migrated and deleted" and the "[SWEEP-R1-STORAGE]" block.
 */
export async function loadPoolHistory(
  store: PoolHistoryStore,
  rpcEndpoint: string,
  poolPDA: string,
): Promise<{ key: string; snapshot: PoolHistorySnapshot | null }> {
  await healForeignRows(store);
  const key = poolHistoryKey(rpcEndpoint, poolPDA);
  let raw = await store.load(key);
  const legacyKey = legacyPoolHistoryKey(rpcEndpoint, poolPDA);
  if (legacyKey !== key) {
    const legacy = await store.load(legacyKey);
    if (legacy) {
      if (!raw) raw = legacy;
      await store.clear(legacyKey);
    }
  }
  const snapshot = raw ? currentSnapshot(raw, key) : null;
  if (raw && !snapshot) {
    // A pre-fix row (`POOL_HISTORY_VERSION`): deleted, so a storage dump does
    // not keep it either, and the walk starts cold.
    await store.clear(key).catch(() => undefined);
  }
  return { key, snapshot };
}
