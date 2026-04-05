/**
 * @protocol-01/rpc-config — shared RPC configuration for Protocol-01
 *
 * Provides priority-based endpoint resolution, connection management with
 * automatic fallback, URL sanitization, and explorer URL builders.
 */

export {
  type SolanaCluster,
  type RpcEndpoint,
  type GetEndpointsOptions,
  getEndpoints,
  getDefaultRpcUrl,
} from './endpoints';

export {
  type ConnectionConfig,
  RpcConnectionManager,
} from './connection';

export {
  sanitizeRpcUrl,
  validateRpcEndpoint,
} from './sanitize';

export {
  getExplorerUrl,
  getSolscanUrl,
} from './explorer';
