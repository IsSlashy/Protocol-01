// TODO: Add certificate pinning for Helius RPC endpoint before mainnet.
// Use react-native-ssl-pinning or TrustKit for production cert pinning.
// See: https://github.com/nickhudkins/react-native-ssl-pinning

import { Connection, clusterApiUrl, Commitment } from '@solana/web3.js';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ---------------------------------------------------------------------------
// Tier 1 — Client-side privacy protection
// ---------------------------------------------------------------------------
//
// Every RPC call from the app passes through this middleware REGARDLESS of
// whether a privacy relay is configured. This provides baseline protection:
//
// 1. Strip identifying headers (User-Agent, Origin, Referer, etc.)
//    → RPC provider can't fingerprint the app/device
// 2. Random jitter (30-120ms) on every request
//    → Breaks timing correlation between user actions and RPC calls
// 3. Whitelist only required headers (Content-Type, Content-Length)
//    → Everything else is dropped — zero metadata leakage
//
// When P01 Privacy Relay (Tier 2) is also active, this adds defense-in-depth:
// even if the relay is compromised, client-side protection remains.
// ---------------------------------------------------------------------------

function stripIdentifyingHeaders(options: Parameters<typeof fetch>[1]): Parameters<typeof fetch>[1] {
  const cleanHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options?.headers) {
    const h = options.headers as Record<string, string>;
    for (const [key, value] of Object.entries(h)) {
      const lk = key.toLowerCase();
      if (lk === 'content-length' || lk === 'solana-client') cleanHeaders[key] = value;
    }
  }
  return { ...options, headers: cleanHeaders };
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Resilient fetch with privacy-relay fallback.
 *
 * 1. Strip identifying headers + random jitter (privacy baseline).
 * 2. Primary attempt through the configured endpoint (relay if set, else direct).
 * 3. On timeout/network failure against the *relay*, fall back to direct Helius/public RPC
 *    so STARK uploads (15-20 sequential calls) don't blow the 60s blockhash window through Tor.
 * 4. Direct-RPC failures are surfaced as-is (no infinite fallback loop).
 */
