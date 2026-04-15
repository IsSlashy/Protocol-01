/**
 * MagicBlock Private Ephemeral Rollup (PER) helpers.
 *
 * Used by the /demo/private-rollup page and the /api/ephemeral/ping route
 * to compare mainnet RPC latency against a PER devnet endpoint.
 *
 * Endpoints sourced from MagicBlock docs (docs.magicblock.gg). PER validators
 * are dedicated regional Intel TDX-backed instances; the `tee` endpoint is
 * the explicitly TEE-attested route used for privacy-critical operations.
 */
export const MAGICBLOCK_DEVNET_RPC: Record<'us' | 'eu' | 'asia' | 'tee', string> = {
  us: 'https://devnet-us.magicblock.app',
  eu: 'https://devnet-eu.magicblock.app',
  asia: 'https://devnet-as.magicblock.app',
  tee: 'https://devnet-tee.magicblock.app',
};

export const MAGICBLOCK_MAINNET_RPC: Record<'us' | 'eu' | 'asia' | 'tee', string> = {
  us: 'https://us.magicblock.app',
  eu: 'https://eu.magicblock.app',
  asia: 'https://as.magicblock.app',
  tee: 'https://mainnet-tee.magicblock.app',
};

export const SOLANA_DEVNET_RPC = 'https://api.devnet.solana.com';

export interface PingResult {
  endpoint: string;
  region: string;
  latencyMs: number;
  slot: number;
  ok: boolean;
  error?: string;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: number;
  error?: { code: number; message: string };
}

/**
 * Ping a Solana-compatible RPC endpoint by issuing a `getSlot` call and
 * measuring round-trip latency. Returns `ok: false` on any transport or
 * protocol error — never throws.
 *
 * `timeoutMs` defaults to 5000ms. The function uses `AbortController` so
 * the `fetch` is cancelled cleanly on timeout.
 */
export async function pingEndpoint(
  rpcUrl: string,
  region: string,
  timeoutMs = 5000,
): Promise<PingResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
      signal: controller.signal,
      cache: 'no-store',
    });

    const elapsed =
      (typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now()) - start;

    if (!res.ok) {
      return {
        endpoint: rpcUrl,
        region,
        latencyMs: Math.round(elapsed),
        slot: 0,
        ok: false,
        error: `HTTP ${res.status}`,
      };
    }

    const json = (await res.json()) as JsonRpcResponse;
    if (json.error) {
      return {
        endpoint: rpcUrl,
        region,
        latencyMs: Math.round(elapsed),
        slot: 0,
        ok: false,
        error: json.error.message,
      };
    }

    const slot = typeof json.result === 'number' ? json.result : 0;
    return {
      endpoint: rpcUrl,
      region,
      latencyMs: Math.round(elapsed),
      slot,
      ok: true,
    };
  } catch (err) {
    const elapsed =
      (typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now()) - start;
    const msg = err instanceof Error ? err.message : String(err);
    const aborted = msg.includes('abort') || msg.includes('AbortError');
    return {
      endpoint: rpcUrl,
      region,
      latencyMs: Math.round(elapsed),
      slot: 0,
      ok: false,
      error: aborted ? `timeout after ${timeoutMs}ms` : msg,
    };
  } finally {
    clearTimeout(timer);
  }
}
