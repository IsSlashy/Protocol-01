/**
 * pacedFetch — the pace is a property of the ENDPOINT.
 *
 * The 120 ms serial queue exists for the public devnet RPC. On a Helius
 * endpoint it was the single largest self-inflicted delay in a proof upload:
 * ~80 chunk sends behind a 120 ms gate is ~10 s of waiting for our own timer
 * per proof (docs/PERF-AND-CAPACITY-PLAN-2026-09-06.md §1). `pacingIntervalFor`
 * picks the pace from the URL, and at 0 the transport must actually be
 * concurrent — not "a queue with no sleep", which would still serialise 80
 * round trips.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPacedFetch, pacingIntervalFor } from './pacedFetch';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A fetch whose responses resolve only when the test says so. */
function deferredFetch() {
  const resolvers: Array<(r: Response) => void> = [];
  const calls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Promise<Response>((r) => resolvers.push(r));
  }) as typeof fetch;
  const ok = () => new Response('{"jsonrpc":"2.0","result":1,"id":1}', { status: 200 });
  return { calls, release: (i: number) => resolvers[i]!(ok()) };
}

describe('pacingIntervalFor', () => {
  it('runs a Helius endpoint unpaced', () => {
    expect(pacingIntervalFor('https://devnet.helius-rpc.com/?api-key=abc')).toBe(0);
    expect(pacingIntervalFor('https://mainnet.helius-rpc.com/?api-key=abc')).toBe(0);
  });

  it('keeps the 120 ms queue for the public devnet RPC and anything unknown', () => {
    expect(pacingIntervalFor('https://api.devnet.solana.com')).toBe(120);
    expect(pacingIntervalFor('http://localhost:8899')).toBe(120);
  });
});

describe('createPacedFetch', () => {
  it('at interval 0, a second request goes out before the first has answered', async () => {
    const f = deferredFetch();
    const paced = createPacedFetch(0);
    const a = paced('https://x/a');
    const b = paced('https://x/b');
    // Both hit the transport with nothing resolved yet.
    await Promise.resolve();
    expect(f.calls).toEqual(['https://x/a', 'https://x/b']);
    f.release(0);
    f.release(1);
    await Promise.all([a, b]);
  });

  it('at interval 120, the second request waits for the first to answer', async () => {
    vi.useFakeTimers();
    try {
      const f = deferredFetch();
      const paced = createPacedFetch(120);
      const a = paced('https://x/a');
      const b = paced('https://x/b');
      await Promise.resolve();
      await Promise.resolve();
      expect(f.calls).toEqual(['https://x/a']);
      f.release(0);
      await a;
      // The gap is the timer, then the second call is issued.
      await vi.advanceTimersByTimeAsync(120);
      expect(f.calls).toEqual(['https://x/a', 'https://x/b']);
      f.release(1);
      await b;
    } finally {
      vi.useRealTimers();
    }
  });

  it('still retries a 429 when unpaced', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      globalThis.fetch = (async () => {
        n++;
        return n === 1
          ? new Response('rate limited', { status: 429 })
          : new Response('{"jsonrpc":"2.0","result":1,"id":1}', { status: 200 });
      }) as typeof fetch;
      const paced = createPacedFetch(0);
      const p = paced('https://x/a');
      await vi.advanceTimersByTimeAsync(1_000);
      const res = await p;
      expect(res.status).toBe(200);
      expect(n).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
