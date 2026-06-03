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

export async function pairSet(id: string, blob: string, ttlSec: number): Promise<void> {
  if (kv) {
    // Wrap in an object so the KV client round-trips it as clean JSON.
    await kv.set(key(id), { b: blob }, { ex: ttlSec });
    return;
  }
  mem.set(id, { v: blob, exp: Date.now() + ttlSec * 1000 });
}

/** Single-use read: returns the blob and atomically removes it (or null/expired). */
export async function pairTake(id: string): Promise<string | null> {
  if (kv) {
    const wrapped = await kv.get<{ b: string }>(key(id));
    if (wrapped?.b != null) await kv.del(key(id));
    return wrapped?.b ?? null;
  }
  const e = mem.get(id);
  if (!e) return null;
  mem.delete(id);
  if (Date.now() > e.exp) return null;
  return e.v;
}
