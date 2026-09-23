/**
 * close-v1 blockers, F11: the HONEST relayed fallback, driven end to end.
 *
 * `/api/claim-for-payment` sells a relayed payment only when the ephemeral the
 * relay funded for THAT payment gave the float its lamports back (audit v1 F11,
 * F74). The key that says "this is the ephemeral the relay funded" is a keyed
 * tag the relay records under `p01:relay:payment:<sig>:ephemeral-tag`.
 *
 * 🚨 THE BREAK THIS PINS SHUT (gate r1, open item 5). Only the claim route and
 * `claimChallenge.ts` knew that row: `/api/relay-to-buyer` never wrote it. The
 * route tests seeded it by hand, so they stayed green while EVERY honest
 * fallback answered 409 RELAYED_EPHEMERAL_UNBOUND: the buyer whose deposit
 * never landed, and who ran Recover, was locked out of the note they paid for.
 *
 * So here nothing is seeded. The REAL relay route writes whatever it writes,
 * the REAL claim route reads it, and only the Connection, the store and the
 * pool history are faked (no network, no cluster). The double-payout refusals
 * are driven the same way, so they still hold once the relay tags its keys.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

// ---------------------------------------------------------------- shared fakes
const counters = new Map<string, number>();
const values = new Map<string, unknown>();
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
  },
  expire: async () => {},
  sadd: async () => {},
  smembers: async () => [],
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

/** signature -> balances; address -> its history, newest first. */
const txs = new Map<string, { keys: string[]; pre: number[]; post: number[] }>();
const addressHistory = new Map<string, string[]>();
let floatAddress = '';
let confirmThrows = false;

