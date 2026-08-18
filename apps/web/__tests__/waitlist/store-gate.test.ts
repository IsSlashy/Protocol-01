/**
 * Who is allowed to hand out a store.
 *
 * Run: cd apps/web && pnpm test
 *
 * `getStore()` returning null outside development is not an oversight to route
 * around — it is what makes every caller answer 503 instead of writing a
 * payment ledger into a map that dies with the isolate. This file pins the
 * shape of the one documented exception so it cannot quietly widen into a
 * fallback.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `getStore` reads NODE_ENV at call time but the module memoises its Upstash
 * client at import time, so each case re-imports with a clean registry.
 */
async function loadGetStore() {
  vi.resetModules();
  const mod = await import('@/lib/waitlist/store');
  return mod.getStore;
}

const ENV = { ...process.env };

beforeEach(() => {
  vi.restoreAllMocks();
  // No Upstash: these cases are about what happens when the real store is
  // absent, which is the only time the gate is consulted at all.
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.P01_LOCAL_FILE_KV;
  (globalThis as { __p01WaitlistMem?: unknown }).__p01WaitlistMem = undefined;
});

afterEach(() => {
  process.env = { ...ENV };
});

describe('getStore outside development', () => {
  it('returns null, so callers fail closed', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const getStore = await loadGetStore();
    expect(getStore()).toBeNull();
  });

  it('is NOT unlocked by the absence of a real KV', async () => {
    // The tempting shape is "no KV configured? use the file one". That is the
    // silent fallback the 503 exists to prevent: a fleet of isolates would each
    // believe it had a store and none of them would agree on a claim ledger.
    vi.stubEnv('NODE_ENV', 'production');
    const getStore = await loadGetStore();
    expect(getStore()).toBeNull();
  });

  it('is NOT unlocked by a truthy-looking value', async () => {
    // Exactly '1'. 'true', 'yes' and '0' all leave the guard closed, so a
    // half-remembered variable name or value cannot open it by accident.
    vi.stubEnv('NODE_ENV', 'production');
    for (const value of ['true', 'yes', '0', '']) {
      process.env.P01_LOCAL_FILE_KV = value;
      const getStore = await loadGetStore();
      expect(getStore(), `P01_LOCAL_FILE_KV=${JSON.stringify(value)}`).toBeNull();
    }
  });

  it('is unlocked by the named opt-in, and says so loudly', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('P01_LOCAL_FILE_KV', '1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const getStore = await loadGetStore();

    const store = getStore();
    expect(store).not.toBeNull();
    // A store that appears without a warning is a store someone will ship.
    expect(warn.mock.calls.flat().join(' ')).toMatch(/NON-production store/);
  });
});

describe('getStore in development', () => {
  it('gives the file store without needing the opt-in', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const getStore = await loadGetStore();
    expect(getStore()).not.toBeNull();
  });
});
