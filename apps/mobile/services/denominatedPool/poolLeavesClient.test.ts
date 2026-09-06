/**
 * The indexer fast path and the fallback that makes it safe.
 *
 *   indexer answers            → its array is used, the RPC scan never runs
 *   indexer down / non-2xx     → RPC scan, unchanged
 *   indexer behind the chain   → one forced refresh, then RPC scan
 *   indexer returns garbage    → RPC scan
 *   `indexer: false`           → RPC scan (what every older test relied on)
 *
 * Runs under the mobile vitest config (node).
 */

import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';

import { fetchPoolLeavesByIndex } from './index';
import { fetchLeavesFromIndexer, resolvePoolLeavesBaseUrl } from './poolLeavesClient';
import { FakePoolRpc, SAMPLE_DENSE, sampleHistory } from './poolLeavesFixture.test-helpers';

const POOL = new PublicKey('6NUS4E5PhQLxnYca6mCVGs3HcwXcgF1qEZtzm392jrBS');
const BASE = 'http://indexer.test/api/pool-leaves';

type Handler = (url: URL) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>;

/** A `fetch` that routes to `handler` and records every URL it saw. */
function fakeFetch(handler: Handler): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    if (init?.signal?.aborted) throw new Error('aborted');
    const r = await handler(url);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    } as Response;
  }) as typeof fetch;
  return { fetchImpl, urls };
}

/** Serve `leaves` with paging, like the real route. */
function serving(leaves: string[], onReq?: (url: URL) => void): Handler {
  return (url) => {
    onReq?.(url);
    const from = Number(url.searchParams.get('from') ?? '0');
    const limit = Number(url.searchParams.get('limit') ?? '65536');
    return {
      status: 200,
      body: {
        pool: POOL.toBase58(),
        leafCount: leaves.length,
        from,
        leaves: leaves.slice(from, from + limit),
        lastSignature: 'sigN',
        updatedAt: 1_700_000_000_000,
        source: 'memory',
      },
    };
  };
}

