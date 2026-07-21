/**
 * Waitlist persistence layer (Vercel KV / Upstash Redis).
 *
 * Backend resolution mirrors lib/pairStore.ts:
 *   1. Vercel KV / Upstash REST — KV_REST_API_URL + KV_REST_API_TOKEN
 *   2. Standalone Upstash       — UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *   3. In-memory dev fallback   — only in development, so `pnpm dev` works with
 *      no external services. It is NOT durable on serverless (every isolate has
 *      its own), which is why production returns 503 instead of using it.
 *
 * We persist only the SHA-256 of each confirmation token, never the raw token.
 * A dump of KV therefore cannot be replayed into working confirm/unsubscribe
 * links (the raw token lives only in the email we sent).
 */
import { createClient, type VercelKV } from '@vercel/kv';
import { randomBytes } from 'node:crypto';
import {
  INTERESTS,
  LOCALES,
  sha256Hex,
  type Interest,
  type Locale,
} from './validate';

// --- Storage record --------------------------------------------------------

export type WaitlistStatus = 'pending' | 'confirmed';

export interface WaitlistRecord {
  email: string;
  status: WaitlistStatus;
  tokenHash: string;
  interest?: Interest;
  locale: Locale;
  source?: string;
  /** ISO 3166-1 alpha-2 from Vercel's geo header; the IP is never stored. */
  country?: string;
  createdAt: string;
  confirmedAt?: string;
  lastSentAt: string;
  resendCount: number;
  /** Set once when the single 24h "confirm your spot" reminder goes out. */
  remindedAt?: string;
}

// --- Minimal KV surface ----------------------------------------------------

/**
 * The subset of Redis operations the waitlist uses. Both the real Upstash
 * client (via an adapter) and the in-memory dev shim implement this, so the
 * domain helpers below are backend-agnostic.
 */
export interface KvLike {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { ex?: number }): Promise<void>;
  del(key: string): Promise<void>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
  sadd(key: string, member: string): Promise<void>;
  srem(key: string, member: string): Promise<void>;
  scard(key: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
  mget(keys: string[]): Promise<(number | null)[]>;
}

/** Wrap the real Upstash client in the KvLike shape. */
function adaptVercelKv(client: VercelKV): KvLike {
  return {
    get: (key) => client.get(key),
    set: async (key, value, opts) => {
      await client.set(key, value, opts?.ex ? { ex: opts.ex } : undefined);
    },
    del: async (key) => {
      await client.del(key);
    },
    incr: (key) => client.incr(key),
    expire: async (key, seconds) => {
      await client.expire(key, seconds);
    },
    sadd: async (key, member) => {
      await client.sadd(key, member);
    },
    srem: async (key, member) => {
      await client.srem(key, member);
    },
    scard: (key) => client.scard(key),
    smembers: (key) => client.smembers(key),
    mget: (keys) => client.mget<(number | null)[]>(...keys),
  };
}

/** Deep-clone stored values so callers cannot mutate them through the map. */
function clone<T>(value: T): T {
  return value === null || typeof value !== 'object'
    ? value
    : (JSON.parse(JSON.stringify(value)) as T);
}

/** Development-only Redis stand-in. Not durable; single process only. */
class InMemoryKv implements KvLike {
  private scalars = new Map<string, { v: unknown; exp: number | null }>();
  private sets = new Map<string, Set<string>>();

  private read(key: string): unknown {
    const e = this.scalars.get(key);
    if (!e) return null;
    if (e.exp !== null && Date.now() > e.exp) {
      this.scalars.delete(key);
      return null;
    }
    return e.v;
  }

  async get<T>(key: string): Promise<T | null> {
    const v = this.read(key);
    return v === null ? null : (clone(v) as T);
  }

  async set(key: string, value: unknown, opts?: { ex?: number }): Promise<void> {
    this.scalars.set(key, {
      v: clone(value),
      exp: opts?.ex ? Date.now() + opts.ex * 1000 : null,
    });
  }

  async del(key: string): Promise<void> {
    this.scalars.delete(key);
    this.sets.delete(key);
  }

  async incr(key: string): Promise<number> {
    const cur = Number(this.read(key) ?? 0) || 0;
    const next = cur + 1;
    const prev = this.scalars.get(key);
    this.scalars.set(key, { v: next, exp: prev?.exp ?? null });
    return next;
  }

  async expire(key: string, seconds: number): Promise<void> {
    const e = this.scalars.get(key);
    if (e) e.exp = Date.now() + seconds * 1000;
  }

  async sadd(key: string, member: string): Promise<void> {
    const s = this.sets.get(key) ?? new Set<string>();
    s.add(member);
    this.sets.set(key, s);
  }

  async srem(key: string, member: string): Promise<void> {
    this.sets.get(key)?.delete(member);
  }

