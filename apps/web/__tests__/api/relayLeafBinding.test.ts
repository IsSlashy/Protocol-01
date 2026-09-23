/**
 * ONE LEAF, ONE PAYMENT — and one payment, one payout.
 *
 * Audit v1 round 4 (server axis), two findings on `/api/relay-to-buyer`, both
 * driven here through the REAL route modules (relay-to-buyer, contribute-note
 * confirm, claim-for-payment) sharing one in-memory store, with only the
 * Connection, the store and the pool history faked. No network, no cluster.
 *
 * 1. A stranger bound to the same leaf took the claim for a victim's landed
 *    contribution. The relay bound a payment to ANY leaf the caller named, and
 *    confirm pays whichever bound payment confirms first, so an attacker who
 *    paid the till the same amount (and got it back at a key it holds) could
 *    bind the victim's leaf, poll confirm, and collect the victim's note. The
 *    victim was then refused by confirm and by the fallback, for ever.
 *    Measured at HEAD 6de4c8c3: scratchpad audit-v1-opus/r4-server/p1p2-head.log.
 *
 * 2. The reverse-order double payout: a payment sold as a plain claim at
 *    `/api/claim-for-payment` first was still forwarded by the relay after,
 *    because the relay never read the sale gate `p01:note:paid:<sig>`.
 *
 * What these cases require of the relay:
 *   - a leaf already on the tree cannot be bound (an honest relay always runs
 *     BEFORE its deposit lands, because it funds that deposit);
 *   - a leaf another payment holds cannot be bound while that holder is live;
 *   - a holder whose leaf never landed, past the reservation window AND with
 *     an empty funded key (audit v1 F72: the fake chain below reports every
 *     balance as 0), is evicted by the payment that takes the leaf over, so a
 *     stale binding can never confirm somebody else's later deposit. A holder
 *     whose key still holds lamports keeps its leaf: see
 *     `closeV1L1LeafHold.test.ts`;
 *   - a payment already sold as a claim is never forwarded.
 * Every refusal happens before a lamport moves, and releases the payment so
 * its owner can still sell it as a plain claim.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

// ---------------------------------------------------------------- shared fakes
const counters = new Map<string, number>();
const values = new Map<string, unknown>();
const sets = new Map<string, Set<string>>();
const kv = {
  incr: async (k: string) => {
    const n = Number(values.get(k) ?? counters.get(k) ?? 0) + 1;
    values.delete(k);
    counters.set(k, n);
    return n;
  },
  get: async (k: string) => (values.has(k) ? values.get(k) : counters.get(k) ?? null),
  set: async (k: string, v: unknown) => {
    counters.delete(k);
    values.set(k, v);
  },
  del: async (k: string) => {
    counters.delete(k);
    values.delete(k);
    sets.delete(k);
  },
  expire: async () => {},
  sadd: async (k: string, m: string) => {
    const s = sets.get(k) ?? new Set<string>();
    s.add(m);
    sets.set(k, s);
  },
  smembers: async (k: string) => [...(sets.get(k) ?? [])],
  srem: async () => {},
  scard: async () => 0,
  mget: async () => [],
};

vi.mock('@/lib/waitlist/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/waitlist/store')>()),
  getStore: () => kv,
  rateLimitExceeded: async () => false,
  rateLimitRemaining: async () => 99,
}));

const txs = new Map<string, { keys: string[]; pre: number[]; post: number[] }>();
const relaySends: Array<{ to: string; lamports: number }> = [];

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  // The relay's own transfer, stubbed like `relay-to-buyer.test.ts` does:
  // `SystemProgram.transfer` drags `@solana/buffer-layout` into jsdom and fails
  // on Buffer for reasons unrelated to what is tested. The stub serialises the
  // transfer's destination and amount so the fake send can record them.
  class FakeTransaction {
    instructions: Array<{ to: string; lamports: number }> = [];
    recentBlockhash?: string;
    feePayer?: unknown;
    add(ix: { to: string; lamports: number }) {
      this.instructions.push(ix);
      return this;
    }
    sign() {}
    serialize() {
      return new TextEncoder().encode(JSON.stringify(this.instructions[0]));
    }
  }
  return {
    ...actual,
    Transaction: FakeTransaction,
    SystemProgram: {
      ...actual.SystemProgram,
      transfer: (p: { toPubkey: { toBase58(): string }; lamports: number }) => ({
        to: p.toPubkey.toBase58(),
        lamports: Number(p.lamports),
      }),
    },
    Connection: class {
      async getGenesisHash() {
        return 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
      }
      async getTransaction(sig: string) {
        const t = txs.get(sig);
        if (!t) return null;
        return {
          meta: { err: null, preBalances: t.pre, postBalances: t.post },
          transaction: {
            message: {
              compiledInstructions: [],
              getAccountKeys: () => ({
                staticAccountKeys: t.keys.map((k) => new actual.PublicKey(k)),
              }),
            },
          },
        };
      }
      async getBalance() {
        return 0;
      }
      async getLatestBlockhash() {
        return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 };
      }
      async sendRawTransaction(raw: Uint8Array) {
        const ix = JSON.parse(new TextDecoder().decode(raw)) as { to: string; lamports: number };
        relaySends.push({ to: ix.to, lamports: ix.lamports });
        return `RELAYSIG${relaySends.length}`;
      }
      async confirmTransaction() {
        return { value: { err: null } };
      }
    },
  };
});

let history = new Map<string, { commitment: bigint; leafIndex: number; depositSlot: number }>();
vi.mock('@/lib/privacy/pool/denominatedPool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/privacy/pool/denominatedPool')>()),
  fetchPoolCommitments: async () => history,
}));

import { getPoolsForTokenV3 } from '@/lib/privacy/pool/denominatedPool';
import { treasuryCommitmentFor, POST as contribute } from '@/app/api/contribute-note/route';
import { POST as relay } from '@/app/api/relay-to-buyer/route';
import { POST as claimForPayment } from '@/app/api/claim-for-payment/route';
import { claimChallenge } from '@/lib/privacy/claimChallenge';
import { relayPaymentClaimKey, relayPaymentContributionKey } from '@/lib/privacy/paymentBinding';

const TICKET = 'public-ticket-from-the-bundle';
const SEED_HEX = 'ab'.repeat(32);
const SEED = Uint8Array.from(Buffer.from(SEED_HEX, 'hex'));
const POOL = getPoolsForTokenV3('SOL').find((p) => p.deposits === 'open')!;
const POOL_KEY = POOL.poolPDA.toBase58();
const DENOM = Number(POOL.denominationAtomic);
const FEE_LAMPORTS = Math.ceil(DENOM / 100);
const funder = Keypair.generate();
const TILL = Keypair.generate().publicKey.toBase58();
const FEE = Keypair.generate().publicKey.toBase58();
/** The tree holds leaves 0..5, so the next index is 6. */
const L = 6;