function onChain(sig: string, keys: string[], deltas: number[]) {
  const pre = keys.map(() => 10_000_000_000);
  txs.set(sig, { keys, pre, post: pre.map((b, i) => b + (deltas[i] ?? 0)) });
  for (const k of keys) addressHistory.set(k, [sig, ...(addressHistory.get(k) ?? [])]);
}

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  // The relay's transfer is stubbed as `relayLeafBinding.test.ts` stubs it
  // (`SystemProgram.transfer` fails on Buffer under jsdom); the fake send
  // records the transfer ON CHAIN, so the ephemeral's history holds it.
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
  let sends = 0;
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
      async getSignaturesForAddress(address: { toBase58(): string }) {
        return (addressHistory.get(address.toBase58()) ?? []).map((signature) => ({
          signature,
          err: null,
        }));
      }
      async getBalance() {
        return 0;
      }
      async getLatestBlockhash() {
        return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 };
      }
      async sendRawTransaction(raw: Uint8Array) {
        const ix = JSON.parse(new TextDecoder().decode(raw)) as { to: string; lamports: number };
        sends += 1;
        const sig = `RELAYSIG${sends}`.padEnd(88, '7');
        onChain(sig, [floatAddress, ix.to], [-(ix.lamports + 5_000), ix.lamports]);
        return sig;
      }
      async confirmTransaction() {
        if (confirmThrows) throw new Error('block height exceeded (injected)');
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
import { POST as relay } from '@/app/api/relay-to-buyer/route';
import { POST as claimForPayment } from '@/app/api/claim-for-payment/route';

const TICKET = 'public-ticket-from-the-bundle';
const SEED_HEX = 'ab'.repeat(32);
const POOL = getPoolsForTokenV3('SOL').find((p) => p.deposits === 'open')!;
const DENOM = Number(POOL.denominationAtomic);
const FEE_LAMPORTS = Math.ceil(DENOM / 100);
/** What a contribution's ephemeral needs: the value plus the rent the float fronts. */
const REQUIRED = DENOM + 573_486_080;
const funder = Keypair.generate();
const FLOAT = funder.publicKey.toBase58();
const TILL = Keypair.generate().publicKey.toBase58();
const FEE = Keypair.generate().publicKey.toBase58();
/** The tree holds leaves 0..5, so the next index is 6, and it never lands here. */
const L = 6;

function post(url: string, body: unknown, ticket: boolean) {
  return new NextRequest(`http://localhost/api/${url}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(ticket ? { 'x-p01-funder-ticket': TICKET } : {}),
      'x-real-ip': '203.0.113.9',
    },
    body: JSON.stringify(body),
  } as never);
}
// The wire strings, written out rather than imported (see closeV1L2ClaimRoute).
const claimText = (sig: string) => `Protocol 01 - collect the note I paid for.\nPayment: ${sig}`;
const ephemeralText = (sig: string) =>
  `Protocol 01 - the deposit key this payment funded gave the float back.\nPayment: ${sig}`;
const signText = (text: string, kp: Keypair) =>
  Buffer.from(
    nacl.sign.detached(new Uint8Array(Buffer.from(text, 'utf8')), new Uint8Array(kp.secretKey)),
  ).toString('base64');

/** A payer: its wallet, the fresh ephemeral it names, and its till payment. */
function payer(tag: string) {
  const wallet = Keypair.generate();
  const eph = Keypair.generate();
  const sig = `PAY${tag}`.padEnd(88, '2');
  onChain(sig, [wallet.publicKey.toBase58(), TILL, FEE], [-(DENOM + FEE_LAMPORTS + 5_000), DENOM, FEE_LAMPORTS]);
  return { wallet, eph, sig };
}
type Payer = ReturnType<typeof payer>;

const relayFor = (p: Payer) =>
  relay(
    post(
      'relay-to-buyer',
      {
        paymentSignature: p.sig,
        buyerPubkey: p.eph.publicKey.toBase58(),
        requiredLamports: REQUIRED,
        proof: signText(claimText(p.sig), p.wallet),
        contribution: { token: 'SOL', leafIndex: L },
      },
      true,
    ),
  );

/** Recover: the ephemeral sweeps what it holds back to the float. */
function sweepHome(p: Payer, tag: string, lamports = REQUIRED - 60_000) {
  onChain(`SWEEP${tag}`.padEnd(88, '3'), [p.eph.publicKey.toBase58(), FLOAT], [-(lamports + 5_000), lamports]);
}

const fallbackFor = (p: Payer, named: Keypair = p.eph) =>
  claimForPayment(
    post(
      'claim-for-payment',
      {
        signature: p.sig,
        proof: signText(claimText(p.sig), p.wallet),
        contribution: { token: 'SOL', leafIndex: L },
        ephemeral: named.publicKey.toBase58(),
        ephemeralProof: signText(ephemeralText(p.sig), named),
      },
      false,
    ),
  );

const mintedCodes = () =>
  [...values.keys(), ...counters.keys()].filter((k) => k.startsWith('p01:note:claim-minted:'));

beforeEach(() => {
  counters.clear();
  values.clear();
  txs.clear();
  addressHistory.clear();
  confirmThrows = false;
  floatAddress = FLOAT;
  history = new Map(
    Array.from({ length: 6 }, (_, i) => [
      String(1000 + i),
      { commitment: 1000n + BigInt(i), leafIndex: i, depositSlot: 1 },
    ]),
  );
  vi.stubEnv('P01_TREASURY_POOL_SEED', SEED_HEX);
  vi.stubEnv('P01_FUNDER_TICKET', TICKET);
  vi.stubEnv('P01_TREASURY_NOTE_DENOMINATION', String(POOL.denomination));
  vi.stubEnv('P01_FUNDER_SECRET_KEY', bs58.encode(funder.secretKey));
  vi.stubEnv('P01_TILL_ADDRESS', TILL);
  vi.stubEnv('P01_FEE_WALLET', FEE);
  vi.stubEnv('P01_FUNDER_RPC', 'http://fake-rpc.invalid');
  delete process.env.P01_NOTE_PRICE_LAMPORTS;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('F11 · the honest relayed fallback, through the real relay', () => {
  it('🚨 relay, no deposit, Recover sweeps the float home: the fallback sells the note ONCE', async () => {
    const A = payer('A');
    const r = await relayFor(A);
    expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
    sweepHome(A, 'A');

    const res = await fallbackFor(A);
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(typeof body.claimCode).toBe('string');
    expect(mintedCodes()).toEqual([`p01:note:claim-minted:${body.claimCode}`]);

    // Asking again replays the same code; it never mints a second one.
    const again = await (await fallbackFor(A)).json();
    expect(again.claimCode).toBe(body.claimCode);
    expect(mintedCodes()).toHaveLength(1);
  });

  it('🚨 the same holds when the relay answered 202 (sent, confirmation timed out)', async () => {
    confirmThrows = true;
    const A = payer('A');
    const r = await relayFor(A);
    expect(r.status).toBe(202);
    sweepHome(A, 'A');
    const res = await fallbackFor(A);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  });

  it('the row the relay writes never holds the ephemeral in clear', async () => {
    const A = payer('A');
    expect((await relayFor(A)).status).toBe(200);
    const eph = A.eph.publicKey.toBase58();
    for (const [k, v] of [...values.entries(), ...counters.entries()]) {
      expect(`${k}=${String(v)}`, `row ${k} joins the payment to its deposit key`).not.toContain(eph);
    }
  });
});

describe('F11/F74 · the double-payout refusals still hold once the relay tags its keys', () => {
  it('⛔ the ephemeral kept the float lamports (sent them elsewhere): no note, gate untouched', async () => {
    const A = payer('A');
    expect((await relayFor(A)).status).toBe(200);
    const sink = Keypair.generate().publicKey.toBase58();
    onChain('AWAY'.padEnd(88, '4'), [A.eph.publicKey.toBase58(), sink], [-(REQUIRED - 5_000), REQUIRED - 10_000]);

    const res = await fallbackFor(A);
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.code).toBe('RELAYED_FLOAT_NOT_RETURNED');
    expect(mintedCodes(), 'one payment was paid out twice').toHaveLength(0);
    expect(await kv.get(`p01:note:paid:${A.sig}`)).toBeNull();
  });

  it('⛔ a payer cannot name ANOTHER relay\'s ephemeral, even one that swept its float home', async () => {
    const A = payer('A');
    const B = payer('B');
    expect((await relayFor(A)).status).toBe(200);
    // Leaf L lands (somebody's deposit), so B binds the next one and both
    // relays go through (a reservation reaches one leaf past the tree).
    history.set('1006', { commitment: 1006n, leafIndex: L, depositSlot: 2 });
    const rB = await relay(
      post(
        'relay-to-buyer',
        {
          paymentSignature: B.sig,
          buyerPubkey: B.eph.publicKey.toBase58(),
          requiredLamports: REQUIRED,
          proof: signText(claimText(B.sig), B.wallet),
          contribution: { token: 'SOL', leafIndex: L + 1 },
        },
        true,
      ),
    );
    expect(rB.status, JSON.stringify(await rB.clone().json())).toBe(200);
    sweepHome(A, 'A');
    // B kept its lamports and names A's clean key.
    const res = await claimForPayment(
      post(
        'claim-for-payment',
        {
          signature: B.sig,
          proof: signText(claimText(B.sig), B.wallet),
          contribution: { token: 'SOL', leafIndex: L + 1 },
          ephemeral: A.eph.publicKey.toBase58(),
          ephemeralProof: signText(ephemeralText(B.sig), A.eph),
        },
        false,
      ),
    );
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.code).toBe('RELAYED_EPHEMERAL_UNBOUND');
    expect(mintedCodes()).toHaveLength(0);
  });
});
