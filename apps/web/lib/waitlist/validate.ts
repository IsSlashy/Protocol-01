/**
 * Pure validation and normalization helpers for the waitlist.
 *
 * This module is intentionally free of any KV or Resend imports: the unit
 * tests import it directly under the jsdom environment, and route handlers
 * reuse the exact same rules so the API contract stays consistent. Only
 * node:crypto (available in both the test and Node runtimes) is used here.
 */
import { createHash, createHmac } from 'node:crypto';

export const INTERESTS = ['mobile', 'extension', 'sdk'] as const;
export type Interest = (typeof INTERESTS)[number];

/**
 * The languages the site ships. Japanese was dropped on 2026-08-11.
 *
 * Records signed up before that date can still carry locale 'ja' in KV. Nothing
 * breaks: `sanitizeLocale` maps any unknown value to English, and the email
 * copy lookup falls back to English too (see lib/waitlist/email.ts). What does
 * change is the stats breakdown, which now counts en and fr only — the old
 * `wl:loc:ja` counter is left untouched in KV rather than deleted, so it is
 * still there if the language ever comes back.
 */
export const LOCALES = ['en', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];

/** RFC-lite email shape: one @, a dot in the domain, no whitespace. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Trim, lowercase and validate an email. Returns the normalized address or
 * null when it is empty, longer than 254 chars, or fails the shape check.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > 254) return null;
  if (!EMAIL_RE.test(email)) return null;
  return email;
}

/** Accept only the known interest tags; anything else is dropped. */
export function sanitizeInterest(raw: unknown): Interest | undefined {
  return typeof raw === 'string' && (INTERESTS as readonly string[]).includes(raw)
    ? (raw as Interest)
    : undefined;
}

/** Coerce to a supported locale, defaulting to English. */
export function sanitizeLocale(raw: unknown): Locale {
  return typeof raw === 'string' && (LOCALES as readonly string[]).includes(raw)
    ? (raw as Locale)
    : 'en';
}

/**
 * Free-form attribution source, lowercased and reduced to a safe character
 * set so it can be used as a Redis key segment. Capped at 64 chars; an empty
 * result becomes undefined.
 */
export function sanitizeSource(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw
    .slice(0, 256)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]/g, '')
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * ISO 3166-1 alpha-2 country code from Vercel's x-vercel-ip-country header.
 * Two ASCII letters, uppercased; anything else is dropped. The IP itself is
 * never stored, only this coarse country tag.
 */
export function sanitizeCountry(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cc = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(cc) ? cc : undefined;
}

/** Hex-encoded SHA-256 of the input. Used for token and IP hashing. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Hash of a confirmation token. We only ever persist this hash, never the raw
 * token, so a leak of the KV store cannot be replayed into working links.
 */
export function tokenHash(token: string): string {
  return sha256Hex(token);
}

/** True when the value looks like a 32-byte hex token from randomBytes(32). */
export function isTokenShape(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[0-9a-f]{64}$/.test(raw);
}

/**
 * ⛔ THE UNSUBSCRIBE LINK CARRIES ITS OWN TOKEN (audit v1 round 2, F41).
 *
 * The confirmation mail used to put the SAME token in two GET links, confirm
 * and unsubscribe, and the unsubscribe GET deleted the record. A gateway or a
 * preview that follows every link in a mail confirmed the reader and then
 * removed them (`audit-v1-opus/r2-server/probes/p6-waitlist-oneclick.probe.test.ts`).
 *
 * The unsubscribe token is HMAC-SHA256 keyed by the confirmation token over a
 * fixed domain, so it is a different 32-byte value, and it is indexed under a
 * domain-separated hash (`unsubscribeTokenHash`), so presenting it to the
 * confirm route finds nothing, and a confirmation token presented as an
 * unsubscribe token finds nothing either. Anyone holding the mail holds both
 * links; the separation is about which ACTION a link can trigger, not secrecy.
 * The GET on the unsubscribe link only shows a confirmation page; the removal
 * is a POST (RFC 8058 one-click). Pinned by
 * `__tests__/api/closeV1L3Waitlist.test.ts`, "F41".
 */
const UNSUBSCRIBE_TOKEN_DOMAIN = 'p01:waitlist:unsubscribe-token:v1';
const UNSUBSCRIBE_INDEX_DOMAIN = 'p01:waitlist:unsubscribe-index:v1';

/** The unsubscribe token that goes with a confirmation token: 64 hex, like it. */
export function unsubscribeToken(confirmToken: string): string {
  return createHmac('sha256', confirmToken).update(UNSUBSCRIBE_TOKEN_DOMAIN).digest('hex');
}

/** Where an unsubscribe token is indexed. Never equal to `tokenHash` of anything. */
export function unsubscribeTokenHash(token: string): string {
  return sha256Hex(`${UNSUBSCRIBE_INDEX_DOMAIN}\u0000${token}`);
}

/**
 * ⛔ THE UNSUBSCRIBE INDEX ROW IS DELETED WITH THE RECORD (close-v1 verify r1,
 * F41 follow-up).
 *
 * The unsubscribe index row (`wl:tok:<unsubscribeTokenHash>`) holds the email in
 * plaintext, like the confirmation index. The first F41 fix wrote one per mail
 * and deleted none of them, so the address stayed in the store after its owner
 * had unsubscribed or been purged (verify-r1/probe-unsub-leftover.log). The
 * record now carries the hash of its CURRENT unsubscribe row, so every path that
 * rotates the token (resend, reminder) replaces that row, and every path that
 * removes the record (unsubscribe by either token, the purge of addresses that
 * never confirmed) deletes it. Only the latest mail's unsubscribe link works,
 * exactly like its confirm link.
 *
 * The field is read through this helper because `WaitlistRecord`
 * (lib/waitlist/store.ts) does not declare it yet; records are stored whole, so
 * it survives every read-spread-write.
 */
export interface UnsubscribeIndexed {
  unsubscribeHash?: string;
}

/** The unsubscribe index hash a stored record names, or null (older records have none). */
export function storedUnsubscribeHash(record: unknown): string | null {
  const v = record && typeof record === 'object' ? (record as UnsubscribeIndexed).unsubscribeHash : undefined;
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : null;
}

/** The unsubscribe index hash that goes with a confirmation token. */
export function unsubscribeHashFor(confirmToken: string): string {
  return unsubscribeTokenHash(unsubscribeToken(confirmToken));
}
