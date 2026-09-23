/**
 * close-v1, lane L3: the developer whitelist route (`app/api/whitelist/route.ts`).
 *
 * Audit v1 findings closed here, each red on the tree the audit left:
 *
 *   F42  a KV read that FAILED was treated as an empty whitelist, and the next
 *        write (a public request, a removal) wrote that emptiness over the real
 *        row: every approved developer gone after one transient error
 *        (audit-v1-opus/r2-server/probes/p5-whitelist.probe.test.ts (a)).
 *   F13  the public POST had no rate limit, no body cap, and a read-modify-write
 *        of the whole list, so two requests at once lost one of them.
 *   F75  an anonymous request chose the recipient of the approval mail
 *        (audit-v1-opus/r4-verify1/probe-whitelist-recipient.test.ts).
 *   F64  ADMIN_PASSWORD could be guessed without limit: 5,000 wrong guesses from
 *        one address in 133 ms, then the right one answered 200
 *        (audit-v1-opus/r3-server/p2/probe-admin-guessing.summary.log).
 *
 * Run: cd apps/web && npx vitest run __tests__/api/closeV1L3Whitelist.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const kvState = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  writes: [] as Array<{ key: string; value: unknown }>,
  failNextGetOf: null as string | null,
  /** The next read of this key never answers: its caller is killed mid-request. */
  hangNextGetOf: null as string | null,
  getDelayMs: 0,
  /** Per-read delays (ms) for the next reads of `whitelist:data`, in order; after they run out, `getDelayMs`. */
  dataReadDelays: [] as number[],
  /** Commands on the admin attempt counters (`adm:fail:*`) that throw, like a KV outage. */
  failCounterCommands: [] as Array<'get' | 'incr' | 'expire'>,
  /** Expiry time (Date.now() ms) of keys that have a TTL, like Redis. */
  expiresAt: new Map<string, number>(),
}));

vi.mock('@vercel/kv', () => {
  const clone = (v: unknown) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  // A key whose TTL has run out is gone, as in Redis (checked on every command).
  const live = (key: string) => {
    const at = kvState.expiresAt.get(key);
    if (at !== undefined && Date.now() >= at) {
      kvState.rows.delete(key);
      kvState.expiresAt.delete(key);
    }
  };
  const counterFails = (cmd: 'get' | 'incr' | 'expire', key: string) => {
    if (key.startsWith('adm:fail:') && kvState.failCounterCommands.includes(cmd)) throw new Error('fetch failed');
  };
  return {
    kv: {
      async get(key: string) {
        live(key);
        counterFails('get', key);
        if (kvState.failNextGetOf === key) {
          kvState.failNextGetOf = null;
          throw new Error('fetch failed');
        }
        if (kvState.hangNextGetOf === key) {
          kvState.hangNextGetOf = null;
          return new Promise(() => undefined);
        }
        const value = clone(kvState.rows.get(key));
        const delay =
          key === 'whitelist:data' && kvState.dataReadDelays.length > 0
            ? (kvState.dataReadDelays.shift() as number)
            : kvState.getDelayMs;
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        return value;
      },
      async set(key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) {
        live(key);
        if (opts?.nx && kvState.rows.has(key)) return null;
        kvState.rows.set(key, clone(value));
        if (opts?.ex) kvState.expiresAt.set(key, Date.now() + opts.ex * 1000);
        else kvState.expiresAt.delete(key);
        kvState.writes.push({ key, value: clone(value) });
        return 'OK';
      },
      async incr(key: string) {
        live(key);
        counterFails('incr', key);
        const n = Number(kvState.rows.get(key) ?? 0) + 1;
        kvState.rows.set(key, n);
        return n;
      },
      async expire(key: string, seconds: number) {
        live(key);
        counterFails('expire', key);
        if (!kvState.rows.has(key)) return 0;
        kvState.expiresAt.set(key, Date.now() + seconds * 1000);
        return 1;
      },
      async del(key: string) {
        kvState.rows.delete(key);
        kvState.expiresAt.delete(key);
        return 1;
      },
    },
  };
});

const sent = vi.hoisted(() => [] as Array<{ to: string; html: string }>);
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: {
      send: vi.fn(async (m: { to: string; html: string }) => {
        sent.push(m);
        return { id: 'mock' };
      }),
    },
  })),
}));

import { DELETE, GET, POST } from '@/app/api/whitelist/route';

const ADMIN = 'test-admin-password';
const KEY = 'whitelist:data';
const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

