/**
 * P01 Bundle Client — SDK for submitting bundles to the P01 Bundle Engine.
 *
 * Usage:
 *   import { P01BundleClient } from '@p01/bundler/client';
 *
 *   const client = new P01BundleClient('https://bundler.protocol-01.xyz');
 *   const result = await client.submitBundle([signedTx1, signedTx2]);
 *   console.log(result.bundleId, result.landed);
 *
 * Works in: Node.js, React Native, browser — just needs fetch().
 */

import { Transaction, VersionedTransaction } from '@solana/web3.js';

export interface P01BundleResult {
  bundleId: string;
  landed: boolean;
  results: Array<{
    txId: string;
    signature?: string;
    error?: string;
  }>;
  batchSize: number;
  flushTimestamp: number;
}

export interface P01BundleQueuedResult {
  bundleId: string;
  queued: boolean;
  txCount: number;
  estimatedFlushMs: number;
}

export interface P01BundlerStats {
  pendingTxs: number;
  pendingBundles: number;
  totalFlushed: number;
  totalTxsProcessed: number;
  totalTxsLanded: number;
  totalTxsFailed: number;
  avgBatchSize: number;
  uptime: number;
  version: string;
  engine: string;
  cluster: string;
}

export class P01BundleClient {
  private baseUrl: string;
  private timeout: number;

  constructor(baseUrl: string, opts?: { timeoutMs?: number }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeout = opts?.timeoutMs ?? 30_000;
  }

  /**
   * Submit a bundle of signed transactions (async — returns immediately).
   *
   * The bundle is queued in the privacy mempool and will be flushed
   * with other TXs in the next batch window (~2s).
   *
   * @param txs - Array of signed Transaction or VersionedTransaction
   * @param bundleId - Optional client-provided bundle ID
   * @returns Queued result with bundle ID and estimated flush time
   */
  async submitBundle(
    txs: (Transaction | VersionedTransaction)[],
    bundleId?: string,
  ): Promise<P01BundleQueuedResult> {
    const transactions = txs.map(tx => {
      const bytes = tx instanceof VersionedTransaction
        ? tx.serialize()
        : tx.serialize();
      return Buffer.from(bytes).toString('base64');
    });

    const res = await this.fetch('/v1/bundle', {
      method: 'POST',
      body: JSON.stringify({ transactions, bundleId }),
    });

    return res as P01BundleQueuedResult;
  }

  /**
   * Submit a bundle and wait for it to be processed.
   *
   * Blocks until the batch window closes and all TXs are submitted.
   * Use this when you need confirmation before proceeding.
   *
   * @param txs - Array of signed Transaction or VersionedTransaction
   * @param bundleId - Optional client-provided bundle ID
   * @returns Full result with signatures and landing status
   */
  async submitBundleSync(
    txs: (Transaction | VersionedTransaction)[],
    bundleId?: string,
  ): Promise<P01BundleResult> {
    const transactions = txs.map(tx => {
      const bytes = tx instanceof VersionedTransaction
        ? tx.serialize()
        : tx.serialize();
      return Buffer.from(bytes).toString('base64');
    });

    const res = await this.fetch('/v1/bundle/sync', {
      method: 'POST',
      body: JSON.stringify({ transactions, bundleId }),
    });

    return res as P01BundleResult;
  }

  /**
   * Check the status of a previously submitted bundle.
   *
   * @param bundleId - The bundle ID to check
   * @returns Bundle result if available, null if pending or expired
   */
  async getBundleStatus(bundleId: string): Promise<P01BundleResult | null> {
    try {
      const res = await this.fetch(`/v1/bundle/${bundleId}`, { method: 'GET' });
      if ((res as any).status === 'pending_or_expired') return null;
      return res as P01BundleResult;
    } catch {
      return null;
    }
  }

  /**
   * Get mempool statistics.
   */
  async getStats(): Promise<P01BundlerStats> {
    return this.fetch('/v1/stats', { method: 'GET' }) as Promise<P01BundlerStats>;
  }

  /**
   * Health check.
   */
  async isHealthy(): Promise<boolean> {
    try {
      const res = await this.fetch('/health', { method: 'GET' });
      return (res as any).status === 'ok';
    } catch {
      return false;
    }
  }

  // ── Internal ──

  private async fetch(path: string, init: { method: string; body?: string }): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: {
          'Content-Type': 'application/json',
          // No user-agent, no cookies, no identifying headers
        },
        body: init.body,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`P01 Bundler error (${res.status}): ${text}`);
      }

      return res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}
