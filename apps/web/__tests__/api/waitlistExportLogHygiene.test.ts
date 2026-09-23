/**
 * What GET /api/waitlist/export leaves in the server log when the store
 * refuses the record reads.
 *
 * Run: cd apps/web && npx vitest run __tests__/api/waitlistExportLogHygiene.test.ts
 *
 * WHY THIS SUITE EXISTS
 * ─────────────────────
 * `serverLogHygiene.test.ts` pins the routes that CATCH a store failure. This
 * route caught nothing, so a failure left the handler, and what leaves a
 * handler is logged by the framework itself: Next runs `console.error(err)` on
 * it (next/dist/server/route-modules/route-module.js). The store words a
 * refused request as `${error}, command was: ${JSON.stringify(commands)}`, and
 * `collectAllRecords` reads every subscriber in one auto-pipelined round trip,
 * so that one line is `["get","wl:sub:<email>"]` for the whole list. Measured
 * on `next start` in scratchpad/web-run/logs8/r1-logs/probe-next-start-logs.log.
 *
 * The harness below therefore does what Next does with an escaped error: it
 * hands it to `console.error`. The assertions then read the log, which is what
 * the adversary (a log drain, a log dump, a support export) reads.
 *
 * The REAL `collectAllRecords` and `readRecord` run here. Only `getStore` is
 * replaced, by a store whose set read succeeds and whose record reads are
 * refused — the one order in which the emails reach the error text.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { KvLike } from '@/lib/waitlist/store';

const SUBSCRIBERS = ['alice@example.com', 'bob@example.org', 'carol@example.net'];
const ADMIN = 'test-admin-password';

/** The message @upstash/redis builds for a refused pipeline of record reads. */
function refusedBatch(): Error {
  const err = new Error(
    'ERR max daily request limit exceeded. Limit: 10000, Usage: 10000, command was: ' +
      JSON.stringify(SUBSCRIBERS.map((e) => ['get', `wl:sub:${e}`])),
  );
  err.name = 'UpstashError';
  return err;
}

let recordReads: 'refused' | 'served' = 'refused';
const reads: string[] = [];

const kv: KvLike = {
  async get<T>(key: string) {
    // close-v1 (audit v1 F64): the export now reads the admin attempt counters
    // (`adm:fail:*`) before it serves anything. Those reads are not the record
    // batch this file is about, so they are answered (no failures counted) and
    // left out of `reads`.
    if (key.startsWith('adm:fail:')) return null;
    reads.push(key);
    if (recordReads === 'refused') throw refusedBatch();
    const email = key.replace(/^wl:sub:/, '');
    return {
      email,
      status: 'confirmed',
      locale: 'en',
      createdAt: '2026-09-01T00:00:00.000Z',
      tokenHash: 'f'.repeat(64),
    } as unknown as T;
  },
  async set() {},
  async del() {},
  async incr() {
    return 1;
  },
  async expire() {},
  async sadd() {},
  async srem() {},
  async scard() {
    return SUBSCRIBERS.length;
  },
  async smembers() {
    return [...SUBSCRIBERS];
  },
  async mget() {
    return [];
  },
};

vi.mock('@/lib/waitlist/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/waitlist/store')>()),
  getStore: () => kv,
}));

import { GET } from '@/app/api/waitlist/export/route';

let logged: string[] = [];

/** Rendered the way a log writer renders an Error: name, message and stack. */
const render = (a: unknown): string =>
  a instanceof Error ? `${a.name}: ${a.message}\n${a.stack ?? ''}` : String(a);

/**
 * Call the handler the way Next does: whatever escapes it goes to
 * `console.error`, and the caller gets a bare 500.
 */
async function callAsNextDoes(url: string): Promise<{ escaped: boolean; res: Response | null }> {
  const request = new Request(url, { headers: { 'x-admin-password': ADMIN } });
  try {
    return { escaped: false, res: await GET(request) };
  } catch (err) {
    console.error(err);
    return { escaped: true, res: null };
  }
}

beforeEach(() => {
  logged = [];
  reads.length = 0;
  recordReads = 'refused';
  vi.stubEnv('ADMIN_PASSWORD', ADMIN);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(render).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(render).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('the waitlist export when the store refuses the record reads', () => {
  for (const [label, url] of [
    ['csv', 'http://localhost:3000/api/waitlist/export'],
    ['json', 'http://localhost:3000/api/waitlist/export?format=json'],
  ] as const) {
    it(`writes no subscriber email to the server log (${label})`, async () => {
      await callAsNextDoes(url);

      // The harness reached the batch this case is about: a red that never got
      // past the set read would prove nothing.
      expect(reads, 'the record reads were never attempted').toEqual(
        SUBSCRIBERS.map((e) => `wl:sub:${e}`),
      );

      const text = logged.join('\n');
      expect(text, 'nothing was logged at all').not.toBe('');
      for (const email of SUBSCRIBERS) {
        expect(text, `the server log names ${email}`).not.toContain(email);
      }
      expect(text, 'the server log carries the store command').not.toMatch(/command was/);
      expect(text, 'the server log carries a record key').not.toMatch(/wl:sub:/);
    });

    it(`answers a JSON 500 in fixed words instead of leaving the handler (${label})`, async () => {
      const { escaped, res } = await callAsNextDoes(url);

      expect(escaped, 'the store error left the handler, so the framework logs it').toBe(false);
      expect(res?.status).toBe(500);
      const body = await res!.text();
      expect(JSON.parse(body)).toEqual({ ok: false, error: 'server_error' });
      for (const email of SUBSCRIBERS) {
        expect(body, `the answer names ${email}`).not.toContain(email);
      }
      expect(body).not.toMatch(/command was/);
      expect(res?.headers.get('cache-control')).toBe('no-store');
    });
  }

  it('logs one line: a fixed tag and the error class', async () => {
    await callAsNextDoes('http://localhost:3000/api/waitlist/export');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^\[waitlist\] export failed \(UpstashError\); details withheld/);
  });
});

describe('the waitlist export when the store answers', () => {
  // The negative control: a guard that turned every export into a 500 would
  // pass every case above.
  it('still serves the csv, one row per subscriber, and logs nothing', async () => {
    recordReads = 'served';
    const { escaped, res } = await callAsNextDoes('http://localhost:3000/api/waitlist/export');
    expect(escaped).toBe(false);
    expect(res?.status).toBe(200);
    expect(res?.headers.get('content-type')).toMatch(/text\/csv/);
    const lines = (await res!.text()).split('\r\n');
    expect(lines).toHaveLength(1 + SUBSCRIBERS.length);
    expect(lines[1]).toBe('alice@example.com,confirmed,,en,,,2026-09-01T00:00:00.000Z,');
    expect(logged).toEqual([]);
  });

  it('still serves the json without the token hash', async () => {
    recordReads = 'served';
    const { res } = await callAsNextDoes('http://localhost:3000/api/waitlist/export?format=json');
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.ok).toBe(true);
    expect(body.records.map((r: { email: string }) => r.email)).toEqual(SUBSCRIBERS);
    expect(JSON.stringify(body)).not.toMatch(/tokenHash|ffffffff/);
  });
});
