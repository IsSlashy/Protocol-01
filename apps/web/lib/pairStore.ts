/**
 * Ephemeral relay for phone→extension wallet pairing.
 *
 * The phone encrypts its BIP39 mnemonic to a one-time 80-bit pairing code
 * (pairCrypto `p01pair1:` blob) and POSTs the CIPHERTEXT here; the (cameraless)
 * extension polls it back and decrypts with the code the user typed. This store
 * only ever holds the ciphertext — it never sees the seed or the code, so a
 * compromised relay cannot recover the wallet (the code lives only on the two
 * devices, never on the wire).
 *
 * Backend (first match wins):
 *   1. Vercel KV / Upstash REST — KV_REST_API_URL + KV_REST_API_TOKEN
 *   2. Standalone Upstash       — UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *   3. In-memory dev fallback   — Map on globalThis (NOT durable on serverless;
 *      every Vercel isolate gets its own — prod MUST set one of the pairs above).
 *
 * Uses @vercel/kv (already a web dependency; Upstash-backed REST client).
 */
import { createClient, type VercelKV } from '@vercel/kv';
import { createHash } from 'node:crypto';

const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

const kv: VercelKV | null = url && token ? createClient({ url, token }) : null;

/** True when a durable backend is wired (prod). False ⇒ in-memory dev shim. */
export const pairStoreDurable = !!kv;

type Entry = { v: string; exp: number };
const mem: Map<string, Entry> =
  (globalThis as unknown as { __p01PairMem?: Map<string, Entry> }).__p01PairMem ?? new Map();
(globalThis as unknown as { __p01PairMem?: Map<string, Entry> }).__p01PairMem = mem;

const key = (id: string) => `p01pair:${id}`;

/**
 * Hard cap on the dev map. KV entries expire server-side, but the in-memory
 * fallback only ever dropped entries on take, so a POST flood grew it without
 * bound. Sweep lazily on every set/take and refuse new channels when full.
 */
const MEM_MAX = 500;

/** Purge expired entries from the dev map (lazy GC; runs on each set/take). */
function memSweep(): void {
  const now = Date.now();
  for (const [k, e] of mem) {
    if (now > e.exp) mem.delete(k);
  }
}

/** Stores the blob. Returns false when the in-memory dev store is at capacity. */
export async function pairSet(id: string, blob: string, ttlSec: number): Promise<boolean> {
  if (kv) {
    // Wrap in an object so the KV client round-trips it as clean JSON.
    await kv.set(key(id), { b: blob }, { ex: ttlSec });
    return true;
  }
  memSweep();
  if (mem.size >= MEM_MAX && !mem.has(id)) return false;
  mem.set(id, { v: blob, exp: Date.now() + ttlSec * 1000 });
  return true;
}

/** Single-use read: returns the blob and atomically removes it (or null/expired). */
export async function pairTake(id: string): Promise<string | null> {
  if (kv) {
    const wrapped = await kv.get<{ b: string }>(key(id));
    if (wrapped?.b != null) await kv.del(key(id));
    return wrapped?.b ?? null;
  }
  memSweep();
  const e = mem.get(id);
  if (!e) return null;
  mem.delete(id);
  if (Date.now() > e.exp) return null;
  return e.v;
}

// --- Rate limiting ---------------------------------------------------------

/** In-process counters for when KV is not configured (dev). Windowed keys
 *  expire, and the sweep below keeps the map from outliving them. */
type RlEntry = { n: number; exp: number };
const rlMem: Map<string, RlEntry> =
  (globalThis as unknown as { __p01PairRlMem?: Map<string, RlEntry> }).__p01PairRlMem ?? new Map();
(globalThis as unknown as { __p01PairRlMem?: Map<string, RlEntry> }).__p01PairRlMem = rlMem;

/**
 * Per-IP fixed-window (1 minute) rate limit; returns true when over the limit.
 * Mirrors rateLimitExceeded in lib/waitlist/store.ts: the IP is hashed with a
 * server secret so raw IPs never touch the store. Falls back to an in-process
 * counter when no KV backend is wired (dev), so local runs never hard-fail.
 */
export async function pairRateLimitExceeded(
  kind: 'set' | 'take',
  ip: string,
  limit: number,
): Promise<boolean> {
  const salt = process.env.WAITLIST_STATS_TOKEN ?? 'salt';
  const hash12 = createHash('sha256').update(ip + salt).digest('hex').slice(0, 12);
  const minute = new Date().toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM (UTC)
  const rlKey = `p01pair:rl:${kind}:${hash12}:${minute}`;

  if (kv) {
    const count = await kv.incr(rlKey);
    await kv.expire(rlKey, 60);
    return count > limit;
  }

  const now = Date.now();
  for (const [k, e] of rlMem) {
    if (now > e.exp) rlMem.delete(k);
  }
  const e = rlMem.get(rlKey);
  if (!e) {
    rlMem.set(rlKey, { n: 1, exp: now + 60_000 });
    return 1 > limit;
  }
  e.n += 1;
  return e.n > limit;
}
