/**
 * Decentralized Relayer Network
 *
 * DEPRECATED: This module uses HTTP-based relayer endpoints which have been replaced
 * by the on-chain p01_relayer program. Use @p01/specter-sdk relay module for
 * on-chain relay via the p01_relayer program instead.
 *
 * This file is retained for backward compatibility with external consumers.
 *
 * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
 */

import { Connection, PublicKey } from '@solana/web3.js';

// Types
/** @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program */
export interface RelayerInfo {
  id: string;
  name: string;
  url: string;
  publicKey: string;
  feeBps: number;           // Fee in basis points (100 = 1%)
  minAmount: number;        // Minimum transaction amount in SOL
  maxAmount: number;        // Maximum transaction amount in SOL
  supportedTokens: string[]; // Token mints supported
  version: string;
  region?: string;
}

/** @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program */
export interface RelayerHealth {
  relayerId: string;
  isOnline: boolean;
  latencyMs: number;
  successRate: number;      // 0-100
  lastChecked: number;
  recentErrors: string[];
  balance: number;          // Relayer's SOL balance
}

/** @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program */
export interface RelayerStats {
  relayerId: string;
  totalTransactions: number;
  totalVolume: number;
  avgLatency: number;
  uptime: number;           // 0-100
}

/** @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program */
export interface RelayRequest {
  proof: any;
  publicInputs: string[];
  nullifiers: string[];
  outputCommitments: string[];
  merkleRoot: string;
  relayerFeeCommitment?: string;
}

/** @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program */
export interface RelayResponse {
  success: boolean;
  txId?: string;
  signature?: string;
  error?: string;
  relayerId: string;
  latencyMs: number;
}

/**
 * Default relayers list.
 * @deprecated HTTP relayers are no longer used. Relay is now handled on-chain via p01_relayer program.
 * Use @p01/specter-sdk relay module instead.
 */
const DEFAULT_RELAYERS: RelayerInfo[] = [];

/**
 * Relayer Network Manager
 *
 * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program.
 * This HTTP-based relayer network is no longer the recommended approach.
 */
export class RelayerNetwork {
  private relayers: Map<string, RelayerInfo> = new Map();
  private healthCache: Map<string, RelayerHealth> = new Map();
  private statsCache: Map<string, RelayerStats> = new Map();
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor(customRelayers?: RelayerInfo[]) {
    // Initialize with default or custom relayers
    const relayersToUse = customRelayers || DEFAULT_RELAYERS;
    for (const relayer of relayersToUse) {
      this.relayers.set(relayer.id, relayer);
    }
  }

  /**
   * Start periodic health checks
   * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
   */
  startHealthChecks(intervalMs: number = 30000): void {
    this.checkAllRelayers();
    this.healthCheckInterval = setInterval(() => {
      this.checkAllRelayers();
    }, intervalMs);
  }

  /**
   * Stop health checks
   * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
   */
  stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Check health of all relayers
   * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
   */
  async checkAllRelayers(): Promise<void> {
    const checks = Array.from(this.relayers.values()).map(r =>
      this.checkRelayerHealth(r)
    );
    await Promise.allSettled(checks);
  }

