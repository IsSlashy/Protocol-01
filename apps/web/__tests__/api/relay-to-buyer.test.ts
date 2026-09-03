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
import nacl from 'tweetnacl';

import { claimChallenge } from '@/lib/privacy/claimChallenge';
import bs58 from 'bs58';

const mockGetStore = vi.fn();
const mockRateLimitExceeded = vi.fn();
const mockIncr = vi.fn();
const mockDel = vi.fn();
/** The rate bucket's stored count. `null` = this IP has not relayed this hour. */
const mockKvGet = vi.fn();
/** Every `set`: the contribution binding and the buyer, written after the send. */
const mockKvSet = vi.fn();
/** How many `set` calls had happened when the relay's send left. -1 = never sent. */
let setsAtSend = -1;

/** Account keys of the payment transaction, in order, with their deltas. */
let paymentKeys: string[] = [];
let preBalances: number[] = [];
let postBalances: number[] = [];
/** What the chain reports for the BUYER identity. Non-zero trips the
 *  fresh-identity rule. */
let buyerBalance = 0;
/** What the float holds, or `'unreadable'` to make the RPC throw on it. */
let funderBalance: number | 'unreadable' = 5_000_000_000;
/** How the relay's own send behaves. `'send-throws'` never left the client;
 *  `'confirm-throws'` DID leave and the answer never came back. */
let sendBehaviour: 'ok' | 'send-throws' | 'confirm-throws' = 'ok';

/**
 * ⚠️ SPREAD THE REAL MODULE, OVERRIDE TWO THINGS.
 *
 * The factory used to list its exports, so anything the route later imported
 * from this module arrived as `undefined` — a call that throws, which the route
 * catches and reports as "could not read". That is a real behaviour, and it is
 * not the one under test: `relaysRemaining` came back `null` and the assertion
 * failed against a mock, not against the code.
 *
 * `rateLimitRemaining` therefore runs FOR REAL here, against the fake store
 * below, so the arithmetic it reports is the arithmetic the deployment uses.
 */
