/**
 * WHOSE balance delta counts as "the buyer paid", and what happens to the
 * one-shot claim when the send has already left.
 *
 * Run: cd apps/web && pnpm test
 *
 * WHY THIS SUITE EXISTS
 * ─────────────────────
 * R != F is the whole mechanism: the address that COLLECTS money from buyers
 * (R, the till) must never be the address that FUNDS the ephemerals (F, the
 * float). MEASURED 2026-08-18 — a subscription passed every probe but P11, and
 * the walk was two hops with no cryptography: the spend's fee payer had been
 * funded by F, and F's own history held a transfer SIGNED BY THE BUYER, one
 * second earlier, for exactly the note's amount. Neither transfer named both
 * ends. The address standing between them named both.
 *
 * The split was asserted in an env template, in a readiness report and in three
 * file headers. It was wired nowhere: this route looked the payment up by
 * `funder.publicKey`'s balance delta, so the ONLY payment it would accept was
 * one that had named F. A client paying the till got 400 "that transaction did
 * not pay this deployment" — after the money had already moved.
 *
 * Nothing was red while that was true. The only coverage this route had was the
 * source scan in `claim-release.test.ts`, which says nothing about which address
 * is indexed. So the load-bearing case here is a fixture where the FUNDER was
 * paid and the TILL was not: correct code must REFUSE it.
 *
 * THE SECOND HALF IS ABOUT THE CLAIM, AND IT IS A MONEY BUG
 * ────────────────────────────────────────────────────────
 * The one-shot claim is released on every path that hands nothing over, which
 * is right — until the `catch` wraps the confirmation as well as the send. A
 * confirmation timeout is an ordinary devnet event and it says NOTHING about
 * whether the transaction landed: `sendRawTransaction` has already returned a
 * signature, the lamports are on their way, and releasing the claim there lets
 * the very next request forward the SAME payment a second time out of F.
 *
 * WHY THE WHOLE OF web3.js IS MOCKED HERE
 * ───────────────────────────────────────
 * `SystemProgram.transfer` drags `@solana/buffer-layout` into jsdom and fails on
 * Buffer for reasons that have nothing to do with what is being tested — the
 * existing `fund-ephemeral.test.ts` says the same and stops every case before
 * the transaction is built. This suite cannot: the defect it exists for lives
 * strictly AFTER a successful send. So `Transaction` and `SystemProgram` are
 * stubs too, and the send path runs end to end on them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const mockGetStore = vi.fn();
const mockRateLimitExceeded = vi.fn();
const mockIncr = vi.fn();
const mockDel = vi.fn();

/** Account keys of the payment transaction, in order, with their deltas. */
let paymentKeys: string[] = [];
let preBalances: number[] = [];
let postBalances: number[] = [];
/** What the chain reports for the BUYER identity. Non-zero trips the
 *  fresh-identity rule. */
let buyerBalance = 0;
/** How the relay's own send behaves. `'send-throws'` never left the client;
 *  `'confirm-throws'` DID leave and the answer never came back. */
let sendBehaviour: 'ok' | 'send-throws' | 'confirm-throws' = 'ok';

vi.mock('@/lib/waitlist/store', () => ({
  getStore: () => mockGetStore(),
  rateLimitExceeded: (...args: unknown[]) => mockRateLimitExceeded(...args),
}));

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  class FakeTransaction {
    instructions: unknown[] = [];
    recentBlockhash?: string;
    feePayer?: unknown;
    add(ix: unknown) {
      this.instructions.push(ix);
      return this;
    }
    sign() {}
    serialize() {
      return new Uint8Array([1, 2, 3]);
    }
  }
  return {
    ...actual,
    Transaction: FakeTransaction,
    SystemProgram: { transfer: (p: unknown) => ({ transfer: p }) },
    Connection: class {
      async getGenesisHash() {
        return 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
      }
      async getTransaction() {
        return {
          meta: { preBalances, postBalances },
          transaction: {
            message: {
              getAccountKeys: () => ({
                staticAccountKeys: paymentKeys.map((k) => new actual.PublicKey(k)),
              }),
            },
          },
        };
      }
      async getBalance() {
        return buyerBalance;
      }
      async getLatestBlockhash() {
        return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 };
      }
      async sendRawTransaction() {
        if (sendBehaviour === 'send-throws') throw new Error('blockhash not found');
        return 'RELAYSIG';
      }
      async confirmTransaction() {
        // 🚨 THE MOMENT THIS SUITE EXISTS FOR. The transaction is already on the
        // wire; only the ANSWER is missing.
        if (sendBehaviour === 'confirm-throws') {
          throw new Error('Transaction was not confirmed in 30.00 seconds');
        }
        return { value: { err: null } };
      }
    },
  };
});

