/**
 * close-v1, lane L3, verify r2: F64 when the attempt counters cannot be kept.
 *
 * `checkAdminAuth` counts every presented credential in the store BEFORE it
 * compares it. If the store cannot count (a KV outage, or no store at all), the
 * limiter is off, so the request must be refused 503, the RIGHT password
 * included. Letting a matching password through on a store error would switch
 * the guessing limit off for as long as the outage lasts, and nothing would
 * notice: two mutants that did exactly that (verify r2,
 * `mut/F64r2-store-error-open.log`, `mut/F64r2-nostore-open.log`) stayed green
 * across every existing test.
 *
 * The route side of the same rule is pinned in `closeV1L3Whitelist.test.ts`
 * ("F64: a counter store that fails refuses the right password").
 *
 * Run: cd apps/web && npx vitest run __tests__/api/closeV1L3AdminAuthStoreFail.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAdminAuth, type AttemptCounterStore } from '@/lib/waitlist/auth';

const RIGHT = 'right-password-xyz';
const STATS = 'stats-token-xyz';

type Command = 'incr' | 'get' | 'expire';

/** A working in-memory store, except that `broken` commands throw. */
function store(broken: Command[] = []): AttemptCounterStore & { calls: string[] } {
  const rows = new Map<string, number>();
  const calls: string[] = [];
  const maybeFail = (cmd: Command) => {
    calls.push(cmd);
    if (broken.includes(cmd)) throw new Error('fetch failed');
  };
  return {
    calls,
    async get<T>(k: string) {
      maybeFail('get');
      return (rows.get(k) ?? null) as T | null;
    },
    async incr(k: string) {
      maybeFail('incr');
      const n = (rows.get(k) ?? 0) + 1;
      rows.set(k, n);
      return n;
    },
    async expire() {
      maybeFail('expire');
      return 1;
    },
  };
}

const byPassword = (pw: string) => ({ headers: new Headers({ 'x-admin-password': pw, 'x-real-ip': '198.51.100.9' }) });
const byBearer = (t: string) => ({ headers: new Headers({ authorization: `Bearer ${t}`, 'x-real-ip': '198.51.100.9' }) });

beforeEach(() => {
  vi.stubEnv('ADMIN_PASSWORD', RIGHT);
  vi.stubEnv('WAITLIST_STATS_TOKEN', STATS);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('F64 (verify r2): a counter store that cannot count refuses the right credential', () => {
  it('control: with a working store the right password and the stats token get in', async () => {
    expect(await checkAdminAuth(byPassword(RIGHT), store(), { statsToken: false })).toEqual({ ok: true });
    expect(await checkAdminAuth(byBearer(STATS), store())).toEqual({ ok: true });
  });

  for (const broken of ['incr', 'get', 'expire'] as const) {
    it(`a store whose ${broken} throws answers 503 to the right password (whitelist and waitlist forms)`, async () => {
      const s = store([broken]);
      const pw = await checkAdminAuth(byPassword(RIGHT), s, { statsToken: false });
      expect(pw, `the right password got in while ${broken} was failing: the limiter was off`).toEqual({
        ok: false,
        status: 503,
      });
      expect(s.calls, 'the store was never asked').toContain(broken);
      expect(await checkAdminAuth(byPassword(RIGHT), store([broken]))).toEqual({ ok: false, status: 503 });
      expect(await checkAdminAuth(byBearer(STATS), store([broken]))).toEqual({ ok: false, status: 503 });
    });

    it(`a store whose ${broken} throws answers 503, not 401, to a wrong password`, async () => {
      expect(await checkAdminAuth(byPassword('wrong'), store([broken]), { statsToken: false })).toEqual({
        ok: false,
        status: 503,
      });
    });
  }

  it('no store at all answers 503 to the right password and to the stats token', async () => {
    expect(
      await checkAdminAuth(byPassword(RIGHT), null, { statsToken: false }),
      'the right password got in with no counter store: the limiter was off',
    ).toEqual({ ok: false, status: 503 });
    expect(await checkAdminAuth(byPassword(RIGHT), null)).toEqual({ ok: false, status: 503 });
    expect(await checkAdminAuth(byBearer(STATS), null)).toEqual({ ok: false, status: 503 });
    expect(await checkAdminAuth(byPassword('wrong'), null)).toEqual({ ok: false, status: 503 });
  });

  it('control: a request with no credential is still 401 and costs no store command, even on a broken store', async () => {
    const s = store(['incr', 'get', 'expire']);
    expect(await checkAdminAuth({ headers: new Headers({ 'x-real-ip': '198.51.100.9' }) }, s)).toEqual({
      ok: false,
      status: 401,
    });
    expect(s.calls).toEqual([]);
  });
});
