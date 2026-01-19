/**
 * Network configurations for Protocol 01
 */

export type NetworkId = 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet' | 'custom';

export interface NetworkConfig {
  id: NetworkId;
  name: string;
  displayName: string;
  rpcUrl: string;
  wsUrl: string;
  explorerUrl: string;
  explorerName: string;
  isTestnet: boolean;
  chainId?: string;
}

export interface RpcEndpoint {
  name: string;
  url: string;
  wsUrl?: string;
  isPublic: boolean;
  rateLimit?: number;
  priority: number;
}

/**
 * Default network configurations
 */
export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  'mainnet-beta': {
    id: 'mainnet-beta',
    name: 'mainnet-beta',
    displayName: 'Mainnet',
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    wsUrl: 'wss://api.mainnet-beta.solana.com',
    explorerUrl: 'https://explorer.solana.com',
    explorerName: 'Solana Explorer',
    isTestnet: false,
  },
  devnet: {
    id: 'devnet',
    name: 'devnet',
    displayName: 'Devnet',
    rpcUrl: 'https://api.devnet.solana.com',
    wsUrl: 'wss://api.devnet.solana.com',
    explorerUrl: 'https://explorer.solana.com/?cluster=devnet',
    explorerName: 'Solana Explorer (Devnet)',
    isTestnet: true,
  },
  testnet: {
    id: 'testnet',
    name: 'testnet',
    displayName: 'Testnet',
    rpcUrl: 'https://api.testnet.solana.com',
    wsUrl: 'wss://api.testnet.solana.com',
    explorerUrl: 'https://explorer.solana.com/?cluster=testnet',
    explorerName: 'Solana Explorer (Testnet)',
    isTestnet: true,
  },
  localnet: {
    id: 'localnet',
    name: 'localnet',
    displayName: 'Localnet',
    rpcUrl: 'http://127.0.0.1:8899',
    wsUrl: 'ws://127.0.0.1:8900',
    explorerUrl: 'https://explorer.solana.com/?cluster=custom&customUrl=http://127.0.0.1:8899',
    explorerName: 'Local Explorer',
    isTestnet: true,
  },
  custom: {
    id: 'custom',
    name: 'custom',
    displayName: 'Custom RPC',
    rpcUrl: '',
    wsUrl: '',
    explorerUrl: 'https://explorer.solana.com/?cluster=custom',
    explorerName: 'Solana Explorer',
    isTestnet: false,
  },
};

/**
 * Alternative RPC endpoints for mainnet
 */
export const MAINNET_RPC_ENDPOINTS: RpcEndpoint[] = [
  {
    name: 'Solana (Official)',
    url: 'https://api.mainnet-beta.solana.com',
    wsUrl: 'wss://api.mainnet-beta.solana.com',
    isPublic: true,
    rateLimit: 100,
    priority: 1,
  },
  {
    name: 'Helius',
    url: 'https://mainnet.helius-rpc.com/?api-key=',
    isPublic: false,
    priority: 2,
  },
  {
    name: 'QuickNode',
    url: 'https://api.quicknode.com/solana/mainnet',
    isPublic: false,
    priority: 3,
  },
  {
    name: 'Alchemy',
    url: 'https://solana-mainnet.g.alchemy.com/v2/',
    isPublic: false,
    priority: 4,
  },
  {
    name: 'Triton',
    url: 'https://p01-mainnet.rpcpool.com',
    isPublic: false,
    priority: 5,
  },
];

/**
 * Alternative RPC endpoints for devnet
 */
export const DEVNET_RPC_ENDPOINTS: RpcEndpoint[] = [
  {
    name: 'Solana (Official)',
    url: 'https://api.devnet.solana.com',
    wsUrl: 'wss://api.devnet.solana.com',
    isPublic: true,
    rateLimit: 100,
    priority: 1,
  },
  {
    name: 'Helius (Devnet)',
    url: 'https://devnet.helius-rpc.com/?api-key=',
    isPublic: false,
    priority: 2,
  },
];

/**
 * Get network config by ID
 */
export function getNetworkConfig(networkId: NetworkId): NetworkConfig {
  return NETWORKS[networkId] || NETWORKS['mainnet-beta'];
}

/**
 * Get explorer URL for transaction
 */
export function getTransactionUrl(signature: string, networkId: NetworkId = 'mainnet-beta'): string {
  const network = getNetworkConfig(networkId);
  const clusterParam = networkId === 'mainnet-beta' ? '' : `?cluster=${networkId}`;
  return `${network.explorerUrl.split('?')[0]}/tx/${signature}${clusterParam}`;
}

/**
 * Get explorer URL for address
 */
export function getAddressUrl(address: string, networkId: NetworkId = 'mainnet-beta'): string {
  const network = getNetworkConfig(networkId);
  const clusterParam = networkId === 'mainnet-beta' ? '' : `?cluster=${networkId}`;
  return `${network.explorerUrl.split('?')[0]}/address/${address}${clusterParam}`;
}

/**
 * Get explorer URL for token
 */
export function getTokenUrl(mint: string, networkId: NetworkId = 'mainnet-beta'): string {
  return getAddressUrl(mint, networkId);
}

/**
 * Get Solscan URL (alternative explorer)
 */
export function getSolscanUrl(
  type: 'tx' | 'account' | 'token',
  value: string,
  networkId: NetworkId = 'mainnet-beta'
): string {
  const baseUrl = networkId === 'mainnet-beta'
    ? 'https://solscan.io'
    : `https://solscan.io/?cluster=${networkId}`;

  return `${baseUrl}/${type}/${value}`;
}

/**
 * Check if network is testnet
 */
export function isTestNetwork(networkId: NetworkId): boolean {
  return NETWORKS[networkId]?.isTestnet ?? false;
}

/**
 * Get available networks for selection
 */
export function getAvailableNetworks(): NetworkConfig[] {
  return Object.values(NETWORKS).filter(network => network.id !== 'custom');
}

/**
 * Create custom network config
 */
export function createCustomNetwork(
  rpcUrl: string,
  name: string = 'Custom Network'
): NetworkConfig {
  const wsUrl = rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');

  return {
    ...NETWORKS.custom,
    displayName: name,
    rpcUrl,
    wsUrl,
  };
}

/**
 * Validate RPC URL format
 */
export function isValidRpcUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Default network
 */
export const DEFAULT_NETWORK: NetworkId = 'mainnet-beta';

/**
 * Commitment levels
 */
export const COMMITMENT_LEVELS = ['processed', 'confirmed', 'finalized'] as const;
export type CommitmentLevel = typeof COMMITMENT_LEVELS[number];
export const DEFAULT_COMMITMENT: CommitmentLevel = 'confirmed';
