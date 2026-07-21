/**
 * Pure validation and normalization helpers for the waitlist.
 *
 * This module is intentionally free of any KV or Resend imports: the unit
 * tests import it directly under the jsdom environment, and route handlers
 * reuse the exact same rules so the API contract stays consistent. Only
 * node:crypto (available in both the test and Node runtimes) is used here.
 */
import { createHash } from 'node:crypto';

export const INTERESTS = ['mobile', 'extension', 'sdk', 'merchant'] as const;
export type Interest = (typeof INTERESTS)[number];

export const LOCALES = ['en', 'fr', 'ja'] as const;
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
