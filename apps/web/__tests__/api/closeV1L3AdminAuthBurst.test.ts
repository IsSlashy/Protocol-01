/**
 * close-v1, lane L3, verify r1: F64 under concurrency.
 *
 * The first F64 fix read the attempt counters, compared the credential, and
 * only then counted a wrong one. Every request of a burst read the counters
 * before any of them counted, so none was limited: 200 concurrent wrong
 * passwords from one address were all compared, and the right password sent in
 * the same burst was accepted
 * (close-v1/L3-pool-client-and-admin-routes-verify-r1/probe-admin-parallel.log).
 * The attempt must be reserved (counted) BEFORE the comparison.
 *
 * The store below answers every command after a short delay, like a network
 * round trip, so concurrent requests interleave the way they do on Upstash.
 *
 * Run: cd apps/web && npx vitest run __tests__/api/closeV1L3AdminAuthBurst.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkAdminAuth, type AttemptCounterStore } from '@/lib/waitlist/auth';

function slowStore(): AttemptCounterStore & { rows: Map<string, number> } {
  const rows = new Map<string, number>();
  const tick = () => new Promise((r) => setTimeout(r, 2));
  return {
    rows,
    async get<T>(k: string) {
      await tick();
      return (rows.get(k) ?? null) as T | null;
    },
    async incr(k: string) {
      await tick();
      const n = (rows.get(k) ?? 0) + 1;
      rows.set(k, n);
      return n;
    },
    async expire() {
      await tick();
      return 1;
    },
  };
}

const RIGHT = 'right-password-xyz';

const req = (pw: string, ip = '198.51.100.9') => ({
  headers: new Headers({ 'x-admin-password': pw, 'x-real-ip': ip }),
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('F64 (verify r1): a burst of concurrent guesses is limited like a sequence', () => {
  it('200 concurrent wrong guesses from one address are compared at most 10 times, and the right one sent with them is refused', async () => {
    vi.stubEnv('ADMIN_PASSWORD', RIGHT);
    vi.stubEnv('WAITLIST_STATS_TOKEN', '');
    const store = slowStore();
    const out = await Promise.all([
      ...Array.from({ length: 200 }, (_, i) => checkAdminAuth(req(`wrong-${i}`), store, { statsToken: false })),
      checkAdminAuth(req(RIGHT), store, { statsToken: false }),
    ]);
    const compared = out.slice(0, 200).filter((r) => !r.ok && r.status === 401).length;
    expect(compared, 'wrong guesses compared in one burst').toBeLessThanOrEqual(10);
    expect(out[200]!.ok, 'the right password was accepted inside a burst of 200 wrong guesses').toBe(false);
  });

  it('150 concurrent wrong guesses from 150 addresses are compared at most 100 times (the global ceiling)', async () => {
    vi.stubEnv('ADMIN_PASSWORD', RIGHT);
    vi.stubEnv('WAITLIST_STATS_TOKEN', '');
    const store = slowStore();
    const out = await Promise.all(
      Array.from({ length: 150 }, (_, i) =>
        checkAdminAuth(req(`wrong-${i}`, `10.1.${i >> 8}.${i & 255}`), store, { statsToken: false }),
      ),
    );
    const compared = out.filter((r) => !r.ok && r.status === 401).length;
    expect(compared, 'wrong guesses compared in one spread burst').toBeLessThanOrEqual(100);
    const fresh = await checkAdminAuth(req(RIGHT, '192.0.2.201'), store, { statsToken: false });
    expect(fresh.ok, 'past the global ceiling the right password is still refused').toBe(false);
  });

  it('control: the operator is not locked out by their own successful requests', async () => {
    vi.stubEnv('ADMIN_PASSWORD', RIGHT);
    vi.stubEnv('WAITLIST_STATS_TOKEN', '');
    const store = slowStore();
    for (let i = 0; i < 40; i++) {
      const r = await checkAdminAuth(req(RIGHT), store, { statsToken: false });
      expect(r.ok, `successful request #${i + 1} was refused`).toBe(true);
    }
    // And a few wrong ones from the same address are still counted from zero.
    const wrong = await Promise.all(
      Array.from({ length: 12 }, (_, i) => checkAdminAuth(req(`typo-${i}`), store, { statsToken: false })),
    );
    expect(wrong.filter((r) => !r.ok && r.status === 401).length).toBeLessThanOrEqual(10);
    expect(wrong.some((r) => !r.ok && r.status === 429)).toBe(true);
  });

  it('control: a request with no credential costs no store command', async () => {
    vi.stubEnv('ADMIN_PASSWORD', RIGHT);
    const store = slowStore();
    const spy = vi.spyOn(store, 'incr');
    const r = await checkAdminAuth({ headers: new Headers({ 'x-real-ip': '198.51.100.9' }) }, store);
    expect(r).toEqual({ ok: false, status: 401 });
    expect(spy).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
  });
});