function post(url: string, body: unknown, ip: string, ticket = true) {
  return new NextRequest(`http://localhost/api/${url}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(ticket ? { 'x-p01-funder-ticket': TICKET } : {}),
      'x-real-ip': ip,
    },
    body: JSON.stringify(body),
  } as never);
}
const proof = (kp: Keypair, sig: string) =>
  // Plain Uint8Arrays: tweetnacl checks `instanceof Uint8Array`, and under
  // jsdom a Buffer comes from another realm.
  Buffer.from(
    nacl.sign.detached(
      new Uint8Array(Buffer.from(claimChallenge(sig), 'utf8')),
      new Uint8Array(kp.secretKey),
    ),
  ).toString('base64');

function treeUpTo(highest: number, landed: number[] = []) {
  const m = new Map<string, { commitment: bigint; leafIndex: number; depositSlot: number }>();
  for (let i = 0; i <= highest; i += 1) {
    m.set(String(1000n + BigInt(i)), { commitment: 1000n + BigInt(i), leafIndex: i, depositSlot: 1 });
  }
  for (const leafIndex of landed) {
    const commitment = treasuryCommitmentFor(SEED, POOL.poolPDA, POOL.tokenMint, leafIndex);
    m.set(commitment.toString(), { commitment, leafIndex, depositSlot: 1 });
  }
  return m;
}

/** A payer: its wallet, the fresh key it names as buyer, and its till payment. */
function payer(tag: string) {
  const wallet = Keypair.generate();
  const eph = Keypair.generate();
  const sig = `PAY_${tag}_`.padEnd(88, tag === 'A' ? '2' : tag === 'B' ? '1' : '3');
  txs.set(sig, {
    keys: [wallet.publicKey.toBase58(), TILL, FEE],
    pre: [10_000_000_000, 0, 0],
    post: [10_000_000_000 - DENOM - FEE_LAMPORTS - 5000, DENOM, FEE_LAMPORTS],
  });
  return { wallet, eph, sig };
}
type Payer = ReturnType<typeof payer>;

const relayFor = (p: Payer, leafIndex: number | null, ip: string) =>
  relay(
    post(
      'relay-to-buyer',
      {
        paymentSignature: p.sig,
        buyerPubkey: p.eph.publicKey.toBase58(),
        requiredLamports: DENOM,
        proof: proof(p.wallet, p.sig),
        ...(leafIndex === null ? {} : { contribution: { token: 'SOL', leafIndex } }),
      },
      ip,
    ),
  );
const confirmFor = (p: Payer, leafIndex: number, ip: string) =>
  contribute(
    post(
      'contribute-note',
      { action: 'confirm', leafIndex, paymentSignature: p.sig, proof: proof(p.wallet, p.sig) },
      ip,
    ),
  );
const saleFor = (p: Payer, ip: string) =>
  claimForPayment(post('claim-for-payment', { signature: p.sig, proof: proof(p.wallet, p.sig) }, ip, false));

const sentTo = (p: Payer) => relaySends.filter((s) => s.to === p.eph.publicKey.toBase58()).length;

beforeEach(() => {
  counters.clear();
  values.clear();
  sets.clear();
  txs.clear();
  relaySends.length = 0;
  history = treeUpTo(5);
  vi.stubEnv('P01_TREASURY_POOL_SEED', SEED_HEX);
  vi.stubEnv('P01_FUNDER_TICKET', TICKET);
  vi.stubEnv('P01_TREASURY_NOTE_DENOMINATION', String(POOL.denomination));
  vi.stubEnv('P01_FUNDER_SECRET_KEY', bs58.encode(funder.secretKey));
  vi.stubEnv('P01_TILL_ADDRESS', TILL);
  vi.stubEnv('P01_FEE_WALLET', FEE);
  vi.stubEnv('P01_FUNDER_RPC', 'http://fake-rpc.invalid');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('one leaf, one live payment', () => {
  it('refuses a second payment bound to a leaf another payment holds, before a lamport moves, and leaves it sellable', async () => {
    // The finding's own order (probe P2): the attacker binds leaf L first.
    const A = payer('A');
    const B = payer('B');
    const rA = await relayFor(A, L, '203.0.113.66');
    expect(rA.status).toBe(200);

    const rB = await relayFor(B, L, '198.51.100.7');
    const bodyB = await rB.json();
    expect(rB.status, JSON.stringify(bodyB)).toBe(409);
    // Nothing forwarded for B, nothing bound, and the one-shot relay claim was
    // given back: the refusal cost B nothing.
    expect(sentTo(B)).toBe(0);
    expect(await kv.get(relayPaymentContributionKey(B.sig))).toBeNull();
    expect(await kv.get(relayPaymentClaimKey(B.sig))).toBeNull();
    // So B's payment still buys its note as a plain sale.
    const sale = await saleFor(B, '198.51.100.7');
    expect(sale.status).toBe(200);
    expect(typeof (await sale.json()).claimCode).toBe('string');
  });

  it('a stranger cannot bind a leaf the victim holds, before or after the deposit lands; the victim collects', async () => {
    const A = payer('A');
    const B = payer('B');
    expect((await relayFor(B, L, '198.51.100.7')).status).toBe(200);

    // Before the deposit lands: the victim's hold is live.
    const early = await relayFor(A, L, '203.0.113.66');
    expect(early.status).toBe(409);
    expect(sentTo(A)).toBe(0);

    // The victim's deposit lands at L.
    history = treeUpTo(5, [L]);

    // After it lands, the leaf is on the tree and binds nobody new.
    const late = await relayFor(A, L, '203.0.113.66');
    const lateBody = await late.json();
    expect(late.status, JSON.stringify(lateBody)).toBe(409);
    expect(sentTo(A)).toBe(0);

    // The attacker polls confirm: no binding, no code.
    const cA = await confirmFor(A, L, '203.0.113.66');
    expect(cA.status).toBe(400);
    expect((await cA.json()).claimCode).toBeUndefined();

    // The victim collects the claim for their own deposit.
    const cB = await confirmFor(B, L, '198.51.100.7');
    const cBody = await cB.json();
    expect(cB.status, JSON.stringify(cBody)).toBe(200);
    expect(typeof cBody.claimCode).toBe('string');
  });

  it('a payment cannot bind a leaf that is already on the tree, even one nobody holds', async () => {
    history = treeUpTo(5, [L]);
    const A = payer('A');
    const r = await relayFor(A, L, '203.0.113.66');
    expect(r.status).toBe(409);
    expect(sentTo(A)).toBe(0);
    expect(await kv.get(relayPaymentContributionKey(A.sig))).toBeNull();
  });

  it('refuses a leaf further past the tree than any reservation reaches', async () => {
    const A = payer('A');
    const r = await relayFor(A, 5 + 64 + 1, '203.0.113.66');
    expect(r.status).toBe(409);
    expect(sentTo(A)).toBe(0);
  });

  it('a stale holder whose leaf never landed is evicted by the payment that takes the leaf over', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-09-22T10:00:00Z');
    vi.setSystemTime(t0);

    // The attacker binds the next index and never deposits.
    const A = payer('A');
    expect((await relayFor(A, L, '203.0.113.66')).status).toBe(200);
    expect(await kv.get(relayPaymentContributionKey(A.sig))).toBe(`${POOL_KEY}:${L}`);

    // Inside the reservation window the hold is live.
    vi.setSystemTime(t0 + 5 * 60_000);
    const B0 = payer('C');
    expect((await relayFor(B0, L, '198.51.100.8')).status).toBe(409);

    // Past the window, the reserve route hands L to the next contributor, and
    // that contributor's relay takes the leaf over.
    vi.setSystemTime(t0 + 21 * 60_000);
    const B = payer('B');
    const rB = await relayFor(B, L, '198.51.100.7');
    expect(rB.status, JSON.stringify(await rB.clone().json())).toBe(200);
    expect(sentTo(B)).toBe(1);
    // The attacker's binding is gone.
    expect(await kv.get(relayPaymentContributionKey(A.sig))).toBeNull();

    // The victim's deposit lands; the attacker's poll earns nothing.
    history = treeUpTo(5, [L]);
    const cA = await confirmFor(A, L, '203.0.113.66');
    expect(cA.status).toBe(400);
    const cB = await confirmFor(B, L, '198.51.100.7');
    const cBody = await cB.json();
    expect(cB.status, JSON.stringify(cBody)).toBe(200);
    expect(typeof cBody.claimCode).toBe('string');
  });

  it('the row that holds a leaf names no payment signature in the clear', async () => {
    const A = payer('A');
    expect((await relayFor(A, L, '203.0.113.66')).status).toBe(200);
    // Every row whose key names this leaf, other than the binding (keyed by
    // the payment, deleted at redemption), must not carry the signature.
    const leafRows = [...values.entries(), ...counters.entries()].filter(([k]) =>
      k.includes(`${POOL_KEY}:${L}`),
    );
    expect(leafRows.length, 'the leaf hold was not written at all').toBeGreaterThan(0);
    for (const [k, v] of leafRows) {
      expect(`${k}=${String(v)}`, `row ${k} pairs the leaf with the payment`).not.toContain(A.sig);
    }
  });
});

describe('one payment, one payout', () => {
  it('a payment already sold as a plain claim is not forwarded by the relay', async () => {
    const A = payer('A');
    const sale = await saleFor(A, '203.0.113.66');
    expect(sale.status).toBe(200);
    const r = await relayFor(A, null, '203.0.113.66');
    const body = await r.json();
    expect(r.status, JSON.stringify(body)).toBe(409);
    expect(sentTo(A)).toBe(0);
    // The sale still replays its own code: the refusal consumed nothing.
    const again = await saleFor(A, '203.0.113.66');
    expect(again.status).toBe(200);
  });

  it('control: relay first, then a sale of the same payment, is still refused by the sale', async () => {
    const A = payer('A');
    expect((await relayFor(A, null, '203.0.113.66')).status).toBe(200);
    expect(sentTo(A)).toBe(1);
    expect((await saleFor(A, '203.0.113.66')).status).toBe(400);
  });
});