describe('fetchLeavesFromIndexer', () => {
  it('returns the dense array, marking gaps as missing', async () => {
    const { fetchImpl } = fakeFetch(serving(['11', '0', '33']));
    const r = await fetchLeavesFromIndexer(POOL.toBase58(), { baseUrl: BASE, fetchImpl });
    expect(r).not.toBeNull();
    expect(r!.leavesByIndex).toEqual([11n, 0n, 33n]);
    expect(r!.scannedLeafCount).toBe(3);
    expect(r!.missing).toEqual([1]);
    expect(r!.source).toBe('indexer');
  });

  it('pages through a long array and stitches it back together', async () => {
    const leaves = Array.from({ length: 10 }, (_, i) => String(i + 1));
    const { fetchImpl, urls } = fakeFetch(serving(leaves));
    const r = await fetchLeavesFromIndexer(POOL.toBase58(), { baseUrl: BASE, fetchImpl, pageSize: 4 });
    expect(r!.leavesByIndex.map(String)).toEqual(leaves);
    expect(urls.map((u) => new URL(u).searchParams.get('from'))).toEqual(['0', '4', '8']);
  });

  it('is null on a non-2xx answer', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 503, body: { error: 'indexing' } }));
    expect(await fetchLeavesFromIndexer(POOL.toBase58(), { baseUrl: BASE, fetchImpl })).toBeNull();
  });

  it('is null on a network failure', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await fetchLeavesFromIndexer(POOL.toBase58(), { baseUrl: BASE, fetchImpl })).toBeNull();
  });

  it('is null when a leaf is not a decimal u64', async () => {
    const { fetchImpl } = fakeFetch(serving(['11', '0x22', '33']));
    expect(await fetchLeavesFromIndexer(POOL.toBase58(), { baseUrl: BASE, fetchImpl })).toBeNull();
    const { fetchImpl: neg } = fakeFetch(serving(['11', '-1']));
    expect(await fetchLeavesFromIndexer(POOL.toBase58(), { baseUrl: BASE, fetchImpl: neg })).toBeNull();
  });

  it('is null when the body is not the wire shape', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { leaves: 'nope' } }));
    expect(await fetchLeavesFromIndexer(POOL.toBase58(), { baseUrl: BASE, fetchImpl })).toBeNull();
  });

  it('is null on timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = ((_: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch;
      const p = fetchLeavesFromIndexer(POOL.toBase58(), { baseUrl: BASE, fetchImpl, timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(60);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('forces ONE refresh when behind the leaf the caller needs, then gives up', async () => {
    const seen: string[] = [];
    const { fetchImpl } = fakeFetch(serving(['11', '22'], (u) => seen.push(u.searchParams.get('refresh') ?? '-')));
    const r = await fetchLeavesFromIndexer(POOL.toBase58(), { baseUrl: BASE, fetchImpl, minLeafCount: 5 });
    expect(r).toBeNull();
    expect(seen).toEqual(['-', '1']);
  });

  it('accepts an answer that catches up on the forced refresh', async () => {
    let calls = 0;
    const { fetchImpl } = fakeFetch((url) => {
      calls += 1;
      const caughtUp = url.searchParams.get('refresh') === '1';
      return serving(caughtUp ? ['11', '22', '33'] : ['11', '22'])(url);
    });
    const r = await fetchLeavesFromIndexer(POOL.toBase58(), { baseUrl: BASE, fetchImpl, minLeafCount: 3 });
    expect(r!.scannedLeafCount).toBe(3);
    expect(calls).toBe(2);
  });

  it('sends refresh=1 on the first page only when asked', async () => {
    const seen: string[] = [];
    const leaves = Array.from({ length: 6 }, (_, i) => String(i + 1));
    const { fetchImpl } = fakeFetch(serving(leaves, (u) => seen.push(u.searchParams.get('refresh') ?? '-')));
    await fetchLeavesFromIndexer(POOL.toBase58(), { baseUrl: BASE, fetchImpl, fresh: true, pageSize: 3 });
    expect(seen).toEqual(['1', '-']);
  });
});

describe('fetchPoolLeavesByIndex routing', () => {
  it('uses the indexer and never touches the RPC when it answers', async () => {
    const rpc = new FakePoolRpc(sampleHistory());
    const { fetchImpl } = fakeFetch(serving(SAMPLE_DENSE));
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const steps: string[] = [];
      const r = await fetchPoolLeavesByIndex(rpc as unknown as Connection, POOL, {
        indexer: BASE,
        onStep: (s) => steps.push(s),
        minLeafCount: 5,
      });
      expect(r.leavesByIndex.map(String)).toEqual(SAMPLE_DENSE);
      expect(rpc.calls.getSignaturesForAddress).toBe(0);
      expect(rpc.calls.getTransaction).toBe(0);
      expect(steps.at(-1)).toMatch(/Fetched 5 leaves from the indexer/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to the RPC scan when the indexer is down, with the same answer', async () => {
    const rpc = new FakePoolRpc(sampleHistory());
    const { fetchImpl } = fakeFetch(() => ({ status: 502 }));
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const steps: string[] = [];
      const r = await fetchPoolLeavesByIndex(rpc as unknown as Connection, POOL, {
        indexer: BASE,
        onStep: (s) => steps.push(s),
      });
      expect(r.leavesByIndex.map(String)).toEqual(SAMPLE_DENSE);
      expect(rpc.calls.getTransaction).toBeGreaterThan(0);
      expect(steps).toContain('Indexer unavailable — scanning pool events from RPC...');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to the RPC scan when the indexer has fewer leaves than the note needs', async () => {
    const rpc = new FakePoolRpc(sampleHistory());
    const { fetchImpl, urls } = fakeFetch(serving(['11', '22']));
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const r = await fetchPoolLeavesByIndex(rpc as unknown as Connection, POOL, {
        indexer: BASE,
        minLeafCount: 5, // the note sits at leaf 4
      });
      expect(r.leavesByIndex.map(String)).toEqual(SAMPLE_DENSE);
      expect(urls).toHaveLength(2); // plain, then refresh=1, then the scan
      expect(rpc.calls.getTransaction).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('`indexer: false` is the plain scan', async () => {
    const rpc = new FakePoolRpc(sampleHistory());
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const r = await fetchPoolLeavesByIndex(rpc as unknown as Connection, POOL, { indexer: false });
      expect(r.leavesByIndex.map(String)).toEqual(SAMPLE_DENSE);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resolves no base URL under vitest unless EXPO_PUBLIC_P01_WEB_URL names the site', () => {
    expect(resolvePoolLeavesBaseUrl()).toBeNull();
    vi.stubEnv('EXPO_PUBLIC_P01_WEB_URL', 'https://protocol-01.dev/');
    try {
      expect(resolvePoolLeavesBaseUrl()).toBe('https://protocol-01.dev/api/pool-leaves');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