const APPROVED = {
  approved: [
    { wallet: 'DevAAAA1111', email: 'a@dev.io', approvedAt: '2026-09-01T00:00:00Z', approvedBy: 'admin' },
    { wallet: 'DevBBBB2222', email: 'b@dev.io', approvedAt: '2026-09-02T00:00:00Z', approvedBy: 'admin' },
  ],
  pending: [],
};

function req(
  method: 'GET' | 'POST' | 'DELETE',
  opts: { url?: string; body?: string | object; ip?: string; admin?: string } = {},
): NextRequest {
  const headers: Record<string, string> = { 'x-real-ip': opts.ip ?? '198.51.100.7' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.admin !== undefined) headers['x-admin-password'] = opts.admin;
  return new NextRequest(`http://localhost:3000${opts.url ?? '/api/whitelist'}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
  } as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

function stored(): { approved: Array<{ wallet: string }>; pending: Array<{ wallet: string }> } {
  return kvState.rows.get(KEY) as never;
}

beforeEach(() => {
  kvState.rows.clear();
  kvState.writes.length = 0;
  kvState.failNextGetOf = null;
  kvState.hangNextGetOf = null;
  kvState.getDelayMs = 0;
  kvState.dataReadDelays.length = 0;
  kvState.failCounterCommands.length = 0;
  kvState.expiresAt.clear();
  sent.length = 0;
  vi.unstubAllEnvs();
  vi.stubEnv('ADMIN_PASSWORD', ADMIN);
  vi.stubEnv('RESEND_API_KEY', 're_test_key_not_real');
  vi.stubEnv('EMAIL_FROM', 'Protocol 01 <team@example.test>');
  vi.stubEnv('DISCORD_WEBHOOK', '');
  vi.stubEnv('WHITELIST_APPROVAL_MAIL_TO', 'operator@example.test');
});

describe('F42: a whitelist read that fails is never written back as an empty list', () => {
  it('a public request during a failed read answers 503 and writes nothing', async () => {
    kvState.rows.set(KEY, APPROVED);
    kvState.failNextGetOf = KEY;
    const res = await POST(req('POST', { body: { wallet: 'SomeStranger999' } }));
    expect(res.status, 'a failed read was answered as if the list were empty').toBe(503);
    expect(kvState.writes.filter((w) => w.key === KEY), 'the list was rewritten').toEqual([]);
    expect(stored().approved).toHaveLength(2);
  });

  it('an admin removal during a failed read answers 503 and writes nothing', async () => {
    kvState.rows.set(KEY, APPROVED);
    kvState.failNextGetOf = KEY;
    const res = await DELETE(req('DELETE', { body: { wallet: 'DevAAAA1111' }, admin: ADMIN }));
    expect(res.status).toBe(503);
    expect(kvState.writes.filter((w) => w.key === KEY)).toEqual([]);
    expect(stored().approved).toHaveLength(2);
  });

  it('control: an empty store (no row yet) is still an empty list, and a request is stored', async () => {
    const res = await POST(req('POST', { body: { wallet: WALLET } }));
    expect(res.status).toBe(200);
    expect(stored().pending.map((e) => e.wallet)).toEqual([WALLET]);
  });
});

describe('F13: the public request is limited, capped and never loses a concurrent one', () => {
  it('one address cannot file an unbounded number of requests', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) {
      const res = await POST(req('POST', { body: { wallet: `Spam${i}Wallet${'x'.repeat(20)}` } }));
      statuses.push(res.status);
    }
    expect(statuses, 'thirty requests from one address were all accepted').toContain(429);
    expect(stored().pending.length).toBeLessThanOrEqual(5);
    // Another address is not punished for the first one.
    const other = await POST(req('POST', { body: { wallet: WALLET }, ip: '203.0.113.9' }));
    expect(other.status).toBe(200);
  });

  it('an oversized body is refused before anything is read or written', async () => {
    const res = await POST(
      req('POST', { body: JSON.stringify({ wallet: WALLET, projectName: 'a', pad: 'x'.repeat(20_000) }) }),
    );
    expect(res.status).toBe(413);
    expect(kvState.writes.filter((w) => w.key === KEY)).toEqual([]);
  });

  it('two requests at the same moment are both kept', async () => {
    kvState.getDelayMs = 25;
    const [a, b] = await Promise.all([
      POST(req('POST', { body: { wallet: 'ConcurrentAAAA1111' }, ip: '203.0.113.21' })),
      POST(req('POST', { body: { wallet: 'ConcurrentBBBB2222' }, ip: '203.0.113.22' })),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(stored().pending.map((e) => e.wallet).sort(), 'one of two concurrent requests was lost').toEqual([
      'ConcurrentAAAA1111',
      'ConcurrentBBBB2222',
    ]);
  });

  it('the pending list stops at 1,000: a new request answers 503 and writes nothing', async () => {
    const pending = Array.from({ length: 1000 }, (_, i) => ({
      wallet: `Queued${i}Wallet`,
      approvedAt: '2026-09-01T00:00:00Z',
      approvedBy: '',
    }));
    kvState.rows.set(KEY, { approved: [], pending });
    const res = await POST(req('POST', { body: { wallet: WALLET }, ip: '203.0.113.60' }));
    expect(res.status, 'a request past the pending cap was accepted').toBe(503);
    expect(kvState.writes.filter((w) => w.key === KEY), 'the list was rewritten past its cap').toEqual([]);
    expect(stored().pending).toHaveLength(1000);
    // Control: one below the cap, the same request is stored.
    kvState.rows.set(KEY, { approved: [], pending: pending.slice(1) });
    const ok = await POST(req('POST', { body: { wallet: WALLET }, ip: '203.0.113.61' }));
    expect(ok.status).toBe(200);
    expect(stored().pending).toHaveLength(1000);
  });

  it('a lock left behind by a killed holder expires even while requests keep arriving', async () => {
    // The first writer takes the lock and is killed mid-request (a function
    // timeout: its read never answers, its `finally` never runs). Requests then
    // arrive every second for 40 s. The lock's TTL is 10 s, so the requests
    // that arrive after it must get through; a waiter that re-arms the TTL on
    // every retry keeps a dead lock alive for as long as traffic lasts.
    vi.useFakeTimers();
    try {
      kvState.hangNextGetOf = KEY;
      void POST(req('POST', { body: { wallet: 'KilledHolderWallet1111' }, ip: '203.0.113.30' }));
      await vi.advanceTimersByTimeAsync(10);
      const t0 = Date.now();
      const results: Array<Promise<{ startedAt: number; status: number }>> = [];
      for (let i = 0; i < 40; i++) {
        const startedAt = Date.now() - t0;
        results.push(
          POST(req('POST', { body: { wallet: `Arrival${i}Wallet` }, ip: `198.18.0.${i + 1}` })).then((r) => ({
            startedAt,
            status: r.status,
          })),
        );
        await vi.advanceTimersByTimeAsync(1000);
      }
      await vi.advanceTimersByTimeAsync(10_000);
      const out = await Promise.all(results);
      const late = out.filter((r) => r.startedAt >= 15_000);
      expect(
        late.filter((r) => r.status !== 200).map((r) => `${r.startedAt}ms:${r.status}`),
        'requests arriving well after the TTL were still refused: the dead lock never expired',
      ).toEqual([]);
      expect(out.some((r) => r.status === 200)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it('a holder that outlived its TTL does not release the lock a later writer took', async () => {
    // A takes the lock and is slow (its read answers after 15 s, past the 10 s
    // TTL). B arrives at 11 s, when A's key has expired, takes the lock, and
    // is slow too (5 s). A finishes at 15 s. A's release must NOT delete the
    // lock: it now holds B's owner value. C arrives at 15.5 s, while B still
    // holds it, and must wait for B. If A's release deleted B's lock, C walks
    // in, reads the list before B has written, and B's later write (of the list
    // it read at 11 s) drops C's entry: a lost update.
    //
    // (A's own entry is lost either way: B read the list at 11 s, before A
    // wrote. That is the residual a TTL lock cannot close once a holder outlives
    // it, documented at `withWhitelistLock`.)
    vi.useFakeTimers();
    try {
      kvState.dataReadDelays.push(15_000, 5_000);
      const t0 = Date.now();
      const a = POST(req('POST', { body: { wallet: 'SlowHolderAAAA1111' }, ip: '203.0.113.40' }));
      let aDone = false;
      void a.then(() => {
        aDone = true;
      });
      await vi.advanceTimersByTimeAsync(11_000);
      const b = POST(req('POST', { body: { wallet: 'LaterWriterBBBB2222' }, ip: '203.0.113.41' }));
      await vi.advanceTimersByTimeAsync(15_500 - (Date.now() - t0));

      const lockWrites = kvState.writes.filter((w) => w.key === 'whitelist:lock');
      expect(lockWrites, 'A and then B should each have taken the lock once').toHaveLength(2);
      const ownerB = lockWrites[1].value;
      expect(aDone, 'A should have finished by 15.5 s').toBe(true);
      expect(
        kvState.rows.get('whitelist:lock'),
        "A's release deleted the lock B was holding (it did not check the owner value)",
      ).toBe(ownerB);

      const c = POST(req('POST', { body: { wallet: 'ThirdWriterCCCC3333' }, ip: '203.0.113.42' }));
      await vi.advanceTimersByTimeAsync(10_000);
      const [ra, rb, rc] = await Promise.all([a, b, c]);
      expect([ra.status, rb.status, rc.status]).toEqual([200, 200, 200]);
      expect(
        stored().pending.map((e) => e.wallet),
        "C was let in while B held the lock, and B's write dropped C's entry",
      ).toEqual(expect.arrayContaining(['LaterWriterBBBB2222', 'ThirdWriterCCCC3333']));
      expect(kvState.rows.has('whitelist:lock'), 'the last holder did not release the lock').toBe(false);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});

describe('F75: the request cannot choose who receives the approval mail', () => {
  it('the approval mail goes to the operator address only, never to the address a stranger typed', async () => {
    const res = await POST(
      req('POST', { body: { wallet: WALLET, email: 'stranger@victim.example', projectName: 'Lure' } }),
    );
    expect(res.status).toBe(200);
    const approve = await POST(req('POST', { body: { wallet: WALLET, action: 'approve' }, admin: ADMIN }));
    expect(approve.status).toBe(200);
    expect(sent.map((m) => m.to), 'a mail went to the address the anonymous request named').not.toContain(
      'stranger@victim.example',
    );
    expect(sent.map((m) => m.to)).toEqual(['operator@example.test']);
  });

  it('with no operator address configured, no approval mail is sent at all', async () => {
    vi.stubEnv('WHITELIST_APPROVAL_MAIL_TO', '');
    vi.stubEnv('REPORT_EMAIL_TO', '');
    await POST(req('POST', { body: { wallet: WALLET, email: 'dev@example.com' } }));
    await POST(req('POST', { body: { wallet: WALLET, action: 'approve' }, admin: ADMIN }));
    expect(sent).toEqual([]);
  });
});

describe('F64: the admin password cannot be guessed without limit', () => {
  it('wrong guesses from one address are cut off, and the right password is then refused too', async () => {
    kvState.rows.set(KEY, APPROVED);
    const statuses: Record<number, number> = {};
    for (let i = 0; i < 40; i++) {
      const res = await GET(req('GET', { url: '/api/whitelist?admin=true', admin: `guess-${i}` }));
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
    }
    expect(statuses[429] ?? 0, `statuses ${JSON.stringify(statuses)}`).toBeGreaterThan(0);
    expect(statuses[401] ?? 0).toBeLessThanOrEqual(10);
    // Locked: a correct guess from the same address is not told it is correct.
    const right = await GET(req('GET', { url: '/api/whitelist?admin=true', admin: ADMIN }));
    expect(right.status).toBe(429);
    // Another address with the right password still gets in.
    const other = await GET(req('GET', { url: '/api/whitelist?admin=true', admin: ADMIN, ip: '203.0.113.50' }));
    expect(other.status).toBe(200);
  });

  it('guesses spread over many addresses hit a global ceiling', async () => {
    for (let i = 0; i < 120; i++) {
      await GET(req('GET', { url: '/api/whitelist?admin=true', admin: `guess-${i}`, ip: `10.0.${i >> 8}.${i & 255}` }));
    }
    const fresh = await GET(req('GET', { url: '/api/whitelist?admin=true', admin: ADMIN, ip: '192.0.2.200' }));
    expect(fresh.status).toBe(429);
  });

  it('the approve / revoke / delete actions are behind the same limit', async () => {
    for (let i = 0; i < 12; i++) {
      await POST(req('POST', { body: { wallet: WALLET, action: 'approve' }, admin: `guess-${i}` }));
    }
    const res = await DELETE(req('DELETE', { body: { wallet: WALLET }, admin: `guess-x` }));
    expect(res.status).toBe(429);
  });

  // verify r2: an attempt counter the store cannot keep is not a zero. If a
  // matching password were let through while the counters fail, a KV outage
  // would switch the guessing limit off, silently.
  for (const broken of ['incr', 'get', 'expire'] as const) {
    it(`a counter store whose ${broken} fails refuses the right password with 503 (GET ?admin=true and approve)`, async () => {
      kvState.rows.set(KEY, APPROVED);
      kvState.failCounterCommands.push(broken);
      const res = await GET(req('GET', { url: '/api/whitelist?admin=true', admin: ADMIN }));
      expect(res.status, `the right password got in while the counters' ${broken} was failing`).toBe(503);
      expect(JSON.stringify(await res.json())).not.toContain('DevAAAA1111');
      const approve = await POST(req('POST', { body: { wallet: WALLET, action: 'approve' }, admin: ADMIN }));
      expect(approve.status).toBe(503);
      expect(kvState.writes.filter((w) => w.key === KEY), 'the list was written during the outage').toEqual([]);
      // Control: once the counters work again, the same request gets in.
      kvState.failCounterCommands.length = 0;
      const ok = await GET(req('GET', { url: '/api/whitelist?admin=true', admin: ADMIN }));
      expect(ok.status).toBe(200);
    });
  }
});

