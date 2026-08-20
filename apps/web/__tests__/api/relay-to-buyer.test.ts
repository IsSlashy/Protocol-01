/**
 * WHOSE balance delta counts as "the buyer paid".
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
 * second earlier, for exactly the note's amount.
 *
 * The split was asserted in the env documentation, in the readiness report and
 * in three file headers. It was wired nowhere. This route read the payment from
 * `funder.publicKey`'s balance delta, so the ONLY payment it would accept was
 * one that had named F — a client paying the till got 400 "that transaction did
 * not pay this deployment", after the money had already moved.
 *
 * Nothing was red while that was true. The only coverage this file had was the
 * source scan in `claim-release.test.ts`, which says nothing about which address
 * is indexed. So the load-bearing case here is a fixture where the FUNDER was
 * paid and the TILL was not: correct code must refuse it.
 *
 * Every case is refused before a transaction is built, deliberately —
 * `SystemProgram.transfer` drags `@solana/buffer-layout` into jsdom and fails on
 * Buffer for reasons that have nothing to do with what is being tested. The
 * positive control stops one step past the balance read instead of at a 200.
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
 *  fresh-identity rule, which 409s without building a transaction — that is
 *  what the positive control uses to prove the till read succeeded. */
let buyerBalance = 0;

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
        return 'RELAYSIG';
      }
      async confirmTransaction() {
        return { value: { err: null } };
      }
    },
  };
});

import { POST } from '@/app/api/relay-to-buyer/route';

const funderKeypair = Keypair.generate();
const FUNDER = funderKeypair.publicKey.toBase58();
const TILL = Keypair.generate().publicKey.toBase58();
const FEE_WALLET = Keypair.generate().publicKey.toBase58();
const BUYER = Keypair.generate().publicKey.toBase58();
/** The wallet that signs the payment. Account index 0: the fee payer, and the
 *  only account DEBITED by a deposit payment. */
const WALLET = Keypair.generate().publicKey.toBase58();
const TICKET = 'test-ticket';

/** A 1 SOL deposit, measured on devnet. */
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

const payment = () => req({ paymentSignature: 'PAYSIG', buyerPubkey: BUYER, requiredLamports: REQUIRED });

