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
import { ONE_PURCHASE_LAMPORTS } from './settlementPolicy';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

// ── The fake chain ──────────────────────────────────────────────────────────

interface FakeChain {
  genesis: string;
  balances: Map<string, number>;
  /** Newest-first signatures per address, as the RPC returns them. */
  signatures: Map<string, { signature: string; blockTime: number | null }[]>;
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
      async getSignaturesForAddress(k: { toBase58(): string }) {
        return chain.signatures.get(k.toBase58()) ?? [];
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
    async expire() {},
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

/** Put the till at k purchases, last credited `agoSeconds` ago. */
function tillHolds(k: number, agoSeconds: number, extra = 0) {
  chain.balances.set(till.publicKey.toBase58(), k * ONE_PURCHASE_LAMPORTS + extra);
  chain.signatures.set(till.publicKey.toBase58(), [
    { signature: 'PAYMENT', blockTime: Math.floor(Date.now() / 1000) - agoSeconds },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  till = Keypair.generate();
  float = Keypair.generate();
  chain = {
    genesis: DEVNET_GENESIS,
    balances: new Map([[float.publicKey.toBase58(), 20_000_000_000]]),
    signatures: new Map(),
    sent: [],
    feeForMessage: 5000,
  };
  kv = memoryKv();
  process.env.CRON_SECRET = CRON_SECRET;
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
  });

  it('treats a wrong bearer as unauthenticated rather than as the scheduler', async () => {
    tillHolds(9, 99999);
    const res = await GET(req('Bearer wrong'));
    expect(res.status).toBe(200);
    expect(chain.sent).toHaveLength(0);
    // and it did not take the side-effect path
    expect(kv!.map.has('p01:settle:hold-until')).toBe(false);
  });

  it('is inert when no cron secret is configured, even with a bearer', async () => {
    delete process.env.CRON_SECRET;
    tillHolds(9, 99999);
    await GET(req('Bearer '));
    expect(chain.sent).toHaveLength(0);
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
    const sent = mockSendReportEmail.mock.calls[0][0] as unknown as { text: string };
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
