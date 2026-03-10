// TODO: Add certificate pinning for Helius RPC endpoint before mainnet.
// Use react-native-ssl-pinning or TrustKit for production cert pinning.
// See: https://github.com/nickhudkins/react-native-ssl-pinning

import { Connection, clusterApiUrl, Commitment } from '@solana/web3.js';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Solana network configuration
export type SolanaCluster = 'devnet' | 'mainnet-beta' | 'testnet';

// Default cluster (will be overridden by stored setting)
let currentCluster: SolanaCluster = 'devnet';

// Storage key for network setting
const NETWORK_STORAGE_KEY = 'settings_network';

// Helius API key from environment (optional but recommended)
const HELIUS_API_KEY = process.env.EXPO_PUBLIC_HELIUS_API_KEY;

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
const RPC_ENDPOINTS: Record<SolanaCluster, { http: string; ws: string }[]> = {
  'devnet': HELIUS_API_KEY
    ? [
        { http: `https://devnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, ws: `wss://devnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` },
        { http: 'https://api.devnet.solana.com', ws: 'wss://api.devnet.solana.com' },
      ]
    : [{ http: 'https://api.devnet.solana.com', ws: 'wss://api.devnet.solana.com' }],
  'mainnet-beta': HELIUS_API_KEY
    ? [
        { http: `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, ws: `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` },
        { http: 'https://api.mainnet-beta.solana.com', ws: 'wss://api.mainnet-beta.solana.com' },
      ]
    : [{ http: 'https://api.mainnet-beta.solana.com', ws: 'wss://api.mainnet-beta.solana.com' }],
  'testnet': [
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
    connectionInstance = new Connection(
      endpoint.http,
      {
        commitment: DEFAULT_COMMITMENT,
        wsEndpoint: endpoint.ws,
        confirmTransactionInitialTimeout: 60000,
        disableRetryOnRateLimit: true,
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
      wsEndpoint: endpoint.ws,
      confirmTransactionInitialTimeout: 60000,
      disableRetryOnRateLimit: true,
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
