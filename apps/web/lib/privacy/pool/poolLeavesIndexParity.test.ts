/**
 * The indexer and the RPC scan must produce the SAME dense array.
 *
 * `fetchPoolLeavesByIndex` (client scan) and `refreshPoolLeaves` +
 * `readPoolLeavesRange` (server indexer) both decode through
 * `decodeLeafInsertionLogs`; this pins that the arrays they build from one
 * shared history are byte-identical, that the indexer is INCREMENTAL (a second
 * refresh reads only what is new), and that its cursor never skips a
 * transaction the RPC could not yet return.
 *
 * Runs under `vitest.pool.config.mts` (node, real web3.js).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';

import { fetchPoolLeavesByIndex } from './denominatedPool';
import {
  CHUNK,
  K,
  getLeafStore,
  readPoolLeavesMeta,
  readPoolLeavesRange,
  refreshPoolLeaves,
  resetMemoryLeafStoreForTests,
  withRefreshLock,
} from './poolLeavesIndex';
import { FakePoolRpc, SAMPLE_DENSE, sampleHistory } from './poolLeavesFixture.test-helpers';

const POOL = new PublicKey('6NUS4E5PhQLxnYca6mCVGs3HcwXcgF1qEZtzm392jrBS');

beforeEach(() => {
  resetMemoryLeafStoreForTests();
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
});

describe('indexer ≡ scan', () => {
  it('builds the same dense array as the RPC scan from the same history', async () => {
    const rpc = new FakePoolRpc(sampleHistory());

    const scan = await fetchPoolLeavesByIndex(rpc as unknown as Connection, POOL, { indexer: false });
    expect(scan.leavesByIndex.map(String)).toEqual(SAMPLE_DENSE);
    expect(scan.missing).toEqual([]);

    const store = getLeafStore();
    expect(store.kind).toBe('memory');
    const { meta } = await refreshPoolLeaves(store, rpc, POOL);
    const idx = await readPoolLeavesRange(store, POOL.toBase58(), meta, 0, meta.leafCount);

    expect(idx).toEqual(scan.leavesByIndex.map(String));
    expect(meta.leafCount).toBe(scan.scannedLeafCount);
    expect(meta.lastSignature).toBe('sig6');
  });

  it('is incremental: a second refresh fetches only the new transaction', async () => {
    const rpc = new FakePoolRpc(sampleHistory());
    const store = getLeafStore();
    await refreshPoolLeaves(store, rpc, POOL);
    const txCallsAfterFill = rpc.calls.getTransaction;
    expect(txCallsAfterFill).toBe(5); // 6 signatures, the failed one is never fetched

    rpc.push({ signature: 'sig7', err: null, leaves: [{ leafIndex: 5, commitment: 55n }] });
    const r = await refreshPoolLeaves(store, rpc, POOL);
    expect(r.newSignatures).toBe(1);
    expect(r.newLeaves).toBe(1);
    expect(rpc.calls.getTransaction).toBe(txCallsAfterFill + 1);
    expect(r.meta.leafCount).toBe(6);
    expect(r.meta.lastSignature).toBe('sig7');

    const all = await readPoolLeavesRange(store, POOL.toBase58(), r.meta, 0, 6);
    expect(all).toEqual([...SAMPLE_DENSE, '55']);

    // And it still equals what a scan sees now.
    const scan = await fetchPoolLeavesByIndex(rpc as unknown as Connection, POOL, { indexer: false });
    expect(scan.leavesByIndex.map(String)).toEqual(all);
  });

  it('never advances the cursor past a transaction the RPC could not return', async () => {
    const history = sampleHistory();
    history[3].unreadable = true; // sig4 not indexed yet
    const rpc = new FakePoolRpc(history);
    const store = getLeafStore();

    const first = await refreshPoolLeaves(store, rpc, POOL);
    expect(first.truncated).toBe(true);
    // sig1..sig3 processed (sig3 failed, counts as processed), stopped at sig4.
    expect(first.meta.lastSignature).toBe('sig3');
    expect(first.meta.leafCount).toBe(3);

    history[3].unreadable = false;
    const second = await refreshPoolLeaves(store, rpc, POOL);
    expect(second.truncated).toBe(false);
    expect(second.meta.lastSignature).toBe('sig6');
    const all = await readPoolLeavesRange(store, POOL.toBase58(), second.meta, 0, second.meta.leafCount);
    expect(all).toEqual(SAMPLE_DENSE);
  });

  it('spans chunk boundaries without disturbing untouched chunks', async () => {
    const history = [
      { signature: 'a', err: null, leaves: [{ leafIndex: 0, commitment: 1n }] },
      { signature: 'b', err: null, leaves: [{ leafIndex: CHUNK - 1, commitment: 2n }] },
      { signature: 'c', err: null, leaves: [{ leafIndex: CHUNK, commitment: 3n }] },
      { signature: 'd', err: null, leaves: [{ leafIndex: 2 * CHUNK + 5, commitment: 4n }] },
    ];
    const rpc = new FakePoolRpc(history);
    const store = getLeafStore();
    const { meta } = await refreshPoolLeaves(store, rpc, POOL);
    expect(meta.leafCount).toBe(2 * CHUNK + 6);

    const range = await readPoolLeavesRange(store, POOL.toBase58(), meta, CHUNK - 2, 4);
    expect(range).toEqual(['0', '2', '3', '0']);
    const tail = await readPoolLeavesRange(store, POOL.toBase58(), meta, 2 * CHUNK + 4, 10);
    expect(tail).toEqual(['0', '4']); // clipped at leafCount

    // Chunk 1 was written whole, chunk 0 and 2 too; nothing else exists.
    expect(await store.get(K.chunk(POOL.toBase58(), 3))).toBeNull();
    const scan = await fetchPoolLeavesByIndex(rpc as unknown as Connection, POOL, { indexer: false });
    const full = await readPoolLeavesRange(store, POOL.toBase58(), meta, 0, meta.leafCount);
    expect(full).toEqual(scan.leavesByIndex.map(String));
  });

  it('serialises refreshes behind one lock', async () => {
    const rpc = new FakePoolRpc(sampleHistory());
    const store = getLeafStore();
    let inner = 0;
    const a = withRefreshLock(store, POOL.toBase58(), async () => {
      inner += 1;
      await refreshPoolLeaves(store, rpc, POOL);
      return 'a';
    });
    const b = withRefreshLock(store, POOL.toBase58(), async () => {
      inner += 1;
      return 'b';
    });
    expect(await Promise.all([a, b])).toEqual(['a', null]);
    expect(inner).toBe(1);
    expect(await readPoolLeavesMeta(store, POOL.toBase58())).not.toBeNull();
  });
});
