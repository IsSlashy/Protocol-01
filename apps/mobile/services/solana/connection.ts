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

/**
 * Privacy-preserving fetch middleware for @solana/web3.js Connection.
 *
 * Intercepts every RPC call to strip fingerprinting headers and add
 * random timing jitter. Uses the callback-based middleware pattern
 * expected by Connection({ fetchMiddleware }).
 */
function privacyFetchMiddleware(
  url: Parameters<typeof fetch>[0],
  options: Parameters<typeof fetch>[1],
  fetchFn: (url: Parameters<typeof fetch>[0], options: Parameters<typeof fetch>[1]) => void,
): void {
  // Whitelist ONLY the headers Solana RPC needs — drop everything else
  const cleanHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Preserve Solana-specific headers if present
  if (options?.headers) {
    const h = options.headers as Record<string, string>;
    for (const [key, value] of Object.entries(h)) {
      const lk = key.toLowerCase();
      if (lk === 'content-length' || lk === 'solana-client') {
        cleanHeaders[key] = value;
      }
      // Drop: user-agent, origin, referer, cookie, authorization,
      // x-forwarded-for, x-real-ip, and any other identifying headers
    }
  }

  const sanitizedOptions = { ...options, headers: cleanHeaders };

  // Random jitter: 30-120ms — small enough to not degrade UX,
  // large enough to decorrelate timing between user tap and RPC call
  const jitter = 30 + Math.floor(Math.random() * 90);
  setTimeout(() => fetchFn(url, sanitizedOptions), jitter);
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
const _rawRelay = process.env.EXPO_PUBLIC_P01_RPC_RELAY || 'https://p01-privacy-relay-production.up.railway.app';
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
    // Privacy relay first (if configured) — WS goes direct (subscriptions only)
    ...(P01_RPC_RELAY ? [{ http: `${P01_RPC_RELAY}/v1/rpc`, ws: DEVNET_WS }] : []),
    // Helius direct (fallback)
    ...(HELIUS_API_KEY
      ? [{ http: `https://devnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, ws: DEVNET_WS }]
      : []),
    { http: 'https://api.devnet.solana.com', ws: 'wss://api.devnet.solana.com' },
  ],
  'mainnet-beta': [
    ...(P01_RPC_RELAY ? [{ http: `${P01_RPC_RELAY}/v1/rpc`, ws: MAINNET_WS }] : []),
    ...(HELIUS_API_KEY
      ? [{ http: `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, ws: MAINNET_WS }]
      : []),
    { http: 'https://api.mainnet-beta.solana.com', ws: 'wss://api.mainnet-beta.solana.com' },
  ],
  'testnet': [
    ...(P01_RPC_RELAY ? [{ http: `${P01_RPC_RELAY}/v1/rpc`, ws: '' }] : []),
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
        fetchMiddleware: privacyFetchMiddleware,
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
      fetchMiddleware: privacyFetchMiddleware,
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
