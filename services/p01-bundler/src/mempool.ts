/**
 * Privacy Mempool — Collects, mixes, and batch-submits transactions.
 *
 * Unlike Jito (MEV-focused, mainnet-only, validator-dependent), this is:
 * - Privacy-focused: strips metadata, mixes TX ordering, batches by time window
 * - Cluster-agnostic: works on devnet, testnet, mainnet — no validator mods needed
 * - Lightweight: single Node.js process, deployable on any VPS or edge function
 *
 * Flow:
 *   1. Clients submit serialized TXs via HTTP POST
 *   2. TXs accumulate in the mempool for BATCH_WINDOW_MS
 *   3. When the window closes, TXs are shuffled (randomize ordering)
 *   4. All TXs are submitted to the RPC simultaneously (Promise.allSettled)
 *   5. Results are returned to clients via their bundle IDs
 *
 * Privacy properties:
 *   - No IP logging (server strips all request metadata)
 *   - TX ordering is randomized (shuffle before submission)
 *   - Batch submission = same slot (or adjacent slots)
 *   - No correlation between submission order and on-chain order
 *   - TX contents are opaque to the bundler (just serialized bytes)
 */

import {
  Connection,
  VersionedTransaction,
  SendOptions,
} from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** How long to accumulate TXs before flushing (ms) */
const DEFAULT_BATCH_WINDOW_MS = 2_000;

/** Maximum TXs per batch (Solana block limit is ~1600 TXs) */
const MAX_BATCH_SIZE = 50;

/** Minimum TXs to trigger an early flush */
const MIN_FLUSH_SIZE = 5;

/** Maximum age of a pending TX before it's dropped (ms) */
const TX_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingTx {
  /** Unique ID for this TX within the bundle */
  id: string;
  /** Bundle ID this TX belongs to */
  bundleId: string;
  /** Raw serialized transaction bytes */
  data: Buffer;
  /** When this TX was received */
  receivedAt: number;
  /** Send options (skip preflight, etc.) */
  options?: SendOptions;
}

export interface BundleSubmission {
  bundleId: string;
  txIds: string[];
  receivedAt: number;
  /** Resolve function to notify the client when bundle is processed */
  resolve: (result: BundleFlushResult) => void;
}

export interface TxResult {
  txId: string;
  signature?: string;
  error?: string;
  slot?: number;
}

export interface BundleFlushResult {
  bundleId: string;
  landed: boolean;
  results: TxResult[];
  flushTimestamp: number;
  batchSize: number;
}

export interface MempoolStats {
  pendingTxs: number;
  pendingBundles: number;
  totalFlushed: number;
  totalTxsProcessed: number;
  totalTxsLanded: number;
  totalTxsFailed: number;
  avgBatchSize: number;
  uptime: number;
}

// ---------------------------------------------------------------------------
// Privacy Mempool
// ---------------------------------------------------------------------------

export class PrivacyMempool {
  private connection: Connection;
  private batchWindowMs: number;
  private pendingTxs: PendingTx[] = [];
  private pendingBundles: Map<string, BundleSubmission> = new Map();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private startedAt: number = Date.now();

  // Stats
  private totalFlushed = 0;
  private totalTxsProcessed = 0;
  private totalTxsLanded = 0;
  private totalTxsFailed = 0;
  private batchSizes: number[] = [];

  constructor(rpcUrl: string, opts?: { batchWindowMs?: number }) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.batchWindowMs = opts?.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;

