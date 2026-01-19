/**
 * Solana connection helpers for Protocol 01
 */

import {
  Connection,
  Commitment,
  ConnectionConfig,
  PublicKey,
  AccountInfo,
  ParsedAccountData,
} from '@solana/web3.js';

// Network configurations
export type NetworkType = 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet';

export interface NetworkConfig {
  name: string;
  rpcUrl: string;
  wsUrl?: string;
  explorerUrl: string;
}

export const NETWORK_CONFIGS: Record<NetworkType, NetworkConfig> = {
  'mainnet-beta': {
    name: 'Mainnet Beta',
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    wsUrl: 'wss://api.mainnet-beta.solana.com',
    explorerUrl: 'https://explorer.solana.com',
  },
  devnet: {
    name: 'Devnet',
    rpcUrl: 'https://api.devnet.solana.com',
    wsUrl: 'wss://api.devnet.solana.com',
    explorerUrl: 'https://explorer.solana.com/?cluster=devnet',
  },
  testnet: {
    name: 'Testnet',
    rpcUrl: 'https://api.testnet.solana.com',
    wsUrl: 'wss://api.testnet.solana.com',
    explorerUrl: 'https://explorer.solana.com/?cluster=testnet',
  },
  localnet: {
    name: 'Localnet',
    rpcUrl: 'http://localhost:8899',
    wsUrl: 'ws://localhost:8900',
    explorerUrl: 'https://explorer.solana.com/?cluster=custom',
  },
};

// Connection instance cache
let connectionInstance: Connection | null = null;
let currentNetwork: NetworkType = 'mainnet-beta';
let currentRpcUrl: string | null = null;

/**
 * Get or create Solana connection
 */
export function getConnection(
  network?: NetworkType,
  customRpcUrl?: string
): Connection {
  const targetNetwork = network || currentNetwork;
  const targetRpcUrl = customRpcUrl || NETWORK_CONFIGS[targetNetwork].rpcUrl;

  // Return existing connection if config matches
  if (
    connectionInstance &&
    currentNetwork === targetNetwork &&
    currentRpcUrl === targetRpcUrl
  ) {
    return connectionInstance;
  }

  // Create new connection
  const config: ConnectionConfig = {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000,
  };

  connectionInstance = new Connection(targetRpcUrl, config);
  currentNetwork = targetNetwork;
  currentRpcUrl = targetRpcUrl;

  return connectionInstance;
}

/**
 * Create a new connection (without caching)
 */
export function createConnection(
  rpcUrl: string,
  commitment: Commitment = 'confirmed'
): Connection {
  return new Connection(rpcUrl, {
    commitment,
    confirmTransactionInitialTimeout: 60000,
  });
}

/**
 * Set the default network
 */
export function setNetwork(network: NetworkType, customRpcUrl?: string): void {
  currentNetwork = network;
  currentRpcUrl = customRpcUrl || null;
  connectionInstance = null; // Reset connection
}

/**
 * Get current network
 */
export function getCurrentNetwork(): NetworkType {
  return currentNetwork;
}

/**
 * Get current RPC URL
 */
export function getCurrentRpcUrl(): string {
  return currentRpcUrl || NETWORK_CONFIGS[currentNetwork].rpcUrl;
}

/**
 * Get network config
 */
export function getNetworkConfig(network?: NetworkType): NetworkConfig {
  return NETWORK_CONFIGS[network || currentNetwork];
}

/**
 * Check if connection is healthy
 */
export async function isConnectionHealthy(
  connection?: Connection
): Promise<boolean> {
  try {
    const conn = connection || getConnection();
    const slot = await conn.getSlot();
    return slot > 0;
  } catch {
    return false;
  }
}

/**
 * Get cluster version
 */
export async function getClusterVersion(
  connection?: Connection
): Promise<string | null> {
  try {
    const conn = connection || getConnection();
    const version = await conn.getVersion();
    return version['solana-core'];
  } catch {
    return null;
  }
}