  async scard(key: string): Promise<number> {
    return this.sets.get(key)?.size ?? 0;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async mget(keys: string[]): Promise<(number | null)[]> {
    return keys.map((k) => {
      const v = this.read(k);
      return v === null ? null : Number(v) || 0;
    });
  }
}

// --- Backend selection ------------------------------------------------------

const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
const client: VercelKV | null = url && token ? createClient({ url, token }) : null;

/** True when a durable KV backend is wired (i.e. we are not on the dev shim). */
export const kvConfigured = !!client;

const realStore: KvLike | null = client ? adaptVercelKv(client) : null;

const globalRef = globalThis as unknown as { __p01WaitlistMem?: InMemoryKv };
function devMemStore(): InMemoryKv {
  if (!globalRef.__p01WaitlistMem) {
    globalRef.__p01WaitlistMem = new InMemoryKv();
    console.warn(
      '[waitlist] KV is not configured — using an in-memory dev store (not durable, dev only).',
    );
  }
  return globalRef.__p01WaitlistMem;
}

/**
 * Resolve the active store. Returns null in production when no KV backend is
 * configured, letting callers respond with 503 rather than silently dropping
 * signups into a per-isolate map.
 */
export function getStore(): KvLike | null {
  if (realStore) return realStore;
  if (process.env.NODE_ENV === 'development') return devMemStore();
  return null;
}

// --- Keys ------------------------------------------------------------------

const K = {
  record: (email: string) => `wl:sub:${email}`,
  token: (hash: string) => `wl:tok:${hash}`,
  emails: 'wl:emails',
  sources: 'wl:sources',
  countries: 'wl:countries',
  cntTotal: 'wl:cnt:total',
  cntConfirmed: 'wl:cnt:confirmed',
  cntUnsub: 'wl:cnt:unsub',
  cntMailfail: 'wl:cnt:mailfail',
  daySignups: (date: string) => `wl:day:${date}:signups`,
  dayConfirmed: (date: string) => `wl:day:${date}:confirmed`,
  interest: (i: string) => `wl:int:${i}`,
  locale: (l: string) => `wl:loc:${l}`,
  source: (s: string) => `wl:src:${s}`,
  country: (c: string) => `wl:ctry:${c}`,
  rate: (hash12: string, hour: string) => `wl:rl:${hash12}:${hour}`,
} as const;

const SOURCE_CAP = 50;
const COUNTRY_CAP = 150;

// --- Date helpers ----------------------------------------------------------

function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Last 30 UTC dates including today, oldest first. */
function last30Dates(): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push(utcDate(d));
  }
  return out;
}

// --- Tokens ----------------------------------------------------------------

/** A fresh 32-byte confirmation token, hex-encoded. */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

// --- Record helpers --------------------------------------------------------

export function readRecord(kv: KvLike, email: string): Promise<WaitlistRecord | null> {
  return kv.get<WaitlistRecord>(K.record(email));
}

export function writeRecord(kv: KvLike, record: WaitlistRecord): Promise<void> {
  return kv.set(K.record(record.email), record);
}

export function deleteRecord(kv: KvLike, email: string): Promise<void> {
  return kv.del(K.record(email));
}

export function emailForToken(kv: KvLike, hash: string): Promise<string | null> {
  return kv.get<string>(K.token(hash));
}

export function setTokenIndex(kv: KvLike, hash: string, email: string): Promise<void> {
  return kv.set(K.token(hash), email);
}

export function deleteTokenIndex(kv: KvLike, hash: string): Promise<void> {
  return kv.del(K.token(hash));
}

export function addEmailToSet(kv: KvLike, email: string): Promise<void> {
  return kv.sadd(K.emails, email);
}

export function removeEmailFromSet(kv: KvLike, email: string): Promise<void> {
  return kv.srem(K.emails, email);
}

// --- Counters --------------------------------------------------------------

async function readCounter(kv: KvLike, key: string): Promise<number> {
  const v = await kv.get<number | string | null>(key);
  return v == null ? 0 : Number(v) || 0;
}

export function incrMailFailures(kv: KvLike): Promise<number> {
  return kv.incr(K.cntMailfail);
}

export function incrUnsubscribed(kv: KvLike): Promise<number> {
  return kv.incr(K.cntUnsub);
}

/** Bump the new-signup counters and per-dimension breakdown for a record. */
export async function recordSignupCounters(kv: KvLike, record: WaitlistRecord): Promise<void> {
  const date = utcDate(new Date(record.createdAt));
  await kv.incr(K.cntTotal);
  await kv.incr(K.daySignups(date));
  await kv.incr(K.locale(record.locale));
  if (record.interest) await kv.incr(K.interest(record.interest));
  if (record.source) {
    await kv.incr(K.source(record.source));
    // Cap the tracked-source set so a spammer cannot explode the stats fan-out.
    if ((await kv.scard(K.sources)) < SOURCE_CAP) {
      await kv.sadd(K.sources, record.source);
    }
  }
  if (record.country) {
    await kv.incr(K.country(record.country));
    if ((await kv.scard(K.countries)) < COUNTRY_CAP) {
      await kv.sadd(K.countries, record.country);
    }
  }
}

/** Bump the confirmed counters for a record confirmed at the given ISO time. */
export async function recordConfirmCounters(kv: KvLike, confirmedAt: string): Promise<void> {
  await kv.incr(K.cntConfirmed);
  await kv.incr(K.dayConfirmed(utcDate(new Date(confirmedAt))));
}