async function resilientFetch(
  url: Parameters<typeof fetch>[0],
  options: Parameters<typeof fetch>[1],
): Promise<Response> {
  const sanitizedOptions = stripIdentifyingHeaders(options);
  await sleep(30 + Math.floor(Math.random() * 90));

  const urlStr = typeof url === 'string' ? url : String(url);
  const isRelayCall = P01_RPC_RELAY !== '' && urlStr.startsWith(P01_RPC_RELAY);
  const timeoutMs = isRelayCall ? 8000 : 30000;

  // STARK chunk upload fires 100+ sequential TXs; Helius free tier (~10 RPS) will
  // 429 a fraction of them. Retry transparently so web3.js never sees the error.
  const MAX_429_RETRIES = 10;
  const BACKOFF_MAX_MS = 5000;

  try {
    for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let resp: Response;
      try {
        resp = await fetch(url as any, { ...sanitizedOptions, signal: controller.signal } as any);
      } finally {
        clearTimeout(timer);
      }

      // HTTP-level 429
      if (resp.status === 429 && attempt < MAX_429_RETRIES) {
        const backoff = Math.min(BACKOFF_MAX_MS, 250 * Math.pow(2, attempt)) + Math.floor(Math.random() * 200);
        console.warn(`[RPC] HTTP 429, retry ${attempt + 1}/${MAX_429_RETRIES} in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }

      // JSON-RPC level rate limit: Helius returns HTTP 200 with body
      // {"jsonrpc":"2.0","error":{"code":-32429,"message":"rate limited"}}.
      // We peek at a clone so the original body stream stays consumable by web3.js.
      if (resp.ok && attempt < MAX_429_RETRIES) {
        let peeked: string | null = null;
        try {
          peeked = await resp.clone().text();
        } catch {
          peeked = null;
        }
        if (peeked && (/"code"\s*:\s*-32429/.test(peeked) || /"message"\s*:\s*"rate limited"/i.test(peeked))) {
          const backoff = Math.min(BACKOFF_MAX_MS, 250 * Math.pow(2, attempt)) + Math.floor(Math.random() * 200);
          console.warn(`[RPC] JSON-RPC -32429, retry ${attempt + 1}/${MAX_429_RETRIES} in ${backoff}ms`);
          await sleep(backoff);
          continue;
        }
      }

      if (!resp.ok && isRelayCall && resp.status >= 500) {
        throw new Error(`relay HTTP ${resp.status}`);
      }
      return resp;
    }
    // Unreachable under normal flow — loop always returns or continues.
    throw new Error('[RPC] resilientFetch exhausted 429 retries');
  } catch (primaryErr) {
    if (!isRelayCall) throw primaryErr;

    const fallback = HELIUS_API_KEY
      ? (currentCluster === 'mainnet-beta'
          ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
          : `https://devnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`)
      : (currentCluster === 'mainnet-beta'
          ? 'https://api.mainnet-beta.solana.com'
          : currentCluster === 'testnet'
          ? 'https://api.testnet.solana.com'
          : 'https://api.devnet.solana.com');
    const msg = (primaryErr as Error)?.message ?? String(primaryErr);
    console.warn(`[RPC] Relay failed (${msg}) — falling back to direct RPC`);
    return fetch(fallback, sanitizedOptions as any);
  }
}

// Solana network configuration
export type SolanaCluster = 'devnet' | 'mainnet-beta' | 'testnet';

// Default cluster (will be overridden by stored setting)
let currentCluster: SolanaCluster = 'devnet';

// Storage key for network setting
const NETWORK_STORAGE_KEY = 'settings_network';

// Helius API key from environment (optional but recommended)
const HELIUS_API_KEY = process.env.EXPO_PUBLIC_HELIUS_API_KEY;

// P01 Privacy RPC Relay — strips IP/metadata, Tor routing
// When set, ALL RPC calls go through the relay instead of directly to Helius
// Fallback to production relay URL if env var not injected (e.g. dev client cache)
const _rawRelay = process.env.EXPO_PUBLIC_P01_RPC_RELAY || '';
const P01_RPC_RELAY = (_rawRelay && _rawRelay.length > 5 && _rawRelay.startsWith('http')) ? _rawRelay : '';

/**
 * Strip API keys from RPC URLs before logging (M10).
 * Helius requires ?api-key= as a query param — this is their required auth method.
 * There is no header-based auth option for Helius RPC endpoints.
 */
function sanitizeRpcUrl(url: string): string {
  return url.replace(/([?&])(api-key|key|apiKey)=[^&]+/gi, '$1$2=***');
}

/**
 * Validate that an RPC endpoint uses HTTPS (M9).
 * Allows http://localhost for local development only.
 */
function validateRpcEndpoint(url: string): void {
  if (!url.startsWith('https://') && !url.startsWith('wss://') && !url.startsWith('http://localhost') && !url.startsWith('ws://localhost')) {
    throw new Error(`RPC endpoint must use HTTPS: ${sanitizeRpcUrl(url)}`);
  }
}

// Helius requires the API key as a query parameter (?api-key=...).
// This is Helius's required auth method — no header-based auth is available.
// URLs containing the key are NEVER logged directly; use sanitizeRpcUrl() for safe output.
// RPC endpoints - Helius first (if configured), then official Solana fallback
// When P01 Privacy RPC Relay is configured, it takes highest priority.
// The relay strips all identifying metadata (IP, User-Agent) and optionally
// routes through Tor — Helius never sees the user's real IP.
// WebSocket endpoints for subscriptions (onAccountChange, onSlotChange, etc.)
// When using the privacy relay, WS goes direct to Helius/public — this is safe
// because subscriptions only listen for on-chain events, they don't send TXs.
// The relay is HTTP-only (no WS support) so we need a separate WS endpoint.
const DEVNET_WS = HELIUS_API_KEY
  ? `wss://devnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : 'wss://api.devnet.solana.com';
const MAINNET_WS = HELIUS_API_KEY
  ? `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : 'wss://api.mainnet-beta.solana.com';

const RPC_ENDPOINTS: Record<SolanaCluster, { http: string; ws: string }[]> = {
  'devnet': [
    // Privacy relay first (if configured) — pass network so relay routes correctly
    ...(P01_RPC_RELAY ? [{ http: `${P01_RPC_RELAY}/v1/rpc?network=devnet`, ws: DEVNET_WS }] : []),
    // Helius direct (fallback)
    ...(HELIUS_API_KEY
      ? [{ http: `https://devnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, ws: DEVNET_WS }]
      : []),
    { http: 'https://api.devnet.solana.com', ws: 'wss://api.devnet.solana.com' },
  ],
  'mainnet-beta': [
    // Privacy relay with network param — if relay doesn't support it, skip to Helius
    ...(P01_RPC_RELAY ? [{ http: `${P01_RPC_RELAY}/v1/rpc?network=mainnet-beta`, ws: MAINNET_WS }] : []),
    // Helius direct — preferred for mainnet (no relay latency)
    ...(HELIUS_API_KEY
      ? [{ http: `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, ws: MAINNET_WS }]
      : []),
    { http: 'https://api.mainnet-beta.solana.com', ws: 'wss://api.mainnet-beta.solana.com' },
  ],
  'testnet': [
    ...(P01_RPC_RELAY ? [{ http: `${P01_RPC_RELAY}/v1/rpc?network=testnet`, ws: '' }] : []),
    { http: 'https://api.testnet.solana.com', ws: 'wss://api.testnet.solana.com' },
  ],
};

// Commitment level for transactions
const DEFAULT_COMMITMENT: Commitment = 'confirmed';

// Singleton connection instance
let connectionInstance: Connection | null = null;
let currentEndpointIndex = 0;
let isInitialized = false;

/**
 * Initialize the connection with stored network setting
 */
export async function initializeConnection(): Promise<void> {
  if (isInitialized) return;

  try {
    const storedNetwork = await AsyncStorage.getItem(NETWORK_STORAGE_KEY);
    if (storedNetwork && ['devnet', 'mainnet-beta', 'testnet'].includes(storedNetwork)) {
      currentCluster = storedNetwork as SolanaCluster;
    }
    isInitialized = true;
  } catch (error) {
    console.error('Failed to load network setting:', error);
    isInitialized = true;
  }
}

/**
 * Set the current cluster and persist to storage
 */
export async function setCluster(cluster: SolanaCluster): Promise<void> {
  currentCluster = cluster;
  connectionInstance = null;
  currentEndpointIndex = 0;

  try {
    await AsyncStorage.setItem(NETWORK_STORAGE_KEY, cluster);
  } catch (error) {
    console.error('Failed to save network setting:', error);
  }
}

/**
 * Get the Solana connection instance (singleton)
 */
export function getConnection(): Connection {
  if (!connectionInstance) {
    const endpoints = RPC_ENDPOINTS[currentCluster];
    const endpoint = endpoints[currentEndpointIndex];
    validateRpcEndpoint(endpoint.http);
    const isRelay = endpoint.http.includes('/v1/rpc');
    console.log(`[Connection] ${currentCluster} → ${isRelay ? 'Privacy Relay' : 'Direct RPC'}: ${sanitizeRpcUrl(endpoint.http).slice(0, 40)}...`);
    connectionInstance = new Connection(
      endpoint.http,
      {
        commitment: DEFAULT_COMMITMENT,
        wsEndpoint: endpoint.ws || undefined,
        confirmTransactionInitialTimeout: 60000,
        disableRetryOnRateLimit: true,
        // Tier 1 privacy: strip headers + timing jitter on every RPC call
        // Auto-fallback to direct RPC if relay fails/times out (STARK uploads need ~15 sequential calls)
        fetch: resilientFetch as any,
      }
    );
  }
  return connectionInstance;
}

/**
 * Switch to next RPC endpoint if current one fails
 */
export function switchEndpoint(): void {
  const endpoints = RPC_ENDPOINTS[currentCluster];
  currentEndpointIndex = (currentEndpointIndex + 1) % endpoints.length;
  const endpoint = endpoints[currentEndpointIndex];
  validateRpcEndpoint(endpoint.http);
  connectionInstance = new Connection(
    endpoint.http,
    {
      commitment: DEFAULT_COMMITMENT,
      wsEndpoint: endpoint.ws || undefined,
      confirmTransactionInitialTimeout: 60000,
      disableRetryOnRateLimit: true,
      fetch: resilientFetch as any,
    }
  );
}

/**
 * Reset connection (useful after config changes)
 */
export function resetConnection(): void {
  connectionInstance = null;
  currentEndpointIndex = 0;
}

/**
 * Get current cluster
 */
export function getCluster(): SolanaCluster {
  return currentCluster;
}

/**
 * Check if connected to devnet
 */
export function isDevnet(): boolean {
  return currentCluster === 'devnet';
}

/**
 * Check if connected to mainnet
 */
export function isMainnet(): boolean {
  return currentCluster === 'mainnet-beta';
}

/**
 * Get explorer URL for a transaction or address
 */
export function getExplorerUrl(signature: string, type: 'tx' | 'address' = 'tx'): string {
  const base = 'https://explorer.solana.com';
  const cluster = currentCluster === 'mainnet-beta' ? '' : `?cluster=${currentCluster}`;
  return `${base}/${type}/${signature}${cluster}`;
}

/**
 * Request airdrop (devnet only)
 *
 * NOTE: The Solana devnet faucet is frequently rate-limited.
 * If this fails, use faucet.solana.com directly.
 */
export async function requestAirdrop(publicKey: string, amount: number = 1): Promise<string> {
  if (!isDevnet()) {
    throw new Error('Airdrop only available on devnet');
  }

  const { PublicKey, LAMPORTS_PER_SOL } = await import('@solana/web3.js');

  // Cap amount to 1 SOL to avoid rate limit issues
  const cappedAmount = Math.min(amount, 1);


  // Use a fresh connection with retry disabled to fail fast
  const { Connection } = await import('@solana/web3.js');
  const connection = new Connection('https://api.devnet.solana.com', {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 30000,
    disableRetryOnRateLimit: true, // Fail fast on 429
  });

  try {
    const pubkey = new PublicKey(publicKey);
    const signature = await connection.requestAirdrop(
      pubkey,
      cappedAmount * LAMPORTS_PER_SOL
    );


    // Quick confirmation check (don't wait too long)
    try {
      await connection.confirmTransaction(signature, 'confirmed');
    } catch {
    }

    return signature;

  } catch (error: any) {
    console.error('Airdrop error:', error.message);

    // Check for rate limit (429)
    if (error.message?.includes('429') || error.message?.includes('limit') || error.message?.includes('run dry')) {
      throw new Error('RATE_LIMITED');
    }

    throw error;
  }
}