/**
 * A NAMESPACE import, deliberately. `GET` does not exist on this route yet, and
 * a named import of a missing export is a module link error: one failed file,
 * zero tests, and every case in it dark — including the ones that would have
 * pointed at the real defect. Through a namespace each case fails on its own
 * assertion and names what is missing.
 */
import * as route from '@/app/api/relay-to-buyer/route';

const funderKeypair = Keypair.generate();
const FUNDER = funderKeypair.publicKey.toBase58();
const TILL = Keypair.generate().publicKey.toBase58();
const FEE_WALLET = Keypair.generate().publicKey.toBase58();
const BUYER = Keypair.generate().publicKey.toBase58();
/** The wallet that signs the payment. Account index 0: the fee payer, and the
 *  only account DEBITED by a deposit payment. */
const WALLET = Keypair.generate().publicKey.toBase58();
const TICKET = 'test-ticket';

/** A 1 SOL deposit, measured on devnet 2026-08-18. */
const VALUE = 1_003_475_300;
const REQUIRED = 1_573_486_080;
/** 1% of the note denomination, charged in the same transaction. */
const FEE = 10_000_000;

function req(body: unknown, ticket: string | null = TICKET) {
  return new NextRequest('http://localhost:3000/api/relay-to-buyer', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(ticket ? { 'x-p01-funder-ticket': ticket } : {}),
      'x-real-ip': '203.0.113.9',
    },
    body: JSON.stringify(body),
  } as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

const payment = (over: Record<string, unknown> = {}) =>
  req({ paymentSignature: 'PAYSIG', buyerPubkey: BUYER, requiredLamports: REQUIRED, ...over });

function get(url = 'http://localhost:3000/api/relay-to-buyer') {
  return new NextRequest(url, { method: 'GET' } as unknown as ConstructorParameters<
    typeof NextRequest
  >[1]);
}

/**
 * The real shape of the transaction the buyer signs: one debit at index 0, one
 * credit to the till, one credit to the fee wallet. `credits` says which
 * addresses actually moved.
 */
