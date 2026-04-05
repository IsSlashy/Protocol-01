/**
 * RPC endpoint definitions and resolution for Solana clusters.
 *
 * Priority chain (lower number = tried first):
 *   QuickNode (if configured) -> 0
 *   Helius   (if API key set)  -> 1
 *   Solana public RPC          -> 2
 *   Custom endpoints            -> their specified priority
 */

export type SolanaCluster = 'devnet' | 'mainnet-beta' | 'testnet' | 'localnet';

export interface RpcEndpoint {
  http: string;
  ws: string;
  provider: 'helius' | 'quicknode' | 'solana-public' | 'custom';
  priority: number; // lower = higher priority
}

// ---------------------------------------------------------------------------
// Public Solana RPC URLs (always available as final fallback)
// ---------------------------------------------------------------------------

const PUBLIC_ENDPOINTS: Record<SolanaCluster, RpcEndpoint> = {
  'mainnet-beta': {
    http: 'https://api.mainnet-beta.solana.com',
    ws: 'wss://api.mainnet-beta.solana.com',
    provider: 'solana-public',
    priority: 2,
  },
  testnet: {
    http: 'https://api.testnet.solana.com',
    ws: 'wss://api.testnet.solana.com',
    provider: 'solana-public',
    priority: 2,
  },
  devnet: {
    http: 'https://api.devnet.solana.com',
    ws: 'wss://api.devnet.solana.com',
    provider: 'solana-public',
    priority: 2,
  },
  localnet: {
    http: 'http://127.0.0.1:8899',
    ws: 'ws://127.0.0.1:8900',
    provider: 'solana-public',
    priority: 2,
  },
};

// ---------------------------------------------------------------------------
// Helius endpoint builders
// ---------------------------------------------------------------------------

function heliusHttp(cluster: SolanaCluster, apiKey: string): string {
  switch (cluster) {
    case 'mainnet-beta':
      return `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
    case 'devnet':
      return `https://devnet.helius-rpc.com/?api-key=${apiKey}`;
    default:
      // Helius doesn't serve testnet/localnet — fall through
      return '';
  }
}

function heliusWs(cluster: SolanaCluster, apiKey: string): string {
  switch (cluster) {
    case 'mainnet-beta':
      return `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`;
    case 'devnet':
      return `wss://devnet.helius-rpc.com/?api-key=${apiKey}`;
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GetEndpointsOptions {
  heliusApiKey?: string;
  quicknodeEndpoint?: string;
  customEndpoints?: RpcEndpoint[];
}

/**
 * Build a priority-sorted list of RPC endpoints for the given cluster.
 *
 * The list always includes the Solana public RPC as the final fallback.
 * Provider-specific endpoints are only included when their credentials
 * are supplied.
 */
export function getEndpoints(
  cluster: SolanaCluster,
  options?: GetEndpointsOptions,
): RpcEndpoint[] {
  const endpoints: RpcEndpoint[] = [];

  // QuickNode — priority 0
  if (options?.quicknodeEndpoint) {
    const qnHttp = options.quicknodeEndpoint;
    // QuickNode WS is the same URL with wss:// scheme
    const qnWs = qnHttp.replace(/^https?:\/\//, 'wss://');
    endpoints.push({
      http: qnHttp,
      ws: qnWs,
      provider: 'quicknode',
      priority: 0,
    });
  }

  // Helius — priority 1
  if (options?.heliusApiKey) {
    const http = heliusHttp(cluster, options.heliusApiKey);
    const ws = heliusWs(cluster, options.heliusApiKey);
    if (http) {
      endpoints.push({
        http,
        ws,
        provider: 'helius',
        priority: 1,
      });
    }
  }

  // Custom endpoints at their declared priority
  if (options?.customEndpoints) {
    for (const ep of options.customEndpoints) {
      endpoints.push(ep);
    }
  }

  // Solana public — priority 2 (always present)
  endpoints.push(PUBLIC_ENDPOINTS[cluster]);

  // Sort by priority ascending (lower = tried first)
  endpoints.sort((a, b) => a.priority - b.priority);

  return endpoints;
}

/**
 * Return the default public RPC HTTP URL for a cluster.
 * Useful as a quick fallback when no fancy config is needed.
 */
export function getDefaultRpcUrl(cluster: SolanaCluster): string {
  return PUBLIC_ENDPOINTS[cluster].http;
}
