/**
 * close-v1 lane L1 · who owns a contributed leaf, and who may hold the edge.
 *
 * Run: cd apps/web && npx vitest run __tests__/api/closeV1L1LeafHold.test.ts
 *
 * The REAL relay-to-buyer, contribute-note and claim-for-payment routes over
 * one in-memory store; only the Connection, the store and the pool history are
 * faked. Unlike `relayLeafBinding.test.ts`, the fake chain here keeps
 * balances: the relay's transfer credits the ephemeral it funded, and a key
 * that swept is empty again. That is the fact the F72 fix reads.
 *
 * F72 (audit v1, round 4, HIGH). A stranger bound to the same leaf took the
 * claim of a contribution whose deposit landed more than 20 minutes after its
 * relay: the hold went stale on a clock, the stranger's relay evicted the
 * victim's binding, and the victim's deposit (the treasury's commitment, the
 * same whoever deposits it) then confirmed for the stranger. Audit probe:
 * `r4-verify1/probe-residual.test.ts` R1. Also R2: the relay bound a leaf ten
 * past the tree although reserve hands out only the next index.
 *
 * F73 (round 4). A free reservation every 20 minutes refused every
 * contribution: reserve is ticket-gated only, and the ticket is in the bundle.
 *
 * F63, contribute-note half (round 3). A store write that failed after the
 * payment gate was taken left the gate taken and no code behind it: the next
 * confirm answered "already redeemed" for ever. Audit probe shape:
 * `r3-server/p4/probe-claim-store-blip.mts`.
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
/** A key whose next `set` throws once, as a store blip. */
let failSetOnce: ((k: string) => boolean) | null = null;
/** A key whose next `incr` throws once, as a store blip. */
let failIncrOnce: ((k: string) => boolean) | null = null;
/**
 * A barrier on one key's `get`: the first reader is parked until a second
 * reader of the same key arrives, so two requests are known to have read the
 * same (absent) value before either writes. Used for the hold-lock race.
 */
let getBarrier: { key: string; arrived: number; release: (() => void) | null } | null = null;
const kv = {
  incr: async (k: string) => {
    if (failIncrOnce?.(k)) {
      failIncrOnce = null;
      throw new Error('ERR transient, command was: [["incr","' + k + '"]]');
    }
    const n = Number(values.get(k) ?? counters.get(k) ?? 0) + 1;
    values.delete(k);
    counters.set(k, n);
    return n;
  },
  get: async (k: string) => {
    const b = getBarrier;
    if (b && k === b.key) {
      b.arrived += 1;
      if (b.arrived === 1) await new Promise<void>((r) => (b.release = r));
      else if (b.arrived === 2) b.release?.();
    }
    return values.has(k) ? values.get(k) : counters.get(k) ?? null;
  },
  set: async (k: string, v: unknown) => {
    if (failSetOnce?.(k)) {
      failSetOnce = null;
      throw new Error('ERR transient, command was: [["set","' + k + '"]]');
    }
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
const balances = new Map<string, number>();
/** Keys whose balance the RPC cannot read (the call throws). */
const unreadableBalances = new Set<string>();

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
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
      async getBalance(k: { toBase58(): string }) {
        if (unreadableBalances.has(k.toBase58())) throw new Error('429 Too Many Requests');
        return balances.get(k.toBase58()) ?? 0;
      }
      async getLatestBlockhash() {
        return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 };
      }
      async sendRawTransaction(raw: Uint8Array) {
        const ix = JSON.parse(new TextDecoder().decode(raw)) as { to: string; lamports: number };
        relaySends.push({ to: ix.to, lamports: ix.lamports });
        balances.set(ix.to, (balances.get(ix.to) ?? 0) + ix.lamports);
        return `RELAYSIG${relaySends.length}`;
      }
      async confirmTransaction() {
        return { value: { err: null } };
      }
    },
  };
});

type Tree = Map<string, { commitment: bigint; leafIndex: number; depositSlot: number }>;
let history: Tree = new Map();
/** When set, the FIRST history read of a request returns this instead (a read that lags). */
let laggingOnce: Tree | null = null;
vi.mock('@/lib/privacy/pool/denominatedPool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/privacy/pool/denominatedPool')>()),
  fetchPoolCommitments: async () => {
    if (laggingOnce) {
      const t = laggingOnce;
      laggingOnce = null;
      return t;
    }
    return history;
  },
}));

