/**
 * What GET /api/relay-to-buyer tells one caller about ANOTHER caller behind the
 * same address.
 *
 * Run: cd apps/web && npx vitest run __tests__/api/relayToBuyerAllowanceOracle.test.ts
 *
 * WHY THIS SUITE EXISTS
 * ─────────────────────
 * The GET previews the per-IP relay allowance so the client can refuse BEFORE
 * the wallet signs. It used to answer the exact count. The GET needs no ticket,
 * has no limiter of its own and spends nothing, and the count moves on every
 * POST from that address — which follows the buyer's public till payment by
 * seconds. So anyone sharing the buyer's egress address (a flat, an office, a
 * campus) could poll it and read "somebody here bought at this second", then
 * look that second up on chain: about 3-4 till payments a day, so one wallet.
 * Measured: scratchpad/web-run/logs8/r1-server/probe-S2-relaysRemaining.log
 * (`watcher on the SAME exit : relaysRemaining 3 -> 2`).
 *
 * The client only ever tests `relaysRemaining <= 0`
 * (lib/privacy/pool/ephemeralFunder.ts), so the answer is clamped to what that
 * test needs: 1 while at least one relay is left, 0 when none is.
 *
 * ⚠️ WHAT THIS DOES NOT CLOSE, so nobody reads it as more than it is. The
 * answer still flips at exhaustion, and the POST's own 429 shows the same
 * event. A per-IP budget is a count oracle by construction; removing it means
 * a budget keyed on something other than the address, which is a design
 * decision and not this suite's.
 *
 * The REAL `rateLimitExceeded`, `rateLimitRemaining` and `rateLimitBucket` run
 * here, against an in-memory store. Only the chain is a stub.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { NextRequest } from 'next/server';
import type { KvLike } from '@/lib/waitlist/store';

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    Connection: class {
      // The buyer's POST stops right after the limiter, which is all this needs:
      // the limiter line runs before any chain read.
      async getGenesisHash() {
        throw new Error('rpc down');
      }
      async getBalance() {
        return 5_000_000_000;
      }
      async getSignaturesForAddress() {
        return [];
      }
    },
  };
});

let ops: string[] = [];
let map = new Map<string, unknown>();
let storeReads: 'ok' | 'throws' = 'ok';

const kv: KvLike = {
  async get<T>(k: string) {
    ops.push('get');
    if (storeReads === 'throws') throw new Error('ERR quota, command was: [["get","wl:rl:X"]]');
    return (map.has(k) ? (map.get(k) as T) : null) as T | null;
  },
  async set(k, v) {
    ops.push('set');
    map.set(k, v);
  },
  async del(k) {
    ops.push('del');
    map.delete(k);
  },
  async incr(k) {
    ops.push('incr');
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

vi.mock('@/lib/waitlist/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/waitlist/store')>()),
  getStore: () => kv,
}));

const TICKET = 'public-ticket-that-ships-in-the-bundle';
process.env.P01_FUNDER_SECRET_KEY = JSON.stringify(Array.from(Keypair.generate().secretKey));
process.env.P01_TILL_ADDRESS = Keypair.generate().publicKey.toBase58();
process.env.P01_FEE_WALLET = Keypair.generate().publicKey.toBase58();
process.env.P01_FUNDER_TICKET = TICKET;
process.env.P01_RATE_LIMIT_KEY = 'k'.repeat(64);
delete process.env.P01_RELAY_LIMIT_PER_HOUR;

const { GET, POST } = await import('@/app/api/relay-to-buyer/route');

const SHARED = '198.51.100.77'; // the address the buyer and the watcher both leave from
const ELSEWHERE = '203.0.113.9';

const preview = async (ip: string) =>
  (await (
    await GET(
      new NextRequest('https://styx.test/api/relay-to-buyer', { headers: { 'x-real-ip': ip } }),
    )
  ).json()) as Record<string, unknown>;

/** Somebody ELSE behind `ip` asks for a relay. Returns the status. */
async function anotherCallerRelays(ip: string): Promise<number> {
  const res = await POST(
    new NextRequest('https://styx.test/api/relay-to-buyer', {
      method: 'POST',
      headers: {
        'x-real-ip': ip,
        'x-p01-funder-ticket': TICKET,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        paymentSignature: '5'.repeat(88),
        buyerPubkey: Keypair.generate().publicKey.toBase58(),
      }),
    } as unknown as ConstructorParameters<typeof NextRequest>[1]),
  );
  return res.status;
}

beforeEach(() => {
  ops = [];
  map = new Map();
  storeReads = 'ok';
});

describe('the allowance preview, read by somebody who shares the buyer’s address', () => {
  it('does not move when another caller behind the same address relays', async () => {
    const before = await preview(SHARED);

    const status = await anotherCallerRelays(SHARED);
    // The harness did what it says: the POST reached the limiter and spent one.
    expect(status).toBe(502);
    expect(ops.filter((o) => o === 'incr')).toHaveLength(1);

    const after = await preview(SHARED);
    expect(after, 'the watcher saw the other caller’s relay').toEqual(before);
  });

  it('does not move on the second relay of the hour either', async () => {
    await anotherCallerRelays(SHARED);
    const before = await preview(SHARED);
    await anotherCallerRelays(SHARED);
    const after = await preview(SHARED);
    expect(after.relaysRemaining, 'the watcher saw the other caller’s relay').toBe(
      before.relaysRemaining,
    );
  });

  it('never publishes how many relays this address has used', async () => {
    const seen = new Set<unknown>();
    seen.add((await preview(SHARED)).relaysRemaining);
    for (let i = 0; i < 3; i += 1) {
      await anotherCallerRelays(SHARED);
      seen.add((await preview(SHARED)).relaysRemaining);
    }
    // Four different states of the bucket (0, 1, 2 and 3 used), two answers.
    expect([...seen].sort()).toEqual([0, 1]);
  });
});

describe('what the client still needs from it', () => {
  it('says a relay is available to a fresh address, without spending one', async () => {
    const body = await preview(ELSEWHERE);
    expect(body.relaysPerHour).toBe(3);
    expect(body.relaysRemaining).toBe(1);
    expect(ops).not.toContain('incr');
  });

  it('reads 0 once the allowance is spent, so the client refuses before the wallet signs', async () => {
    // `ephemeralFunder.ts` refuses on `relaysRemaining <= 0`. That is the whole
    // reason the field exists, and the clamp must not cost it.
    for (let i = 0; i < 3; i += 1) await anotherCallerRelays(SHARED);
    expect((await preview(SHARED)).relaysRemaining).toBe(0);
    // And it is this address's bucket, not everybody's.
    expect((await preview(ELSEWHERE)).relaysRemaining).toBe(1);
  });

  it('reads null, never 0, when the store cannot be read', async () => {
    storeReads = 'throws';
    expect((await preview(SHARED)).relaysRemaining).toBeNull();
  });
});