function paymentTx(credits: Record<string, number>) {
  paymentKeys = [WALLET, TILL, FEE_WALLET, FUNDER];
  preBalances = [2_000_000_000, 5, 5, 900_000_000];
  postBalances = paymentKeys.map((k, i) => preBalances[i] + (credits[k] ?? 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  // 🚨 `vi.stubEnv` PERSISTS ACROSS CASES. Without this, a case that declares a
  // till leaves it declared for the case that asserts an undeclared one is
  // refused — which then passes for the wrong reason, the only kind of green
  // worth fearing.
  vi.unstubAllEnvs();
  vi.stubEnv('P01_FUNDER_TICKET', TICKET);
  vi.stubEnv('P01_FUNDER_SECRET_KEY', bs58.encode(funderKeypair.secretKey));
  vi.stubEnv('P01_TILL_ADDRESS', TILL);
  vi.stubEnv('P01_FEE_WALLET', FEE_WALLET);
  mockIncr.mockResolvedValue(1);
  mockDel.mockResolvedValue(undefined);
  mockGetStore.mockReturnValue({ incr: mockIncr, del: mockDel, expire: vi.fn() });
  mockRateLimitExceeded.mockResolvedValue(false);
  buyerBalance = 0;
  sendBehaviour = 'ok';
  paymentTx({ [TILL]: VALUE, [FEE_WALLET]: FEE });
});

describe('the payment must have credited the TILL, not the float', () => {
  it('relays a payment that credited the till, and reports the float it came from', async () => {
    // The positive control, all the way to the send. `funder` is in the answer
    // because the client sweeps the ephemeral's residue back to whoever fronted
    // the rent — and it must learn that address from the party that actually
    // sent, not guess it.
    const res = await route.POST(payment());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.signature).toBe('RELAYSIG');
    expect(body.lamports).toBe(REQUIRED);
    expect(body.funder).toBe(FUNDER);
    expect(body.till).toBe(TILL);
    // Lamports moved, so the claim is CORRECTLY held.
    expect(mockDel).not.toHaveBeenCalled();
  });

  it('REFUSES A PAYMENT THAT NAMED THE FUNDER INSTEAD', async () => {
    // 🚨 THE CASE THIS FILE EXISTS FOR. Reading `received` from the funder's
    // delta made this fixture — F credited the full note value, R credited
    // nothing — the HAPPY PATH. It is the leak: a buyer who pays F is one
    // transaction from the address that funds their own spend, and P11 walks it.
    paymentTx({ [FUNDER]: VALUE });
    const res = await route.POST(payment());
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.signature).toBeUndefined();
    // Refused, so the buyer gets their retry back.
    expect(mockDel).toHaveBeenCalledTimes(1);
  });

  it('refuses when the till is not in the transaction at all, and NAMES it', async () => {
    // An operator reading a log has to be able to tell a client paying the wrong
    // address from a client paying nothing.
    paymentKeys = [WALLET, FUNDER];
    preBalances = [2_000_000_000, 900_000_000];
    postBalances = [2_000_000_000 - VALUE, 900_000_000 + VALUE];
    const res = await route.POST(payment());
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.till).toBe(TILL);
    expect(mockDel).toHaveBeenCalledTimes(1);
  });

  it('reads the till delta to the lamport, with the 1% fee excluded', async () => {
    // Two transfers to two distinct pubkeys occupy two distinct entries in
    // `staticAccountKeys`, and `pre/postBalances` are positionally aligned with
    // that array — so the fee wallet's credit cannot enter the till's delta. The
    // only way they could merge is key equality, which web3.js collapses into
    // one index and which is refused outright below.
    //
    // The over-cap refusal echoes `received` back, and it is the only place this
    // route states the figure out loud, so a fee that had bled into the till's
    // delta would be visible here as `+ FEE` and nowhere else.
    const OVER_CAP = 2_600_000_000;
    paymentTx({ [TILL]: OVER_CAP, [FEE_WALLET]: FEE });
    const res = await route.POST(payment());
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.received).toBe(OVER_CAP);
    expect(body.received).not.toBe(OVER_CAP + FEE);
    expect(mockDel).toHaveBeenCalledTimes(1);
  });

  it('refuses a payment that credited only the fee wallet', async () => {
    // The fee alone is not a payment. If the fee's index were read by mistake,
    // the deployment would front the entire note value out of its own float.
    paymentTx({ [FEE_WALLET]: FEE });
    const res = await route.POST(payment());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/nothing/);
    expect(mockDel).toHaveBeenCalledTimes(1);
  });
});

describe('a misconfigured deployment refuses BEFORE it burns the buyer’s one claim', () => {
  // ⚠️ ORDER, NOT JUST CONDITION. `kv.incr` is one-shot per payment signature: a
  // claim taken and not released answers 409 "already relayed" forever. An
  // operator's env mistake must not consume it, or fixing the env would not make
  // the buyer whole — their money has already moved by the time this route runs.
  // The rate-limit bucket is protected for the same reason.

  it('refuses with 503 when the till is unset, and does NOT take the claim', async () => {
    vi.stubEnv('P01_TILL_ADDRESS', '');
    const res = await route.POST(payment());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/P01_TILL_ADDRESS/);
    expect(mockIncr).not.toHaveBeenCalled();
    expect(mockRateLimitExceeded).not.toHaveBeenCalled();
  });

  it('refuses a till that is not a public key at all', async () => {
    // Unparseable is a different operator mistake from unset, and it must fail
    // the same way: closed, rather than falling back to the funder.
    vi.stubEnv('P01_TILL_ADDRESS', 'not-a-pubkey');
    const res = await route.POST(payment());
    expect(res.status).toBe(503);
    expect(mockIncr).not.toHaveBeenCalled();
  });

  it('refuses when the till IS the funder', async () => {
    vi.stubEnv('P01_TILL_ADDRESS', FUNDER);
    const res = await route.POST(payment());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/till/i);
    expect(mockIncr).not.toHaveBeenCalled();
  });

  it('refuses when the fee wallet IS the funder', async () => {
    // The fee rides in the buyer's own transaction, so this would put F in a
    // transaction signed by the buyer: the 2026-08-18 walk with its middle step
    // deleted.
    vi.stubEnv('P01_FEE_WALLET', FUNDER);
    const res = await route.POST(payment());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/P01_FEE_WALLET/);
    expect(mockIncr).not.toHaveBeenCalled();
  });

  it('refuses when the fee wallet IS the till', async () => {
    // The collision that CORRUPTS the read rather than blocking it. web3.js
    // dedupes an identical pubkey into ONE account index, so the till's delta
    // would read value + fee: `subsidy = required - received` merely shrinks, the
    // deployment fronts less than it should, and the operator collects no fee at
    // all while believing they do. Nothing errors.
    vi.stubEnv('P01_FEE_WALLET', TILL);
    const res = await route.POST(payment());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/till/);
    expect(mockIncr).not.toHaveBeenCalled();
  });
});

