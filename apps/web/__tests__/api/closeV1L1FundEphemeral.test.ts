/**
 * close-v1 lane L1 · what `/api/fund-ephemeral` may pay out, and to whom.
 *
 * Run: cd apps/web && npx vitest run __tests__/api/closeV1L1FundEphemeral.test.ts
 *
 * F37 (audit v1, round 2, server axis). The route paid up to 2 SOL per call
 * against the public ticket alone, twelve calls per IP per hour, and its only
 * lamport bound was a module-scope counter that resets on every cold start.
 * Measured by the audit probe `r2-server/probes/p1-fund-ephemeral.probe.test.ts`:
 * 24 SOL per IP per hour, unbounded across instances. What these cases require:
 *   - a per-IP LAMPORT budget per hour, not a grant count, sized to the jobs
 *     that really ask this route: a direct withdrawal and a subscribe (a
 *     shield carries value and goes through the relay; see the last block);
 *   - a GLOBAL hourly lamport budget held in KV, so a fresh instance or a
 *     fresh IP does not reset it;
 *   - no second grant to a key whose earlier grant never came back;
 *   - fail closed when the store cannot be read.
 *
 * F62 (round 3). The route could pay the float into the till, which inflates
 * the settlement floor (the settler counts the till's balance as purchases).
 * The route knows every operator address it is configured with and refuses
 * each of them as a target.
 *
 * Real route, real store limiter (`rateLimitExceeded` over an in-memory KV),
 * only the chain is faked. The transfer itself is stubbed like
 * `fundEphemeralChainErrors.test.ts` does, and the stub records it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

// ── The store: one keyspace, real limiter arithmetic on top ─────────────────
const scal = new Map<string, unknown>();
let kvFails = false;
/** When a number, every `incr` after that many succeeded ones throws. */
let incrFailsAfter: number | null = null;
let incrCalls = 0;
const fakeKv = {
  async get(k: string) {
    if (kvFails) throw new Error('store down');
    return (scal.get(k) ?? null) as never;
  },
  async set(k: string, v: unknown) {
    if (kvFails) throw new Error('store down');
    scal.set(k, v);
  },
  async del(k: string) {
    scal.delete(k);
  },
  async incr(k: string) {
    if (kvFails) throw new Error('store down');
    incrCalls += 1;
    if (incrFailsAfter !== null && incrCalls > incrFailsAfter) throw new Error('store down');
    const n = Number(scal.get(k) ?? 0) + 1;
    scal.set(k, n);
    return n;
  },
  async expire() {},
  async sadd() {},
  async srem() {},
  async scard() {
    return 0;
  },
  async smembers() {
    return [];
  },
  async mget(keys: string[]) {
    return keys.map(() => null);
  },
};
vi.mock('@/lib/waitlist/store', async (orig) => ({
  ...(await orig<typeof import('@/lib/waitlist/store')>()),
  getStore: () => fakeKv,
}));

// ── The chain ───────────────────────────────────────────────────────────────
interface FakeTx {
  keys: string[];
  signers: number;
  pre: number[];
  post: number[];
}
const balances = new Map<string, number>();
/** Newest-first signatures per address. */
const histories = new Map<string, string[]>();
const txs = new Map<string, FakeTx>();
const grants: { to: string; lamports: number }[] = [];
let funderKey = '';

function land(sig: string, tx: FakeTx) {
  txs.set(sig, tx);
  tx.keys.forEach((k, i) => {
    balances.set(k, (balances.get(k) ?? 0) + (tx.post[i] - tx.pre[i]));
    histories.set(k, [sig, ...(histories.get(k) ?? [])]);
  });
}
function transfer(sig: string, from: string, to: string, lamports: number) {
  const a = balances.get(from) ?? 0;
  const b = balances.get(to) ?? 0;
  land(sig, { keys: [from, to], signers: 1, pre: [a, b], post: [a - lamports - 5000, b + lamports] });
}