describe('F13 log hygiene: a failed write is answered, and nothing is left half-written', () => {
  it('a KV write that fails answers 500 and the lock is released for the next request', async () => {
    const { kv } = await import('@vercel/kv');
    // The WHITELIST write fails (not the lock's own command, which is also a set).
    const realSet = kv.set.bind(kv) as (...a: unknown[]) => Promise<unknown>;
    let failed = false;
    const spy = vi.spyOn(kv, 'set').mockImplementation((async (...a: unknown[]) => {
      if (a[0] === KEY && !failed) {
        failed = true;
        throw new Error('ERR write refused');
      }
      return realSet(...a);
    }) as never);
    const res = await POST(req('POST', { body: { wallet: WALLET } }));
    expect(res.status).toBe(500);
    spy.mockRestore();
    const again = await POST(req('POST', { body: { wallet: WALLET }, ip: '203.0.113.77' }));
    expect(again.status).toBe(200);
    expect(stored().pending.map((e) => e.wallet)).toEqual([WALLET]);
  });
});

/**
 * [close-v1 F64, gate r1 open item 2] THE WHITELIST ANSWERS TO ADMIN_PASSWORD
 * ONLY. `WAITLIST_STATS_TOKEN` is a read-only credential for the waitlist
 * counters; it is handed to dashboards, and it must never approve, revoke or
 * list developers. `checkAdminAuth(…, { statsToken: false })` is what says so,
 * and until this block no test did: the mutant `statsToken: true` survived all
 * 126 lane tests (close-v1 L3 verifier). Every case below goes red on it
 * (close-v1/blockers/f64-mutant.log).
 */
