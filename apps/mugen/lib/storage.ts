/**
 * Persistent KV storage layer for Mugen.
 *
 * Problem: Vercel Fluid Compute (and any serverless host) runs API routes
 * across many ephemeral instances. `globalThis`-backed Maps are per-instance —
 * a maker's write to instance A is invisible to instance B when the taker
 * polls. This module provides a Redis-compatible interface that ALL app
 * state-adjacent modules (encrypted-order-registry, sessions, noise stats,
 * treasury buffer state, ...) should share.
 *
 * Backend selection (first match wins):
 *   1. Vercel KV env vars — KV_REST_API_URL + KV_REST_API_TOKEN → Upstash REST
 *   2. Standalone Upstash env vars — UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *   3. In-memory fallback — Map stashed on globalThis (dev only)
 *
 * WARNING: The in-memory backend is NOT safe for production Vercel. It works
 * across hot reloads in `next dev`, but every serverless invocation gets its
 * own isolate, so cross-request state is lost. Prod MUST set one of the
 * two env-var pairs above.
 *
 * All values are JSON-encoded on write and parsed on read. TTLs map to
 * Upstash EX; the in-memory shim emulates TTL with setTimeout. The `keys()`
 * glob matching uses Upstash's native SCAN MATCH in prod; the in-memory shim
 * only supports `prefix*` / `*suffix` / exact keys — do not rely on deep
 * glob in dev.
 */

import { Redis } from '@upstash/redis';

export interface Storage {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, opts?: { ttlSeconds?: number }): Promise<void>;
  del(key: string): Promise<void>;
  keys(pattern: string): Promise<string[]>;
  lpush<T>(key: string, value: T): Promise<number>;
  rpop<T>(key: string): Promise<T | null>;
  lrange<T>(key: string, start: number, stop: number): Promise<T[]>;
  llen(key: string): Promise<number>;
}

// ═══ In-memory backend (dev only) ═══════════════════════════════════════════

interface MemEntry {
  value: string;
  expiresAt: number | null;
  timer: NodeJS.Timeout | null;
}

interface MemBackend {
  kv: Map<string, MemEntry>;
  lists: Map<string, string[]>;
}

const MEM_GLOBAL_KEY = Symbol.for('mugen.storage.memory.v1');

function getMemBackend(): MemBackend {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (!g[MEM_GLOBAL_KEY]) {
    g[MEM_GLOBAL_KEY] = {
      kv: new Map<string, MemEntry>(),
      lists: new Map<string, string[]>(),
    } satisfies MemBackend;
  }
  return g[MEM_GLOBAL_KEY] as MemBackend;
}

function globToSimplePredicate(pattern: string): (k: string) => boolean {
  // Shim: supports exact match, `prefix*`, `*suffix`, `*` alone.
  if (pattern === '*') return () => true;
  if (pattern.endsWith('*') && !pattern.slice(0, -1).includes('*')) {
    const prefix = pattern.slice(0, -1);
    return (k) => k.startsWith(prefix);
  }
  if (pattern.startsWith('*') && !pattern.slice(1).includes('*')) {
    const suffix = pattern.slice(1);
    return (k) => k.endsWith(suffix);
  }
  // Fallback: exact match only. Warn once at call time (logged via caller).
  return (k) => k === pattern;
}

class MemoryStorage implements Storage {
  private backend = getMemBackend();

  async get<T>(key: string): Promise<T | null> {
    const entry = this.backend.kv.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.backend.kv.delete(key);
      return null;
    }
    try {
      return JSON.parse(entry.value) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, opts?: { ttlSeconds?: number }): Promise<void> {
    // Clear prior timer if any
    const prior = this.backend.kv.get(key);
    if (prior?.timer) clearTimeout(prior.timer);

    const serialized = JSON.stringify(value);
    let expiresAt: number | null = null;
    let timer: NodeJS.Timeout | null = null;
    if (opts?.ttlSeconds && opts.ttlSeconds > 0) {
      expiresAt = Date.now() + opts.ttlSeconds * 1000;
      timer = setTimeout(() => {
        this.backend.kv.delete(key);
      }, opts.ttlSeconds * 1000);
      // Don't keep the event loop alive just for TTL cleanup.
      if (typeof timer.unref === 'function') timer.unref();
    }
    this.backend.kv.set(key, { value: serialized, expiresAt, timer });
  }

  async del(key: string): Promise<void> {
    const prior = this.backend.kv.get(key);
    if (prior?.timer) clearTimeout(prior.timer);
    this.backend.kv.delete(key);
    this.backend.lists.delete(key);
  }

