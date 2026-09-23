/**
 * The settler, end to end against a fake chain.
 *
 * WHY IT LIVES HERE AND NOT IN `__tests__/api`
 * ────────────────────────────────────────────
 * The main suite runs in jsdom with `@solana/web3.js` mocked for component
 * rendering. This route BUILDS AND SIGNS a transaction, and the assertions that
 * matter are about the transaction: who it pays, how much, and who signed it. A
 * mocked web3 cannot answer any of those. So it runs in the pool suite, on the
 * real library, in node — the same reason `liveRelayedShield` does.
 *
 * ⚠️ The confinement test in `topologyInvariants.test.ts` allowlists this file
 * by path. Moving it means updating that list, and the list is deliberately not
 * a glob: a file that can read the till's spending key should be named.
 *
 * Run: cd apps/web && npx vitest run --config vitest.pool.config.mts lib/privacy/pool/settleTillRoute.test.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';

import type { KvLike } from '@/lib/waitlist/store';
import { MIN_PURCHASE_CREDIT_LAMPORTS, ONE_PURCHASE_LAMPORTS } from './settlementPolicy';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

// ── The fake chain ──────────────────────────────────────────────────────────

interface FakeChain {
  genesis: string;
  balances: Map<string, number>;
  /** Newest-first signatures per address, as the RPC returns them. */
  signatures: Map<string, { signature: string; blockTime: number | null; err?: unknown }[]>;
  /**
   * What each till transaction credited the till, by signature. The settler
   * reads the AMOUNT of each till transaction since audit v1 F38 (only a
   * purchase-sized credit resets the quiet period and counts as a purchase),
   * so a chain that lists signatures and cannot serve them no longer answers
   * the question the route asks.
   */
  tillCredits: Map<string, number>;
  /**
   * Who paid a till credit, by signature (audit v1 F62). Unset: a fresh key
   * with no history, which is what an honest buyer's wallet looks like to the
   * float-funding check.
   */
  tillPayers: Map<string, string>;
  /** Any other transaction, served as is (a float grant in a payer's history). */
  txs: Map<string, { keys: string[]; pre: number[]; post: number[] }>;
  /** Every `getSignaturesForAddress` call, to measure what a read costs. */
  sigReads: { address: string; limit?: number }[];
  sent: { tx: Transaction; signers: Keypair[] }[];
  feeForMessage: number | null;
  throwOnGenesis?: boolean;
  throwOnSend?: string;
  /** Called just before `sendTransaction`, to simulate a late arrival. */
  beforeSend?: () => void;
}

let chain: FakeChain;

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    Connection: class {
      async getGenesisHash() {
        if (chain.throwOnGenesis) throw new Error('rpc down');
        return chain.genesis;
      }
      async getBalance(k: { toBase58(): string }) {
        return chain.balances.get(k.toBase58()) ?? 0;
      }
      async getSignaturesForAddress(
        k: { toBase58(): string },
        o?: { limit?: number; before?: string },
      ) {
        chain.sigReads.push({ address: k.toBase58(), limit: o?.limit });
        let list = chain.signatures.get(k.toBase58()) ?? [];
        if (o?.before) {
          const i = list.findIndex((s) => s.signature === o.before);
          list = i < 0 ? [] : list.slice(i + 1);
        }
        return list.slice(0, o?.limit ?? 1000);
      }
      async getTransaction(sig: string) {
        const other = chain.txs.get(sig);
        if (other) {
          return {
            meta: { err: null, preBalances: other.pre, postBalances: other.post },
            transaction: {
              message: {
                getAccountKeys: () => ({
                  staticAccountKeys: other.keys.map((k) => new actual.PublicKey(k)),
                }),
              },
            },
          };
        }
        if (!chain.tillCredits.has(sig)) return null;
        const credit = chain.tillCredits.get(sig)!;
        const named = chain.tillPayers.get(sig);
        const payer = named ? new actual.PublicKey(named) : actual.Keypair.generate().publicKey;
        return {
          meta: { err: null, preBalances: [1e12, 0], postBalances: [1e12 - credit, credit] },
          transaction: {
            message: {
              getAccountKeys: () => ({
                staticAccountKeys: [payer, new actual.PublicKey(process.env.P01_TILL_ADDRESS!)],
              }),
            },
          },
        };
      }
      async getLatestBlockhash() {
        return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1000 };
      }
      async getFeeForMessage() {
        return { value: chain.feeForMessage };
      }
      async sendTransaction(tx: Transaction, signers: Keypair[]) {
        chain.beforeSend?.();
        if (chain.throwOnSend) throw new Error(chain.throwOnSend);
        chain.sent.push({ tx, signers });
        return 'SIGNATURE_' + chain.sent.length;
      }
      async confirmTransaction() {
        return { value: { err: null } };
      }
    },
  };
});

// ── The fake store ──────────────────────────────────────────────────────────

let failExpireOnce: string | null = null;
const ttl = new Map<string, number>();

function memoryKv(): KvLike & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    async get<T>(k: string) {
      return (map.has(k) ? (map.get(k) as T) : null) as T | null;
    },
    async set(k, v) {
      map.set(k, v);
    },
    async del(k) {
      map.delete(k);
    },
    async incr(k) {
      const n = Number(map.get(k) ?? 0) + 1;
      map.set(k, n);
      return n;
    },
    async expire(k, s) {
      // audit v1 F39: a store whose `expire` can fail once, and a record of
      // which keys were given a TTL, so a lock left without one is visible.
      if (failExpireOnce === k) {
        failExpireOnce = null;
        throw new Error('transient store error');
      }
      ttl.set(k, s);
    },
    async sadd() {},
    async srem() {},
    async scard() {
      return 0;
    },
    async smembers() {
      return [];
    },
    async mget() {
      return [];
    },
  };
}

let kv: (KvLike & { map: Map<string, unknown> }) | null;
const mockSendReportEmail = vi.fn(async () => true);

vi.mock('@/lib/waitlist/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/waitlist/store')>();
  return { ...actual, getStore: () => kv };
});

vi.mock('@/lib/waitlist/email', () => ({
  sendReportEmail: (...a: unknown[]) => mockSendReportEmail(...(a as [])),
}));

const { GET } = await import('@/app/api/settle-till/route');
const { NextRequest } = await import('next/server');

