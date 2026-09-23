/**
 * [flow-speed X6 + X7 2026-09-23] Two server steps on the critical path of every
 * float-funded withdrawal and subscription, in POST /api/fund-ephemeral.
 *
 * Run: cd apps/web && npx vitest run __tests__/api/fundEphemeralGrantPath.test.ts
 *
 * X6: the devnet guard reads the genesis hash once per instance and RPC URL
 * (for ten minutes), not once per grant. Only a DEVNET answer is kept: a
 * mainnet answer or a failed read is never cached, so the 403 and the
 * fixed-words 502 still come from a live read. GET readiness still reads it
 * live. Refusals before the guard never read it.
 *
 * X7: the grant's confirmation is polled (`getSignatureStatuses`, every 400 ms,
 * block height at most once a second at 'confirmed') instead of trusting a
 * WebSocket that a serverless instance can miss. What must not move:
 *   - only 'confirmed' or 'finalized' ends the wait; 'processed' keeps polling;
 *   - "could not be confirmed" is answered only after the block height was seen
 *     past `lastValidBlockHeight`, then ONE more status read (a transfer that
 *     landed in the last valid slot is served, never refused); a failed read is
 *     never read as expiry: that is what keeps a retry from funding a key twice;
 *   - no chain error leaves the handler, and no answer or log carries the
 *     funding signature or the ephemeral;
 *   - an unconfirmed send counts against the instance ceiling; a confirmed
 *     failure does not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const FUNDING_SIG =
  '3dih3B3WBaDEoQWj6Tutt3mnMtg5AbtCyBySmpaBd7AeG8ovccXs4rUHJvZpyCxPT8KGPxtDtU5MsuoFTbJ8JYws';
const LAST_VALID = 100;

type Status = { confirmationStatus: string; err: unknown } | null;
const w = vi.hoisted(() => ({
  genesis: vi.fn(async (): Promise<string> => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'),
  targetBalance: 0,
  /** ms since the send -> what the status read says (an Error is thrown). */
  status: (_ms: number, _read: number): unknown => null,
  /** ms since the send -> the block height (an Error is thrown). */
  height: (_ms: number): unknown => 0,
  statusReads: 0,
  heightReads: [] as unknown[],
  confirmCalls: 0,
  sentAt: 0,
  endpoints: [] as string[],
}));

vi.mock('@/lib/waitlist/store', () => ({
  getStore: () => ({ incr: vi.fn(), expire: vi.fn() }),
  rateLimitExceeded: async () => false,
}));

