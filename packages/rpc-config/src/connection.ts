/**
 * RpcConnectionManager — a thin wrapper around @solana/web3.js Connection
 * that supports priority-based endpoint fallback and health checks.
 */

import { Connection, type Commitment } from '@solana/web3.js';
import {
  type SolanaCluster,
  type RpcEndpoint,
  getEndpoints,
  type GetEndpointsOptions,
} from './endpoints';

export interface ConnectionConfig extends GetEndpointsOptions {
  cluster: SolanaCluster;
  commitment?: Commitment;
  confirmTimeout?: number;
  maxRetries?: number;
  /** Timeout in milliseconds for health checks (default: 5000) */
  healthCheckTimeout?: number;
  onEndpointSwitch?: (from: RpcEndpoint, to: RpcEndpoint) => void;
}

export class RpcConnectionManager {
  private connection: Connection | null = null;
  private endpoints: RpcEndpoint[];
  private currentIndex: number = 0;
  private config: ConnectionConfig;

  constructor(config: ConnectionConfig) {
    this.config = config;
    this.endpoints = getEndpoints(config.cluster, {
      heliusApiKey: config.heliusApiKey,
      quicknodeEndpoint: config.quicknodeEndpoint,
      customEndpoints: config.customEndpoints,
    });
    if (this.endpoints.length === 0) {
      throw new Error(`[rpc-config] No endpoints available for cluster "${config.cluster}"`);
    }
  }

  // ---------------------------------------------------------------------------
  // Core accessors
  // ---------------------------------------------------------------------------

  /**
   * Return the current Connection, creating one lazily on first access.
   */
  getConnection(): Connection {
    if (!this.connection) {
      const ep = this.endpoints[this.currentIndex];
      this.connection = new Connection(ep.http, {
        commitment: this.config.commitment ?? 'confirmed',
        wsEndpoint: ep.ws || undefined,
        confirmTransactionInitialTimeout: this.config.confirmTimeout,
      });
    }
    return this.connection;
  }

  /**
   * Advance to the next endpoint in the priority list and return a fresh
   * Connection. Wraps around to the first endpoint when the list is
   * exhausted.
   */
  switchEndpoint(): Connection {
    const prev = this.endpoints[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.endpoints.length;
    this.connection = null; // force re-creation
    const next = this.endpoints[this.currentIndex];

    if (this.config.onEndpointSwitch) {
      this.config.onEndpointSwitch(prev, next);
    }

    return this.getConnection();
  }

  /**
   * Drop the cached Connection so the next `getConnection()` call creates
   * a brand-new instance (same endpoint).
   */
  resetConnection(): void {
    this.connection = null;
  }

  /**
   * Return metadata about the endpoint currently in use.
   */
  getCurrentEndpoint(): RpcEndpoint {
    return this.endpoints[this.currentIndex];
  }

  /**
   * Return the cluster this manager was configured for.
   */
  getCluster(): SolanaCluster {
    return this.config.cluster;
  }

  // ---------------------------------------------------------------------------
  // Health & error handling
  // ---------------------------------------------------------------------------

  /**
   * Quick health probe -- calls `getSlot()` and measures latency.
   *
   * @param timeoutMs - Maximum time to wait for a response (default: `healthCheckTimeout` config or 5000ms).
   *   If the RPC does not respond within this window the endpoint is marked unhealthy.
   */
  async checkHealth(timeoutMs?: number): Promise<{ healthy: boolean; latencyMs: number; endpoint: RpcEndpoint }> {
    const timeout = timeoutMs ?? this.config.healthCheckTimeout ?? 5000;
    const start = Date.now();
    const ep = this.getCurrentEndpoint();

    try {
      await Promise.race([
        this.getConnection().getSlot(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Health check timed out')), timeout),
        ),
      ]);
      return { healthy: true, latencyMs: Date.now() - start, endpoint: ep };
    } catch {
      return { healthy: false, latencyMs: Date.now() - start, endpoint: ep };
    }
  }

  /**
   * Check health of the current endpoint and automatically fail over to the
   * next one if it is unhealthy. Cycles through all endpoints once.
   *
   * @returns The first healthy Connection, or throws if all endpoints fail.
   */
  async checkHealthWithFailover(timeoutMs?: number): Promise<Connection> {
    const tried: string[] = [];
    const startIndex = this.currentIndex;

    for (let i = 0; i < this.endpoints.length; i++) {
      const { healthy, endpoint } = await this.checkHealth(timeoutMs);
      if (healthy) {
        return this.getConnection();
      }
      tried.push(`${endpoint.provider}(${endpoint.http})`);
      // Don't switch past the last endpoint
      if (i < this.endpoints.length - 1) {
        this.switchEndpoint();
      }
    }

    // Reset to original index so the caller can retry later
    this.currentIndex = startIndex;
    this.connection = null;

    throw new Error(
      `All RPC endpoints failed health checks. Endpoints tried: ${tried.join(', ')}. ` +
      'Check your network connection or provide a custom endpoint.',
    );
  }

  /**
   * Inspect an RPC error and switch endpoints when appropriate.
   *
   * Switches on 429 (rate-limited), 502/503 (server down), fetch failures,
   * and "Blockhash not found" (intermittent Solana public RPC issue).
   *
   * Returns `true` if the endpoint was switched, `false` otherwise.
   */
  handleError(error: Error): boolean {
    const msg = error?.message ?? '';
    const shouldSwitch =
      msg.includes('429') ||
      msg.includes('502') ||
      msg.includes('503') ||
      msg.includes('fetch failed') ||
      msg.includes('Failed to fetch') ||
      msg.includes('Blockhash not found') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('socket hang up');

    if (shouldSwitch && this.endpoints.length > 1) {
      this.switchEndpoint();
      return true;
    }

    return false;
  }
}
