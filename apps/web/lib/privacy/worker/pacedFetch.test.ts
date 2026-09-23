/**
 * pacedFetch: read-lane spacing (shield-speed proposal D).
 *
 * Run: cd apps/web && pnpm test:pool
 *
 * The pacer exists for 429 reliability, not privacy (its header; no ledger row
 * names it). MEASURED 2026-09-22 (shield-speed MEASURE.md): every gap between
 * two paced requests was 120-139 ms, and the reads that waited on that floor
 * got 0 HTTP 429 in both runs while sends got 24/46 and 21/43. So reads move to
 * a 25 ms floor and every other request keeps 120 ms. What does NOT change:
 * one request in flight, request order, the retry ladder, both 429 dialects.
 *
 * Conditions the skeptics attached, each pinned below:
 *  - the method peek fails CLOSED: a batch, a non-JSON body, a Request object
 *    or an unknown method keeps the 120 ms floor (privacy D condition 2,
 *    correctness D condition a);
 *  - the spacing is chosen by the class of the request ABOUT TO START, counted
 *    from the end of the previous one, retries included (correctness D (b));
 *  - fake timers (correctness D (c));
 *  - `createPacedFetch()` keeps its signature (correctness D (d)).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPacedFetch } from './pacedFetch';

type Started = { at: number; method: string };

let started: Started[] = [];
let inFlight = 0;
let peakInFlight = 0;

function rpcBody(method: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] });
}

/**
 * A fake RPC endpoint. Each request takes `latencyMs`, records when it started
 * and what it asked. `answer` decides the response per call index.
 */
