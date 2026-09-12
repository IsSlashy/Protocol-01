/**
 * [HISTORY-CACHE 2026-09-13] The pool's leaf history, fetched ONCE and then
 * only extended. Twin of `apps/web/lib/privacy/pool/poolHistoryCache.ts`; the
 * measurement that motivates it (a 90 s history walk on every note location,
 * `docs/BENCHMARK-2026-09-13.md` §5) lives there. Every entry is public
 * on-chain data. IndexedDB when the runtime has it, memory otherwise, or what
 * `setPoolHistoryStore` installs.
 */

export interface CachedCommitmentEntry {
  commitment: string;
  leafIndex: number;
}

export interface PoolHistorySnapshot {
  version: 1;
  key: string;
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
    async load(key) { return m.get(key) ?? null; },
    async save(snapshot) { m.set(snapshot.key, snapshot); },
    async clear(key) { m.delete(key); },
  };
}

const IDB_NAME = 'p01-pool-history';
const IDB_STORE = 'snapshots';

export function indexedDbPoolHistoryStore(idb: IDBFactory): PoolHistoryStore {
  const fallback = memoryPoolHistoryStore();
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = idb.open(IDB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE, { keyPath: 'key' }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const run = async <T,>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
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
      } catch { return fallback.load(key); }
    },
    async save(snapshot) {
      try { await run('readwrite', (s) => s.put(snapshot)); } catch { await fallback.save(snapshot); }
    },
    async clear(key) {
      try { await run('readwrite', (s) => s.delete(key)); } catch { await fallback.clear(key); }
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
