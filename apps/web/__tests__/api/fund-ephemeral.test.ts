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

/** Signature histories by address, for the till-versus-funder join. A
 *  transaction naming two addresses is returned for BOTH, so putting the same
 *  signature in two lists is what "they have paid each other" looks like. */
let signatureHistories: Record<string, { signature: string }[]> = {};
/** What a shared till/funder transaction moved, in lamports. `null` = unreadable. */
let settlementLamports: number | null = 1_003_000_000;

/** What the chain reports for the funding TARGET. Non-zero trips the
 *  empty-target rule, which returns 409 without building a transaction. */
let targetBalance = 0;

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
      /** 0 = a fresh ephemeral, which is what the empty-target rule requires.
       *  Settable so a case can be refused by the empty-target rule instead of
       *  running on into `SystemProgram.transfer`, which drags
       *  `@solana/buffer-layout` into jsdom and fails on Buffer for reasons that
       *  have nothing to do with what is being tested. */
      async getBalance() {
        return targetBalance;
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
      async getSignaturesForAddress(key: { toBase58(): string }, o?: { limit?: number }) {
        return (signatureHistories[key.toBase58()] ?? []).slice(0, o?.limit ?? 1000);
      }
      // The settlement check reads the AMOUNT a shared transaction moved, so a
      // mock that only lists signatures can no longer answer the question the
      // route asks. `settlementLamports` is what the till's balance changed by.
      async getTransaction(sig: string) {
        if (settlementLamports === null) return null;
        return {
          meta: { preBalances: [0, settlementLamports], postBalances: [0, 0] },
          transaction: {
            message: {
              getAccountKeys: () => ({
                // ⚠️ FROM THE ENVIRONMENT, NOT FROM `TILL`. That constant is
                // declared inside a `describe`, and this factory is module
                // scope — the reference throws, `settlementPurchaseCount`
                // catches it, and the case then passes through the
                // could-not-be-read branch while looking like the check simply
                // did not fire.
                staticAccountKeys: [
                  { toBase58: () => 'OTHER' },
                  { toBase58: () => process.env.P01_TILL_ADDRESS ?? '' },
                ],
              }),
            },
          },
          signature: sig,
        };
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
  // 🚨 `vi.stubEnv` PERSISTS ACROSS CASES. Without this, a case that declares a
  // till leaves it declared for every case after it — and the one that asserts
  // "undeclared is refused" silently tests a declared deployment instead. It
  // passed for the wrong reason, which is the only kind of green worth fearing.
  vi.unstubAllEnvs();
  vi.stubEnv('P01_FUNDER_SECRET_KEY', FUNDER_SECRET);
  vi.stubEnv('P01_FUNDER_TICKET', TICKET);
  mockGetStore.mockReturnValue({ incr: vi.fn(), expire: vi.fn() });
  mockRateLimitExceeded.mockResolvedValue(false);
  signatureHistories = {};
  targetBalance = 0;
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

// ---------------------------------------------------------------------------
// R versus F — the configuration that decides whether any of the rest matters
// ---------------------------------------------------------------------------

describe('the till and the float', () => {
  // 🚨 THE SHAPE THAT LEAKED, PINNED SO IT CANNOT BE DEPLOYED AGAIN.
  //
  // On 2026-08-18 a subscription passed every probe but P11. The walk was two
  // hops and no cryptography: the spend's fee payer was funded by the funder,
  // and the funder's own history held a transfer SIGNED BY THE BUYER, one second
  // earlier, for exactly the note's amount. Neither transfer named both ends.
  // The funder in the middle named both.
  //
  // Distinct addresses are necessary. Not paying each other per purchase is the
  // other half, and it needs the chain to see.
  const TILL = Keypair.generate().publicKey.toBase58();
  const get = (qs = '') =>
    GET(
      new NextRequest(`http://localhost:3000/api/fund-ephemeral${qs}`) as unknown as NextRequest,
    );

  it('reports the till, so a harness can assert R != F without the operator', async () => {
    vi.stubEnv('P01_TILL_ADDRESS', TILL);
    const body = await (await get()).json();
    expect(body.till).toBe(TILL);
  });

  it('is NOT ready while the till is undeclared', async () => {
    // Undeclared is not "fine by default": it means this deployment cannot tell
    // whether it is the shape that leaked, and unknown has never been clean here.
    const body = await (await get('?readiness=1')).json();
    expect(body.readiness.ready).toBe(false);
    expect(body.readiness.reasons.join(' ')).toMatch(/P01_TILL_ADDRESS is unset/);
  });

  it('refuses the till-IS-the-funder configuration outright', async () => {
    vi.stubEnv('P01_TILL_ADDRESS', funderKeypair.publicKey.toBase58());
    const body = await (await get('?readiness=1')).json();
    expect(body.readiness.ready).toBe(false);
    expect(body.readiness.reasons.join(' ')).toMatch(/IS this funder/);
  });

  it('flags a till and funder that have paid each other', async () => {
    // Two addresses, one transaction naming both: the same leak wearing a second
    // address. Per-purchase settlement is what this catches.
    vi.stubEnv('P01_TILL_ADDRESS', TILL);
    signatureHistories = {
      [funderKeypair.publicKey.toBase58()]: [{ signature: 'SETTLEMENT' }, { signature: 'F1' }],
      [TILL]: [{ signature: 'SETTLEMENT' }],
    };
    // ⚠️ THIS CASE CHANGED MEANING ON 2026-08-22, DELIBERATELY. It used to pin
    // that ANY shared transaction is flagged. That was a correct control over a
    // rule that turned out to be wrong: settling R into F is the ONLY way the
    // float is replenished, so a COMPLIANT batch names both too. The old check
    // fired on the right behaviour, never cleared, and its remedy — settle in
    // batches — was the act that tripped it. What it pins now is the case that
    // really is a violation: a settlement carrying ONE purchase.
    settlementLamports = 1_003_000_000;
    const body = await (await get('?readiness=1')).json();
    expect(body.readiness.ready).toBe(false);
    expect(body.readiness.reasons.join(' ')).toMatch(/carrying ONE purchase/);
    expect(body.readiness.reasons.join(' ')).toMatch(/A set of one is not a set/);
  });

  it('does NOT flag a settlement that carried several purchases', async () => {
    // 🚨 THE HALF THE OLD CHECK GOT BACKWARDS. A batch is the required
    // behaviour; reporting it as a fault taught the operator to ignore the
    // reason, and an ignored guard protects nothing.
    vi.stubEnv('P01_TILL_ADDRESS', TILL);
    signatureHistories = {
      [funderKeypair.publicKey.toBase58()]: [{ signature: 'SETTLEMENT' }, { signature: 'F1' }],
      [TILL]: [{ signature: 'SETTLEMENT' }],
    };
    settlementLamports = 7 * 1_003_000_000;
    const body = await (await get('?readiness=1')).json();
    expect(body.readiness.reasons.join(' ')).not.toMatch(/ONE purchase/);
  });

  it('does not call an unreadable settlement clean', async () => {
    vi.stubEnv('P01_TILL_ADDRESS', TILL);
    signatureHistories = {
      [funderKeypair.publicKey.toBase58()]: [{ signature: 'SETTLEMENT' }],
      [TILL]: [{ signature: 'SETTLEMENT' }],
    };
    settlementLamports = null;
    const body = await (await get('?readiness=1')).json();
    expect(body.readiness.ready).toBe(false);
    expect(body.readiness.reasons.join(' ')).toMatch(/Unknown is not clean/);
  });

  it('does not call a truncated history clean', async () => {
    vi.stubEnv('P01_TILL_ADDRESS', TILL);
    signatureHistories = {
      [funderKeypair.publicKey.toBase58()]: Array.from({ length: 1000 }, (_, i) => ({
        signature: `F${i}`,
      })),
      [TILL]: [{ signature: 'T1' }],
    };
    const body = await (await get('?readiness=1')).json();
    expect(body.readiness.reasons.join(' ')).toMatch(/Could not establish/);
  });

  it('says nothing about the till when it is separate and unlinked', async () => {
    vi.stubEnv('P01_TILL_ADDRESS', TILL);
    signatureHistories = {
      [funderKeypair.publicKey.toBase58()]: [{ signature: 'F1' }],
      [TILL]: [{ signature: 'T1' }],
    };
    const reasons = (await (await get('?readiness=1')).json()).readiness.reasons.join(' ');
    expect(reasons).not.toMatch(/P01_TILL_ADDRESS/);
    expect(reasons).not.toMatch(/names BOTH/);
  });

  it('REFUSES TO SPEND when the till is the funder', async () => {
    // The POST half, and the important one: readiness is advice, this is the
    // gate. Spending here would buy a subscription that looks private and is
    // walkable in two hops — worse than not running at all.
    vi.stubEnv('P01_TILL_ADDRESS', funderKeypair.publicKey.toBase58());
    const res = await POST(req({ ephemeralPubkey: TARGET, lamports: 1_000_000 }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/till \(P01_TILL_ADDRESS\) is the funder/);
  });

  it('lets a correctly configured deployment straight through', async () => {
    // 🚨 THE NEGATIVE CONTROL, AND IT IS THE POINT. A guard that refuses
    // everything is not a guard, it is an outage — the exact shape of the
    // funder-resolution bug that returned null for every note.
    //
    // Asserted one step PAST the guard rather than at a 200: a non-empty target
    // is refused with 409 by the rule that follows it, which proves the till
    // check let the request through without dragging `@solana/buffer-layout`
    // into jsdom (see the note on the limiter cases above).
    vi.stubEnv('P01_TILL_ADDRESS', TILL);
    targetBalance = 1;
    const res = await POST(req({ ephemeralPubkey: TARGET, lamports: 1_000_000 }));
    expect(res.status).toBe(409);
    expect(res.status).not.toBe(503);
  });
});