// --- Rate limiting ---------------------------------------------------------

/**
 * Per-IP hourly rate limit. Returns true when the caller is over the limit.
 * The IP is hashed with a server secret so raw IPs never touch the store.
 */
export async function rateLimitExceeded(
  kv: KvLike,
  ip: string,
  salt: string,
  limit = 20,
): Promise<boolean> {
  const hash12 = sha256Hex(ip + salt).slice(0, 12);
  const hour = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)
  const key = K.rate(hash12, hour);
  const count = await kv.incr(key);
  await kv.expire(key, 3600);
  return count > limit;
}

// --- Aggregation (stats + export) ------------------------------------------

export interface DailyPoint {
  date: string;
  signups: number;
  confirmed: number;
}

export interface WaitlistStats {
  totals: {
    signups: number;
    confirmed: number;
    pending: number;
    unsubscribed: number;
    mailFailures: number;
  };
  rates: { confirmationRate: number };
  last7d: { signups: number; confirmed: number };
  last30d: { signups: number; confirmed: number };
  daily: DailyPoint[];
  breakdown: {
    interest: Record<string, number>;
    locale: Record<string, number>;
    source: Record<string, number>;
    country: Record<string, number>;
  };
}

function emptyStats(dates: string[]): WaitlistStats {
  return {
    totals: { signups: 0, confirmed: 0, pending: 0, unsubscribed: 0, mailFailures: 0 },
    rates: { confirmationRate: 0 },
    last7d: { signups: 0, confirmed: 0 },
    last30d: { signups: 0, confirmed: 0 },
    daily: dates.map((date) => ({ date, signups: 0, confirmed: 0 })),
    breakdown: {
      interest: Object.fromEntries(INTERESTS.map((i) => [i, 0])),
      locale: Object.fromEntries(LOCALES.map((l) => [l, 0])),
      source: {},
      country: {},
    },
  };
}

/** Assemble the full stats payload. Returns zeros when no store is available. */
export async function collectStats(kv: KvLike | null): Promise<WaitlistStats> {
  const dates = last30Dates();
  if (!kv) return emptyStats(dates);

  const [signups, confirmed, unsubscribed, mailFailures] = await Promise.all([
    readCounter(kv, K.cntTotal),
    readCounter(kv, K.cntConfirmed),
    readCounter(kv, K.cntUnsub),
    readCounter(kv, K.cntMailfail),
  ]);

  const [daySignups, dayConfirmed] = await Promise.all([
    kv.mget(dates.map(K.daySignups)),
    kv.mget(dates.map(K.dayConfirmed)),
  ]);

  const daily: DailyPoint[] = dates.map((date, i) => ({
    date,
    signups: Number(daySignups[i] ?? 0) || 0,
    confirmed: Number(dayConfirmed[i] ?? 0) || 0,
  }));

  const sumTail = (key: 'signups' | 'confirmed', n: number): number =>
    daily.slice(-n).reduce((acc, d) => acc + d[key], 0);

  const [intVals, locVals, sources, countries] = await Promise.all([
    kv.mget(INTERESTS.map(K.interest)),
    kv.mget(LOCALES.map(K.locale)),
    kv.smembers(K.sources),
    kv.smembers(K.countries),
  ]);

  const interest: Record<string, number> = {};
  INTERESTS.forEach((i, idx) => {
    interest[i] = Number(intVals[idx] ?? 0) || 0;
  });
  const locale: Record<string, number> = {};
  LOCALES.forEach((l, idx) => {
    locale[l] = Number(locVals[idx] ?? 0) || 0;
  });

  const source: Record<string, number> = {};
  if (sources.length > 0) {
    const srcVals = await kv.mget(sources.map(K.source));
    sources.forEach((s, idx) => {
      source[s] = Number(srcVals[idx] ?? 0) || 0;
    });
  }

  const country: Record<string, number> = {};
  if (countries.length > 0) {
    const ctryVals = await kv.mget(countries.map(K.country));
    countries.forEach((c, idx) => {
      country[c] = Number(ctryVals[idx] ?? 0) || 0;
    });
  }

  const pending = Math.max(0, signups - confirmed - unsubscribed);
  const confirmationRate = signups > 0 ? Math.round((confirmed / signups) * 1000) / 1000 : 0;

  return {
    totals: { signups, confirmed, pending, unsubscribed, mailFailures },
    rates: { confirmationRate },
    last7d: { signups: sumTail('signups', 7), confirmed: sumTail('confirmed', 7) },
    last30d: { signups: sumTail('signups', 30), confirmed: sumTail('confirmed', 30) },
    daily,
    breakdown: { interest, locale, source, country },
  };
}

/** All current records (pending + confirmed), read from the email set. */
export async function collectAllRecords(kv: KvLike | null): Promise<WaitlistRecord[]> {
  if (!kv) return [];
  const emails = await kv.smembers(K.emails);
  if (emails.length === 0) return [];
  const records = await Promise.all(emails.map((e) => readRecord(kv, e)));
  return records.filter((r): r is WaitlistRecord => r != null);
}
