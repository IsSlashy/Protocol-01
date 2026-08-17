/**
 * The gate in front of the treasury.
 *
 * Run: cd apps/web && pnpm test
 *
 * WHY THIS SUITE EXISTS
 * ─────────────────────
 * `/api/fund-ephemeral` signs transfers out of a funded keypair, and its ticket
 * ships in the browser bundle by design. Its own header says the anti-abuse work
 * is not done. The one bound that used to exist — `MAX_LAMPORTS_PER_INSTANCE` —
 * is a module-scope `let` inside a serverless function: it resets on every cold
 * start and bounds one runaway loop within one warm isolate, not the treasury.
 *
 * So the durable bound is a per-IP counter in KV, and the posture is FAIL
 * CLOSED: no limiter, no spending. These cases pin that, because the failure
 * mode of a limiter is that it quietly stops limiting and everything still
 * looks fine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const mockGetStore = vi.fn();
const mockRateLimitExceeded = vi.fn();

vi.mock('@/lib/waitlist/store', () => ({
  getStore: () => mockGetStore(),
  rateLimitExceeded: (...args: unknown[]) => mockRateLimitExceeded(...args),
}));

// A devnet that always answers. Most cases are refused long before the chain is
// touched, but the one that asserts the limiter's ARGUMENTS has to be allowed
// through to the end — otherwise it would only prove the limiter is reached,
// not what it is asked.
vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    Connection: class {
      async getGenesisHash() {
        return 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
      }
      /** 0 = a fresh ephemeral, which is what the empty-target rule requires. */
      async getBalance() {
        return 0;
      }
      async getLatestBlockhash() {
        return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 };
      }
      async sendRawTransaction() {
        return 'FUNDSIG';
      }
      async confirmTransaction() {
        return { value: { err: null } };
      }
    },
  };
});

import { GET, POST } from '@/app/api/fund-ephemeral/route';

/**
 * A REAL keypair, base58-encoded the way the route expects.
 *
 * A hand-written literal is not good enough here and quietly was not: the POST
 * path parses its key LAST, after the ticket, the caps and the limiter, so
 * every refusal case passed while the key was in fact garbage. Only the GET
 * path, which parses first, exposed it. Generate it, and both paths test the
 * same funder.
 */
const funderKeypair = Keypair.generate();
const FUNDER_SECRET = bs58.encode(funderKeypair.secretKey);
const TICKET = 'test-ticket';
const TARGET = '7gWpzSZAqUiN6uZ9NkfB1gZ5gYtvUvQyFAUhZTjJ6Trh';

function req(body: unknown, ticket: string | null = TICKET) {
  return new NextRequest('http://localhost:3000/api/fund-ephemeral', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(ticket ? { 'x-p01-funder-ticket': ticket } : {}),
      'x-real-ip': '203.0.113.7',
    },
    body: JSON.stringify(body),
  } as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('P01_FUNDER_SECRET_KEY', FUNDER_SECRET);
  vi.stubEnv('P01_FUNDER_TICKET', TICKET);
  mockGetStore.mockReturnValue({ incr: vi.fn(), expire: vi.fn() });
  mockRateLimitExceeded.mockResolvedValue(false);
});