// ── Fixtures ────────────────────────────────────────────────────────────────

const CRON_SECRET = 'cron-secret-value';
let till: Keypair;
let float: Keypair;

function req(auth?: string) {
  return new NextRequest('https://example.test/api/settle-till', {
    headers: auth ? { authorization: auth } : {},
  });
}

const cron = () => req(`Bearer ${CRON_SECRET}`);

/**
 * Put the till at k purchases, last credited `agoSeconds` ago.
 *
 * One transaction per purchase, the newest `agoSeconds` old and each earlier
 * one a minute older, because that is what k purchases look like on chain and
 * the settler now counts them one per transaction (audit v1 F38). `extra`
 * rides on the newest credit.
 */
function tillHolds(k: number, agoSeconds: number, extra = 0) {
  chain.balances.set(till.publicKey.toBase58(), k * ONE_PURCHASE_LAMPORTS + extra);
  const now = Math.floor(Date.now() / 1000);
  const sigs = Array.from({ length: Math.max(k, 1) }, (_, i) => ({
    signature: i === 0 ? 'PAYMENT' : `PAYMENT${i}`,
    blockTime: now - agoSeconds - i * 60,
  }));
  chain.signatures.set(till.publicKey.toBase58(), sigs);
  sigs.forEach((s, i) => {
    if (i < k) chain.tillCredits.set(s.signature, ONE_PURCHASE_LAMPORTS + (i === 0 ? extra : 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  till = Keypair.generate();
  float = Keypair.generate();
  chain = {
    genesis: DEVNET_GENESIS,
    balances: new Map([[float.publicKey.toBase58(), 20_000_000_000]]),
    signatures: new Map(),
    tillCredits: new Map(),
    tillPayers: new Map(),
    txs: new Map(),
    sigReads: [],
    sent: [],
    feeForMessage: 5000,
  };
  failExpireOnce = null;
  ttl.clear();
  delete process.env.P01_SETTLE_MAX_DEFERRAL_SECONDS;
  kv = memoryKv();
  process.env.CRON_SECRET = CRON_SECRET;
  delete process.env.P01_SETTLE_TRIGGER_SECRET;
  process.env.P01_TILL_SECRET_KEY = JSON.stringify(Array.from(till.secretKey));
  process.env.P01_FUNDER_SECRET_KEY = JSON.stringify(Array.from(float.secretKey));
  process.env.P01_TILL_ADDRESS = till.publicKey.toBase58();
  process.env.REPORT_EMAIL_TO = 'ops@example.test';
  delete process.env.P01_SETTLE_MIN_PURCHASES;
  delete process.env.P01_SETTLE_MIN_QUIET_SECONDS;
  delete process.env.P01_SETTLE_HOLD_SPREAD_SECONDS;
  delete process.env.P01_FLOAT_ALARM_DEPOSITS;
  delete process.env.P01_FUNDER_RPC;
});

// ── Authorisation and the public view ───────────────────────────────────────

describe('who may make it act', () => {
  it('answers an unauthenticated caller with status and never settles', async () => {
    tillHolds(9, 99999);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verdict).toBe('settle');
    expect(chain.sent).toHaveLength(0);
  });

  /**
   * 🚨 THE ONE FIELD THAT IS GENUINELY SECRET.
   *
   * Balances are public on chain and the policy is public by design. The drawn
   * hold is a FUTURE timestamp, and publishing "the settlement fires at 04:17"
   * hands an observer the exact transaction to watch — which is the whole of
   * what the randomised hold was for. Leaking it would make the jitter
   * decorative.
   */
  it('never publishes the drawn hold to an unauthenticated caller', async () => {
    tillHolds(9, 99999);
    await GET(cron()); // draws and stores a hold
    expect(kv!.map.get('p01:settle:hold-until')).toBeTypeOf('number');

    const body = await (await GET(req())).json();
    expect(body).not.toHaveProperty('holdUntilSeconds');
    expect(JSON.stringify(body)).not.toContain(String(kv!.map.get('p01:settle:hold-until')));
    // [sweep 2 round 1] The digits were never the only spelling. `decideSettlement`
    // writes the hold into `reason` as an ISO instant, so the two lines above
    // passed while the value was public. Hold the body to the instant too.
    const hold = kv!.map.get('p01:settle:hold-until') as number;
    expect(body.verdict).toBe('holding-off');
    expect(JSON.stringify(body)).not.toContain(new Date(hold * 1000).toISOString());
  });

  /**
   * [sweep 2 round 1, server lens] A list of spellings is dodged by one more
   * spelling, so this case does not list any. Two worlds, one frozen clock, and
   * the ONLY thing that differs between them is the stored hold. Whatever the
   * anonymous body is made of, it has to come out the same in both — a body the
   * hold can move is a body the hold can be read from.
   *
   * The determinism leg (`base` twice) is what keeps it honest: if something
   * unfrozen moved the body on its own, every comparison here would differ for
   * that reason and prove nothing about the hold.
   */
  describe('the anonymous view, measured against the hold', () => {
    const NOW_MS = Date.UTC(2026, 8, 20, 9, 0, 0);
    const NOW_S = NOW_MS / 1000;

    async function anonymousBodyWithHold(holdUntil: number): Promise<string> {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
      try {
        tillHolds(9, 30 * 86400);
        kv!.map.set('p01:settle:hold-until', holdUntil);
        const res = await GET(req());
        expect(res.status).toBe(200);
        return JSON.stringify(await res.json());
      } finally {
        clock.mockRestore();
      }
    }

    it('is byte-identical whatever hold is stored, while a hold is running', async () => {
      const base = await anonymousBodyWithHold(NOW_S + 1 * 3600 + 17);
      const again = await anonymousBodyWithHold(NOW_S + 1 * 3600 + 17);
      const other = await anonymousBodyWithHold(NOW_S + 5 * 3600 + 43 * 60 + 9);
      expect(again, 'the same world twice differs: something is not frozen').toBe(base);
      // Anti-vacuity: both worlds really are holding, and say so.
      expect(JSON.parse(base).verdict).toBe('holding-off');
      expect(JSON.parse(other).verdict).toBe('holding-off');
      expect(other, 'the stored hold moves the anonymous body').toBe(base);
    });

    it('carries no instant at all while holding, and still says a hold is running', async () => {
      const body = await anonymousBodyWithHold(NOW_S + 4 * 3600 + 17 * 60);
      expect(JSON.parse(body).verdict).toBe('holding-off');
      expect(JSON.parse(body).reason).toBeTypeOf('string');
      expect(JSON.parse(body).reason.length).toBeGreaterThan(0);
      expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(body).not.toMatch(/\b\d{1,2}:\d{2}(:\d{2})?\b/);
    });

    it('does not answer "settle" to the public while the scheduler is holding', async () => {
      // The cheap fix — deciding the public view with no hold — would publish a
      // false status: "Settling 9 purchase(s)" on a tick that settles nothing.
      const body = JSON.parse(await anonymousBodyWithHold(NOW_S + 2 * 3600));
      expect(body.verdict).toBe('holding-off');
      expect(body.reason).not.toMatch(/Settling/);
    });

    it('the scheduler still gets the full reason and the hold, so the operator can read it', async () => {
      const hold = NOW_S + 3 * 3600 + 5;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
      try {
        tillHolds(9, 30 * 86400);
        kv!.map.set('p01:settle:hold-until', hold);
        const body = await (await GET(cron())).json();
        expect(body.verdict).toBe('holding-off');
        expect(body.holdUntilSeconds).toBe(hold);
        expect(body.reason).toContain(new Date(hold * 1000).toISOString());
      } finally {
        clock.mockRestore();
      }
    });
  });

  it('treats a wrong bearer as unauthenticated rather than as the scheduler', async () => {
    tillHolds(9, 99999);
    const res = await GET(req('Bearer wrong'));
    expect(res.status).toBe(200);
    expect(chain.sent).toHaveLength(0);
    // and it did not take the side-effect path
    expect(kv!.map.has('p01:settle:hold-until')).toBe(false);
  });

  it('is inert when no secret is configured at all, even with a bearer', async () => {
    delete process.env.CRON_SECRET;
    tillHolds(9, 99999);
    await GET(req('Bearer '));
    expect(chain.sent).toHaveLength(0);
  });

  /**
   * The external scheduler's secret is scoped to THIS route.
   *
   * Vercel's Hobby plan refuses an hourly cron (measured 2026-08-22), and a
   * daily one would make the randomised hold decorative — it always lands on
   * the same tick. So the tick comes from a GitHub workflow, and handing that
   * workflow `CRON_SECRET` would hand it every cron route in the app.
   */
  it('accepts the route-scoped trigger secret', async () => {
    delete process.env.CRON_SECRET;
    process.env.P01_SETTLE_TRIGGER_SECRET = 'trigger-value';
    tillHolds(9, 30 * 86400);
    const body = await (await GET(req('Bearer trigger-value'))).json();
    // It reached the side-effect path: a hold was drawn.
    expect(kv!.map.get('p01:settle:hold-until')).toBeTypeOf('number');
    expect(body.settled).toBe(false);
  });

  it('still accepts the platform secret, so moving to Pro is one line elsewhere', async () => {
    process.env.P01_SETTLE_TRIGGER_SECRET = 'trigger-value';
    tillHolds(9, 30 * 86400);
    await GET(cron());
    expect(kv!.map.get('p01:settle:hold-until')).toBeTypeOf('number');
  });

  it('refuses a bearer that matches neither secret', async () => {
    process.env.P01_SETTLE_TRIGGER_SECRET = 'trigger-value';
    tillHolds(9, 30 * 86400);
    await GET(req('Bearer neither-of-them'));
    expect(kv!.map.has('p01:settle:hold-until')).toBe(false);
    expect(chain.sent).toHaveLength(0);
  });

  it('does not let an unset trigger secret authorise an empty bearer', async () => {
    // ⛔ THE CLASSIC. `matches()` returns false on an undefined secret; without
    // that guard `Buffer.from('')` and an absent variable would compare equal
    // and every unauthenticated caller would become the scheduler.
    delete process.env.CRON_SECRET;
    delete process.env.P01_SETTLE_TRIGGER_SECRET;
    tillHolds(9, 30 * 86400);
    await GET(req('Bearer '));
    expect(kv!.map.has('p01:settle:hold-until')).toBe(false);
  });
});

// ── The configuration guards that make the online key defensible ────────────

describe('the guards on holding the till key', () => {
  it('refuses the scheduler when the till key is absent', async () => {
    delete process.env.P01_TILL_SECRET_KEY;
    const res = await GET(cron());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.reasons.join(' ')).toMatch(/P01_TILL_SECRET_KEY/);
  });

  it('refuses when the till key and the float key are the same keypair', async () => {
    // R == F is the collapse the whole split exists to prevent. Settling into
    // itself would report success forever while the float never refilled.
    process.env.P01_FUNDER_SECRET_KEY = JSON.stringify(Array.from(till.secretKey));
    process.env.P01_TILL_ADDRESS = till.publicKey.toBase58();
    const res = await GET(cron());
    expect(res.status).toBe(503);
    expect((await res.json()).reasons.join(' ')).toMatch(/SAME keypair/);
    expect(chain.sent).toHaveLength(0);
  });

  it('refuses a till key that is not the address buyers are told to pay', async () => {
    // Sweeping the wrong address succeeds, reports a settlement, and leaves the
    // real till filling — a green light over an untouched balance.
    process.env.P01_TILL_ADDRESS = Keypair.generate().publicKey.toBase58();
    const res = await GET(cron());
    expect(res.status).toBe(503);
    expect((await res.json()).reasons.join(' ')).toMatch(/derives .* but buyers are told to pay/);
  });

  it('reports every reason at once, not the first', async () => {
    // An operator fixing one variable per redeploy is how an evening goes.
    delete process.env.P01_TILL_SECRET_KEY;
    delete process.env.P01_FUNDER_SECRET_KEY;
    const body = await (await GET(cron())).json();
    expect(body.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses to move money on a chain that is not devnet', async () => {
    chain.genesis = 'MAINNETGENESISHASH1111111111111111111111111';
    tillHolds(9, 99999);
    const res = await GET(cron());
    expect(res.status).toBe(403);
    expect(chain.sent).toHaveLength(0);
  });

  it('refuses rather than assumes when the RPC cannot be reached', async () => {
    chain.throwOnGenesis = true;
    const res = await GET(cron());
    expect(res.status).toBe(502);
    expect(chain.sent).toHaveLength(0);
  });
});

// ── The policy, as the route applies it ─────────────────────────────────────

describe('when it refuses to settle', () => {
  it('does nothing below the batch floor', async () => {
    tillHolds(2, 99999);
    const body = await (await GET(cron())).json();
    expect(body.verdict).toBe('below-batch-floor');
    expect(body.settled).toBe(false);
    expect(chain.sent).toHaveLength(0);
  });

  it('does nothing while a purchase is recent', async () => {
    tillHolds(9, 60);
    const body = await (await GET(cron())).json();
    expect(body.verdict).toBe('too-soon-after-purchase');
    expect(chain.sent).toHaveLength(0);
  });

  /** ⛔ An RPC blink is the cheapest way to manufacture a naming settlement. */
  it('does nothing when the till history cannot be read', async () => {
    chain.balances.set(till.publicKey.toBase58(), 9 * ONE_PURCHASE_LAMPORTS);
    chain.signatures.set(till.publicKey.toBase58(), []); // no clock
    const body = await (await GET(cron())).json();
    expect(body.verdict).toBe('till-history-unknown');
    expect(chain.sent).toHaveLength(0);
  });

  /**
   * 🚨 THE FIRST-TICK RULE, AND IT IS THE ONE MOST LIKELY TO BE REFACTORED AWAY.
   *
   * Purchases arrive slowly, so by the time the third lands the first two can
   * already be a day old — the quiet period is satisfied on the very tick the
   * floor is reached. Without drawing the hold BEFORE deciding, the settlement
   * fires at "the first cron tick after the floor was met", which is a constant
   * an observer reads straight off the schedule.
   */
  it('never settles on the first tick the floor is met, even when long quiet', async () => {
    tillHolds(9, 30 * 86400);
    const first = await (await GET(cron())).json();
    expect(first.settled).toBe(false);
    expect(first.verdict).toBe('holding-off');
    expect(chain.sent).toHaveLength(0);
    expect(kv!.map.get('p01:settle:hold-until')).toBeTypeOf('number');
  });

  it('keeps the same hold across ticks instead of resampling it', async () => {
    // A hold redrawn every tick is a fresh sample every hour, and the minimum of
    // many samples arrives quickly — the constant again, wearing a hat.
    tillHolds(9, 30 * 86400);
    await GET(cron());
    const drawn = kv!.map.get('p01:settle:hold-until');
    await GET(cron());
    await GET(cron());
    expect(kv!.map.get('p01:settle:hold-until')).toBe(drawn);
  });

  it('refuses to settle with no durable store, because it cannot lock', async () => {
    kv = null;
    tillHolds(9, 99999);
    const res = await GET(cron());
    expect(res.status).toBe(503);
    expect(chain.sent).toHaveLength(0);
  });

  it('stands down when another settlement holds the lock', async () => {
    tillHolds(9, 99999);
    kv!.map.set('p01:settle:hold-until', 1); // hold already expired
    kv!.map.set('p01:settle:lock', 1); // someone else is in flight
    const body = await (await GET(cron())).json();
    expect(body.settled).toBe(false);
    expect(body.note).toMatch(/already in flight/);
    expect(chain.sent).toHaveLength(0);
  });
});

// ── The settlement itself ───────────────────────────────────────────────────

describe('the settlement it sends', () => {
  async function settleNow(purchases = 9, extra = 0) {
    tillHolds(purchases, 30 * 86400, extra);
    await GET(cron()); // draws the hold
    kv!.map.set('p01:settle:hold-until', 1); // expire it
    return (await GET(cron())).json();
  }

  it('pays the float, from the till, signed by the till', async () => {
    const body = await settleNow();
    expect(body.settled).toBe(true);
    expect(chain.sent).toHaveLength(1);

    const { tx, signers } = chain.sent[0];
    expect(signers.map((s) => s.publicKey.toBase58())).toEqual([till.publicKey.toBase58()]);
    expect(tx.feePayer?.toBase58()).toBe(till.publicKey.toBase58());
    expect(tx.instructions).toHaveLength(1);

    // 🚨 THE ASSERTION THE WHOLE FILE EXISTS FOR: exactly one destination, and
    // it is the float. There is no request field that could have changed it.
    const keys = tx.instructions[0].keys.map((k) => k.pubkey.toBase58());
    expect(keys).toContain(float.publicKey.toBase58());
    expect(keys).toContain(till.publicKey.toBase58());
    expect(keys).toHaveLength(2);
  });

  it('moves the whole till less the network fee, leaving no counter behind', async () => {
    const body = await settleNow(9);
    expect(body.lamports).toBe(9 * ONE_PURCHASE_LAMPORTS - 5000);
    expect(body.purchases).toBe(9);
  });

  it('asks the chain for the fee rather than hardcoding it', async () => {
    chain.feeForMessage = 7500;
    const body = await settleNow(9);
    expect(body.lamports).toBe(9 * ONE_PURCHASE_LAMPORTS - 7500);
  });

  /**
   * 🚨 THE LATE ARRIVAL. A payment landing between the decision and the send
   * would otherwise be swept with it — and that buyer's payment would sit
   * SECONDS before the settlement, which is exactly the adjacency the quiet
   * period exists to break. It waits for the next batch instead.
   */
  it('does not sweep a purchase that arrives after the decision', async () => {
    tillHolds(9, 30 * 86400);
    await GET(cron());
    kv!.map.set('p01:settle:hold-until', 1);

    // The arrival has to land BETWEEN the balance the policy decided on and the
    // balance read just before signing — anywhere else and the test is only
    // watching the ordinary path. The first read of this tick is the decision's;
    // every later one sees the newcomer.
    const decided = 9 * ONE_PURCHASE_LAMPORTS;
    const key = till.publicKey.toBase58();
    const real = chain.balances.get.bind(chain.balances);
    let reads = 0;
    chain.balances.get = ((k: string) => {
      if (k !== key) return real(k);
      reads += 1;
      return reads === 1 ? decided : decided + ONE_PURCHASE_LAMPORTS;
    }) as typeof chain.balances.get;

    const body = await (await GET(cron())).json();
    expect(body.settled).toBe(true);
    expect(reads).toBeGreaterThanOrEqual(2); // the re-read really happened
    // 🚨 The tenth purchase is LEFT BEHIND on purpose. Sweeping it would put
    // that buyer's payment seconds before the settlement — the adjacency the
    // quiet period exists to break. It opens the next batch instead.
    expect(body.lamports).toBe(decided - 5000);
    expect(body.purchases).toBe(9);
  });

  it('refuses if the till balance fell between the decision and the send', async () => {
    tillHolds(9, 30 * 86400);
    await GET(cron());
    kv!.map.set('p01:settle:hold-until', 1);
    // Something else spent the till after the policy approved an amount.
    const original = chain.balances.get(till.publicKey.toBase58())!;
    let reads = 0;
    const realGet = chain.balances.get.bind(chain.balances);
    chain.balances.get = ((k: string) => {
      if (k === till.publicKey.toBase58()) {
        reads += 1;
        return reads > 1 ? original - ONE_PURCHASE_LAMPORTS : original;
      }
      return realGet(k);
    }) as typeof chain.balances.get;
    const res = await GET(cron());
    expect(res.status).toBe(409);
    expect(chain.sent).toHaveLength(0);
  });

  it('releases the lock after a failed send, so the next tick can retry', async () => {
    tillHolds(9, 30 * 86400);
    await GET(cron());
    kv!.map.set('p01:settle:hold-until', 1);
    chain.throwOnSend = 'blockhash not found';
    const res = await GET(cron());
    expect(res.status).toBe(502);
    expect(kv!.map.has('p01:settle:lock')).toBe(false);
  });

  it('clears the hold after settling, so the next window draws a fresh one', async () => {
    await settleNow(9);
    expect(kv!.map.has('p01:settle:hold-until')).toBe(false);
    expect(kv!.map.get('p01:settle:last')).toMatchObject({ purchases: 9 });
  });
});

// ── The alarm ───────────────────────────────────────────────────────────────

describe('the float alarm', () => {
  it('mails the operator when the float is nearly spent', async () => {
    chain.balances.set(float.publicKey.toBase58(), 2_000_000_000); // 1 deposit left
    tillHolds(1, 99999);
    const body = await (await GET(cron())).json();
    expect(body.floatAlarm).toBe(true);
    expect(body.alarm).toBe('sent');
    expect(mockSendReportEmail).toHaveBeenCalledTimes(1);
    const sent = (mockSendReportEmail.mock.calls as unknown as Array<[{ text: string }]>)[0][0];
    expect(sent.text).toMatch(/deposits remaining/);
    expect(sent.text).toMatch(/Do not lower P01_SETTLE_MIN_PURCHASES/);
  });

  it('does not mail again while the same alarm stands', async () => {
    chain.balances.set(float.publicKey.toBase58(), 2_000_000_000);
    tillHolds(1, 99999);
    await GET(cron());
    const second = await (await GET(cron())).json();
    expect(second.alarm).toBe('suppressed');
    expect(mockSendReportEmail).toHaveBeenCalledTimes(1);
  });

  it('re-arms as soon as the float recovers, so the next drop is not swallowed', async () => {
    chain.balances.set(float.publicKey.toBase58(), 2_000_000_000);
    tillHolds(1, 99999);
    await GET(cron());
    chain.balances.set(float.publicKey.toBase58(), 40_000_000_000);
    await GET(cron());
    expect(kv!.map.has('p01:settle:alarm-sent')).toBe(false);
    chain.balances.set(float.publicKey.toBase58(), 2_000_000_000);
    const again = await (await GET(cron())).json();
    expect(again.alarm).toBe('sent');
    expect(mockSendReportEmail).toHaveBeenCalledTimes(2);
  });

  it('reports the deadlock instead of telling the operator to be patient', async () => {
    // One deposit of capacity left, two purchases short of the floor. Waiting
    // cannot work: the relay refuses before the next purchase arrives.
    chain.balances.set(float.publicKey.toBase58(), 2_000_000_000);
    tillHolds(1, 99999);
    const body = await (await GET(cron())).json();
    expect(body.verdict).toBe('float-too-small-for-batch-floor');
    expect(body.floatShortfallLamports).toBeGreaterThan(0);
    expect(body.reason).toMatch(/Add .* SOL to the float/);
  });
});

// ── Configuration ───────────────────────────────────────────────────────────

describe('the policy is configurable but never off', () => {
  it('honours a raised batch floor', async () => {
    process.env.P01_SETTLE_MIN_PURCHASES = '10';
    tillHolds(9, 99999);
    const body = await (await GET(cron())).json();
    expect(body.verdict).toBe('below-batch-floor');
    expect(body.policy.minPurchases).toBe(10);
  });

  it('a malformed floor falls back to the default rather than to zero', async () => {
    process.env.P01_SETTLE_MIN_PURCHASES = '0';
    tillHolds(1, 99999);
    const body = await (await GET(cron())).json();
    expect(body.policy.minPurchases).toBe(3);
    expect(body.verdict).not.toBe('settle');
  });

  it('publishes the float a given floor requires, so the operator can act', async () => {
    const body = await (await GET(req())).json();
    expect(body.policy.floatRequiredForFloorLamports).toBe(2 * ONE_PURCHASE_LAMPORTS + 1_620_000_000);
    expect(new PublicKey(body.till).toBase58()).toBe(till.publicKey.toBase58());
    expect(new PublicKey(body.float).toBase58()).toBe(float.publicKey.toBase58());
  });
});

// ── close-v1 lane L1: audit v1 F38 and F39 ─────────────────────────────────
//
// F38 (round 2, server axis). The quiet period was read off the till's NEWEST
// SIGNATURE OF ANY KIND, so one failed or empty transaction that merely lists
// the till, once per quiet window, kept settlement off for ever; and the
// purchase count was the till's balance over one credit, so a single
// non-purchase credit made one real purchase settle as a batch of three.
// Audit probe: `r2-server/probes/p3-settle-till.probe.test.ts`.
//
// F39 (round 2). The lock was `incr` then `expire`; one failed `expire` left a
// lock with no TTL, and every later tick answered "a settlement is already in
// flight". Audit probe: `r2-server/probes/p7-settle-lock.probe.test.ts`.
//
// Red logs: scratchpad close-v1/L1-server-money/red-F38-F39*.log.

/** Newest first, as the RPC returns them. */
function tillHistory(entries: Array<{ sig: string; ago: number; credit?: number; err?: unknown }>) {
  const now = Math.floor(Date.now() / 1000);
  chain.signatures.set(
    till.publicKey.toBase58(),
    entries.map((e) => ({ signature: e.sig, blockTime: now - e.ago, err: e.err ?? null })),
  );
  for (const e of entries) if (e.credit !== undefined) chain.tillCredits.set(e.sig, e.credit);
}
/** k real purchases, the newest `newestAgo` seconds ago, one hour apart. */
function realPurchases(k: number, newestAgo: number) {
  return Array.from({ length: k }, (_, i) => ({
    sig: `PURCHASE${i}`,
    ago: newestAgo + i * 3600,
    credit: ONE_PURCHASE_LAMPORTS,
  }));
}
/** Draw the hold, then expire it, so the next tick is decided on the clock alone. */
async function pastTheHold() {
  await GET(cron());
  kv!.map.set('p01:settle:hold-until', 1);
}

describe('F38 · only a purchase resets the quiet period', () => {
  it('control: three purchases, the newest two days old, settle once the hold expires', async () => {
    chain.balances.set(till.publicKey.toBase58(), 3 * ONE_PURCHASE_LAMPORTS);
    tillHistory(realPurchases(3, 2 * 86400));
    await pastTheHold();
    const body = await (await GET(cron())).json();
    expect(body.settled, JSON.stringify(body)).toBe(true);
  });

  it('a FAILED transaction naming the till one hour ago does not hold settlement off', async () => {
    chain.balances.set(till.publicKey.toBase58(), 3 * ONE_PURCHASE_LAMPORTS);
    tillHistory([
      { sig: 'GRIEF', ago: 3600, err: { InstructionError: [0, 'Custom'] } },
      ...realPurchases(3, 2 * 86400),
    ]);
    await pastTheHold();
    const body = await (await GET(cron())).json();
    expect(body.verdict, JSON.stringify(body)).toBe('settle');
    expect(body.settled).toBe(true);
  });

  it('a successful 0-lamport transaction naming the till does not hold settlement off either', async () => {
    chain.balances.set(till.publicKey.toBase58(), 3 * ONE_PURCHASE_LAMPORTS);
    tillHistory([{ sig: 'DUST', ago: 3600, credit: 0 }, ...realPurchases(3, 2 * 86400)]);
    await pastTheHold();
    const body = await (await GET(cron())).json();
    expect(body.verdict, JSON.stringify(body)).toBe('settle');
  });

  it('control: a real purchase one hour ago still holds settlement off', async () => {
    chain.balances.set(till.publicKey.toBase58(), 4 * ONE_PURCHASE_LAMPORTS);
    tillHistory([{ sig: 'LATE', ago: 3600, credit: ONE_PURCHASE_LAMPORTS }, ...realPurchases(3, 2 * 86400)]);
    await pastTheHold();
    const body = await (await GET(cron())).json();
    expect(body.verdict).toBe('too-soon-after-purchase');
    expect(chain.sent).toHaveLength(0);
  });

  it('a non-purchase credit does not turn one purchase into a batch of three', async () => {
    // (a) of the probe: one real purchase plus 2,006,000,000 lamports arriving
    // in ONE transaction. The balance reads as three credits; the chain shows
    // two payers, one transaction each.
    chain.balances.set(till.publicKey.toBase58(), 3 * ONE_PURCHASE_LAMPORTS);
    tillHistory([
      { sig: 'BIG', ago: 30_000, credit: 2 * ONE_PURCHASE_LAMPORTS },
      { sig: 'REAL', ago: 40_000, credit: ONE_PURCHASE_LAMPORTS },
    ]);
    await pastTheHold();
    const body = await (await GET(cron())).json();
    expect(body.verdict, JSON.stringify(body)).toBe('below-batch-floor');
    expect(chain.sent).toHaveLength(0);
  });

  it('a purchase-sized credit every few hours cannot defer a met batch past the hard maximum', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = Date.parse('2026-09-23T00:00:00Z');
      vi.setSystemTime(t0);
      process.env.P01_SETTLE_HOLD_SPREAD_SECONDS = '1';
      chain.balances.set(till.publicKey.toBase58(), 4 * ONE_PURCHASE_LAMPORTS);
      tillHistory([{ sig: 'KEEPALIVE0', ago: 3600, credit: ONE_PURCHASE_LAMPORTS }, ...realPurchases(3, 2 * 86400)]);
      const first = await (await GET(cron())).json();
      expect(first.verdict).toBe('too-soon-after-purchase');

      // Four days on, one purchase-sized credit has kept landing every few
      // hours. At HEAD this is too-soon for ever.
      vi.setSystemTime(t0 + 4 * 86400_000);
      tillHistory([{ sig: 'KEEPALIVE9', ago: 3600, credit: ONE_PURCHASE_LAMPORTS }, ...realPurchases(3, 2 * 86400)]);
      const late = await (await GET(cron())).json();
      expect(late.settled, JSON.stringify(late)).toBe(true);
      expect(late.reason).toMatch(/maximum deferral/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the anonymous view never carries the drawn deadline', async () => {
    chain.balances.set(till.publicKey.toBase58(), 4 * ONE_PURCHASE_LAMPORTS);
    tillHistory([{ sig: 'LATE', ago: 3600, credit: ONE_PURCHASE_LAMPORTS }, ...realPurchases(3, 2 * 86400)]);
    await GET(cron());
    const forceAt = kv!.map.get('p01:settle:force-at');
    expect(forceAt).toBeTypeOf('number');
    const text = JSON.stringify(await (await GET(req())).json());
    expect(text).not.toContain(String(forceAt));
    expect(text).not.toContain(new Date(Number(forceAt) * 1000).toISOString());
  });
});

describe('F39 · the settlement lock always carries a TTL', () => {
  it('a failed expire right after the lock is taken does not wedge settlement', async () => {
    chain.balances.set(till.publicKey.toBase58(), 3 * ONE_PURCHASE_LAMPORTS);
    tillHistory(realPurchases(3, 2 * 86400));
    await pastTheHold();
    failExpireOnce = 'p01:settle:lock';
    const first = await GET(cron());
    expect(first.status).toBe(503);
    expect(chain.sent).toHaveLength(0);
    const second = await (await GET(cron())).json();
    expect(second.settled, JSON.stringify(second)).toBe(true);
  });

  it('a lock already left without a TTL gets one back on the next tick', async () => {
    chain.balances.set(till.publicKey.toBase58(), 3 * ONE_PURCHASE_LAMPORTS);
    tillHistory(realPurchases(3, 2 * 86400));
    await pastTheHold();
    kv!.map.set('p01:settle:lock', 7); // wedged by an earlier failure, no TTL
    const body = await (await GET(cron())).json();
    expect(body.settled).toBe(false);
    expect(body.note).toMatch(/already in flight/);
    expect(ttl.get('p01:settle:lock'), 'the wedged lock was left without a TTL').toBeGreaterThan(0);
  });
});

// ── close-v1 verify round 1: F62 one hop later, and two unpinned guards ────

describe('F62 · float lamports sent to the till through a granted key are not purchases', () => {
  /**
   * The attack the verifier measured: a 2 SOL grant from `/api/fund-ephemeral`
   * to a fresh key K (allowed), then two purchase-sized transfers from K to the
   * till. Each is >= MIN_PURCHASE_CREDIT_LAMPORTS, so at the lane-L1 code the
   * settler counted two purchases the attacker paid nothing for, and one real
   * purchase settled as a batch of three.
   */
  function grantedKey(): string {
    const k = Keypair.generate().publicKey.toBase58();
    const f = float.publicKey.toBase58();
    chain.txs.set('GRANT_TO_K', { keys: [f, k], pre: [20_000_000_000, 0], post: [17_999_995_000, 2_000_000_000] });
    return k;
  }
  function payerHistory(k: string, sigsNewestFirst: string[]) {
    const now = Math.floor(Date.now() / 1000);
    chain.signatures.set(k, sigsNewestFirst.map((signature, i) => ({ signature, blockTime: now - 3 * 86400 + 60 - i })));
  }

  it('two credits paid by a key the float funded do not make one real purchase a batch of three', async () => {
    chain.balances.set(till.publicKey.toBase58(), 3 * ONE_PURCHASE_LAMPORTS);
    const k = grantedKey();
    tillHistory([
      { sig: 'FAKE2', ago: 2 * 86400, credit: ONE_PURCHASE_LAMPORTS },
      { sig: 'FAKE1', ago: 2 * 86400 + 60, credit: ONE_PURCHASE_LAMPORTS },
      { sig: 'REAL', ago: 2 * 86400 + 3600, credit: ONE_PURCHASE_LAMPORTS },
    ]);
    chain.tillPayers.set('FAKE2', k);
    chain.tillPayers.set('FAKE1', k);
    payerHistory(k, ['FAKE2', 'FAKE1', 'GRANT_TO_K']);
    await pastTheHold();
    const body = await (await GET(cron())).json();
    expect(body.verdict, JSON.stringify(body)).toBe('below-batch-floor');
    expect(body.purchasesHeld).toBe(1);
    expect(chain.sent).toHaveLength(0);
  });

  it('control: a payer with a long history and no grant from the float in it still counts', async () => {
    chain.balances.set(till.publicKey.toBase58(), 3 * ONE_PURCHASE_LAMPORTS);
    const busy = Keypair.generate().publicKey.toBase58();
    const other = Keypair.generate().publicKey.toBase58();
    const noise = Array.from({ length: 30 }, (_, i) => `WALLET_TX${i}`);
    for (const sig of noise) chain.txs.set(sig, { keys: [busy, other], pre: [5e9, 0], post: [5e9 - 5000, 0] });
    tillHistory(realPurchases(3, 2 * 86400));
    chain.tillPayers.set('PURCHASE0', busy);
    payerHistory(busy, ['PURCHASE0', ...noise]);
    await pastTheHold();
    const body = await (await GET(cron())).json();
    expect(body.settled, JSON.stringify(body)).toBe(true);
    expect(body.purchases).toBe(3);
  });

  it('a payer whose history before the payment cannot be read is not counted: unknown is not a purchase', async () => {
    chain.balances.set(till.publicKey.toBase58(), 3 * ONE_PURCHASE_LAMPORTS);
    const k = Keypair.generate().publicKey.toBase58();
    tillHistory(realPurchases(3, 2 * 86400));
    chain.tillPayers.set('PURCHASE0', k);
    payerHistory(k, ['PURCHASE0', 'UNREADABLE_TX']);
    await pastTheHold();
    const body = await (await GET(cron())).json();
    expect(body.verdict, JSON.stringify(body)).toBe('below-batch-floor');
    expect(chain.sent).toHaveLength(0);
  });
});

describe('guards the report claims, pinned (verify round 1 revert mutants)', () => {
  it('(4) a settlement clears the maximum-deferral deadline, so the next window draws its own', async () => {
    chain.balances.set(till.publicKey.toBase58(), 9 * ONE_PURCHASE_LAMPORTS);
    tillHistory(realPurchases(9, 30 * 86400));
    await pastTheHold();
    expect(kv!.map.get('p01:settle:force-at'), 'the first tick with the batch met draws a deadline').toBeTypeOf('number');
    const body = await (await GET(cron())).json();
    expect(body.settled, JSON.stringify(body)).toBe(true);
    expect(kv!.map.has('p01:settle:force-at'), 'a stale deadline would force the next window').toBe(false);
  });

  it('(5) a full page of cheap transactions hides no purchase: its oldest entry is the quiet time, a lower bound', async () => {
    // 100 successful 0-lamport transactions, one a minute, the newest a minute
    // ago; three real purchases sit behind the page. The quiet time read is
    // about 100 minutes, under the 6 h minimum, whatever lies behind.
    chain.balances.set(till.publicKey.toBase58(), 3 * ONE_PURCHASE_LAMPORTS);
    const dust = Array.from({ length: 100 }, (_, i) => ({ sig: `DUST${i}`, ago: 60 + i * 60, credit: 0 }));
    tillHistory([...dust, ...realPurchases(3, 2 * 86400)]);
    await pastTheHold();
    const body = await (await GET(cron())).json();
    expect(body.verdict, JSON.stringify(body)).toBe('too-soon-after-purchase');
    expect(body.lastCreditSecondsAgo).toBeLessThanOrEqual(100 * 60 + 5);
    expect(chain.sent).toHaveLength(0);
  });
});

describe('settle-till reads what its comments say it reads (close-v1 verify round 1)', () => {
  it('stops at the last outflow: purchases before the previous settlement are not this batch', async () => {
    // One purchase since the last settlement; three older ones sit behind the
    // settlement's outflow. The till still holds three purchases' worth (what
    // the previous settlement left behind), so only the walk can tell.
    chain.balances.set(till.publicKey.toBase58(), 3 * ONE_PURCHASE_LAMPORTS);
    tillHistory([
      { sig: 'NEW', ago: 2 * 86400, credit: ONE_PURCHASE_LAMPORTS },
      { sig: 'OUTFLOW', ago: 3 * 86400, credit: -3 * ONE_PURCHASE_LAMPORTS },
      ...realPurchases(3, 4 * 86400),
    ]);
    await pastTheHold();
    const body = await (await GET(cron())).json();
    expect(body.verdict, JSON.stringify(body)).toBe('below-batch-floor');
    expect(body.purchasesHeld).toBe(1);
  });

  it('the anonymous status read reads at most 10 signatures and checks no payer', async () => {
    tillHolds(9, 99999);
    await GET(req());
    const tillReads = chain.sigReads.filter((r) => r.address === till.publicKey.toBase58());
    expect(tillReads.map((r) => r.limit)).toEqual([10]);
    expect(chain.sigReads).toHaveLength(1);
  });

  it('control: the scheduler reads 100 and checks each purchase payer', async () => {
    tillHolds(3, 99999);
    await GET(cron());
    const tillReads = chain.sigReads.filter((r) => r.address === till.publicKey.toBase58());
    expect(tillReads.map((r) => r.limit)).toEqual([100]);
    expect(chain.sigReads.length).toBe(1 + 3);
  });
});

// ── close-v1 verify round 2: three settle-till guards the report claims ────
//
// Each case below turns red under the matching verify-r2 mutant
// (close-v1/L1-server-money-verify-r2/mut/*.json): st-mincredit,
// st-f62-direction, st-f62-unknownnoreset. Mutant-red logs:
// close-v1/L1-server-money/r3/mut-*.log.

describe('F38 · the purchase floor is the threshold, not "any credit" (verify round 2)', () => {
  // The cheapest real grief is not a 0-lamport or a failed transaction but a
  // SUCCESSFUL transfer of 1 lamport to the till once per quiet window. Only
  // `delta >= MIN_PURCHASE_CREDIT_LAMPORTS` tells it from a purchase.
  it.each([
    ['1 lamport', 1],
    ['MIN_PURCHASE_CREDIT_LAMPORTS - 1', MIN_PURCHASE_CREDIT_LAMPORTS - 1],
  ])('a successful credit of %s one hour ago does not reset the quiet period: the batch settles', async (_label, credit) => {
    chain.balances.set(till.publicKey.toBase58(), 3 * ONE_PURCHASE_LAMPORTS + credit);
    tillHistory([{ sig: 'SMALL_CREDIT', ago: 3600, credit }, ...realPurchases(3, 2 * 86400)]);
    // First tick: draws the hold. Its body carries the quiet time read.
    const first = await (await GET(cron())).json();
    expect(first.lastCreditSecondsAgo, JSON.stringify(first)).toBeGreaterThanOrEqual(2 * 86400 - 5);
    expect(first.lastCreditSecondsAgo).toBeLessThan(2 * 86400 + 60);
    kv!.map.set('p01:settle:hold-until', 1);
    const body = await (await GET(cron())).json();
    expect(body.verdict, JSON.stringify(body)).toBe('settle');
    expect(body.settled).toBe(true);
    expect(body.purchases).toBe(3);
  });
});

describe('F62 · the float-funding check reads direction, and an unknown payer still resets the clock (verify round 2)', () => {
  function payerHistoryOf(k: string, sigsNewestFirst: string[]) {
    const now = Math.floor(Date.now() / 1000);
    chain.signatures.set(k, sigsNewestFirst.map((signature, i) => ({ signature, blockTime: now - 3 * 86400 + 60 - i })));
  }

  it('control: a payer funded from an exchange (not the float) before paying still counts, and the batch settles', async () => {
    // Every real buyer RECEIVED lamports before paying. Only a credit that came
    // FROM THE FLOAT marks a granted key; a check on "the payer was credited"
    // alone would set every buyer aside and no batch would ever settle.
    chain.balances.set(till.publicKey.toBase58(), 3 * ONE_PURCHASE_LAMPORTS);
    const buyer = Keypair.generate().publicKey.toBase58();
    const exchange = Keypair.generate().publicKey.toBase58();
    chain.txs.set('EXCHANGE_TO_BUYER', {
      keys: [exchange, buyer],
      pre: [1_000_000_000_000, 0],
      post: [1_000_000_000_000 - 2_000_000_000 - 5000, 2_000_000_000],
    });
    tillHistory(realPurchases(3, 2 * 86400));
    chain.tillPayers.set('PURCHASE0', buyer);
    payerHistoryOf(buyer, ['PURCHASE0', 'EXCHANGE_TO_BUYER']);
    await pastTheHold();
    const body = await (await GET(cron())).json();
    expect(body.settled, JSON.stringify(body)).toBe(true);
    expect(body.purchases).toBe(3);
  });

  it('a credit whose payer history cannot be read is not counted, but it DOES reset the quiet period', async () => {
    // Three real purchases two days old would settle; one hour ago a
    // purchase-sized credit arrived from a payer whose history is unreadable.
    // It may be a real buyer, so it must hold the batch off like one.
    chain.balances.set(till.publicKey.toBase58(), 4 * ONE_PURCHASE_LAMPORTS);
    const k = Keypair.generate().publicKey.toBase58();
    tillHistory([{ sig: 'UNKNOWN_PAYER', ago: 3600, credit: ONE_PURCHASE_LAMPORTS }, ...realPurchases(3, 2 * 86400)]);
    chain.tillPayers.set('UNKNOWN_PAYER', k);
    payerHistoryOf(k, ['UNKNOWN_PAYER', 'UNREADABLE_TX']);
    await pastTheHold();
    const body = await (await GET(cron())).json();
    expect(body.verdict, JSON.stringify(body)).toBe('too-soon-after-purchase');
    expect(body.lastCreditSecondsAgo).toBeGreaterThanOrEqual(3600 - 5);
    expect(body.lastCreditSecondsAgo).toBeLessThan(3600 + 60);
    expect(chain.sent).toHaveLength(0);
  });
});
