/**
 * close-v1, lane L3, audit v1 F33 / F34 follow-up: a pool-history row written
 * before the leaf-map fixes is never served again.
 *
 * Run: cd apps/web && npx vitest run --config vitest.pool.config.mts lib/privacy/pool/closeV1L3PoolHistoryVersion.test.ts
 *
 * THE FLAW. The fixes of audit round 2 changed what a walk files: leaves by
 * INDEX instead of by commitment (F33: a commitment inserted twice used to
 * overwrite its first leaf, a hole in every rebuilt tree) and only events logged
 * by zk_shielded for THIS pool (F34: any program's `Program data:` line that
 * started with the LeafInserted discriminator was a leaf). The rows those walks
 * wrote, on the device (IndexedDB) and in the shared KV twin, still carried
 * version 2, so the fixed code loaded them and trusted them: a foreign leaf
 * filed at some index, or a hole, survived every warm walk, because a warm walk
 * does not re-read the transactions a row already covers.
 *
 * WHAT IS PINNED. `POOL_HISTORY_VERSION` is 3, and a row of any earlier version
 * (1 or 2), on a device or in KV, is discarded and rebuilt by a cold walk.
 */
import { describe, expect, it } from 'vitest';
import type { KvLike } from '@/lib/waitlist/store';
import {
  POOL_HISTORY_VERSION,
  loadPoolHistory,
  memoryPoolHistoryStore,
  poolHistoryKey,
  indexedDbPoolHistoryStore,
  type PoolHistoryStore,
} from './poolHistoryCache';
import { KV_POOL_HISTORY_PREFIX, kvPoolHistoryStore } from './kvPoolHistory';

const ENDPOINT = 'https://devnet.helius-rpc.com/';
const POOL = 'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c';
const SIG = (i: number) => `${'5'.repeat(86)}${'ABCDEFGHJKLMNPQRSTUVWXYZ'[i]}z`;
const PAYER = '7nxQB4Hy9LmPdTJ3kYfPq8WvNs2jKmRt4xFc6dZe8fKm';

/** A row exactly as the pre-fix walk (version 2) wrote it, with a foreign leaf at index 1. */
function preFixRow(key: string, version: 1 | 2) {
  const entries = [
    { commitment: '1001', leafIndex: 0, depositPayer: PAYER, depositSlot: 10, signature: SIG(0) },
    // Logged by another program in a transaction that named the pool: F34.
    { commitment: '6666', leafIndex: 1, depositPayer: PAYER, depositSlot: 11, signature: SIG(1) },
  ];
  return version === 1
    ? { version: 1 as const, key, newestSignature: SIG(1), entries, savedAt: 0 }
    : {
        version: 2,
        key,
        newestSignature: SIG(1),
        oldestSignature: SIG(0),
        reachedOldest: true,
        complete: true,
        retry: [],
        dropped: 0,
        gaps: [],
        rewalkAt: null,
        entries,
        savedAt: 0,
      };
}

describe('F33/F34: a pre-fix pool-history row is rebuilt, never served', () => {
  it('the version was bumped past the pre-fix rows', () => {
    expect(POOL_HISTORY_VERSION).toBe(3);
  });

  for (const version of [2, 1] as const) {
    it(`a version-${version} device row under the current key is discarded and deleted`, async () => {
      const store = memoryPoolHistoryStore();
      const key = poolHistoryKey(ENDPOINT, POOL);
      await store.save(preFixRow(key, version) as never);
      const { snapshot } = await loadPoolHistory(store, ENDPOINT, POOL);
      expect(snapshot, `a version-${version} row was served to the walk`).toBeNull();
      expect(await store.load(key), 'the pre-fix row is still on the device').toBeNull();
    });
  }

  it('a version-1 row left under an endpoint-shaped key is deleted without being healed into a served row', async () => {
    const store = memoryPoolHistoryStore();
    const legacyKey = `${ENDPOINT}?api-key=OLD|${POOL}`;
    await store.save(preFixRow(legacyKey, 1) as never);
    const { snapshot } = await loadPoolHistory(store, ENDPOINT, POOL);
    expect(snapshot).toBeNull();
    expect(await store.keys!()).toEqual([]);
  });

  it('the IndexedDB store does not hand a version-2 row back', async () => {
    const rows = new Map<string, unknown>();
    const req = <T,>(result: () => T) => {
      const r: { result?: T; error?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
      queueMicrotask(() => {
        r.result = result();
        r.onsuccess?.();
      });
      return r;
    };
    const idb = {
      open() {
        const r: Record<string, unknown> = {};
        const db = {
          transaction: () => ({
            objectStore: () => ({
              get: (k: string) => req(() => rows.get(k)),
              put: (v: { key: string }) => req(() => rows.set(v.key, v)),
              delete: (k: string) => req(() => rows.delete(k)),
              getAllKeys: () => req(() => [...rows.keys()]),
            }),
          }),
          close() {},
          createObjectStore() {},
        };
        queueMicrotask(() => {
          r.result = db;
          (r.onsuccess as (() => void) | undefined)?.();
        });
        return r;
      },
    } as unknown as IDBFactory;
    const store: PoolHistoryStore = indexedDbPoolHistoryStore(idb);
    const key = poolHistoryKey(ENDPOINT, POOL);
    rows.set(key, preFixRow(key, 2));
    expect(await store.load(key)).toBeNull();
  });

  it('a version-2 row in the shared KV twin is not trusted by a cold isolate', async () => {
    const kvRows = new Map<string, unknown>();
    const kv = {
      async get(k: string) {
        return (kvRows.get(k) ?? null) as never;
      },
      async set(k: string, v: unknown) {
        kvRows.set(k, v);
      },
    } as unknown as KvLike;
    const { entries, newestSignature, oldestSignature } = preFixRow('', 2) as ReturnType<typeof preFixRow> & {
      oldestSignature: string;
    };
    kvRows.set(KV_POOL_HISTORY_PREFIX + POOL, {
      format: 1,
      version: 2,
      newestSignature,
      oldestSignature,
      reachedOldest: true,
      complete: true,
      retry: [],
      dropped: 0,
      gaps: [],
      rewalkAt: null,
      entries,
    });
    const store = kvPoolHistoryStore(() => kv, { schedule: async (t) => t() });
    expect(await store.load(poolHistoryKey(ENDPOINT, POOL))).toBeNull();
  });
});
