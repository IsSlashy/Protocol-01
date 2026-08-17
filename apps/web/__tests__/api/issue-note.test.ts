/**
 * The gate in front of the notes.
 *
 * Run: cd apps/web && pnpm test
 *
 * WHY THIS IS STRICTER THAN THE FUNDER'S SUITE
 * ────────────────────────────────────────────
 * A funder grant is rent that comes back. A note IS the denomination and does
 * not. So the failure modes worth pinning are the ones that hand over value:
 * an unminted claim, a reused claim, two callers racing for one note, and the
 * ticket — which ships in the browser bundle — being enough on its own.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetStore = vi.fn();
const mockRateLimitExceeded = vi.fn();

vi.mock('@/lib/waitlist/store', () => ({
  getStore: () => mockGetStore(),
  rateLimitExceeded: (...args: unknown[]) => mockRateLimitExceeded(...args),
}));

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    Connection: class {
      async getGenesisHash() {
        return 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
      }
    },
  };
});

import { POST } from '@/app/api/issue-note/route';

const TICKET = 'test-ticket';
const SEED = 'ab'.repeat(32);
/**
 * A syntactically valid p01pq address: 32 bytes of X25519 plus a 1184-byte
 * ML-KEM-768 public key. The length is checked exactly, so an approximate
 * buffer makes every case 400 at the address check and the suite silently
 * measures nothing — which is what a first draft of this file did.
 */
const RECIPIENT = `p01pq:${Buffer.alloc(32 + 1184, 7).toString('base64')}`;

/** Claim keys the fake KV considers minted. */
let mintedClaims: Set<string>;
/** Counter per key, so `incr` behaves like Redis. */
let counters: Map<string, number>;

function fakeKv() {
  return {
    incr: vi.fn(async (key: string) => {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    }),
    get: vi.fn(async (key: string) =>
      mintedClaims.has(key.replace('p01:note:claim-minted:', '')) ? 'paid-ref' : null,
    ),
    expire: vi.fn(),
    set: vi.fn(),
  };
}

function req(body: unknown, ticket: string | null = TICKET) {
  return new NextRequest('http://localhost:3000/api/issue-note', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(ticket ? { 'x-p01-funder-ticket': ticket } : {}),
      'x-real-ip': '198.51.100.9',
    },
    body: JSON.stringify(body),
  } as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

const CLAIM = 'AAAAAAAAAAAAAAAAAAAAAAAA';
const goodBody = (over: Record<string, unknown> = {}) => ({
  recipientAddress: RECIPIENT,
  token: 'SOL',
  denomination: 0.1,
  claimCode: CLAIM,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mintedClaims = new Set([CLAIM]);
  counters = new Map();
  vi.stubEnv('P01_TREASURY_POOL_SEED', SEED);
  vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '23,24');
  vi.stubEnv('P01_FUNDER_TICKET', TICKET);
  mockGetStore.mockReturnValue(fakeKv());
  mockRateLimitExceeded.mockResolvedValue(false);
});

describe('the payment gate', () => {
  it('refuses with 402 when no claim code is supplied', async () => {
    // The ticket alone must never be enough: it ships in the browser bundle by
    // design, so anyone who reads the bundle would otherwise mint themselves
    // unlimited notes.
    const res = await POST(req(goodBody({ claimCode: undefined })));
    expect(res.status).toBe(402);
    expect((await res.json()).error).toMatch(/claim code is required/);
  });

  it('refuses a claim that was never minted', async () => {
    // A guessed or invented code. It is still CONSUMED — see the next case —
    // so guessing cannot be retried until it works.
    mintedClaims = new Set();
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(402);
    expect((await res.json()).error).toMatch(/never issued against a payment/);
  });

  it('refuses the SECOND redemption of a claim', async () => {
    // One payment, one note. `incr` is what makes this hold under concurrency:
    // read-then-write would let two simultaneous callers both pass.
    const first = await POST(req(goodBody()));
    // The first attempt gets past the gate and fails later (no chain here) —
    // what matters is that the claim is now spent.
    expect(first.status).not.toBe(409);
    const second = await POST(req(goodBody()));
    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatch(/already been used/);
  });

  it('consumes a bad claim too, so guessing cannot be retried', async () => {
    mintedClaims = new Set();
    await POST(req(goodBody()));
    const again = await POST(req(goodBody()));
    expect(again.status).toBe(409);
  });
});

describe('the refusals that come before the gate', () => {
  it('401s a bad ticket without touching the claim', async () => {
    const res = await POST(req(goodBody(), 'wrong'));
    expect(res.status).toBe(401);
    expect(counters.size).toBe(0);
  });

  it('503s when the deployment issues no notes', async () => {
    vi.stubEnv('P01_TREASURY_POOL_SEED', '');
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(503);
  });

  it('has an EMPTY inventory when the variable is unset, not a leaf-0 inventory', async () => {
    // `''.split(',')` is `['']` and `Number('')` is 0, which is an integer and
    // is >= 0 — so an unset variable used to produce an inventory of exactly one
    // leaf, index 0, and readiness reported the deployment as configured. Found
    // by curling the built route, not by a test, which is why this one exists.
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '');
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/no note inventory configured/);
  });

  it('400s a recipient that is not a note address', async () => {
    const res = await POST(req(goodBody({ recipientAddress: 'not-an-address' })));
    expect(res.status).toBe(400);
  });

  it('503s without a durable store, rather than issuing untracked', async () => {
    // No store means no claim ledger and no inventory ledger, so a note could
    // be issued twice with nothing recording it.
    mockGetStore.mockReturnValue(null);
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(503);
  });

  it('429s an IP over its hourly allowance', async () => {
    mockRateLimitExceeded.mockResolvedValue(true);
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(429);
    expect((await res.json()).limit).toBe(3);
  });
});
