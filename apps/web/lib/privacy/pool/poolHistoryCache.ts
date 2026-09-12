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
 * The cache keeps, per (RPC endpoint, pool), the decoded leaf events and the
 * NEWEST signature seen. The next walk asks the RPC for signatures `until` that
 * one and decodes only those; the map is merged, never rebuilt. Every entry is
 * public on-chain data (a commitment and the signature that emitted it), so
 * holding it locally reveals nothing the chain does not.
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

export interface PoolHistorySnapshot {
  version: 1;
  key: string;
  /** The newest signature whose transaction has been decoded, or null for an empty history. */
  newestSignature: string | null;
  entries: CachedCommitmentEntry[];
  savedAt: number;
}

export interface PoolHistoryStore {
  load(key: string): Promise<PoolHistorySnapshot | null>;
  save(snapshot: PoolHistorySnapshot): Promise<void>;
  clear(key: string): Promise<void>;
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
    async load(key) {
      try {
        const v = await run<PoolHistorySnapshot | undefined>('readonly', (s) => s.get(key) as IDBRequest<PoolHistorySnapshot | undefined>);
        return v && v.version === 1 ? v : null;
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
  };
}

let activeStore: PoolHistoryStore | null = null;

export function setPoolHistoryStore(store: PoolHistoryStore | null): void {
  activeStore = store;
}

export function getPoolHistoryStore(): PoolHistoryStore {
  if (activeStore) return activeStore;
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  activeStore = idb ? indexedDbPoolHistoryStore(idb) : memoryPoolHistoryStore();
  return activeStore;
}

export function poolHistoryKey(rpcEndpoint: string, poolPDA: string): string {
  return `${rpcEndpoint}|${poolPDA}`;
}