describe('F64: the stats token is not an admin credential here', () => {
  const STATS = 'test-stats-token-read-only';
  const bearer = (method: 'GET' | 'POST' | 'DELETE', url: string, body?: object) => {
    const r = req(method, { url, body });
    r.headers.set('authorization', `Bearer ${STATS}`);
    return r;
  };

  beforeEach(() => {
    vi.stubEnv('WAITLIST_STATS_TOKEN', STATS);
  });

  it('the admin list is refused to the stats token, and nothing about it is served', async () => {
    kvState.rows.set(KEY, APPROVED);
    const res = await GET(bearer('GET', '/api/whitelist?admin=true'));
    expect(res.status, 'the stats token read the developer list').toBe(401);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('DevAAAA1111');
    expect(text).not.toContain('a@dev.io');
  });

  it('approve and delete are refused to the stats token, and the list is not written', async () => {
    kvState.rows.set(KEY, { approved: [], pending: [{ wallet: WALLET, requestedAt: '2026-09-20T00:00:00Z' }] });
    const approve = await POST(bearer('POST', '/api/whitelist', { wallet: WALLET, action: 'approve' }));
    expect(approve.status, 'the stats token approved a developer').toBe(401);
    const del = await DELETE(bearer('DELETE', '/api/whitelist', { wallet: WALLET }));
    expect(del.status, 'the stats token deleted a developer').toBe(401);
    expect(kvState.writes.filter((w) => w.key === KEY), 'the list was written').toEqual([]);
    expect(sent, 'an approval mail went out').toEqual([]);
  });

  it('with no ADMIN_PASSWORD set, a stats token does not make the whitelist configured', async () => {
    vi.stubEnv('ADMIN_PASSWORD', '');
    kvState.rows.set(KEY, APPROVED);
    const res = await GET(bearer('GET', '/api/whitelist?admin=true'));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain('DevAAAA1111');
  });

  it('control: with the stats token set too, the admin password still gets in', async () => {
    kvState.rows.set(KEY, APPROVED);
    const res = await GET(req('GET', { url: '/api/whitelist?admin=true', admin: ADMIN }));
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain('DevAAAA1111');
  });
});