vi.mock('@/lib/privacy/pool/sendTx', () => ({
  sendWithFreshBlockhash: async (_c: unknown, tx: { ixs: { to: string; lamports: number }[] }) => {
    const ix = tx.ixs[0];
    grants.push(ix);
    const sig = `GRANT${grants.length}`;
    transfer(sig, funderKey, ix.to, ix.lamports);
    return { signature: sig, blockhash: 'BH', lastValidBlockHeight: 1 };
  },
}));

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  class FakeTransaction {
    ixs: { to: string; lamports: number }[] = [];
    add(ix: { to: string; lamports: number }) {
      this.ixs.push(ix);
      return this;
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
        return DEVNET;
      }
      async getBalance(k: { toBase58(): string }) {
        return balances.get(k.toBase58()) ?? 0;
      }
      async getSignaturesForAddress(k: { toBase58(): string }, o?: { limit?: number }) {
        return (histories.get(k.toBase58()) ?? [])
          .slice(0, o?.limit ?? 1000)
          .map((signature) => ({ signature, err: null, blockTime: 1 }));
      }
      async getTransaction(sig: string) {
        const t = txs.get(sig);
        if (!t) return null;
        return {
          meta: { err: null, preBalances: t.pre, postBalances: t.post },
          transaction: {
            message: {
              header: { numRequiredSignatures: t.signers },
              getAccountKeys: () => ({
                staticAccountKeys: t.keys.map((k) => new actual.PublicKey(k)),
              }),
            },
          },
        };
      }
      async confirmTransaction() {
        return { value: { err: null } };
      }
      async getSignatureStatuses() {
        return { value: [null] };
      }
    },
  };
});

const TICKET = 'public-ticket-from-the-bundle';
const funder = Keypair.generate();
const TILL = Keypair.generate().publicKey.toBase58();
const FEE = Keypair.generate().publicKey.toBase58();
const RESTOCK = Keypair.generate().publicKey.toBase58();

function post(route: { POST: (r: NextRequest) => Promise<Response> }, ip: string, to: string, lamports: number) {
  return route.POST(
    new NextRequest('http://localhost/api/fund-ephemeral', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-p01-funder-ticket': TICKET, 'x-real-ip': ip },
      body: JSON.stringify({ ephemeralPubkey: to, lamports }),
    } as never),
  );
}
const fresh = () => Keypair.generate().publicKey.toBase58();
const sum = (xs: { lamports: number }[]) => xs.reduce((a, g) => a + g.lamports, 0);

async function freshRoute() {
  vi.resetModules();
  return (await import('@/app/api/fund-ephemeral/route')) as unknown as {
    POST: (r: NextRequest) => Promise<Response>;
  };
}

beforeEach(() => {
  scal.clear();
  balances.clear();
  histories.clear();
  txs.clear();
  grants.length = 0;
  kvFails = false;
  incrFailsAfter = null;
  incrCalls = 0;
  funderKey = funder.publicKey.toBase58();
  balances.set(funderKey, 500_000_000_000);
  vi.unstubAllEnvs();
  vi.stubEnv('P01_FUNDER_SECRET_KEY', bs58.encode(funder.secretKey));
  vi.stubEnv('P01_FUNDER_TICKET', TICKET);
  vi.stubEnv('P01_TILL_ADDRESS', TILL);
  vi.stubEnv('P01_FEE_WALLET', FEE);
  vi.stubEnv('P01_FUNDER_RPC', 'http://fake-rpc.invalid');
});