  /**
   * Check health of a single relayer
   * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
   */
  async checkRelayerHealth(relayer: RelayerInfo): Promise<RelayerHealth> {
    const startTime = Date.now();

    try {
      const response = await fetch(`${relayer.url}/health`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      const health: RelayerHealth = {
        relayerId: relayer.id,
        isOnline: true,
        latencyMs,
        successRate: data.successRate || 100,
        lastChecked: Date.now(),
        recentErrors: [],
        balance: data.balance || 0,
      };

      this.healthCache.set(relayer.id, health);
      return health;

    } catch (error) {
      const health: RelayerHealth = {
        relayerId: relayer.id,
        isOnline: false,
        latencyMs: Date.now() - startTime,
        successRate: 0,
        lastChecked: Date.now(),
        recentErrors: [(error as Error).message],
        balance: 0,
      };

      this.healthCache.set(relayer.id, health);
      return health;
    }
  }

  /**
   * Get all available relayers
   * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
   */
  getRelayers(): RelayerInfo[] {
    return Array.from(this.relayers.values());
  }

  /**
   * Get online relayers only
   * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
   */
  getOnlineRelayers(): RelayerInfo[] {
    return this.getRelayers().filter(r => {
      const health = this.healthCache.get(r.id);
      return health?.isOnline !== false;
    });
  }

  /**
   * Get relayer by ID
   * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
   */
  getRelayer(id: string): RelayerInfo | undefined {
    return this.relayers.get(id);
  }

  /**
   * Get health for a relayer
   * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
   */
  getHealth(relayerId: string): RelayerHealth | undefined {
    return this.healthCache.get(relayerId);
  }

  /**
   * Select best relayer based on criteria
   * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
   */
  selectBestRelayer(options?: {
    token?: string;
    amount?: number;
    preferRegion?: string;
    maxFeeBps?: number;
  }): RelayerInfo | null {
    let candidates = this.getOnlineRelayers();

    // Filter by token support
    if (options?.token) {
      candidates = candidates.filter(r =>
        r.supportedTokens.includes(options.token!)
      );
    }

    // Filter by amount limits
    if (options?.amount) {
      candidates = candidates.filter(r =>
        options.amount! >= r.minAmount && options.amount! <= r.maxAmount
      );
    }

    // Filter by max fee
    if (options?.maxFeeBps) {
      candidates = candidates.filter(r => r.feeBps <= options.maxFeeBps!);
    }

    if (candidates.length === 0) {
      return null;
    }

    // Score candidates
    const scored = candidates.map(r => {
      const health = this.healthCache.get(r.id);
      let score = 100;

      // Penalize high latency
      if (health?.latencyMs) {
        score -= Math.min(30, health.latencyMs / 100);
      }

      // Penalize low success rate
      if (health?.successRate) {
        score -= (100 - health.successRate) * 0.5;
      }

      // Penalize high fees
      score -= r.feeBps;

      // Bonus for preferred region
      if (options?.preferRegion && r.region === options.preferRegion) {
        score += 20;
      }

      // Bonus for high balance (can handle more txs)
      if (health?.balance && health.balance > 1) {
        score += 10;
      }

      return { relayer: r, score };
    });

    // Sort by score and return best
    scored.sort((a, b) => b.score - a.score);
    return scored[0].relayer;
  }

  /**
   * Select random relayer (for privacy)
   * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
   */
  selectRandomRelayer(options?: {
    token?: string;
    amount?: number;
  }): RelayerInfo | null {
    let candidates = this.getOnlineRelayers();

    if (options?.token) {
      candidates = candidates.filter(r =>
        r.supportedTokens.includes(options.token!)
      );
    }

    if (options?.amount) {
      candidates = candidates.filter(r =>
        options.amount! >= r.minAmount && options.amount! <= r.maxAmount
      );
    }

    if (candidates.length === 0) {
      return null;
    }

    // Random selection for privacy
    const index = Math.floor(Math.random() * candidates.length);
    return candidates[index];
  }

  /**
   * Submit transaction through a relayer
   * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
   */
  async submitTransaction(
    request: RelayRequest,
    relayerId?: string
  ): Promise<RelayResponse> {
    // Select relayer
    const relayer = relayerId
      ? this.getRelayer(relayerId)
      : this.selectBestRelayer();

    if (!relayer) {
      return {
        success: false,
        error: 'No available relayer',
        relayerId: 'none',
        latencyMs: 0,
      };
    }

    const startTime = Date.now();

    try {
      const response = await fetch(`${relayer.url}/relay/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(60000), // 1 minute timeout for ZK verification
      });

      const latencyMs = Date.now() - startTime;
      const data = await response.json();

      if (!response.ok || !data.success) {
        // Try fallback relayer
        const fallback = this.selectBestRelayer();
        if (fallback && fallback.id !== relayer.id) {
          return this.submitTransaction(request, fallback.id);
        }

        return {
          success: false,
          error: data.error || 'Relay failed',
          relayerId: relayer.id,
          latencyMs,
        };
      }

      // Update stats
      this.updateStats(relayer.id, true, latencyMs);

      return {
        success: true,
        txId: data.txId,
        signature: data.signature,
        relayerId: relayer.id,
        latencyMs,
      };

    } catch (error) {
      const latencyMs = Date.now() - startTime;

      // Update stats
      this.updateStats(relayer.id, false, latencyMs);

      // Mark relayer as potentially down
      const health = this.healthCache.get(relayer.id);
      if (health) {
        health.recentErrors.push((error as Error).message);
        if (health.recentErrors.length > 3) {
          health.isOnline = false;
        }
      }

      // Try fallback
      const fallback = this.selectBestRelayer();
      if (fallback && fallback.id !== relayer.id) {
        return this.submitTransaction(request, fallback.id);
      }

      return {
        success: false,
        error: (error as Error).message,
        relayerId: relayer.id,
        latencyMs,
      };
    }
  }

  /**
   * Update relayer stats after transaction
   */
  private updateStats(relayerId: string, success: boolean, latencyMs: number): void {
    let stats = this.statsCache.get(relayerId);

    if (!stats) {
      stats = {
        relayerId,
        totalTransactions: 0,
        totalVolume: 0,
        avgLatency: 0,
        uptime: 100,
      };
    }

    stats.totalTransactions++;
    stats.avgLatency = (stats.avgLatency * (stats.totalTransactions - 1) + latencyMs) / stats.totalTransactions;

    if (!success) {
      stats.uptime = Math.max(0, stats.uptime - 1);
    }

    this.statsCache.set(relayerId, stats);
  }

  /**
   * Add a custom relayer
   * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
   */
  addRelayer(relayer: RelayerInfo): void {
    this.relayers.set(relayer.id, relayer);
  }

  /**
   * Remove a relayer
   * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
   */
  removeRelayer(relayerId: string): void {
    this.relayers.delete(relayerId);
    this.healthCache.delete(relayerId);
    this.statsCache.delete(relayerId);
  }

  /**
   * Get network status summary
   * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
   */
  getNetworkStatus(): {
    totalRelayers: number;
    onlineRelayers: number;
    avgLatency: number;
    avgSuccessRate: number;
  } {
    const relayers = this.getRelayers();
    const online = this.getOnlineRelayers();

    let totalLatency = 0;
    let totalSuccessRate = 0;
    let healthCount = 0;

    for (const r of relayers) {
      const health = this.healthCache.get(r.id);
      if (health) {
        totalLatency += health.latencyMs;
        totalSuccessRate += health.successRate;
        healthCount++;
      }
    }

    return {
      totalRelayers: relayers.length,
      onlineRelayers: online.length,
      avgLatency: healthCount > 0 ? totalLatency / healthCount : 0,
      avgSuccessRate: healthCount > 0 ? totalSuccessRate / healthCount : 0,
    };
  }
}

// Singleton instance
let networkInstance: RelayerNetwork | null = null;

/** @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program */
export function getRelayerNetwork(): RelayerNetwork {
  if (!networkInstance) {
    networkInstance = new RelayerNetwork();
  }
  return networkInstance;
}

export default RelayerNetwork;