/**
 * The real shape of the transaction the buyer signs after this change: one
 * debit at index 0, one credit to the till, one credit to the fee wallet.
 * `credits` overrides which addresses actually moved.
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
  // refused — which then passes for the wrong reason.
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
  paymentTx({ [TILL]: VALUE, [FEE_WALLET]: FEE });
});

describe('the payment must have credited the TILL', () => {
  it('REFUSES A PAYMENT THAT NAMED THE FUNDER INSTEAD', async () => {
    // 🚨 THE CASE THIS FILE EXISTS FOR. The old code read `received` from the
    // funder's delta, so this fixture — F credited the full note value, R
    // credited nothing — was the HAPPY PATH. It is the leak: a buyer who pays F
    // is one transaction from the address that funds their own spend.
    paymentTx({ [FUNDER]: VALUE });
    const res = await POST(payment());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    // Refused for the right reason: the till was named in the transaction and
    // simply received nothing, so the message is "paid nothing", not "wrong
    // transaction". Either way nothing is forwarded.
    expect(body.signature).toBeUndefined();
  });

  it('refuses when the till is not in the transaction at all, and NAMES it', async () => {
    // An operator reading this in a log has to be able to tell a client paying
    // the wrong address from a client paying nothing.
    paymentKeys = [WALLET, FUNDER];
    preBalances = [2_000_000_000, 900_000_000];
    postBalances = [2_000_000_000 - VALUE, 900_000_000 + VALUE];
    const res = await POST(payment());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/collection address/);
    expect(body.till).toBe(TILL);
  });

  it('reads the till delta and IGNORES the 1% fee credited in the same transaction', async () => {
    // 🚨 THE NEGATIVE CONTROL, AND IT IS THE POINT. A guard that refuses
    // everything is an outage, not a guard.
    //
    // Two transfers to two distinct pubkeys occupy two distinct entries in
    // `staticAccountKeys`, and `pre/postBalances` are positionally aligned with
    // that array — so the fee wallet's credit cannot enter the till's delta. The
    // only way they could merge is key equality, which web3.js collapses into
    // one index, and which is refused outright below.
    //
    // Asserted one step PAST the balance read rather than at a 200: a non-empty
    // buyer is 409'd by the rule that follows, which proves `received` was
    // positive and within the cap without dragging `@solana/buffer-layout` into
    // jsdom.
    paymentTx({ [TILL]: VALUE, [FEE_WALLET]: FEE });
    buyerBalance = 1;
    const res = await POST(payment());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already holds lamports/);
  });

  it('reports the EXACT till credit, with the fee excluded to the lamport', async () => {
    // The case above proves the read succeeded; this one proves it read the
    // right number. The over-cap refusal echoes `received` back, which is the
    // only place this route states the figure out loud — so a fee that had bled
    // into the till's delta would be visible here as `+ FEE` and nowhere else.
    //
    // ⚠️ If this ever reads OVER by exactly the fee, the cause is key equality:
    // web3.js dedupes an identical pubkey into ONE account index, so a fee
    // wallet configured equal to the till merges the two credits. That is
    // refused in three places for this reason.
    const OVER_CAP = 2_600_000_000;
    paymentTx({ [TILL]: OVER_CAP, [FEE_WALLET]: FEE });
    const res = await POST(payment());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.received).toBe(OVER_CAP);
    expect(body.received).not.toBe(OVER_CAP + FEE);
    expect(body.cap).toBe(2_500_000_000);
  });

  it('refuses a payment that credited only the fee wallet', async () => {
    // The fee alone is not a payment. If the fee's index were read by mistake
    // the deployment would front the entire note value out of its own float.
    paymentTx({ [FEE_WALLET]: FEE });
    const res = await POST(payment());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/nothing/);
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
    const res = await POST(payment());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/P01_TILL_ADDRESS/);
    expect(mockIncr).not.toHaveBeenCalled();
    expect(mockRateLimitExceeded).not.toHaveBeenCalled();
  });

  it('refuses a till that is not a public key at all', async () => {
    // Unparseable is not "unset with extra steps" from an operator's point of
    // view, but it fails the same way and must fail closed rather than fall back
    // to the funder.
    vi.stubEnv('P01_TILL_ADDRESS', 'not-a-pubkey');
    const res = await POST(payment());
    expect(res.status).toBe(503);
    expect(mockIncr).not.toHaveBeenCalled();
  });

  it('refuses when the till IS the funder', async () => {
    vi.stubEnv('P01_TILL_ADDRESS', FUNDER);
    const res = await POST(payment());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/till \(P01_TILL_ADDRESS\) is the funder/);
    expect(mockIncr).not.toHaveBeenCalled();
  });

  it('refuses when the fee wallet IS the funder', async () => {
    vi.stubEnv('P01_FEE_WALLET', FUNDER);
    const res = await POST(payment());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/P01_FEE_WALLET/);
    expect(mockIncr).not.toHaveBeenCalled();
  });

  it('refuses when the fee wallet IS the till', async () => {
    // The collision that corrupts the read rather than blocking it. web3.js
    // dedupes an identical pubkey into ONE account index, so the till's delta
    // would read value + fee: `subsidy = required - received` merely shrinks,
    // the deployment fronts less than it should, and the operator collects no
    // fee at all while believing they do. Nothing errors — which is precisely
    // the class of configuration bug this repository keeps paying for.
    vi.stubEnv('P01_FEE_WALLET', TILL);
    const res = await POST(payment());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/is the till/);
    expect(mockIncr).not.toHaveBeenCalled();
  });

  it('lets a deployment with no fee wallet declared through to the payment read', async () => {
    // The fee is charged CLIENT-side and never touches this route, so an unset
    // fee wallet is not this endpoint's problem to refuse — only the collisions
    // are, because those corrupt the delta it reads. Refusing here would take a
    // working relay down for a setting it does not use.
    vi.stubEnv('P01_FEE_WALLET', '');
    buyerBalance = 1;
    const res = await POST(payment());
    expect(res.status).toBe(409);
    expect(res.status).not.toBe(503);
  });
});
