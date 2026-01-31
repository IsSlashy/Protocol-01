/**
 * Decentralized Relayer Network
 *
 * Manages multiple relayers for:
 * - Redundancy and failover
 * - Load balancing
 * - Privacy (random relayer selection)
 * - Censorship resistance
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────┐
 * │                    RELAYER NETWORK                          │
 * │                                                             │
 * │   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐   │
 * │   │Relayer 1│   │Relayer 2│   │Relayer 3│   │Relayer N│   │
 * │   │ 🟢 98%  │   │ 🟢 95%  │   │ 🟡 80%  │   │ 🔴 DOWN │   │
 * │   └────┬────┘   └────┬────┘   └────┬────┘   └─────────┘   │
 * │        │             │             │                       │
 * │        └─────────────┼─────────────┘                       │
 * │                      │                                     │
 * │              ┌───────┴───────┐                             │
 * │              │  LOAD BALANCER │                            │
 * │              │  (weighted)    │                            │
 * │              └───────┬───────┘                             │
 * │                      │                                     │
 * └──────────────────────┼─────────────────────────────────────┘
 *                        │
 *                   YOUR WALLET
 */

import { Connection, PublicKey } from '@solana/web3.js';

// Types
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

export interface RelayerHealth {
  relayerId: string;
  isOnline: boolean;
  latencyMs: number;
  successRate: number;      // 0-100
  lastChecked: number;
  recentErrors: string[];
  balance: number;          // Relayer's SOL balance
}

export interface RelayerStats {
  relayerId: string;
  totalTransactions: number;
  totalVolume: number;
  avgLatency: number;
  uptime: number;           // 0-100
}

export interface RelayRequest {
  proof: any;
  publicInputs: string[];
  nullifiers: string[];
  outputCommitments: string[];
  merkleRoot: string;
  relayerFeeCommitment?: string;
}

export interface RelayResponse {
  success: boolean;
  txId?: string;
  signature?: string;
  error?: string;
  relayerId: string;
  latencyMs: number;
}

// Default relayers (would be fetched from on-chain registry in production)
const DEFAULT_RELAYERS: RelayerInfo[] = [
  {
    id: 'relayer-1',
    name: 'Specter Main',
    url: 'https://relayer1.specter.protocol',
    publicKey: 'Re1ay1111111111111111111111111111111111111',
    feeBps: 10,
    minAmount: 0.01,
    maxAmount: 1000,
    supportedTokens: ['SOL', 'USDC', 'USDT'],
    version: '1.0.0',
    region: 'US',
  },
  {
    id: 'relayer-2',
    name: 'Specter EU',
    url: 'https://relayer2.specter.protocol',
    publicKey: 'Re1ay2222222222222222222222222222222222222',
    feeBps: 12,
    minAmount: 0.01,
    maxAmount: 500,
    supportedTokens: ['SOL', 'USDC'],
    version: '1.0.0',
    region: 'EU',
  },
  {
    id: 'relayer-3',
    name: 'Specter Asia',
    url: 'https://relayer3.specter.protocol',
    publicKey: 'Re1ay3333333333333333333333333333333333333',
    feeBps: 15,
    minAmount: 0.05,
    maxAmount: 200,
    supportedTokens: ['SOL'],
    version: '1.0.0',
    region: 'ASIA',
  },
];

/**
 * Relayer Network Manager
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
   */
  startHealthChecks(intervalMs: number = 30000): void {
    this.checkAllRelayers();
    this.healthCheckInterval = setInterval(() => {
      this.checkAllRelayers();
    }, intervalMs);
  }

  /**
   * Stop health checks
   */
  stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Check health of all relayers
   */
  async checkAllRelayers(): Promise<void> {
    const checks = Array.from(this.relayers.values()).map(r =>
      this.checkRelayerHealth(r)
    );
    await Promise.allSettled(checks);
  }

  /**
   * Check health of a single relayer
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
   */
  getRelayers(): RelayerInfo[] {
    return Array.from(this.relayers.values());
  }

  /**
   * Get online relayers only
   */
  getOnlineRelayers(): RelayerInfo[] {
    return this.getRelayers().filter(r => {
      const health = this.healthCache.get(r.id);
      return health?.isOnline !== false;
    });
  }

  /**
   * Get relayer by ID
   */
  getRelayer(id: string): RelayerInfo | undefined {
    return this.relayers.get(id);
  }

  /**
   * Get health for a relayer
   */
  getHealth(relayerId: string): RelayerHealth | undefined {
    return this.healthCache.get(relayerId);
  }

  /**
   * Select best relayer based on criteria
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
   */
  addRelayer(relayer: RelayerInfo): void {
    this.relayers.set(relayer.id, relayer);
  }

  /**
   * Remove a relayer
   */
  removeRelayer(relayerId: string): void {
    this.relayers.delete(relayerId);
    this.healthCache.delete(relayerId);
    this.statsCache.delete(relayerId);
  }

  /**
   * Get network status summary
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

export function getRelayerNetwork(): RelayerNetwork {
  if (!networkInstance) {
    networkInstance = new RelayerNetwork();
  }
  return networkInstance;
}

export default RelayerNetwork;
