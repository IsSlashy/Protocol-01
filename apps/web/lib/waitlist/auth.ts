/**
 * Shared admin auth for the waitlist stats and export endpoints.
 *
 * Accepts either a bearer token (WAITLIST_STATS_TOKEN) or the existing admin
 * password header (x-admin-password / ADMIN_PASSWORD) so ops can reuse either
 * credential. Comparisons are constant-time to avoid leaking the secret length
 * or a prefix through response timing.
 */
import { timingSafeEqual } from 'node:crypto';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export type AuthResult = { ok: true } | { ok: false; status: 401 | 503 };

/**
 * Returns { ok: true } when the request carries a valid credential.
 * 503 when neither server secret is configured; 401 when creds are wrong or
 * missing.
 */
export function checkAdminAuth(req: Request): AuthResult {
  const statsToken = process.env.WAITLIST_STATS_TOKEN;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!statsToken && !adminPassword) {
    return { ok: false, status: 503 };
  }

  const authz = req.headers.get('authorization');
  const bearer = authz?.startsWith('Bearer ') ? authz.slice(7) : null;
  if (statsToken && bearer && safeEqual(bearer, statsToken)) {
    return { ok: true };
  }

  const adminHeader = req.headers.get('x-admin-password');
  if (adminPassword && adminHeader && safeEqual(adminHeader, adminPassword)) {
    return { ok: true };
  }

  return { ok: false, status: 401 };
}