    console.log(`[Mempool] Initialized — RPC: ${rpcUrl.slice(0, 30)}... | Window: ${this.batchWindowMs}ms`);
  }

  /**
   * Submit a bundle of serialized transactions.
   *
   * Returns a promise that resolves when the batch containing this bundle
   * is flushed and submitted to the network.
   *
   * @param bundleId - Unique bundle identifier
   * @param txs - Array of serialized transaction buffers
   * @returns Promise resolving to flush results
   */
  submit(bundleId: string, txs: Buffer[]): Promise<BundleFlushResult> {
    return new Promise((resolve) => {
      const txIds: string[] = [];

      for (let i = 0; i < txs.length; i++) {
        const txId = `${bundleId}_${i}`;
        txIds.push(txId);

        this.pendingTxs.push({
          id: txId,
          bundleId,
          data: txs[i],
          receivedAt: Date.now(),
        });
      }

      this.pendingBundles.set(bundleId, {
        bundleId,
        txIds,
        receivedAt: Date.now(),
        resolve,
      });

      console.log(`[Mempool] Bundle ${bundleId.slice(0, 8)}... queued (${txs.length} TXs) | Pool: ${this.pendingTxs.length} total`);

      // Start or reset the flush timer
      this.scheduleFLush();

      // Flush immediately if we've hit the batch size
      if (this.pendingTxs.length >= MAX_BATCH_SIZE) {
        console.log(`[Mempool] Max batch size reached — flushing now`);
        this.flush();
      }
    });
  }

  /**
   * Force an immediate flush of all pending transactions.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Grab all pending TXs and clear the pool
    const txsToFlush = [...this.pendingTxs];
    const bundlesToNotify = new Map(this.pendingBundles);
    this.pendingTxs = [];
    this.pendingBundles.clear();

    if (txsToFlush.length === 0) return;

    // Drop expired TXs
    const now = Date.now();
    const validTxs = txsToFlush.filter(tx => now - tx.receivedAt < TX_TTL_MS);
    const dropped = txsToFlush.length - validTxs.length;
    if (dropped > 0) {
      console.warn(`[Mempool] Dropped ${dropped} expired TXs`);
    }

    // ── PRIVACY STEP: Shuffle TX ordering ──
    // This ensures submission order doesn't leak information about
    // which TXs belong together or which arrived first.
    shuffleArray(validTxs);

    console.log(`[Mempool] Flushing ${validTxs.length} TXs (shuffled)...`);

    // ── Submit all simultaneously ──
    const results = await Promise.allSettled(
      validTxs.map(async (tx): Promise<TxResult> => {
        try {
          const sig = await this.connection.sendRawTransaction(tx.data, {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
            maxRetries: 2,
          });
          return { txId: tx.id, signature: sig };
        } catch (err: any) {
          return { txId: tx.id, error: err.message || 'Send failed' };
        }
      })
    );

    // Map results back to TxResults
    const txResults: Map<string, TxResult> = new Map();
    for (const result of results) {
      if (result.status === 'fulfilled') {
        txResults.set(result.value.txId, result.value);
        if (result.value.signature) this.totalTxsLanded++;
        else this.totalTxsFailed++;
      } else {
        this.totalTxsFailed++;
      }
    }

    // Update stats
    this.totalFlushed++;
    this.totalTxsProcessed += validTxs.length;
    this.batchSizes.push(validTxs.length);

    const landed = [...txResults.values()].filter(r => r.signature).length;
    console.log(`[Mempool] Flush complete: ${landed}/${validTxs.length} landed`);

    // Notify bundles
    for (const [bundleId, bundle] of bundlesToNotify) {
      const bundleResults = bundle.txIds.map(
        txId => txResults.get(txId) || { txId, error: 'Not found in flush results' }
      );
      const allLanded = bundleResults.every(r => r.signature);

      bundle.resolve({
        bundleId,
        landed: allLanded,
        results: bundleResults,
        flushTimestamp: now,
        batchSize: validTxs.length,
      });
    }
  }

  /**
   * Get mempool statistics.
   */
  getStats(): MempoolStats {
    const avgBatch = this.batchSizes.length > 0
      ? this.batchSizes.reduce((a, b) => a + b, 0) / this.batchSizes.length
      : 0;

    return {
      pendingTxs: this.pendingTxs.length,
      pendingBundles: this.pendingBundles.size,
      totalFlushed: this.totalFlushed,
      totalTxsProcessed: this.totalTxsProcessed,
      totalTxsLanded: this.totalTxsLanded,
      totalTxsFailed: this.totalTxsFailed,
      avgBatchSize: Math.round(avgBatch * 10) / 10,
      uptime: Date.now() - this.startedAt,
    };
  }

  /**
   * Graceful shutdown — flush remaining TXs.
   */
  async shutdown(): Promise<void> {
    console.log('[Mempool] Shutting down — flushing remaining TXs...');
    await this.flush();
  }

  // ── Internal ──

  private scheduleFLush(): void {
    if (this.flushTimer) return; // Already scheduled

    // Flush early if we have enough TXs
    const delay = this.pendingTxs.length >= MIN_FLUSH_SIZE
      ? Math.floor(this.batchWindowMs / 2)
      : this.batchWindowMs;

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, delay);
  }
}

// ---------------------------------------------------------------------------
// Fisher-Yates shuffle (cryptographically unnecessary but privacy-preserving)
// ---------------------------------------------------------------------------

function shuffleArray<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