vi.mock('@/lib/waitlist/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/waitlist/store')>()),
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
      async getBalance(pk?: { toBase58?: () => string }) {
        // 🚨 KEYED BY ADDRESS, NOT ONE NUMBER FOR EVERYONE. The GET reads the
        // FLOAT's balance and the POST reads the BUYER's, and they answer
        // opposite questions — "can this deployment pay" against "is this
        // identity fresh". One shared variable made a case about one of them
        // silently assert the other.
        const key = pk?.toBase58?.();
        if (key === FUNDER) {
          if (funderBalance === 'unreadable') throw new Error('rpc down');
          return funderBalance;
        }
        return buyerBalance;
      }
      async getLatestBlockhash() {
        return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 };
      }
      async sendRawTransaction() {
        if (sendBehaviour === 'send-throws') throw new Error('blockhash not found');
        setsAtSend = mockKvSet.mock.calls.length;
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
 * The pool table, stubbed. The route resolves a contribution's pool through
 * `resolveContributionPool`, and the real table lives in a module that builds
 * PDAs from `SystemProgram.programId` at load, which the web3 stub above does
 * not carry. One open pool at the configured denomination is all it needs.
 */
vi.mock('@/lib/privacy/pool/denominatedPool', () => ({
  getPoolsForTokenV3: (token: string) =>
    token === 'SOL'
      ? [
          {
            token: 'SOL',
            denomination: 1,
            // The floor a contribution binding is priced at. Absent here until
            // 2026-09-03, which made the dust-payment guard read NaN and pass.
            denominationAtomic: 1_000_000_000n,
            deposits: 'open',
            poolPDA: { toBase58: () => FAKE_POOL_KEY },
          },
        ]
      : [],
}));

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
 *  only account DEBITED by a deposit payment. Its SECRET is kept because the
 *  route now requires a proof signed by it: `keys[0]` is the only key that can
 *  authorise relaying this payment. */
const walletKeypair = Keypair.generate();
const WALLET = walletKeypair.publicKey.toBase58();
/** The proof the real client sends: the payer's signature over the challenge. */
function payerProof(signature = 'PAYSIG', signer = walletKeypair): string {
  return Buffer.from(
    nacl.sign.detached(
      new Uint8Array(Buffer.from(claimChallenge(signature), 'utf8')),
      signer.secretKey,
    ),
  ).toString('base64');
}
const TICKET = 'test-ticket';
/** The pool a contribution lands in, as the stub above reports it. */
const FAKE_POOL_KEY = Keypair.generate().publicKey.toBase58();

/**
 * The VALUE leg of a 1 SOL deposit: the denomination plus the protocol's 0.3%,
 * DERIVED from the pool table rather than remembered
 * (`shieldEphemeral.ts:293`). Exactly what the buyer's wallet sends the till,
 * and exactly what this route reads back as `received`.
 *
 * ⚠️ NOT 1,003,475,300. That number is a measured pre-fund TOTAL minus a rent
 * constant, and the 475,300 it carries is buffer rent, not value.
 */
const VALUE = 1_003_000_000;
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
  req({
    paymentSignature: 'PAYSIG',
    buyerPubkey: BUYER,
    requiredLamports: REQUIRED,
    proof: payerProof(),
    ...over,
  });

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
  mockKvGet.mockResolvedValue(null);
  // `get` is part of the store the route now reads: the readiness answer
  // previews the rate bucket without incrementing it. A mock missing the method
  // made the preview throw and report "unknown", which is a real behaviour but
  // not the one under test.
  mockKvSet.mockResolvedValue(undefined);
  mockGetStore.mockReturnValue({
    get: mockKvGet,
    set: mockKvSet,
    incr: mockIncr,
    del: mockDel,
    expire: vi.fn(),
  });
  mockRateLimitExceeded.mockResolvedValue(false);
  buyerBalance = 0;
  funderBalance = 5_000_000_000;
  sendBehaviour = 'ok';
  setsAtSend = -1;
  vi.stubEnv('P01_TREASURY_NOTE_DENOMINATION', '1');
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
    // What the float holds, so a client can refuse BEFORE the buyer pays rather
    // than meet the shortfall as a 502 afterwards.
    expect(body.funderLamports).toBe(5_000_000_000);
    expect(body.relayFeeLamports).toBe(5_000);
    // 🚨 THE ALLOWANCE, READ WITHOUT SPENDING ONE. It is enforced inside the
    // POST, i.e. after the buyer has paid the till, and the bucket is per IP —
    // so a group test on one connection burned the fourth tester's denomination.
    // Reporting it here is what lets the client refuse before the signature.
    expect(body.relaysPerHour).toBe(3);
    expect(body.relaysRemaining).toBe(3);
    // Reading it must NOT consume one: `rateLimitExceeded` answers by
    // incrementing, which is right where the limit bites and wrong here.
    expect(mockIncr).not.toHaveBeenCalled();
    // Pinned against the DERIVATION, not against a remembered number: the
    // subsidy a shield honestly needs is its rent leg plus the most the jitter
    // can add, and the cap must sit above that and below twice it. A future
    // edit that widens the cap back out fails here with the reason attached.
    expect(body.maxRentSubsidyLamports).toBe(650_000_000);
    const worstHonestSubsidy = 570_010_780 + 10_000_000 + 4 * 10_000_000;
    expect(body.maxRentSubsidyLamports).toBeGreaterThan(worstHonestSubsidy);
    expect(body.maxRentSubsidyLamports).toBeLessThan(2 * worstHonestSubsidy);
  });

  /**
   * 🚨 THE LIMIT THAT BIT THE FOURTH TESTER, NOW CONFIGURABLE.
   *
   * The bucket is per IP and a group test is one IP by definition — several
   * people on one office wifi share a single allowance. At three, the fourth
   * person is refused having done nothing, and before 2026-08-21 that refusal
   * arrived AFTER they had signed away a full denomination.
   *
   * The constant is read at module load, like `ISSUES_PER_IP_PER_HOUR`, so the
   * override has to be exercised through a fresh import. Doing it any other way
   * would assert against the value this file already imported and pass whatever
   * the route does.
   */
  it('lets an operator raise the per-IP allowance for a group test', async () => {
    vi.resetModules();
    process.env.P01_RELAY_LIMIT_PER_HOUR = '25';
    const fresh = await import('@/app/api/relay-to-buyer/route');
    const body = await (await fresh.GET(get())).json();
    expect(body.relaysPerHour).toBe(25);
    delete process.env.P01_RELAY_LIMIT_PER_HOUR;
    vi.resetModules();
  });

  it('falls back to three on a malformed allowance rather than to zero', async () => {
    // ⛔ 0 is the value that turns the limiter off, and this endpoint spends the
    // float on every call it serves. A typo must not become an open faucet.
    for (const bad of ['0', '-4', 'lots', '2.5', '']) {
      vi.resetModules();
      process.env.P01_RELAY_LIMIT_PER_HOUR = bad;
      const fresh = await import('@/app/api/relay-to-buyer/route');
      const body = await (await fresh.GET(get())).json();
      expect(body.relaysPerHour, `"${bad}" must not disable the limiter`).toBe(3);
    }
    delete process.env.P01_RELAY_LIMIT_PER_HOUR;
    vi.resetModules();
  });

  it('reports an unreadable float balance as null, never as zero', async () => {
    // ⚠️ UNKNOWN IS NOT EMPTY. A client that read `0` from an RPC outage would
    // refuse every deposit and delete the only private path over a hiccup —
    // the shape of overreach that has already cost this project a working
    // journey. `null` says "could not tell" and the client proceeds.
    funderBalance = 'unreadable';
    const body = await (await route.GET(get())).json();
    expect(body.funderLamports).toBeNull();
    // And an outage in this one read must not drag the rest of readiness down
    // with it: the addresses are still correct and still reported.
    expect(body.ready).toBe(true);
    expect(body.till).toBe(TILL);
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
    expect(body.minFee).toBe(9_929_700); // floor(1_003_000_000 * 99 / 10_000)
  });

  it('accepts a fee exactly at the floor, and nothing sends below it', async () => {
    // WHY 99 bps AND NOT 100. The client charges 1% of the DENOMINATION, while
    // what lands at the till is the denomination plus the protocol's own 0.3%.
    // An honest fee is therefore 0.01 / 1.003 = 99.70 bps of `received`, and the
    // client's integer division can shave one atom below that. 9,929,700 is the
    // floor for a 1 SOL note; the honest client sends 10,000,000.
    paymentTx({ [TILL]: VALUE, [FEE_WALLET]: 9_929_700 });
    expect((await route.POST(payment())).status).toBe(200);

    paymentTx({ [TILL]: VALUE, [FEE_WALLET]: 9_929_699 });
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

describe('the payment is bound to the contribution it funded, only once the lamports moved', () => {
  // The confirm of `/api/contribute-note` and the fallback at
  // `/api/claim-for-payment` both require `p01:relay:payment:<sig>:contribution`
  // to name the leaf being claimed, so a payer cannot collect against somebody
  // else's reservation. The binding must therefore describe a deposit that WAS
  // funded: written after the send, never on a path that released the claim.
  const CONTRIBUTION = { token: 'SOL', leafIndex: 6 };
  const BINDING = `${FAKE_POOL_KEY}:6`;
  const setOf = (key: string) => mockKvSet.mock.calls.find((c) => c[0] === key)?.[1];

  it('writes the binding AFTER the send, and never the buyer join', async () => {
    const res = await route.POST(payment({ contribution: CONTRIBUTION }));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.contribution).toBe(BINDING);
    expect(setOf('p01:relay:payment:PAYSIG:contribution')).toBe(BINDING);
    // The payment -> ephemeral join is not written any more: nothing ever read
    // it, and it paired the buyer's own wallet with the deposit it funds.
    expect(setOf('p01:relay:payment:PAYSIG:buyer')).toBeUndefined();
    // Nothing had been written when the send left the process.
    expect(setsAtSend).toBe(0);
    expect(mockDel).not.toHaveBeenCalled();
  });

  it('writes nothing when the send never left', async () => {
    sendBehaviour = 'send-throws';
    const res = await route.POST(payment({ contribution: CONTRIBUTION }));
    expect(res.status).toBe(502);
    expect(mockKvSet).not.toHaveBeenCalled();
    expect(mockDel).toHaveBeenCalledTimes(1);
  });

  it('writes nothing on a refusal that released the claim', async () => {
    paymentTx({ [TILL]: VALUE });
    const res = await route.POST(payment({ contribution: CONTRIBUTION }));
    expect(res.status).toBe(402);
    expect(mockKvSet).not.toHaveBeenCalled();
    expect(mockDel).toHaveBeenCalledTimes(1);
  });

  it('still writes it when the send left and only the confirmation timed out', async () => {
    // The lamports are on the wire and the claim is held; the deposit this
    // payment funds may land, and its confirm has to find the leaf.
    sendBehaviour = 'confirm-throws';
    const res = await route.POST(payment({ contribution: CONTRIBUTION }));
    const body = await res.json();
    expect(res.status).toBe(202);
    expect(body.contribution).toBe(BINDING);
    expect(setOf('p01:relay:payment:PAYSIG:contribution')).toBe(BINDING);
    expect(mockDel).not.toHaveBeenCalled();
  });

  it('refuses a malformed contribution BEFORE the claim is taken', async () => {
    const res = await route.POST(payment({ contribution: { token: 'SOL', leafIndex: -1 } }));
    expect(res.status).toBe(400);
    expect(mockIncr).not.toHaveBeenCalled();
    expect(mockKvSet).not.toHaveBeenCalled();
  });

  it('relays a plain deposit with no contribution, and binds none', async () => {
    const res = await route.POST(payment());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.contribution).toBeNull();
    expect(setOf('p01:relay:payment:PAYSIG:contribution')).toBeUndefined();
  });
});

