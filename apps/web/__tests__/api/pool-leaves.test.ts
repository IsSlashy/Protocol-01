/**
 * /api/pool-leaves/[pool] — the leaf indexer route.
 *
 *   unknown pool                     → 404, and the RPC is never asked
 *   known pool, cold cache           → fills from the chain, answers dense
 *   warm cache inside STALE_AFTER_MS → answers from the store, no RPC call
 *   ?refresh=1 / POST                → re-reads incrementally
 *   ?from&limit                      → pages
 *   OPTIONS                          → 204 + CORS for the extension and mobile
 *
 * The RPC is a fake `Connection` (vi.mock on web3.js, same pattern as
 * relay-to-buyer.test.ts); the store is the process-memory fallback, because
 * no KV env is set here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { FakePoolRpc, SAMPLE_DENSE, sampleHistory } from '@/lib/privacy/pool/poolLeavesFixture.test-helpers';

let rpc: FakePoolRpc;
let connections = 0;

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    Connection: class {
      constructor() {
        connections += 1;
      }
      getSignaturesForAddress(...args: Parameters<FakePoolRpc['getSignaturesForAddress']>) {
        return rpc.getSignaturesForAddress(...args);
      }
      getTransaction(...args: Parameters<FakePoolRpc['getTransaction']>) {
        return rpc.getTransaction(...args);
      }
    },
  };
});

import { ALL_POOLS_V3 } from '@/lib/privacy/pool/denominatedPool';
import { STALE_AFTER_MS, resetMemoryLeafStoreForTests } from '@/lib/privacy/pool/poolLeavesIndex';
import { GET, OPTIONS, POST } from '@/app/api/pool-leaves/[pool]/route';

const KNOWN = ALL_POOLS_V3[0].poolPDA.toBase58();

function get(pool: string, query = '') {
  const req = new NextRequest(`http://localhost/api/pool-leaves/${pool}${query}`);
  return GET(req, { params: Promise.resolve({ pool }) });
}

beforeEach(() => {
  resetMemoryLeafStoreForTests();
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  rpc = new FakePoolRpc(sampleHistory());
  connections = 0;
  vi.useRealTimers();
});

describe('GET /api/pool-leaves/[pool]', () => {
  it('refuses a pool this app is not configured with, without touching the RPC', async () => {
    const res = await get('11111111111111111111111111111111');
    expect(res.status).toBe(404);
    expect(connections).toBe(0);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('fills a cold cache from the chain and answers the dense array', async () => {
    const res = await get(KNOWN);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pool).toBe(KNOWN);
    expect(body.leaves).toEqual(SAMPLE_DENSE);
    expect(body.leafCount).toBe(5);
    expect(body.from).toBe(0);
    expect(body.lastSignature).toBe('sig6');
    expect(body.source).toBe('memory');
    expect(body.refreshed).toBe(true);
    expect(res.headers.get('cache-control')).toBe('public, max-age=5, stale-while-revalidate=60');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('serves a warm cache without asking the RPC again', async () => {
    await get(KNOWN);
    const sigCalls = rpc.calls.getSignaturesForAddress;
    const res = await get(KNOWN);
    const body = await res.json();
    expect(body.leaves).toEqual(SAMPLE_DENSE);
    expect(body.refreshed).toBe(false);
    expect(rpc.calls.getSignaturesForAddress).toBe(sigCalls);
  });

  it('re-reads incrementally once the snapshot is older than STALE_AFTER_MS', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-06T12:00:00Z'));
    await get(KNOWN);
    rpc.push({ signature: 'sig7', err: null, leaves: [{ leafIndex: 5, commitment: 55n }] });
    const txCalls = rpc.calls.getTransaction;

    // Still fresh: the new deposit is not visible yet.
    let body = await (await get(KNOWN)).json();
    expect(body.leafCount).toBe(5);

    vi.setSystemTime(Date.now() + STALE_AFTER_MS + 1);
    body = await (await get(KNOWN)).json();
    expect(body.leafCount).toBe(6);
    expect(body.leaves).toEqual([...SAMPLE_DENSE, '55']);
    expect(body.refreshed).toBe(true);
    expect(rpc.calls.getTransaction).toBe(txCalls + 1); // only sig7 was fetched
  });

  it('?refresh=1 re-reads now, and POST does the same', async () => {
    await get(KNOWN);
    rpc.push({ signature: 'sig7', err: null, leaves: [{ leafIndex: 5, commitment: 55n }] });

    let body = await (await get(KNOWN, '?refresh=1')).json();
    expect(body.leafCount).toBe(6);

    rpc.push({ signature: 'sig8', err: null, leaves: [{ leafIndex: 6, commitment: 66n }] });
    // Forced refreshes are rate-limited; the one just taken blocks this one.
    body = await (await get(KNOWN, '?refresh=1')).json();
    expect(body.leafCount).toBe(6);

    resetMemoryLeafStoreForTests(); // drops the rate-limit marker with the cache
    await get(KNOWN);
    rpc.push({ signature: 'sig9', err: null, leaves: [{ leafIndex: 7, commitment: 77n }] });
    const posted = await POST(new NextRequest(`http://localhost/api/pool-leaves/${KNOWN}`, { method: 'POST' }), {
      params: Promise.resolve({ pool: KNOWN }),
    });
    expect(posted.status).toBe(200);
    body = await posted.json();
    expect(body.leafCount).toBe(8);
    expect(body.refreshed).toBe(true);
  });

  it('pages with from/limit and clips at leafCount', async () => {
    let body = await (await get(KNOWN, '?from=1&limit=2')).json();
    expect(body.from).toBe(1);
    expect(body.leaves).toEqual(['22', '33']);
    expect(body.leafCount).toBe(5);
    body = await (await get(KNOWN, '?from=4&limit=100')).json();
    expect(body.leaves).toEqual(['18446744069414584320']);
    body = await (await get(KNOWN, '?from=99')).json();
    expect(body.leaves).toEqual([]);
  });

  it('answers OPTIONS with CORS for cross-origin surfaces', async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });
});