describe('a relay that has already left is never given back', () => {
  // 🚨 D3, AND IT IS A DOUBLE SPEND OUT OF THE FLOAT. `sendRawTransaction`
  // returning a signature means the transaction is on the wire. Everything after
  // it — the confirmation, a JSON parse, a 30-second timeout on a busy devnet —
  // is about the ANSWER, not about whether the money moved. A `catch` that spans
  // both releases the one-shot claim after a successful send, and the buyer's
  // retry (or a racing tab) forwards the same payment a second time out of F.
  //
  // Measured cost: one full pre-fund per event, 1.57 SOL on the 1 SOL pool, paid
  // by the deployment, with the receipt looking entirely legitimate.

  it('KEEPS the claim when the confirmation times out after a successful send', async () => {
    sendBehaviour = 'confirm-throws';
    const res = await route.POST(payment());
    const body = await res.json();
    expect(mockDel).not.toHaveBeenCalled();
    // And the buyer is not left blind: the signature is the only way anyone can
    // find out what actually happened to their money.
    expect(body.signature).toBe('RELAYSIG');
    expect(body.sent).toBe(true);
  });

  it('gives the claim back when the send itself never left', async () => {
    // The other side of the same line, and the reason the release exists at all:
    // nothing moved, so the buyer must be able to retry with the same receipt.
    sendBehaviour = 'send-throws';
    const res = await route.POST(payment());
    expect(res.status).toBe(502);
    expect(mockDel).toHaveBeenCalledTimes(1);
  });

  it('refuses a second request carrying a receipt already claimed', async () => {
    mockIncr.mockResolvedValue(2);
    const res = await route.POST(payment());
    expect(res.status).toBe(409);
    // ⛔ AND IT MUST NOT RELEASE. A 409 that released would hand the second
    // caller the claim it just refused.
    expect(mockDel).not.toHaveBeenCalled();
  });
});