/**
 * Get current slot
 */
export async function getCurrentSlot(connection?: Connection): Promise<number> {
  const conn = connection || getConnection();
  return conn.getSlot();
}

/**
 * Get current block time
 */
export async function getCurrentBlockTime(
  connection?: Connection
): Promise<number | null> {
  const conn = connection || getConnection();
  const slot = await conn.getSlot();
  return conn.getBlockTime(slot);
}

/**
 * Get account info
 */
export async function getAccountInfo(
  publicKey: PublicKey | string,
  connection?: Connection
): Promise<AccountInfo<Buffer> | null> {
  const conn = connection || getConnection();
  const pubkey = typeof publicKey === 'string' ? new PublicKey(publicKey) : publicKey;
  return conn.getAccountInfo(pubkey);
}

/**
 * Get parsed account info
 */
export async function getParsedAccountInfo(
  publicKey: PublicKey | string,
  connection?: Connection
): Promise<AccountInfo<ParsedAccountData | Buffer> | null> {
  const conn = connection || getConnection();
  const pubkey = typeof publicKey === 'string' ? new PublicKey(publicKey) : publicKey;
  const result = await conn.getParsedAccountInfo(pubkey);
  return result.value;
}

/**
 * Check if account exists
 */
export async function accountExists(
  publicKey: PublicKey | string,
  connection?: Connection
): Promise<boolean> {
  const accountInfo = await getAccountInfo(publicKey, connection);
  return accountInfo !== null;
}

/**
 * Get SOL balance in lamports
 */
export async function getBalance(
  publicKey: PublicKey | string,
  connection?: Connection
): Promise<number> {
  const conn = connection || getConnection();
  const pubkey = typeof publicKey === 'string' ? new PublicKey(publicKey) : publicKey;
  return conn.getBalance(pubkey);
}

/**
 * Get SOL balance in SOL
 */
export async function getBalanceSOL(
  publicKey: PublicKey | string,
  connection?: Connection
): Promise<number> {
  const lamports = await getBalance(publicKey, connection);
  return lamports / 1e9;
}

/**
 * Get minimum balance for rent exemption
 */
export async function getMinimumBalanceForRentExemption(
  dataLength: number,
  connection?: Connection
): Promise<number> {
  const conn = connection || getConnection();
  return conn.getMinimumBalanceForRentExemption(dataLength);
}

/**
 * Get recent blockhash
 */
export async function getRecentBlockhash(
  connection?: Connection
): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const conn = connection || getConnection();
  return conn.getLatestBlockhash();
}

/**
 * Get explorer URL for transaction
 */
export function getTransactionExplorerUrl(
  signature: string,
  network?: NetworkType
): string {
  const config = getNetworkConfig(network);
  const networkSuffix = network === 'mainnet-beta' ? '' : `?cluster=${network}`;
  return `${config.explorerUrl}/tx/${signature}${networkSuffix}`;
}

/**
 * Get explorer URL for address
 */
export function getAddressExplorerUrl(
  address: string,
  network?: NetworkType
): string {
  const config = getNetworkConfig(network);
  const networkSuffix = network === 'mainnet-beta' ? '' : `?cluster=${network}`;
  return `${config.explorerUrl}/address/${address}${networkSuffix}`;
}

/**
 * Request airdrop (devnet/testnet only)
 */
export async function requestAirdrop(
  publicKey: PublicKey | string,
  lamports: number = 1e9,
  connection?: Connection
): Promise<string> {
  const conn = connection || getConnection();
  const pubkey = typeof publicKey === 'string' ? new PublicKey(publicKey) : publicKey;

  if (currentNetwork === 'mainnet-beta') {
    throw new Error('Airdrop not available on mainnet');
  }

  return conn.requestAirdrop(pubkey, lamports);
}

/**
 * Close connection (cleanup)
 */
export function closeConnection(): void {
  connectionInstance = null;
  currentRpcUrl = null;
}