describe('F37 · the float pays a bounded lamport budget per IP per hour, not twelve capped grants', () => {
  it('control: a grant of 1,573,486,080 lamports (the largest pre-fund measured, the one of a relayed shield) is served', async () => {
    const route = await freshRoute();
    const res = await post(route, '203.0.113.7', fresh(), 1_573_486_080);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(grants).toHaveLength(1);
  });

  it('control: that size and then a subscribe-sized grant from one IP in the same hour are both served', async () => {
    const route = await freshRoute();
    expect((await post(route, '203.0.113.7', fresh(), 1_573_486_080)).status).toBe(200);
    expect((await post(route, '203.0.113.7', fresh(), 1_035_725_040)).status).toBe(200);
  });

  it('the audit probe: 13 capped calls from one IP to fresh keys pay at most the per-IP budget', async () => {
    const route = await freshRoute();
    const statuses: number[] = [];
    for (let i = 0; i < 13; i += 1) {
      statuses.push((await post(route, '203.0.113.7', fresh(), 2_000_000_000)).status);
    }
    // At HEAD: twelve 200s, 24 SOL out of the float.
    expect(sum(grants), `statuses ${statuses.join(',')}`).toBeLessThanOrEqual(3_000_000_000);
    expect(statuses).toContain(429);
  });

  it('the per-IP budget is durable: a fresh instance does not reset it', async () => {
    let route = await freshRoute();
    await post(route, '203.0.113.7', fresh(), 2_000_000_000);
    route = await freshRoute();
    await post(route, '203.0.113.7', fresh(), 2_000_000_000);
    route = await freshRoute();
    const third = await post(route, '203.0.113.7', fresh(), 2_000_000_000);
    expect(third.status).toBe(429);
    expect(sum(grants)).toBeLessThanOrEqual(3_000_000_000);
  });

  it('a GLOBAL hourly budget bounds many IPs across many instances', async () => {
    for (let ip = 1; ip <= 12; ip += 1) {
      const route = await freshRoute();
      await post(route, `198.51.100.${ip}`, fresh(), 2_000_000_000);
    }
    // Twelve IPs at one capped grant each: 24 SOL at HEAD, whatever the
    // instance ceiling says, because each instance starts at zero.
    expect(sum(grants)).toBeLessThanOrEqual(10_000_000_000);
  });

  it('the global budget is configurable, and never switched off by a malformed value', async () => {
    vi.stubEnv('P01_FUNDER_GLOBAL_LAMPORTS_PER_HOUR', '0');
    for (let ip = 1; ip <= 12; ip += 1) {
      const route = await freshRoute();
      await post(route, `198.51.100.${ip}`, fresh(), 2_000_000_000);
    }
    expect(sum(grants)).toBeLessThanOrEqual(10_000_000_000);
    expect(sum(grants)).toBeGreaterThan(0);
  });

  it('refuses a second grant to a key whose first grant left without coming back', async () => {
    const route = await freshRoute();
    const eph = fresh();
    const attacker = fresh();
    expect((await post(route, '203.0.113.7', eph, 1_000_000_000)).status).toBe(200);
    // The key forwards the float's lamports elsewhere and is empty again, so
    // the empty-target rule alone would fund it once more.
    transfer('DRAIN', eph, attacker, (balances.get(eph) ?? 0) - 5000);
    expect(balances.get(eph)).toBe(0);
    const again = await post(route, '198.51.100.99', eph, 1_000_000_000);
    const body = await again.json();
    expect(again.status, JSON.stringify(body)).toBe(409);
    expect(grants).toHaveLength(1);
  });

  it('control: a key whose grant was swept back to the float can be funded again (a retry after Recover)', async () => {
    const route = await freshRoute();
    const eph = fresh();
    expect((await post(route, '203.0.113.7', eph, 1_000_000_000)).status).toBe(200);
    transfer('SWEEP', eph, funderKey, (balances.get(eph) ?? 0) - 5000);
    const again = await post(route, '203.0.113.7', eph, 1_000_000_000);
    expect(again.status, JSON.stringify(await again.clone().json())).toBe(200);
  });

  it('fails closed when the store cannot be read', async () => {
    const route = await freshRoute();
    kvFails = true;
    const res = await post(route, '203.0.113.7', fresh(), 1_000_000_000);
    expect(res.status).toBe(503);
    expect(grants).toHaveLength(0);
  });
});