/**
 * The two exploits the 2026-09-03 audit confirmed on this route, pinned shut.
 *
 * A payment to the till is public the moment it lands. Until this route asked
 * for a payer proof, anyone reading `getSignaturesForAddress(till)` could POST
 * first with somebody else's signature.
 */
describe('the payer, proven', () => {
  it('refuses a relay with no proof, and gives the claim back so the real payer can still use it', async () => {
    const res = await route.POST(payment({ proof: undefined }));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(401);
    expect(body.error).toMatch(/payer proof is required/);
    // Released: a stranger's attempt must not burn the honest buyer's one shot.
    expect(mockDel).toHaveBeenCalledTimes(1);
    expect(mockKvSet).not.toHaveBeenCalled();
  });

  it('refuses a proof signed by anyone other than the fee payer of that payment', async () => {
    const stranger = Keypair.generate();
    const res = await route.POST(payment({ proof: payerProof('PAYSIG', stranger) }));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(401);
    expect(body.payer).toBe(WALLET);
    expect(mockDel).toHaveBeenCalledTimes(1);
  });

  it('refuses a proof over a DIFFERENT payment, so one signature does not authorise another', async () => {
    const res = await route.POST(payment({ proof: payerProof('SOME-OTHER-PAYMENT') }));
    expect(res.status).toBe(401);
    expect(mockDel).toHaveBeenCalledTimes(1);
  });

  it('a stranger naming their own buyerPubkey proves nothing: the proof is checked against keys[0]', async () => {
    const mallory = Keypair.generate();
    const res = await route.POST(
      payment({ buyerPubkey: mallory.publicKey.toBase58(), proof: payerProof('PAYSIG', mallory) }),
    );
    expect(res.status).toBe(401);
    expect(mockKvSet).not.toHaveBeenCalled();
  });
});

describe('a contribution binding costs a contribution', () => {
  const CONTRIBUTION = { token: 'SOL', leafIndex: 6 };

  it('refuses a dust payment bound to a leaf, so a claim code cannot be bought for one lamport', async () => {
    paymentTx({ [TILL]: 1, [FEE_WALLET]: FEE });
    const res = await route.POST(payment({ contribution: CONTRIBUTION }));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(402);
    expect(body.required).toBe(1_000_000_000);
    expect(mockKvSet).not.toHaveBeenCalled();
    expect(mockDel).toHaveBeenCalledTimes(1);
  });

  it('a payment without a contribution is not held to that floor', async () => {
    paymentTx({ [TILL]: VALUE, [FEE_WALLET]: FEE });
    const res = await route.POST(payment());
    expect(res.status).toBe(200);
  });
});
