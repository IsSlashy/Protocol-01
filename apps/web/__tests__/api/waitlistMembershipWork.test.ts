/**
 * [SWEEP round 1 of run logs8, server lens] POST /api/waitlist does the same
 * work before it answers, whoever the address belongs to.
 *
 * THE LEAK, MEASURED (`logs8/r1-server/S4-waitlistMembership.probe.ts`). The
 * status and the bytes were already equal, `200 {"ok":true}`, for a member and
 * a stranger. The work was not: a confirmed address (or a pending one the route
 * will not mail again) answered after 3 store commands and no mail; a pending
 * address past its cooldown after 6 and one mail; an unknown address after 9 to
 * 12 and one mail. Each of those is a network round trip from the function, so
 * one request told anyone holding a candidate address whether a record exists,
 * and two requests ten minutes apart told them whether it was confirmed.
 *
 * WHAT IS PINNED. The same request in five WORLDS that differ only in what the
 * store holds for that address. What the route awaits before the response
 * resolves (store commands, in order, and mails) must not move between worlds.
 * The writes and the mail still happen, in `after()`, store first and mail
 * second, so a mail failure never loses the lead.
 *
 * Run: cd apps/web && pnpm test -- --run __tests__/api/waitlistMembershipWork.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KvLike, WaitlistRecord } from '@/lib/waitlist/store';

const h = vi.hoisted(() => ({
  deferred: [] as Array<() => unknown>,
  afterThrows: false,
  events: [] as string[],
  mailOk: true,
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    // The real `after` throws outside a request scope (error E468), so it is
    // captured here and drained by the test exactly as the runtime would run it.
    after: (task: () => unknown) => {
      if (h.afterThrows) throw new Error('`after` was called outside a request scope');
      h.deferred.push(task);
    },
  };
});

const scalars = new Map<string, unknown>();
const sets = new Map<string, Set<string>>();
const op = (name: string) => { h.events.push(name); };
const kv: KvLike = {
  async get<T>(k: string) { op('get'); return (scalars.get(k) ?? null) as T | null; },
  async set(k, v) { op('set'); scalars.set(k, v); },
  async del(k) { op('del'); scalars.delete(k); },
  async incr(k) { op('incr'); const n = Number(scalars.get(k) ?? 0) + 1; scalars.set(k, n); return n; },
  async expire() { op('expire'); },
  async sadd(k, m) { op('sadd'); (sets.get(k) ?? sets.set(k, new Set()).get(k)!).add(m); },
  async srem() { op('srem'); },
  async scard(k) { op('scard'); return sets.get(k)?.size ?? 0; },
  async smembers(k) { op('smembers'); return [...(sets.get(k) ?? [])]; },
  async mget(keys) { op('mget'); return keys.map(() => null); },
};

vi.mock('@/lib/waitlist/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/waitlist/store')>();
  return { ...actual, getStore: () => kv };
});
vi.mock('@/lib/waitlist/email', () => ({
  sendConfirmationEmail: async () => { op('MAIL'); return h.mailOk; },
}));

const { POST } = await import('@/app/api/waitlist/route');
const { NextRequest } = await import('next/server');

const ADDRESS = 'someone.asked.about@example.org';
const RECORD_KEY = 'wl:sub:' + ADDRESS;
const MINUTE = 60_000;

function record(over: Partial<WaitlistRecord>): WaitlistRecord {
  return {
    email: ADDRESS,
    status: 'pending',
    tokenHash: 'a'.repeat(64),
    locale: 'en',
    createdAt: '2026-09-01T00:00:00.000Z',
    lastSentAt: '2026-09-01T00:00:00.000Z',
    resendCount: 0,
    ...over,
  } as WaitlistRecord;
}

/** The worlds: one address, five states of the list. */
const WORLDS: Record<string, () => WaitlistRecord | null> = {
  stranger: () => null,
  confirmed: () => record({ status: 'confirmed', confirmedAt: '2026-09-01T00:05:00.000Z' } as Partial<WaitlistRecord>),
  'pending, mailed a minute ago': () => record({ lastSentAt: new Date(Date.now() - MINUTE).toISOString() }),
  'pending, past the cooldown': () => record({ lastSentAt: new Date(Date.now() - 30 * MINUTE).toISOString() }),
  'pending, out of resends': () => record({ lastSentAt: new Date(Date.now() - 30 * MINUTE).toISOString(), resendCount: 5 }),
};