describe('F62 · the float never pays an operator address', () => {
  it('refuses the till', async () => {
    const route = await freshRoute();
    const res = await post(route, '203.0.113.7', TILL, 2_000_000_000);
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(grants).toHaveLength(0);
  });

  it('refuses the restock wallet when one is configured', async () => {
    vi.stubEnv('P01_RESTOCK_WALLET_ADDRESS', RESTOCK);
    const route = await freshRoute();
    const res = await post(route, '203.0.113.7', RESTOCK, 1_000_000_000);
    expect(res.status).toBe(400);
    expect(grants).toHaveLength(0);
  });

  it('still refuses the fee wallet and the float itself (controls)', async () => {
    const route = await freshRoute();
    expect((await post(route, '203.0.113.7', FEE, 1_000_000)).status).toBe(400);
    expect((await post(route, '203.0.113.7', funderKey, 1_000_000)).status).toBe(400);
    expect(grants).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// close-v1 verify round 1. The per-IP budget is sized against the jobs that
// really ask this route: a shield carries value, so it goes through the relay
// and never asks here (`ephemeralFunder.ts`, `valueLamports > 0`). The jobs
// that ask are the DIRECT WITHDRAWAL (`unshieldFromPool`, valueLamports 0,
// neverExposeWallet; fixtures 1,030,290,360 and 1,400,000,000) and the
// SUBSCRIBE (1,035,725,040). In 0.25 SOL units: 5, 6 and 5.
// ---------------------------------------------------------------------------
const WITHDRAW_MEASURED = 1_030_290_360;
const WITHDRAW_HEAVY = 1_400_000_000;
const SUBSCRIBE = 1_035_725_040;

describe('F37 · the per-IP budget, measured against the jobs that ask for a grant', () => {
  it('control: the heaviest withdrawal and then a subscribe from one IP in one hour are both served (11 of 12 units)', async () => {
    const route = await freshRoute();
    expect((await post(route, '203.0.113.7', fresh(), WITHDRAW_HEAVY)).status).toBe(200);
    expect((await post(route, '203.0.113.7', fresh(), SUBSCRIBE)).status).toBe(200);
  });

  it('the stated limit: two withdrawals and a subscribe in one clock hour is 15 units, and the third job is refused', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-09-23T10:05:00Z'));
      const route = await freshRoute();
      expect((await post(route, '203.0.113.7', fresh(), WITHDRAW_MEASURED)).status).toBe(200);
      expect((await post(route, '203.0.113.7', fresh(), WITHDRAW_MEASURED)).status).toBe(200);
      const third = await post(route, '203.0.113.7', fresh(), SUBSCRIBE);
      expect(third.status).toBe(429);
      expect((await third.json()).code).toBe('FUNDER_IP_BUDGET');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the stated limit: the bucket is a UTC clock hour, so one caller gets two budgets across a :00 boundary', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-09-23T10:59:00Z'));
      const route = await freshRoute();
      for (let i = 0; i < 2; i += 1) await post(route, '203.0.113.7', fresh(), WITHDRAW_HEAVY);
      vi.setSystemTime(Date.parse('2026-09-23T11:00:30Z'));
      for (let i = 0; i < 2; i += 1) await post(route, '203.0.113.7', fresh(), WITHDRAW_HEAVY);
      // 2 x 1.4 SOL is 6 + 6 = 12 units, the whole budget of each hour: four
      // grants, 5.6 SOL, within ninety seconds, from one IP.
      expect(sum(grants)).toBe(4 * WITHDRAW_HEAVY);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the stated limit: once many IPs exhaust the global budget, an honest withdrawal is refused for the rest of the hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-09-23T10:05:00Z'));
      for (let ip = 1; ip <= 5; ip += 1) {
        const route = await freshRoute();
        await post(route, `198.51.100.${ip}`, fresh(), 2_000_000_000);
      }
      expect(sum(grants)).toBe(10_000_000_000);
      const route = await freshRoute();
      const honest = await post(route, '203.0.113.200', fresh(), WITHDRAW_MEASURED);
      expect(honest.status).toBe(429);
      expect((await honest.json()).code).toBe('FUNDER_GLOBAL_BUDGET');
    } finally {
      vi.useRealTimers();
    }
  });

  it('(2) fails closed when the LAMPORT budget cannot be taken, after the grant limiter passed', async () => {
    const route = await freshRoute();
    incrFailsAfter = 1; // the grant limiter's one `incr` succeeds; the budget's throw
    const res = await post(route, '203.0.113.7', fresh(), 1_000_000_000);
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(503);
    expect(body.error).toBe('the rate limiter could not be read');
    expect(grants).toHaveLength(0);
  });

  it('(3) a key with more history than one page is refused as unknown, never assumed fresh', async () => {
    const route = await freshRoute();
    const eph = fresh();
    const stranger = fresh();
    balances.set(stranger, 1_000_000_000);
    // 25 transactions that list the key and move it nothing: no grant in the
    // page read, and the page is full, so what lies behind it is unknown.
    for (let i = 0; i < 25; i += 1) {
      land(`NOISE${i}`, { keys: [stranger, eph], signers: 1, pre: [1_000_000_000, 0], post: [1_000_000_000, 0] });
    }
    const res = await post(route, '203.0.113.7', eph, 1_000_000_000);
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.code).toBe('FUNDER_UNSWEPT_GRANT');
    expect(grants).toHaveLength(0);
  });

  it('control: 24 such transactions are a complete page with no grant in it, and the key is funded', async () => {
    const route = await freshRoute();
    const eph = fresh();
    const stranger = fresh();
    for (let i = 0; i < 24; i += 1) {
      land(`NOISE${i}`, { keys: [stranger, eph], signers: 1, pre: [1_000_000_000, 0], post: [1_000_000_000, 0] });
    }
    const res = await post(route, '203.0.113.7', eph, 1_000_000_000);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  });
});