describe('the client learns this relay’s ceilings from this relay', () => {
  // PORTE 2, the half that lives on the server. A cap the client also carries is
  // a cap that drifts: an operator lowering it here would not lower it there,
  // and every buyer between the two numbers pays first and is refused after.
  // MEASURED FROM SOURCE: MAX_RELAY_LAMPORTS 2_500_000_000, and
  // MAX_RENT_SUBSIDY_LAMPORTS RECALIBRATED 2026-08-21 from 1_500_000_000 to
  // 650_000_000 — see the derivation on the constant itself.

  it('reports the till, the fee wallet, the funder and both ceilings', async () => {
    const res = await route.GET(get());
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.till).toBe(TILL);
    expect(body.feeWallet).toBe(FEE_WALLET);
    expect(body.funder).toBe(FUNDER);
    expect(body.maxRelayLamports).toBe(2_500_000_000);
    // Pinned against the DERIVATION, not against a remembered number: the
    // subsidy a shield honestly needs is its rent leg plus the most the jitter
    // can add, and the cap must sit above that and below twice it. A future
    // edit that widens the cap back out fails here with the reason attached.
    expect(body.maxRentSubsidyLamports).toBe(650_000_000);
    const worstHonestSubsidy = 570_010_780 + 10_000_000 + 4 * 10_000_000;
    expect(body.maxRentSubsidyLamports).toBeGreaterThan(worstHonestSubsidy);
    expect(body.maxRentSubsidyLamports).toBeLessThan(2 * worstHonestSubsidy);
  });

  it('never reports anything the deployment has to keep', async () => {
    // This endpoint is deliberately not ticket-gated — the addresses are public
    // the instant they pay for anything — which is exactly why what it returns
    // has to be checked rather than assumed.
    const res = await route.GET(get());
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(bs58.encode(funderKeypair.secretKey));
    expect(text.toLowerCase()).not.toContain('secret');
    expect(text).not.toContain(TICKET);
  });

  it('says it cannot serve when the till is unset, rather than reporting a null', async () => {
    // A client that reads `till: null` and pays anyway is the D2 defect. The
    // honest answer is "not ready, here is why", and the client refuses on it.
    vi.stubEnv('P01_TILL_ADDRESS', '');
    const res = await route.GET(get());
    const body = await res.json();
    expect(body.ready).toBe(false);
    expect(JSON.stringify(body.reasons)).toMatch(/P01_TILL_ADDRESS/);
  });

  it('says it cannot serve when the till is the funder', async () => {
    vi.stubEnv('P01_TILL_ADDRESS', FUNDER);
    const body = await (await route.GET(get())).json();
    expect(body.ready).toBe(false);
  });

  it('is ready when three distinct addresses are configured', async () => {
    // The negative control. A readiness check that is never true is an outage
    // with a nicer message.
    const body = await (await route.GET(get())).json();
    expect(body.ready).toBe(true);
    expect(body.reasons).toEqual([]);
  });
});

