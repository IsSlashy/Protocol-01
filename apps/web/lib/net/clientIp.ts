/**
 * Who is calling, and the rate-limit bucket that caller is counted under.
 *
 * ONE READER. Seven routes used to parse the address headers themselves, in
 * three different orders (x-forwarded-for first, x-real-ip first, or the whole
 * forwarded chain unsplit), so one caller could land in different buckets on
 * different routes. Every app/api route now calls `clientIp` and nothing else
 * under app/api names an address header: `__tests__/lib/rateLimitKey.test.ts`
 * "no file under app/api parses an IP header itself".
 *
 * ONE BUCKET FORMULA. A counter row is what a KV dump holds, so its name must
 * not be a keyless function of the IP. With `P01_RATE_LIMIT_KEY` set the bucket
 * is the first 16 hex of HMAC-SHA256(key, route || window || ip); a /16 brute
 * force with every public salt then matches nothing (same test file, "with
 * P01_RATE_LIMIT_KEY set ..."). Unset, it keeps the historical
 * sha256(ip + salt)[0:12], which that test's positive control reverses, and the
 * readiness answers carry an advisory instead of switching anything off.
 *
 * Residual: whoever holds the KV AND the env (the key) can still test
 * candidate IPs against the rows that have not expired yet (one hour for the
 * routes, one minute for pairing).
 */
import { createHash, createHmac } from 'node:crypto';

export interface HeaderSource {
  headers: { get(name: string): string | null };
}

/** x-real-ip, else the first x-forwarded-for entry, else `'unknown'`. */
export function clientIp(req: HeaderSource): string {
  const real = req.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const first = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (first) return first;
  return 'unknown';
}

/** Below this a key is treated as unset: a short string is a guessable one. */
export const RATE_LIMIT_KEY_MIN_LENGTH = 32;

function rateLimitKey(): string | null {
  const key = process.env.P01_RATE_LIMIT_KEY?.trim() ?? '';
  return key.length >= RATE_LIMIT_KEY_MIN_LENGTH ? key : null;
}

/**
 * The bucket name for `ip` on `route` during `window` (the hour or minute the
 * counter covers). `route` is the route's rate salt, so the unkeyed fallback is
 * byte-identical to the formula it replaces.
 */
export function rateLimitBucket(route: string, window: string, ip: string): string {
  const key = rateLimitKey();
  if (!key) return createHash('sha256').update(ip + route).digest('hex').slice(0, 12);
  return createHmac('sha256', key)
    .update(`${route}\u0000${window}\u0000${ip}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Non-gating operator notes for the readiness answers. Never folded into
 * `reasons`, `configured` or `ready` ("with the key unset, configured and ready
 * stay true and advisories names the key"). Names the variable, never its value.
 */
export function rateLimitAdvisories(): string[] {
  if (rateLimitKey()) return [];
  return [
    `P01_RATE_LIMIT_KEY is unset or shorter than ${RATE_LIMIT_KEY_MIN_LENGTH} characters, so ` +
      'rate-limit rows are named by sha256(ip + a public salt) and a KV dump turns them back ' +
      'into caller IPs (__tests__/lib/rateLimitKey.test.ts). Set a random 64-hex value.',
  ];
}