import { getPoolsForTokenV3 } from '@/lib/privacy/pool/denominatedPool';
import { treasuryCommitmentFor, POST as contribute } from '@/app/api/contribute-note/route';
import { POST as relay } from '@/app/api/relay-to-buyer/route';
import { claimChallenge } from '@/lib/privacy/claimChallenge';
import { leafHoldKey, notePaidCodeKey, relayPaymentContributionKey } from '@/lib/privacy/paymentBinding';

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
const T0 = Date.parse('2026-09-23T10:00:00Z');
const MIN = 60_000;

function post(url: string, body: unknown, ip: string) {
  return new NextRequest(`http://localhost/api/${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-p01-funder-ticket': TICKET, 'x-real-ip': ip },
    body: JSON.stringify(body),
  } as never);
}
const proof = (kp: Keypair, sig: string) =>
  Buffer.from(
    nacl.sign.detached(new Uint8Array(Buffer.from(claimChallenge(sig), 'utf8')), new Uint8Array(kp.secretKey)),
  ).toString('base64');

function treeUpTo(highest: number, landed: number[] = []): Tree {
  const m: Tree = new Map();
  for (let i = 0; i <= highest; i += 1) {
    m.set(String(1000n + BigInt(i)), { commitment: 1000n + BigInt(i), leafIndex: i, depositSlot: 1 });
  }
  for (const leafIndex of landed) {
    const commitment = treasuryCommitmentFor(SEED, POOL.poolPDA, POOL.tokenMint, leafIndex);
    m.set(commitment.toString(), { commitment, leafIndex, depositSlot: 1 });
  }
  return m;
}

function payer(tag: string) {
  const wallet = Keypair.generate();
  const eph = Keypair.generate();
  const sig = `PAY_${tag}_`.padEnd(88, String((tag.charCodeAt(0) % 9) + 1));
  txs.set(sig, {
    keys: [wallet.publicKey.toBase58(), TILL, FEE],
    pre: [10_000_000_000, 0, 0],
    post: [10_000_000_000 - DENOM - FEE_LAMPORTS - 5000, DENOM, FEE_LAMPORTS],
  });
  return { wallet, eph, sig };
}
type Payer = ReturnType<typeof payer>;

const relayFor = (p: Payer, leafIndex: number, ip: string) =>
  relay(
    post(
      'relay-to-buyer',
      {
        paymentSignature: p.sig,
        buyerPubkey: p.eph.publicKey.toBase58(),
        requiredLamports: DENOM,
        proof: proof(p.wallet, p.sig),
        contribution: { token: 'SOL', leafIndex },
      },
      ip,
    ),
  );
const confirmFor = (p: Payer, leafIndex: number, ip: string) =>
  contribute(
    post('contribute-note', { action: 'confirm', leafIndex, paymentSignature: p.sig, proof: proof(p.wallet, p.sig) }, ip),
  );
const reserveFrom = (ip: string) => contribute(post('contribute-note', { action: 'reserve' }, ip));
const at = (minutes: number) => vi.setSystemTime(T0 + minutes * MIN);
const sentTo = (p: Payer) => relaySends.filter((s) => s.to === p.eph.publicKey.toBase58()).length;
/** The ephemeral deposits its note and sweeps the residue: the key is empty. */
const spent = (p: Payer) => balances.set(p.eph.publicKey.toBase58(), 0);

beforeEach(() => {
  counters.clear();
  values.clear();
  sets.clear();
  txs.clear();
  balances.clear();
  relaySends.length = 0;
  failSetOnce = null;
  failIncrOnce = null;
  getBarrier = null;
  unreadableBalances.clear();
  laggingOnce = null;
  history = treeUpTo(5);
  vi.useFakeTimers({ toFake: ['Date'] });
  at(0);
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

describe('F72 · a hold lasts until its leaf is decided, not for 20 minutes', () => {
  it('a victim whose deposit lands 21 minutes after its relay keeps its leaf, and collects', async () => {
    const V = payer('V');
    const A = payer('A');
    expect((await relayFor(V, L, '198.51.100.7')).status).toBe(200);
    expect(sentTo(V)).toBe(1);

    // The victim is still proving: its key holds what the relay sent.
    at(21);
    const rA = await relayFor(A, L, '203.0.113.66');
    const bodyA = await rA.json();
    expect(rA.status, JSON.stringify(bodyA)).toBe(409);
    expect(sentTo(A)).toBe(0);
    expect(await kv.get(relayPaymentContributionKey(V.sig))).toBe(`${POOL_KEY}:${L}`);

    // The victim's deposit lands.
    history = treeUpTo(5, [L]);
    spent(V);
    const cA = await confirmFor(A, L, '203.0.113.66');
    expect(cA.status).toBe(400);
    const cV = await confirmFor(V, L, '198.51.100.7');
    const cVBody = await cV.json();
    expect(cV.status, JSON.stringify(cVBody)).toBe(200);
    expect(typeof cVBody.claimCode).toBe('string');
  });

  it('control: a holder whose key is empty and whose leaf never landed is taken over', async () => {
    const V = payer('V');
    const B = payer('B');
    expect((await relayFor(V, L, '198.51.100.7')).status).toBe(200);
    spent(V); // Recover swept it, or it was emptied: it cannot deposit any more.
    at(21);
    const rB = await relayFor(B, L, '203.0.113.66');
    expect(rB.status, JSON.stringify(await rB.clone().json())).toBe(200);
    expect(await kv.get(relayPaymentContributionKey(V.sig))).toBeNull();
  });

  it('a holder that deposited and swept is not evicted by a relay whose first tree read lags', async () => {
    const V = payer('V');
    const A = payer('A');
    expect((await relayFor(V, L, '198.51.100.7')).status).toBe(200);
    at(25);
    // The deposit landed and the residue went home; the first read of the
    // tree in A's request has not caught up.
    history = treeUpTo(5, [L]);
    spent(V);
    laggingOnce = treeUpTo(5);
    const rA = await relayFor(A, L, '203.0.113.66');
    expect(rA.status, JSON.stringify(await rA.clone().json())).toBe(409);
    expect(sentTo(A)).toBe(0);
    expect(await kv.get(relayPaymentContributionKey(V.sig))).toBe(`${POOL_KEY}:${L}`);
  });

  it('R2: the relay binds only the index reserve hands out, the tree\'s next one', async () => {
    const A = payer('A');
    const far = await relayFor(A, L + 10, '203.0.113.66');
    expect(far.status).toBe(409);
    const next = await relayFor(A, L + 1, '203.0.113.66');
    expect(next.status).toBe(409);
    expect(sentTo(A)).toBe(0);
    expect((await relayFor(A, L, '203.0.113.66')).status).toBe(200);
  });
});

describe('F73 · a free reservation cannot hold the pool shut', () => {
  it('control: while nobody abuses it, a live free reservation still answers the honest 409', async () => {
    expect((await (await reserveFrom('203.0.113.1')).json()).leafIndex).toBe(L);
    at(1);
    const res = await reserveFrom('198.51.100.2');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/another contribution is in progress/);
  });

  it('after repeated free reservations that died unpaid, a free one stops being exclusive', async () => {
    // Somebody reserves for free every 21 minutes and never pays.
    for (const m of [0, 21, 42, 63]) {
      at(m);
      const r = await reserveFrom('203.0.113.1');
      expect(r.status, `t+${m}`).toBe(200);
    }
    // One minute after the latest free reservation, an honest buyer arrives.
    at(64);
    const res = await reserveFrom('198.51.100.2');
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.leafIndex).toBe(L);
  });

  it('a paid hold whose deposit may still land keeps the edge past 20 minutes: reserve says busy, before anyone pays', async () => {
    const V = payer('V');
    expect((await (await reserveFrom('198.51.100.7')).json()).leafIndex).toBe(L);
    expect((await relayFor(V, L, '198.51.100.7')).status).toBe(200);
    at(21);
    const res = await reserveFrom('198.51.100.8');
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.leafIndex).toBeUndefined();
  });
});

describe('F63 · a store blip after the payment gate does not refuse the purchase for ever', () => {
  it('a failed write of the code gives the gate back, and the retry mints', async () => {
    const V = payer('V');
    expect((await relayFor(V, L, '198.51.100.7')).status).toBe(200);
    history = treeUpTo(5, [L]);
    failSetOnce = (k) => k === notePaidCodeKey(V.sig);
    const first = await confirmFor(V, L, '198.51.100.7');
    const firstBody = await first.json();
    expect(first.status).toBe(503);
    expect(JSON.stringify(firstBody), 'the refusal echoed the store command').not.toMatch(/command was/);
    const again = await confirmFor(V, L, '198.51.100.7');
    const body = await again.json();
    expect(again.status, JSON.stringify(body)).toBe(200);
    expect(typeof body.claimCode).toBe('string');
  });

  it('a failed write of the minted marker gives the gate back too', async () => {
    const V = payer('V');
    expect((await relayFor(V, L, '198.51.100.7')).status).toBe(200);
    history = treeUpTo(5, [L]);
    failSetOnce = (k) => k.startsWith('p01:note:claim-minted:');
    expect((await confirmFor(V, L, '198.51.100.7')).status).toBe(503);
    const again = await confirmFor(V, L, '198.51.100.7');
    const body = await again.json();
    expect(again.status, JSON.stringify(body)).toBe(200);
    // The code handed back must be one `issue-note` will redeem: it tests the
    // minted marker, and a code without one is refused there.
    expect(
      await kv.get(`p01:note:claim-minted:${body.claimCode}`),
      'the retry handed back a code that was never marked minted',
    ).toBe(`payment:${V.sig}`);
  });
});

// ---------------------------------------------------------------------------
// close-v1 verify round 1: the ceiling on a paid hold, and the guards the
// report claims that no test pinned (each case below turns red under the
// matching revert mutant in close-v1/L1-server-money-verify-r1/mut/*.json).
// ---------------------------------------------------------------------------

const HOUR = 60 * MIN;

describe('F72/F73 · a paid hold has a hard ceiling (P01_LEAF_HOLD_MAX_MS, default 3 h)', () => {
  it('a payer that keeps lamports on its key and never deposits holds the edge no longer than the ceiling', async () => {
    const V = payer('V');
    expect((await (await reserveFrom('198.51.100.7')).json()).leafIndex).toBe(L);
    expect((await relayFor(V, L, '198.51.100.7')).status).toBe(200);
    // V never deposits and never empties its key.
    at(179);
    expect((await reserveFrom('198.51.100.8')).status, 'inside the ceiling the hold is live').toBe(409);
    at(181);
    const res = await reserveFrom('198.51.100.8');
    const body = await res.json();
    expect(res.status, 'a funded key that never deposited held the edge past the ceiling: ' + JSON.stringify(body)).toBe(200);
    expect(body.leafIndex).toBe(L);
    const B = payer('B');
    const rB = await relayFor(B, L, '198.51.100.8');
    expect(rB.status, JSON.stringify(await rB.clone().json())).toBe(200);
    expect(sentTo(B)).toBe(1);
    expect(await kv.get(relayPaymentContributionKey(V.sig)), "the evicted holder's binding").toBeNull();
  });

  it('past the ceiling, a holder whose deposit landed is still never evicted (the second tree read)', async () => {
    const V = payer('V');
    expect((await relayFor(V, L, '198.51.100.7')).status).toBe(200);
    at(200);
    history = treeUpTo(5, [L]);
    spent(V);
    laggingOnce = treeUpTo(5);
    const B = payer('B');
    const rB = await relayFor(B, L, '203.0.113.66');
    expect(rB.status, JSON.stringify(await rB.clone().json())).toBe(409);
    expect(sentTo(B)).toBe(0);
    expect(await kv.get(relayPaymentContributionKey(V.sig))).toBe(`${POOL_KEY}:${L}`);
  });

  it('the operator may set the ceiling, e.g. one hour', async () => {
    vi.stubEnv('P01_LEAF_HOLD_MAX_MS', String(HOUR));
    const V = payer('V');
    expect((await relayFor(V, L, '198.51.100.7')).status).toBe(200);
    at(59);
    expect((await relayFor(payer('A'), L, '203.0.113.66')).status).toBe(409);
    at(61);
    const B = payer('B');
    expect((await relayFor(B, L, '203.0.113.67')).status).toBe(200);
  });

  it('a malformed or zero ceiling is the default, never "no ceiling" and never "no hold"', async () => {
    vi.stubEnv('P01_LEAF_HOLD_MAX_MS', '0');
    const V = payer('V');
    expect((await relayFor(V, L, '198.51.100.7')).status).toBe(200);
    at(21);
    expect((await relayFor(payer('A'), L, '203.0.113.66')).status, '0 must not end the hold at 20 min').toBe(409);
    at(181);
    expect((await relayFor(payer('B'), L, '203.0.113.67')).status, '0 must not remove the ceiling').toBe(200);
  });

  it('a ceiling set above 24 h is held at 24 h: the stall stays bounded', async () => {
    vi.stubEnv('P01_LEAF_HOLD_MAX_MS', String(1000 * HOUR));
    const V = payer('V');
    expect((await relayFor(V, L, '198.51.100.7')).status).toBe(200);
    at(24 * 60 - 1);
    expect((await relayFor(payer('A'), L, '203.0.113.66')).status).toBe(409);
    at(24 * 60 + 1);
    expect((await relayFor(payer('B'), L, '203.0.113.67')).status).toBe(200);
  });
});

describe('pins for guards the report claims (verify round 1 revert mutants)', () => {
  it('(1) inside the ceiling, a holder whose balance cannot be read is LIVE: no takeover on an unknown', async () => {
    const V = payer('V');
    expect((await relayFor(V, L, '198.51.100.7')).status).toBe(200);
    at(21);
    unreadableBalances.add(V.eph.publicKey.toBase58());
    const A = payer('A');
    const rA = await relayFor(A, L, '203.0.113.66');
    expect(rA.status, JSON.stringify(await rA.clone().json())).toBe(409);
    expect(sentTo(A)).toBe(0);
    expect(await kv.get(relayPaymentContributionKey(V.sig))).toBe(`${POOL_KEY}:${L}`);
    // Reserve reads the same hold the same way.
    expect((await reserveFrom('198.51.100.9')).status).toBe(409);
  });

  it('(6) a failed contrib-confirmed write gives the payment gate back, and the retry mints', async () => {
    const V = payer('V');
    expect((await relayFor(V, L, '198.51.100.7')).status).toBe(200);
    history = treeUpTo(5, [L]);
    failIncrOnce = (k) => k.startsWith('p01:note:contrib-confirmed:');
    const first = await confirmFor(V, L, '198.51.100.7');
    expect(first.status).toBe(503);
    expect(JSON.stringify(await first.json())).not.toMatch(/command was/);
    const again = await confirmFor(V, L, '198.51.100.7');
    const body = await again.json();
    expect(again.status, 'the gate was kept after a failed confirmation write: ' + JSON.stringify(body)).toBe(200);
    expect(typeof body.claimCode).toBe('string');
  });

  // close-v1 verify round 2 (mutant rb-lockincr, `if (lock !== 1)` -> `if
  // (false)`): without the hold lock, two relays that read the same absent or
  // dead hold both forward lamports and both write a binding for the leaf. A
  // stranger fires the moment the victim's till payment shows on chain, and
  // whichever payment confirms first takes the claim: F72 reopened as a race.
  it.each([
    ['no hold yet', false],
    ['a dead hold (empty key, leaf never landed)', true],
  ])('(8) two relays racing for one leaf over %s: exactly one is served and bound', async (_label, deadHolder) => {
    if (deadHolder) {
      const D = payer('D');
      expect((await relayFor(D, L, '198.51.100.5')).status).toBe(200);
      spent(D);
      at(21);
    }
    const A = payer('A');
    const B = payer('B');
    const sendsBefore = relaySends.length;
    // Park the first request right after its hold read until the second has
    // read the same hold: both decide on the same value, as in a real race.
    getBarrier = { key: leafHoldKey(`${POOL_KEY}:${L}`), arrived: 0, release: null };
    const [rA, rB] = await Promise.all([relayFor(A, L, '198.51.100.7'), relayFor(B, L, '203.0.113.66')]);
    getBarrier = null;
    const statuses = [rA.status, rB.status].sort();
    const bodies = JSON.stringify([await rA.clone().json(), await rB.clone().json()]);
    expect(statuses, bodies).toEqual([200, 409]);
    expect(relaySends.length - sendsBefore, 'forwards sent for one leaf').toBe(1);
    const bound = [
      await kv.get(relayPaymentContributionKey(A.sig)),
      await kv.get(relayPaymentContributionKey(B.sig)),
    ].filter((v) => v === `${POOL_KEY}:${L}`);
    expect(bound, 'bindings naming the leaf').toHaveLength(1);
    const loser = rA.status === 409 ? rA : rB;
    expect((await loser.json()).error).toMatch(/another payment is binding that leaf right now/);
  });

  it('(7) reserve treats a paid hold it cannot unseal as live and hands out nothing', async () => {
    values.set(leafHoldKey(`${POOL_KEY}:${L}`), 'v1.bm90LWEtcmVhbC1pdg.bm90LWEtcmVhbC1ib2R5.bm90LWEtdGFn');
    const res = await reserveFrom('198.51.100.9');
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.leafIndex).toBeUndefined();
  });
});