describe('what the float actually pays out per call', () => {
  // ⚠️ MOVING `received` OFF THE FUNDER'S INDEX UNBINDS THE SUBSIDY CAP FROM
  // F'S SPENDING, AND THAT HAS TO BE RE-DERIVED RATHER THAN ASSUMED.
  //
  // Before: the buyer paid F, so F's own delta was `received`, F then forwarded
  // `required`, and F's net outlay was exactly `required - received` — the
  // number `MAX_RENT_SUBSIDY_LAMPORTS` bounds. Bounding the subsidy bounded the
  // spending.
  //
  // After: the value lands at R and F is credited NOTHING. F's cash outflow per
  // call is the WHOLE of `required`, and the only thing bounding it is
  // `MAX_RELAY_LAMPORTS`. The subsidy cap still answers a real question — how
  // much of this job did the buyer NOT pay for — but it is now an accounting
  // bound between R and F, not a bound on F's balance. Both are asserted, and
  // the difference is the reason F needs a balance alarm and a settlement
  // runbook that this repository does not implement.

  it('bounds one call by the relay cap, which is what F actually sends', async () => {
    paymentTx({ [TILL]: VALUE, [FEE_WALLET]: FEE });
    const res = await route.POST(payment({ requiredLamports: 2_500_000_001 }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.cap).toBe(2_500_000_000);
    expect(mockDel).toHaveBeenCalledTimes(1);
  });

  it('refuses a subsidy the OLD 1.5 SOL ceiling would have admitted', async () => {
    // The regression test for the recalibration, expressed as the attack it
    // closes. Both inputs to the payout are caller-chosen — `buyerPubkey` is
    // where the lamports go and `requiredLamports` is how many — and the ticket
    // that gates this route ships inside the browser bundle
    // (NEXT_PUBLIC_P01_FUNDER_TICKET). So this constant is not a tidiness
    // preference: it IS the bound on what one call can take out of the float.
    //
    // received 573,486,080 against a 1,573,486,080 job = a subsidy of exactly
    // 1 SOL. Under the old ceiling that was served; the caller paid the till
    // 0.573 SOL and the float sent 1.573 SOL to an address they named.
    paymentTx({ [TILL]: 573_486_080, [FEE_WALLET]: FEE });
    const res = await route.POST(payment());
    const body = await res.json();
    expect(res.status).toBe(402);
    expect(body.subsidy).toBe(1_000_000_000);
    expect(body.maxSubsidy).toBe(650_000_000);
    expect(mockDel).toHaveBeenCalledTimes(1);
  });

  it('still admits the worst subsidy an honest deposit can ask for', async () => {
    // The other half, and the reason the cap is derived rather than guessed at:
    // tightening it below the honest worst case would refuse real deposits on
    // an unlucky jitter draw — a deposit that works most days, which is worse to
    // debug than one that never works.
    //
    // rent leg 570,010,780 + the jitter's round-up (< 0.01 SOL) + its four
    // extra steps (0.04 SOL) = 620,010,779 worst case.
    paymentTx({ [TILL]: REQUIRED - 620_010_779, [FEE_WALLET]: FEE });
    const res = await route.POST(payment());
    expect(res.status).toBe(200);
    expect((await res.json()).lamports).toBe(REQUIRED);
  });
  it('refuses when the buyer paid less than the value, so F would be buying the note', async () => {
    // The subsidy cap in its surviving meaning: the deployment fronts refundable
    // rent and nothing else. A payment of one lamport against a 1.57 SOL job is
    // the deployment buying somebody a note.
    paymentTx({ [TILL]: 1, [FEE_WALLET]: FEE });
    const res = await route.POST(payment());
    const body = await res.json();
    expect(res.status).toBe(402);
    expect(body.subsidy).toBeGreaterThan(650_000_000);
    expect(mockDel).toHaveBeenCalledTimes(1);
  });

});

describe('the operator fee is checked ON CHAIN, or it is not checked at all', () => {
  // 🚨 THE FEE HAD NO SERVER-SIDE CHECK. `feeWallet` appeared only in the
  // configuration refusals and never in the balance read, so the 1% was enforced
  // by the client — which is not a trust boundary, because the ticket is in the
  // bundle. A caller POSTing this route with a payment that omits the second
  // transfer got the identical service for free, with no symptom anywhere.

  it('refuses a payment that credited the till and skipped the fee wallet', async () => {
    paymentTx({ [TILL]: VALUE });
    const res = await route.POST(payment());
    const body = await res.json();
    expect(res.status).toBe(402);
    expect(body.error).toMatch(/operator fee/i);
    expect(body.feeReceived).toBe(0);
    expect(body.feeWallet).toBe(FEE_WALLET);
    // Released: a caller who genuinely botched the fee must be able to build a
    // correct payment. The receipt they lose is one they were never served on.
    expect(mockDel).toHaveBeenCalledTimes(1);
  });

  it('refuses a fee that is short of the floor', async () => {
    paymentTx({ [TILL]: VALUE, [FEE_WALLET]: 9_000_000 });
    const res = await route.POST(payment());
    const body = await res.json();
    expect(res.status).toBe(402);
    expect(body.feeReceived).toBe(9_000_000);
    expect(body.minFee).toBe(9_934_405);
  });

  it('accepts a fee exactly at the floor, and nothing sends below it', async () => {
    // WHY 99 bps AND NOT 100. The client charges 1% of the DENOMINATION, while
    // what lands at the till is the denomination plus the protocol's own 0.3%.
    // An honest fee is therefore 0.01 / 1.003 = 99.70 bps of `received`, and the
    // client's integer division can shave one atom below that. 9,934,405 is the
    // floor for a 1 SOL note; the honest client sends 10,000,000.
    paymentTx({ [TILL]: VALUE, [FEE_WALLET]: 9_934_405 });
    expect((await route.POST(payment())).status).toBe(200);

    paymentTx({ [TILL]: VALUE, [FEE_WALLET]: 9_934_404 });
    expect((await route.POST(payment())).status).toBe(402);
  });

  it('reads the fee out of the SAME transaction as the payment', async () => {
    // A fee wallet the payment never named is a fee of zero, not an error:
    // "paid a different address" and "paid nothing" both mean this deployment
    // was not paid, so they must land on one refusal.
    paymentKeys = [WALLET, TILL, FUNDER];
    preBalances = [2_000_000_000, 5, 900_000_000];
    postBalances = [2_000_000_000 - VALUE, 5 + VALUE, 900_000_000];
    const res = await route.POST(payment());
    expect(res.status).toBe(402);
    expect((await res.json()).feeReceived).toBe(0);
  });
});