async function ask(world: string) {
  scalars.clear();
  sets.clear();
  h.deferred.length = 0;
  h.events.length = 0;
  const seeded = WORLDS[world]!();
  if (seeded) scalars.set(RECORD_KEY, seeded);
  const res = await POST(
    new NextRequest('https://styx.test/api/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '198.51.100.23' },
      body: JSON.stringify({ email: ADDRESS, locale: 'en', source: 'landing', interest: 'sdk' }),
    } as unknown as ConstructorParameters<typeof NextRequest>[1]),
  );
  const beforeAnswer = [...h.events];
  const answer = `${res.status} ${JSON.stringify(await res.json())}`;
  for (const task of h.deferred.splice(0)) await task();
  return { answer, beforeAnswer, afterAnswer: h.events.slice(beforeAnswer.length) };
}

beforeEach(() => {
  h.afterThrows = false;
  h.mailOk = true;
  process.env.RESEND_API_KEY = 'test-placeholder';
});

describe('[SWEEP-R1-SERVER] POST /api/waitlist: the work before the answer does not say who is on the list', () => {
  it('the harness sees the store: the record key it seeds is the one the route reads', async () => {
    // Positive control for every case below. If the route read another key the
    // worlds would all be "stranger" and the equalities would be empty.
    const confirmed = await ask('confirmed');
    expect(confirmed.afterAnswer, 'a confirmed address was written to or mailed').toEqual([]);
    const stranger = await ask('stranger');
    expect(stranger.afterAnswer).toContain('MAIL');
  });

  it('same answer, same store commands and no mail before it, in all five worlds', async () => {
    const seen: Record<string, { answer: string; beforeAnswer: string[] }> = {};
    for (const world of Object.keys(WORLDS)) {
      const { answer, beforeAnswer } = await ask(world);
      seen[world] = { answer, beforeAnswer };
    }
    const base = seen.confirmed!;
    expect(base.answer).toBe('200 {"ok":true}');
    // Not an empty equality: the rate limit and the record read are in it.
    expect(base.beforeAnswer).toEqual(['incr', 'expire', 'get']);
    for (const [world, got] of Object.entries(seen)) {
      expect(got.answer, `${world}: the answer differs`).toBe(base.answer);
      expect(got.beforeAnswer, `${world}: the work before the answer differs from a confirmed member’s`).toEqual(
        base.beforeAnswer,
      );
      expect(got.beforeAnswer, `${world}: a mail went out before the answer`).not.toContain('MAIL');
    }
  });

  it('a stranger is still signed up, store first and mail last', async () => {
    const { afterAnswer } = await ask('stranger');
    expect(afterAnswer.at(-1)).toBe('MAIL');
    expect(afterAnswer.indexOf('set')).toBeGreaterThanOrEqual(0);
    expect(afterAnswer.indexOf('set')).toBeLessThan(afterAnswer.indexOf('MAIL'));
    const stored = scalars.get(RECORD_KEY) as WaitlistRecord;
    expect(stored.status).toBe('pending');
    expect(stored.email).toBe(ADDRESS);
    expect(sets.get('wl:emails')?.has(ADDRESS) ?? [...sets.values()].some((s) => s.has(ADDRESS))).toBe(true);
  });

  it('a pending address past the cooldown is mailed again with a new token, after the answer', async () => {
    const { afterAnswer } = await ask('pending, past the cooldown');
    expect(afterAnswer.filter((e) => e === 'MAIL').length).toBe(1);
    const stored = scalars.get(RECORD_KEY) as WaitlistRecord;
    expect(stored.resendCount).toBe(1);
    expect(stored.tokenHash).not.toBe('a'.repeat(64));
  });

  it('inside the cooldown, or out of resends, nothing is written and nothing is mailed', async () => {
    expect((await ask('pending, mailed a minute ago')).afterAnswer).toEqual([]);
    expect((await ask('pending, out of resends')).afterAnswer).toEqual([]);
  });

  it('a mail that fails is counted, and the lead is kept', async () => {
    h.mailOk = false;
    const { afterAnswer } = await ask('stranger');
    expect(afterAnswer.indexOf('MAIL')).toBeGreaterThan(0);
    expect(afterAnswer.slice(afterAnswer.indexOf('MAIL') + 1)).toContain('incr');
    expect((scalars.get(RECORD_KEY) as WaitlistRecord).status).toBe('pending');
  });

  it('outside a request scope `after()` throws: the signup is done before the answer instead of being lost', async () => {
    h.afterThrows = true;
    const { answer, beforeAnswer } = await ask('stranger');
    expect(answer).toBe('200 {"ok":true}');
    expect(beforeAnswer).toContain('MAIL');
    expect((scalars.get(RECORD_KEY) as WaitlistRecord).status).toBe('pending');
  });
});