describe('the durable rate limiter', () => {
  it('REFUSES TO SPEND when no KV backend is configured', async () => {
    // Fail closed. An unmetered faucet that spends is worse than one that
    // refuses, and the refusal is not silent — the client reports the reason
    // and falls back to the wallet, so the user pays publicly and is TOLD.
    mockGetStore.mockReturnValue(null);
    const res = await POST(req({ ephemeralPubkey: TARGET, lamports: 1_000_000 }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/unmetered faucet/);
  });

  it('refuses when the limiter itself errors', async () => {
    // A limiter that throws is a limiter that is not limiting. Serving here
    // would make every KV outage a window in which the treasury is unbounded.
    mockRateLimitExceeded.mockRejectedValue(new Error('kv unreachable'));
    const res = await POST(req({ ephemeralPubkey: TARGET, lamports: 1_000_000 }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/rate limiter could not be read/);
  });

  it('refuses an IP over its hourly allowance, and says what the limit is', async () => {
    mockRateLimitExceeded.mockResolvedValue(true);
    const res = await POST(req({ ephemeralPubkey: TARGET, lamports: 1_000_000 }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/too many funding requests/);
    expect(body.limit).toBe(12);
  });

  it('keys the counter on the caller, with its own domain separator', async () => {
    // The salt is what stops this counter sharing a keyspace with the
    // waitlist's — a collision there would let signups exhaust the funder's
    // allowance, or vice versa, with no visible symptom.
    //
    // Asserted on the OVER-LIMIT path deliberately: the limiter has already
    // been called with its real arguments by then, and the route returns
    // without building a transaction. Letting it run to the transfer instead
    // drags `@solana/buffer-layout` into jsdom, which fails on Buffer for
    // reasons that have nothing to do with rate limiting.
    mockRateLimitExceeded.mockResolvedValue(true);
    await POST(req({ ephemeralPubkey: TARGET, lamports: 1_000_000 }));
    expect(mockRateLimitExceeded).toHaveBeenCalledWith(
      expect.anything(),
      '203.0.113.7',
      'p01:fund-ephemeral:v1',
      12,
    );
  });
});

describe('readiness, answered BEFORE it matters', () => {
  // Every way this funder is switched off is silent at the point of use: the
  // client catches, falls back to the wallet, and the job succeeds with the
  // wallet on chain. That is discovered by whoever opens an explorer
  // afterwards. These cases pin that the reasons are enumerable in advance.
  const get = (qs = '') =>
    GET(
      new NextRequest(`http://localhost:3000/api/fund-ephemeral${qs}`) as unknown as NextRequest,
    );

  it('says nothing about readiness unless asked', async () => {
    // The plain GET is on the recovery path, which runs often and must stay one
    // cheap answer — no RPC round trip for a balance nobody asked for.
    const body = await (await get()).json();
    expect(body.configured).toBe(true);
    expect(body.funder).toBeTruthy();
    expect(body.readiness).toBeUndefined();
  });

  it('reports NOT ready, with a reason, when the limiter is missing', async () => {
    // The failure I introduced with fail-closed: no KV means the funder never
    // serves, and without this the first symptom is a demo paying publicly.
    mockGetStore.mockReturnValue(null);
    const body = await (await get('?readiness=1')).json();
    expect(body.readiness.ready).toBe(false);
    expect(body.readiness.limiter).toBe(false);
    expect(body.readiness.reasons.join(' ')).toMatch(/KV/);
  });

  it('refuses the depositor-is-the-funder configuration', async () => {
    // One treasury on both ends makes P8 report exactly that — the probe
    // working, and fatal to the claim being demonstrated. Invisible until
    // someone runs the tool, which is usually after the transaction exists.
    const funderAddr = (await (await get()).json()).funder;
    const body = await (await get(`?readiness=1&depositor=${funderAddr}`)).json();
    expect(body.readiness.ready).toBe(false);
    expect(body.readiness.reasons.join(' ')).toMatch(/IS this funder/);
  });

  it('accepts a depositor that is a different key', async () => {
    const body = await (await get(`?readiness=1&depositor=${TARGET}`)).json();
    expect(body.readiness.reasons.join(' ')).not.toMatch(/IS this funder/);
  });

  it('always carries the blind spot it cannot check', async () => {
    // No server can see what a past build inlined into the browser bundle. A
    // "ready" deployment serving a stale bundle never calls this endpoint at
    // all — so the boolean must arrive with its own limit attached, or it will
    // be read as a guarantee.
    const body = await (await get('?readiness=1')).json();
    expect(body.readiness.blindSpot).toMatch(/NEXT_PUBLIC_P01_FUNDER_TICKET/);
    expect(body.readiness.blindSpot).toMatch(/falls?\s+back to the wallet/);
  });
});

describe('the older refusals still answer with their own codes', () => {
  it('401s a bad ticket BEFORE touching the limiter', async () => {
    // Order matters: an unauthenticated caller must not be able to burn a
    // legitimate IP's allowance.
    const res = await POST(req({ ephemeralPubkey: TARGET, lamports: 1_000_000 }, 'wrong'));
    expect(res.status).toBe(401);
    expect(mockRateLimitExceeded).not.toHaveBeenCalled();
  });

  it('400s above the per-request cap', async () => {
    const res = await POST(req({ ephemeralPubkey: TARGET, lamports: 3_000_000_000 }));
    expect(res.status).toBe(400);
    expect((await res.json()).cap).toBe(2_000_000_000);
  });

  it('503s when the deployment has no funder at all', async () => {
    // Distinct from "refused": a deployment with no funder must be able to say
    // so, or the client cannot tell "turned off here" from "your request was
    // rejected" and shows the user the wrong thing.
    vi.stubEnv('P01_FUNDER_SECRET_KEY', '');
    const res = await POST(req({ ephemeralPubkey: TARGET, lamports: 1_000_000 }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/no funder configured/);
  });
});