  async keys(pattern: string): Promise<string[]> {
    const pred = globToSimplePredicate(pattern);
    const out: string[] = [];
    for (const [k, entry] of this.backend.kv) {
      if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) continue;
      if (pred(k)) out.push(k);
    }
    return out;
  }

  async lpush<T>(key: string, value: T): Promise<number> {
    const list = this.backend.lists.get(key) ?? [];
    list.unshift(JSON.stringify(value));
    this.backend.lists.set(key, list);
    return list.length;
  }

  async rpop<T>(key: string): Promise<T | null> {
    const list = this.backend.lists.get(key);
    if (!list || list.length === 0) return null;
    const raw = list.pop();
    this.backend.lists.set(key, list);
    if (raw === undefined) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async lrange<T>(key: string, start: number, stop: number): Promise<T[]> {
    const list = this.backend.lists.get(key);
    if (!list || list.length === 0) return [];
    // Redis semantics: stop is inclusive, negatives index from the end.
    const len = list.length;
    const s = start < 0 ? Math.max(0, len + start) : Math.min(start, len);
    const e = stop < 0 ? len + stop : Math.min(stop, len - 1);
    if (e < s) return [];
    const slice = list.slice(s, e + 1);
    const out: T[] = [];
    for (const raw of slice) {
      try {
        out.push(JSON.parse(raw) as T);
      } catch {
        // skip corrupted entry
      }
    }
    return out;
  }

  async llen(key: string): Promise<number> {
    const list = this.backend.lists.get(key);
    return list ? list.length : 0;
  }
}

// ═══ Upstash REST backend ════════════════════════════════════════════════════

class UpstashStorage implements Storage {
  constructor(private client: Redis) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get<unknown>(key);
    if (raw === null || raw === undefined) return null;
    // Upstash auto-parses JSON when it can. Normalize.
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw) as T;
      } catch {
        return raw as unknown as T;
      }
    }
    return raw as T;
  }

  async set<T>(key: string, value: T, opts?: { ttlSeconds?: number }): Promise<void> {
    const serialized = JSON.stringify(value);
    if (opts?.ttlSeconds && opts.ttlSeconds > 0) {
      await this.client.set(key, serialized, { ex: opts.ttlSeconds });
    } else {
      await this.client.set(key, serialized);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async keys(pattern: string): Promise<string[]> {
    // Use SCAN-loop under the hood via Upstash's `keys` — fine for our scale.
    return (await this.client.keys(pattern)) ?? [];
  }

  async lpush<T>(key: string, value: T): Promise<number> {
    return (await this.client.lpush(key, JSON.stringify(value))) as number;
  }

  async rpop<T>(key: string): Promise<T | null> {
    const raw = await this.client.rpop<unknown>(key);
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw) as T;
      } catch {
        return raw as unknown as T;
      }
    }
    return raw as T;
  }

  async lrange<T>(key: string, start: number, stop: number): Promise<T[]> {
    const raws = (await this.client.lrange<unknown>(key, start, stop)) ?? [];
    const out: T[] = [];
    for (const raw of raws) {
      if (typeof raw === 'string') {
        try {
          out.push(JSON.parse(raw) as T);
        } catch {
          out.push(raw as unknown as T);
        }
      } else {
        out.push(raw as T);
      }
    }
    return out;
  }

  async llen(key: string): Promise<number> {
    return (await this.client.llen(key)) as number;
  }
}

// ═══ Singleton factory ═══════════════════════════════════════════════════════

let cached: Storage | null = null;

export function getStorage(): Storage {
  if (cached) return cached;

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const upUrl = process.env.UPSTASH_REDIS_REST_URL;
  const upToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (kvUrl && kvToken) {
    const client = new Redis({ url: kvUrl, token: kvToken });
    cached = new UpstashStorage(client);
    // eslint-disable-next-line no-console
    console.log('[mugen/storage] Using Vercel KV (Upstash) backend');
    return cached;
  }
  if (upUrl && upToken) {
    const client = new Redis({ url: upUrl, token: upToken });
    cached = new UpstashStorage(client);
    // eslint-disable-next-line no-console
    console.log('[mugen/storage] Using Upstash Redis REST backend');
    return cached;
  }

  cached = new MemoryStorage();
  // eslint-disable-next-line no-console
  console.warn(
    '[mugen/storage] No KV_REST_API_URL or UPSTASH_REDIS_REST_URL set — ' +
      'falling back to in-memory store. NOT SAFE FOR PRODUCTION VERCEL: ' +
      'state will not survive across serverless invocations.',
  );
  return cached;
}

/** Testing helper — reset the cached singleton so a new backend can be picked up. */
export function __resetStorageForTests(): void {
  cached = null;
}