vi.mock('@/lib/privacy/pool/sendTx', () => ({
  sendWithFreshBlockhash: async () => {
    w.sentAt = Date.now();
    return { signature: FUNDING_SIG, blockhash: 'BLOCKHASH', lastValidBlockHeight: LAST_VALID };
  },
}));

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  class FakeTransaction {
    add() {
      return this;
    }
  }
  return {
    ...actual,
    Transaction: FakeTransaction,
    SystemProgram: { ...actual.SystemProgram, transfer: () => ({}) },
    Connection: class {
      constructor(endpoint: string) {
        w.endpoints.push(endpoint);
      }
      getGenesisHash() {
        return w.genesis();
      }
      async getBalance() {
        return w.targetBalance;
      }
      async getSignaturesForAddress() {
        return [];
      }
      async getTransaction() {
        return null;
      }
      // HEAD's path: a WebSocket that never fires, then web3.js's own
      // block-height expiry about 20 s later, worded with the signature.
      confirmTransaction(strategy: { signature: string }) {
        w.confirmCalls += 1;
        return new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Signature ${strategy.signature} has expired: block height exceeded.`)), 20_000),
        );
      }
      async getSignatureStatuses(sigs: string[]) {
        w.statusReads += 1;
        const v = w.status(Date.now() - w.sentAt, w.statusReads);
        if (v instanceof Error) throw v;
        expect(sigs).toEqual([FUNDING_SIG]);
        return { value: [v as Status] };
      }
      async getBlockHeight(commitment?: unknown) {
        w.heightReads.push(commitment);
        const v = w.height(Date.now() - w.sentAt);
        if (v instanceof Error) throw v;
        return v as number;
      }
    },
  };
});

const funder = Keypair.generate();
const TICKET = 'test-ticket';
const EPHEMERAL = Keypair.generate().publicKey.toBase58();
type Route = typeof import('@/app/api/fund-ephemeral/route');
let route: Route;
let logged: string[] = [];

function post(ticket = TICKET): Promise<Response> {
  return route.POST(
    new NextRequest('http://localhost:3000/api/fund-ephemeral', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-p01-funder-ticket': ticket, 'x-real-ip': '203.0.113.9' },
      body: JSON.stringify({ ephemeralPubkey: EPHEMERAL, lamports: 1_000_000 }),
    } as unknown as ConstructorParameters<typeof NextRequest>[1]),
  );
}

async function spent(): Promise<number> {
  const r = await route.GET(new NextRequest('http://localhost:3000/api/fund-ephemeral?readiness=1'));
  return (await r.json()).readiness.spentThisInstance;
}

const confirmed = (err: unknown = null): Status => ({ confirmationStatus: 'confirmed', err });
const processed = (err: unknown = null): Status => ({ confirmationStatus: 'processed', err });

async function freshRoute(): Promise<void> {
  vi.resetModules();
  route = await import('@/app/api/fund-ephemeral/route');
}

beforeEach(async () => {
  logged = [];
  w.genesis.mockReset();
  w.genesis.mockImplementation(async () => DEVNET);
  w.targetBalance = 0;
  w.status = () => confirmed();
  w.height = () => 0;
  w.statusReads = 0;
  w.heightReads = [];
  w.confirmCalls = 0;
  w.sentAt = 0;
  w.endpoints = [];
  vi.unstubAllEnvs();
  vi.stubEnv('P01_FUNDER_SECRET_KEY', bs58.encode(funder.secretKey));
  vi.stubEnv('P01_FUNDER_TICKET', TICKET);
  await freshRoute();
  const keep = (...args: unknown[]) => {
    logged.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : String(a))).join(' '));
  };
  vi.spyOn(console, 'error').mockImplementation(keep);
  vi.spyOn(console, 'warn').mockImplementation(keep);
  vi.spyOn(console, 'log').mockImplementation(keep);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ===========================================================================
// X6
// ===========================================================================

describe('[X6] the devnet guard reads the genesis once per instance and RPC', () => {
  it('T1: two grants on one instance read the genesis once', async () => {
    // Both refused by the empty-target rule, which sits AFTER the guard, so the
    // second passes the guard too. RED at HEAD: 2 reads.
    w.targetBalance = 5;
    expect((await post()).status).toBe(409);
    expect((await post()).status).toBe(409);
    expect(w.genesis).toHaveBeenCalledTimes(1);
  });

  it('T2: a mainnet answer is never kept: 403 with {genesis}, and the next grant reads again', async () => {
    w.targetBalance = 5;
    w.genesis.mockImplementation(async () => MAINNET);
    const first = await post();
    expect(first.status).toBe(403);
    expect((await first.json()).genesis).toBe(MAINNET);
    expect((await post()).status).toBe(403);
    expect(w.genesis).toHaveBeenCalledTimes(2);
    w.genesis.mockImplementation(async () => DEVNET);
    expect((await post()).status).toBe(409);
    expect(w.genesis).toHaveBeenCalledTimes(3);
  });

  it('T3: a failed read is never kept: the fixed-words 502, nothing logged, and the next grant reads again', async () => {
    w.targetBalance = 5;
    w.genesis.mockImplementationOnce(async () => {
      throw new Error('failed to get genesis hash: fetch failed https://rpc.example/?api-key=SECRET');
    });
    const first = await post();
    expect(first.status).toBe(502);
    expect(await first.json()).toEqual({ ok: false, error: 'the configured RPC could not be read; nothing was sent' });
    expect(logged).toEqual([]);
    expect((await post()).status).toBe(409);
    expect(w.genesis).toHaveBeenCalledTimes(2);
  });

  it('T4: the cache is keyed by the RPC URL: a new URL is read again, and its mainnet answer refused', async () => {
    w.targetBalance = 5;
    vi.stubEnv('P01_FUNDER_RPC', 'https://a.example');
    expect((await post()).status).toBe(409);
    vi.stubEnv('P01_FUNDER_RPC', 'https://b.example');
    w.genesis.mockImplementation(async () => MAINNET);
    expect((await post()).status).toBe(403);
    expect(w.genesis).toHaveBeenCalledTimes(2);
  });

  it('T4b: the kept answer expires, so a URL repointed without a restart is read again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    w.targetBalance = 5;
    expect((await post()).status).toBe(409);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect((await post()).status).toBe(409);
    expect(w.genesis).toHaveBeenCalledTimes(2);
  });

  it('T5: a refusal before the guard never reads the genesis, warm or cold', async () => {
    expect((await post('wrong-ticket')).status).toBe(401);
    expect(w.genesis).not.toHaveBeenCalled();
    w.targetBalance = 5;
    await post();
    expect((await post('wrong-ticket')).status).toBe(401);
    expect(w.genesis).toHaveBeenCalledTimes(1);
  });

  it('T6: GET readiness still reads the genesis live, every call', async () => {
    w.targetBalance = 5;
    await post();
    const before = w.genesis.mock.calls.length;
    await route.GET(new NextRequest('http://localhost:3000/api/fund-ephemeral?readiness=1'));
    await route.GET(new NextRequest('http://localhost:3000/api/fund-ephemeral?readiness=1'));
    expect(w.genesis.mock.calls.length - before).toBe(2);
  });
});

// ===========================================================================
// X7
// ===========================================================================

/** Run the POST under fake time; return when it answered (ms after start) and the response. */
async function postTimed(limitMs = 120_000): Promise<{ at: number | null; res: Response | null }> {
  vi.useFakeTimers();
  const t0 = Date.now();
  let res: Response | null = null;
  let at: number | null = null;
  void post().then((r) => {
    res = r;
    at = Date.now() - t0;
  });
  for (let t = 0; t < limitMs && res === null; t += 100) await vi.advanceTimersByTimeAsync(100);
  return { at, res };
}

describe('[X7] the grant is confirmed by polling its status, never by a serverless WebSocket', () => {
  it('T1: a status that turns confirmed at 600 ms is served by 1.2 s, with no WebSocket', async () => {
    // RED at HEAD: `confirmTransaction` waited for the block height (~20 s here).
    w.status = (ms) => (ms >= 600 ? confirmed() : null);
    const { at, res } = await postTimed();
    expect(res, 'no answer at all').not.toBeNull();
    expect(at!, 'answered long after the transfer was confirmed').toBeLessThanOrEqual(1_200);
    expect(res!.status).toBe(200);
    expect((await res!.json()).signature).toBe(FUNDING_SIG);
    expect(w.confirmCalls, 'a WebSocket confirmation was opened').toBe(0);
  });

  it('T2: never seen -> no answer before the block height passes, then one more read, then 502 and the ceiling counted', async () => {
    w.status = () => null;
    w.height = (ms) => (ms >= 5_000 ? LAST_VALID + 1 : LAST_VALID);
    const { at, res } = await postTimed();
    expect(at!).toBeGreaterThanOrEqual(5_000);
    expect(res!.status).toBe(502);
    expect(await res!.json()).toEqual({ ok: false, error: 'the funding transaction could not be confirmed' });
    vi.useRealTimers();
    expect(await spent()).toBe(1_000_000);
  });

  it('T3: landed in the last valid slot -> the read after expiry serves it', async () => {
    let expiredSeen = false;
    w.height = (ms) => {
      if (ms >= 3_000) expiredSeen = true;
      return ms >= 3_000 ? LAST_VALID + 1 : LAST_VALID;
    };
    w.status = () => (expiredSeen ? confirmed() : null);
    const { res } = await postTimed();
    expect(res!.status).toBe(200);
    vi.useRealTimers();
    expect(await spent()).toBe(1_000_000);
  });

  it('T4: processed (with or without an err) keeps polling until confirmed', async () => {
    for (const early of [processed(), processed({ InstructionError: [0, { Custom: 1 }] })]) {
      await freshRoute();
      w.status = (ms) => (ms >= 2_000 ? confirmed() : early);
      w.height = () => LAST_VALID;
      const { res } = await postTimed();
      expect(res!.status).toBe(200);
      vi.useRealTimers();
    }
  });

  it('T4b: processed until expiry, then nothing -> 502 unknown, ceiling counted', async () => {
    w.status = (ms) => (ms < 4_000 ? processed() : null);
    w.height = (ms) => (ms >= 4_000 ? LAST_VALID + 1 : LAST_VALID);
    const { res } = await postTimed();
    expect(res!.status).toBe(502);
    expect(await res!.json()).toEqual({ ok: false, error: 'the funding transaction could not be confirmed' });
    vi.useRealTimers();
    expect(await spent()).toBe(1_000_000);
  });

  it('T5: failing reads (carrying the signature and the key) are retried, never read as expiry, and never logged', async () => {
    w.status = (_ms, read) =>
      read <= 3 ? new Error(`failed to get signature statuses for ${FUNDING_SIG} (${EPHEMERAL}): 429`) : confirmed();
    let heightFails = 3;
    w.height = () => (heightFails-- > 0 ? new Error(`429 Too Many Requests for ${FUNDING_SIG} ${EPHEMERAL}`) : LAST_VALID + 50);
    const { res } = await postTimed();
    expect(res!.status).toBe(200);
    const text = logged.join('\n');
    expect(text).not.toContain(FUNDING_SIG);
    expect(text).not.toContain(EPHEMERAL);
  });

  it('T6: confirmed with an err -> 502 naming neither the signature nor the key; not counted', async () => {
    w.status = () => confirmed({ InstructionError: [0, { Custom: 1 }] });
    const { res } = await postTimed();
    expect(res!.status).toBe(502);
    const body = await res!.text();
    expect(body).not.toContain(FUNDING_SIG);
    expect(body).not.toContain(EPHEMERAL);
    vi.useRealTimers();
    expect(await spent()).toBe(0);
  });

  it('T7: block height is read at "confirmed", at most once a second; the load over a 20 s life is bounded', async () => {
    w.status = () => null;
    w.height = (ms) => (ms >= 20_000 ? LAST_VALID + 1 : LAST_VALID);
    const { res } = await postTimed();
    expect(res!.status).toBe(502);
    expect(w.heightReads.length).toBeGreaterThan(0);
    expect(w.heightReads.every((c) => c === 'confirmed')).toBe(true);
    expect(w.heightReads.length).toBeLessThanOrEqual(22);
    expect(w.statusReads).toBeLessThanOrEqual(53);
  });

  it('T8: a dead RPC ends in the fixed-words 502 within the wall-clock bound (never under 90 s), ceiling counted', async () => {
    w.status = () => new Error(`fetch failed ${FUNDING_SIG}`);
    w.height = () => new Error(`fetch failed ${FUNDING_SIG}`);
    const { at, res } = await postTimed(200_000);
    expect(res, 'the handler never answered').not.toBeNull();
    expect(at!).toBeGreaterThanOrEqual(90_000);
    expect(res!.status).toBe(502);
    expect(await res!.json()).toEqual({ ok: false, error: 'the funding transaction could not be confirmed' });
    expect(logged.join('\n')).not.toContain(FUNDING_SIG);
    vi.useRealTimers();
    expect(await spent()).toBe(1_000_000);
  });
});