function stubEndpoint(
  opts: {
    latencyMs?: number;
    answer?: (i: number) => { status: number; body: unknown };
  } = {},
) {
  const latency = opts.latencyMs ?? 10;
  let i = 0;
  vi.stubGlobal('fetch', async (_input: unknown, init?: { body?: unknown }) => {
    const k = i++;
    let method = '?';
    try {
      const parsed = JSON.parse(String(init?.body));
      method = Array.isArray(parsed) ? 'batch' : String(parsed?.method);
    } catch {
      method = 'not-json';
    }
    started.push({ at: Date.now(), method });
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    await new Promise((r) => setTimeout(r, latency));
    inFlight -= 1;
    const { status, body } = opts.answer?.(k) ?? { status: 200, body: { jsonrpc: '2.0', id: 1, result: k } };
    return new Response(JSON.stringify(body), { status });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  started = [];
  inFlight = 0;
  peakInFlight = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Fire the given bodies back to back (same tick) and settle them under fake time. */
async function fireAll(paced: typeof fetch, bodies: unknown[]): Promise<Response[]> {
  const all = Promise.all(
    bodies.map((b) => paced('https://rpc.example/', { method: 'POST', body: b as BodyInit })),
  );
  await vi.advanceTimersByTimeAsync(60_000);
  return all;
}

describe('pacedFetch read lane (proposal D)', () => {
  it('RED: two back-to-back reads start at least 25 ms and less than 120 ms apart', async () => {
    stubEndpoint({ latencyMs: 10 });
    const paced = createPacedFetch();
    await fireAll(paced, [rpcBody('getAccountInfo'), rpcBody('getSignatureStatuses')]);

    expect(started).toHaveLength(2);
    // Gap measured from the END of the first request (it took 10 ms).
    const gap = started[1]!.at - (started[0]!.at + 10);
    expect(gap).toBeGreaterThanOrEqual(25);
    expect(gap).toBeLessThan(120);
  });

  it('every read the shield makes gets the read lane', async () => {
    stubEndpoint({ latencyMs: 0 });
    const paced = createPacedFetch();
    const reads = [
      'getAccountInfo',
      'getBalance',
      'getLatestBlockhash',
      'getSignatureStatuses',
      'getMinimumBalanceForRentExemption',
      'getBlockHeight',
    ];
    await fireAll(paced, reads.map(rpcBody));
    for (let k = 1; k < started.length; k++) {
      expect(started[k]!.at - started[k - 1]!.at, reads[k]).toBeLessThan(120);
    }
  });

  it('CONTROL: a send after a read still waits the full 120 ms', async () => {
    stubEndpoint({ latencyMs: 10 });
    const paced = createPacedFetch();
    await fireAll(paced, [rpcBody('getLatestBlockhash'), rpcBody('sendTransaction')]);
    expect(started.map((s) => s.method)).toEqual(['getLatestBlockhash', 'sendTransaction']);
    expect(started[1]!.at - (started[0]!.at + 10)).toBeGreaterThanOrEqual(120);
  });

  it('a read after a send gets the read floor (the class of the request about to start decides)', async () => {
    stubEndpoint({ latencyMs: 10 });
    const paced = createPacedFetch();
    await fireAll(paced, [rpcBody('sendTransaction'), rpcBody('getSignatureStatuses'), rpcBody('sendTransaction')]);
    expect(started[1]!.at - (started[0]!.at + 10)).toBeLessThan(120);
    expect(started[2]!.at - (started[1]!.at + 10)).toBeGreaterThanOrEqual(120);
  });

  it('CONTROL: the peek fails closed — batch, non-JSON, unknown method and history walks keep 120 ms', async () => {
    const closed: unknown[] = [
      JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [] }]),
      '{not json',
      rpcBody('requestAirdrop'),
      rpcBody('getSignaturesForAddress'),
      rpcBody('getTransaction'),
      undefined,
    ];
    for (const body of closed) {
      started = [];
      stubEndpoint({ latencyMs: 10 });
      const paced = createPacedFetch();
      // A read first, then the unclassifiable one: it must wait the full floor.
      await fireAll(paced, [rpcBody('getBalance'), body]);
      expect(started, String(body)).toHaveLength(2);
      expect(started[1]!.at - (started[0]!.at + 10), String(body)).toBeGreaterThanOrEqual(120);
    }
  });

  it('CONTROL: a Request object (not a string body) keeps 120 ms', async () => {
    stubEndpoint({ latencyMs: 10 });
    const paced = createPacedFetch();
    const all = Promise.all([
      paced('https://rpc.example/', { method: 'POST', body: rpcBody('getBalance') }),
      paced(new Request('https://rpc.example/', { method: 'POST', body: rpcBody('getBalance') })),
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    await all;
    expect(started[1]!.at - (started[0]!.at + 10)).toBeGreaterThanOrEqual(120);
  });

  it('CONTROL: still one request in flight, in submission order', async () => {
    stubEndpoint({ latencyMs: 200 });
    const paced = createPacedFetch();
    const order = ['getAccountInfo', 'getBalance', 'sendTransaction', 'getSignatureStatuses', 'getBalance'];
    await fireAll(paced, order.map(rpcBody));
    expect(peakInFlight).toBe(1);
    expect(started.map((s) => s.method)).toEqual(order);
  });

  it('CONTROL: a Helius -32429 inside a 200 is still a 429 and is retried', async () => {
    stubEndpoint({
      latencyMs: 5,
      answer: (i) =>
        i === 0
          ? { status: 200, body: { jsonrpc: '2.0', id: 1, error: { code: -32429, message: 'rate limited' } } }
          : { status: 200, body: { jsonrpc: '2.0', id: 1, result: 'ok' } },
    });
    const paced = createPacedFetch();
    const [res] = await fireAll(paced, [rpcBody('getBalance')]);
    expect(started).toHaveLength(2);
    expect(await res!.json()).toMatchObject({ result: 'ok' });
  });

  it('CONTROL: the spacing counts from the end of the previous request, its retries included', async () => {
    stubEndpoint({
      latencyMs: 5,
      answer: (i) => (i === 0 ? { status: 429, body: {} } : { status: 200, body: { result: i } }),
    });
    const paced = createPacedFetch();
    await fireAll(paced, [rpcBody('getBalance'), rpcBody('getBalance')]);
    // Call 0 = 429, call 1 = its retry (300 ms later), call 2 = the second read.
    expect(started).toHaveLength(3);
    expect(started[1]!.at - started[0]!.at).toBeGreaterThanOrEqual(300);
    expect(started[2]!.at - (started[1]!.at + 5)).toBeGreaterThanOrEqual(25);
  });

  it('CONTROL: a real network error still throws after the retries', async () => {
    vi.stubGlobal('fetch', async () => {
      started.push({ at: Date.now(), method: 'x' });
      throw new TypeError('network down');
    });
    const paced = createPacedFetch();
    const p = paced('https://rpc.example/', { method: 'POST', body: rpcBody('getBalance') }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const err = await p;
    expect(err).toBeInstanceOf(TypeError);
    expect(started).toHaveLength(6);
  });
});
