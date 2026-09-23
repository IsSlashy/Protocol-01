/**
 * Which RPC credential /api/metrics spends. Audit v1, finding F36 (server
 * part).
 *
 * The metrics reader fell back to NEXT_PUBLIC_HELIUS_API_KEY when the server
 * had no HELIUS_API_KEY of its own. A NEXT_PUBLIC_ variable is inlined into the
 * browser bundle, so the key this server route spends was the public one:
 * anyone could read it from the bundle and burn the same quota, and rotating
 * the public key silently re-pointed the server. The server must use its own
 * key (HELIUS_API_KEY or EXPLORER_RPC_URL) and nothing else; without one it
 * reads the keyless public devnet endpoint, which carries no credential.
 *
 * Run: cd apps/web && pnpm exec vitest run --config vitest.pool.config.mts lib/metrics/onchain.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const seen: string[] = [];

vi.mock('@solana/web3.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('@solana/web3.js')>();
  class RecordingConnection {
    constructor(url: string) {
      seen.push(url);
    }
    async getProgramAccounts() {
      return [];
    }
  }
  return { ...real, Connection: RecordingConnection };
});

const PUBLIC_KEY_VALUE = 'public-bundle-key-for-test';
const SERVER_KEY_VALUE = 'server-only-key-for-test';

describe('readNetworkMetrics: the RPC credential is the server’s own', () => {
  beforeEach(() => {
    seen.length = 0;
    vi.stubEnv('EXPLORER_RPC_URL', '');
    vi.stubEnv('HELIUS_API_KEY', '');
    vi.stubEnv('NEXT_PUBLIC_HELIUS_API_KEY', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('never spends the public NEXT_PUBLIC_HELIUS_API_KEY, even when it is the only key set', async () => {
    vi.stubEnv('NEXT_PUBLIC_HELIUS_API_KEY', PUBLIC_KEY_VALUE);
    const { readNetworkMetrics } = await import('./onchain');
    const r = await readNetworkMetrics();
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain(PUBLIC_KEY_VALUE);
    // No server credential: the keyless public devnet endpoint, no key at all.
    expect(seen[0]).toBe('https://api.devnet.solana.com');
    expect(r.debug?.rpcHost).toBe('api.devnet.solana.com');
  });

  it('uses the server key when one is set, and not the public one beside it', async () => {
    vi.stubEnv('NEXT_PUBLIC_HELIUS_API_KEY', PUBLIC_KEY_VALUE);
    vi.stubEnv('HELIUS_API_KEY', SERVER_KEY_VALUE);
    const { readNetworkMetrics } = await import('./onchain');
    await readNetworkMetrics();
    expect(seen[0]).toContain(SERVER_KEY_VALUE);
    expect(seen[0]).not.toContain(PUBLIC_KEY_VALUE);
    expect(new URL(seen[0]).host).toBe('devnet.helius-rpc.com');
  });

  it('an explicit EXPLORER_RPC_URL wins', async () => {
    vi.stubEnv('EXPLORER_RPC_URL', 'https://rpc.example.invalid/devnet');
    vi.stubEnv('HELIUS_API_KEY', SERVER_KEY_VALUE);
    const { readNetworkMetrics } = await import('./onchain');
    await readNetworkMetrics();
    expect(seen[0]).toBe('https://rpc.example.invalid/devnet');
  });

  it('the metrics sources never name a NEXT_PUBLIC_ variable', () => {
    for (const f of ['onchain.ts', 'types.ts', '../../app/api/metrics/route.ts']) {
      const src = readFileSync(join(__dirname, f), 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
      expect(src, f).not.toMatch(/NEXT_PUBLIC_/);
    }
  });
});
