/**
 * Shared admin auth for the waitlist stats / export / remind / report endpoints
 * and the developer whitelist.
 *
 * Accepts either a bearer token (WAITLIST_STATS_TOKEN) or the existing admin
 * password header (x-admin-password / ADMIN_PASSWORD) so ops can reuse either
 * credential (the whitelist accepts the password only). Comparisons are
 * constant-time to avoid leaking the secret length or a prefix through response
 * timing.
 *
 * ⛔ EVERY GUESS IS COUNTED BEFORE IT IS COMPARED, AND A LOCKED CALLER IS NOT
 * TOLD WHEN IT IS RIGHT (audit v1 round 3, F64). The comparison used to be the
 * only gate: 5,000 wrong guesses from one address in 133 ms, then the right one
 * answered 200 (`audit-v1-opus/r3-server/p2/probe-admin-guessing.summary.log`).
 *
 * The attempt is RESERVED first: every presented credential adds one (`incr`,
 * atomic in the store) to a per-address counter and to a global one, both for
 * the current UTC hour, and the request is refused 429 when the value its own
 * `incr` returned is past the ceiling, BEFORE the credential is compared, the
 * right one included, so the lockout is not an oracle. Counting after the
 * comparison (the first version of this fix) was read-then-compare-then-count:
 * every request of a concurrent burst read the counters before any of them
 * counted, and 200 wrong guesses sent at once were all compared, the right one
 * among them accepted (close-v1 verify r1, `probe-admin-parallel.log`). Each
 * `incr` answers a distinct value, so at most the ceiling's worth of requests
 * in any burst is ever compared.
 *
 * A credential that MATCHES is then given back by counting it on a second
 * counter (`...:ok`), and the ceiling applies to attempts minus matches: the
 * operator's own successful requests never lock the operator out. (The store
 * interface has no `decr`; a second `incr` counter is the same arithmetic.) An
 * attacker cannot add matches without the credential.
 *
 * A request that presents no credential at all is not a guess and costs no
 * store command. A store that cannot be read or written answers 503, the
 * right credential included: an unreadable counter is not a zero, and letting
 * a match through would switch the limit off for as long as the store is down
 * (`__tests__/api/closeV1L3AdminAuthStoreFail.test.ts`). Pinned by
 * `__tests__/api/closeV1L3AdminAuthBurst.test.ts` (concurrent bursts),
 * `__tests__/api/closeV1L3Whitelist.test.ts` and `closeV1L3Waitlist.test.ts`
 * ("F64").
 *
 * ⚠️ THE GLOBAL CEILING IS ALSO A LOCKOUT FOR THE OPERATOR. Someone spreading
 * wrong guesses over many addresses closes the admin surfaces for the rest of
 * the hour. That is the price of a limit that many addresses cannot walk around,
 * and the cron calls (CRON_SECRET, checked by the routes before this) are not
 * affected.
 */
import { timingSafeEqual } from 'node:crypto';
import { clientIp, rateLimitBucket, type HeaderSource } from '@/lib/net/clientIp';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export type AuthResult = { ok: true } | { ok: false; status: 401 | 429 | 503 };

/** The store commands the attempt counters need. `@vercel/kv` and the waitlist `KvLike` both have them. */
export interface AttemptCounterStore {
  get<T>(key: string): Promise<T | null>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

/** Wrong credentials one address may present in one UTC hour. */
export const ADMIN_FAILURES_PER_ADDRESS = 10;
/** Wrong credentials all addresses together may present in one UTC hour. */
export const ADMIN_FAILURES_GLOBAL = 100;

const WINDOW_SECONDS = 3600;
const RATE_SALT = 'p01:admin-auth:v1';

/**
 * `address` and `global` count every presented credential (attempts); the
 * `...Ok` twins count the ones that matched. Both carry the `adm:fail:` prefix
 * the stores' test fakes key on.
 */
function counterKeys(ip: string): { address: string; global: string; addressOk: string; globalOk: string } {
  const hour = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)
  const address = `adm:fail:${rateLimitBucket(RATE_SALT, hour, ip)}:${hour}`;
  const global = `adm:fail:all:${hour}`;
  return { address, global, addressOk: `${address}:ok`, globalOk: `${global}:ok` };
}

function asCount(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

type Verdict = 'match' | 'mismatch' | 'absent' | 'unconfigured';

function credentialVerdict(req: HeaderSource, opts: { statsToken: boolean }): Verdict {
  const statsToken = opts.statsToken ? process.env.WAITLIST_STATS_TOKEN : undefined;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!statsToken && !adminPassword) return 'unconfigured';

  const authz = req.headers.get('authorization');
  const bearer = opts.statsToken && authz?.startsWith('Bearer ') ? authz.slice(7) : null;
  const adminHeader = req.headers.get('x-admin-password');
  if (!bearer && !adminHeader) return 'absent';

  if (statsToken && bearer && safeEqual(bearer, statsToken)) return 'match';
  if (adminPassword && adminHeader && safeEqual(adminHeader, adminPassword)) return 'match';
  return 'mismatch';
}

/**
 * Returns { ok: true } when the request carries a valid credential and its
 * address is not locked out. 503 when no server secret is configured or the
 * counter store is missing or failing; 429 when the address or the whole
 * surface is past its ceiling for this hour; 401 when the credential is wrong
 * or missing.
 *
 * `statsToken: false` (the whitelist) accepts the admin password only.
 */
export async function checkAdminAuth(
  req: HeaderSource,
  store: AttemptCounterStore | null,
  opts: { statsToken?: boolean } = {},
): Promise<AuthResult> {
  const verdict = credentialVerdict(req, { statsToken: opts.statsToken ?? true });
  if (verdict === 'unconfigured') return { ok: false, status: 503 };
  if (verdict === 'absent') return { ok: false, status: 401 };
  if (!store) return { ok: false, status: 503 };

  const keys = counterKeys(clientIp(req));
  try {
    // 1. Reserve the attempt. The values these two `incr` return are this
    //    request's own places in the hour, distinct across a concurrent burst.
    const [address, global] = await Promise.all([store.incr(keys.address), store.incr(keys.global)]);
    await Promise.all([
      store.expire(keys.address, WINDOW_SECONDS),
      store.expire(keys.global, WINDOW_SECONDS),
    ]);
    // 2. Give back the attempts that matched, then refuse past either ceiling,
    //    before the credential is compared.
    const [addressOk, globalOk] = await Promise.all([
      store.get<number>(keys.addressOk),
      store.get<number>(keys.globalOk),
    ]);
    if (
      asCount(address) - asCount(addressOk) > ADMIN_FAILURES_PER_ADDRESS ||
      asCount(global) - asCount(globalOk) > ADMIN_FAILURES_GLOBAL
    ) {
      return { ok: false, status: 429 };
    }
    if (verdict !== 'match') return { ok: false, status: 401 };
  } catch {
    return { ok: false, status: 503 };
  }
  // 3. A match: count it as given back. A failure here only leaves the attempt
  //    counted (the conservative side), so the request is still let in.
  try {
    await Promise.all([store.incr(keys.addressOk), store.incr(keys.globalOk)]);
    await Promise.all([
      store.expire(keys.addressOk, WINDOW_SECONDS),
      store.expire(keys.globalOk, WINDOW_SECONDS),
    ]);
  } catch {
    // Nothing to undo.
  }
  return { ok: true };
}

/** The error word each refusal is answered with. */
export function authErrorWord(status: 401 | 429 | 503): 'unauthorized' | 'rate_limited' | 'not_configured' {
  return status === 503 ? 'not_configured' : status === 429 ? 'rate_limited' : 'unauthorized';
}
