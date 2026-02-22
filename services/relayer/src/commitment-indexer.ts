/**
 * Commitment Indexer for the ZK Shielded Pool
 *
 * Scans on-chain transaction history to build a commitment index,
 * then subscribes to real-time log updates for live tracking.
 * Serves commitments to mobile clients via REST endpoints,
 * replacing 157+ sequential RPC calls (~2.5 min) with a single HTTP request (~200ms).
 */

import { Connection, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import winston from 'winston';
import WebSocket from 'ws';

const CACHE_FILE = path.resolve(__dirname, '../commitments-cache.json');

export type IndexerStatus = 'initializing' | 'syncing' | 'synced' | 'error';

interface CacheData {
  commitments: Record<string, string>; // leafIndex -> commitment hex string
  lastSignature: string | null;
  lastUpdated: string;
}

export class CommitmentIndexer {
  private connection: Connection;
  private programId: PublicKey;
  private merkleTreePDA: PublicKey;
  private logger: winston.Logger;

  // In-memory commitment store: leafIndex -> commitment (decimal string)
  private commitments: Map<number, string> = new Map();
  private lastSignature: string | null = null;
  private _status: IndexerStatus = 'initializing';
  private logSubscriptionId: number | null = null;

  // On-chain state cache
  private _onChainRoot: string = '';
  private _onChainLeafCount: number = 0;

  // WebSocket clients for real-time push
  private wsClients: Set<WebSocket> = new Set();

  constructor(
    connection: Connection,
    programId: PublicKey,
    merkleTreePDA: PublicKey,
    logger: winston.Logger
  ) {
    this.connection = connection;
    this.programId = programId;
    this.merkleTreePDA = merkleTreePDA;
    this.logger = logger;
  }

  get status(): IndexerStatus {
    return this._status;
  }

  get leafCount(): number {
    return this._onChainLeafCount;
  }

  get root(): string {
    return this._onChainRoot;
  }

  /**
   * Get all commitments from a starting index
   */
  getCommitments(fromIndex: number = 0): { commitments: string[]; fromIndex: number; toIndex: number } {
    const result: string[] = [];
    const maxIndex = this._onChainLeafCount;
    for (let i = fromIndex; i < maxIndex; i++) {
      const c = this.commitments.get(i);
      if (c) {
        result.push(c);
      } else {
        // Gap - shouldn't happen, but return what we have
        this.logger.warn(`[Indexer] Missing commitment at index ${i}`);
        result.push('0');
      }
    }
    return { commitments: result, fromIndex, toIndex: maxIndex };
  }

  /**
   * Register a WebSocket client for real-time commitment updates
   */
  addWsClient(ws: WebSocket): void {
    this.wsClients.add(ws);
    this.logger.info(`[Indexer] WebSocket client connected (${this.wsClients.size} total)`);

    // Send current state snapshot on connect
    const snapshot = {
      type: 'snapshot',
      root: this._onChainRoot,
      leafCount: this._onChainLeafCount,
      status: this._status,
    };
    ws.send(JSON.stringify(snapshot));

    ws.on('close', () => {
      this.wsClients.delete(ws);
      this.logger.info(`[Indexer] WebSocket client disconnected (${this.wsClients.size} remaining)`);
    });

    ws.on('error', () => {
      this.wsClients.delete(ws);
    });
  }

  /**
   * Broadcast a new commitment to all connected WebSocket clients
   */
  private broadcastCommitment(index: number, commitment: string): void {
    const message = JSON.stringify({
      type: 'commitment',
      index,
      commitment,
      root: this._onChainRoot,
      leafCount: this._onChainLeafCount,
    });

    for (const ws of this.wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }

  /**
   * Initialize the indexer: load cache, scan chain, subscribe to updates
   */
  async start(): Promise<void> {
    this._status = 'syncing';

    // Load cached commitments from disk
    this.loadCache();

    try {
      // Read current on-chain state
      await this.refreshOnChainState();

      // Scan all historical transactions
      await this.scanHistory();

      // Subscribe to real-time updates
      this.subscribeToLogs();

      this._status = 'synced';
      this.logger.info(`[Indexer] Synced: ${this.commitments.size} commitments, leafCount=${this._onChainLeafCount}`);
    } catch (e: any) {
      this._status = 'error';
      this.logger.error(`[Indexer] Failed to start: ${e.message}`);
    }
  }

  /**
   * Stop the indexer and save cache
   */
  stop(): void {
    if (this.logSubscriptionId !== null) {
      this.connection.removeOnLogsListener(this.logSubscriptionId);
      this.logSubscriptionId = null;
    }
    this.saveCache();
  }

  /**
   * Read the on-chain MerkleTreeState to get root and leaf_count
   */
  private async refreshOnChainState(): Promise<void> {
    const account = await this.connection.getAccountInfo(this.merkleTreePDA);
    if (!account) {
      this.logger.warn('[Indexer] MerkleTree account not found');
      return;
    }

    const data = account.data;
    // Layout: 8 (disc) + 32 (pool) + 32 (root) + 8 (leaf_count) + ...
    const rootBytes = data.slice(8 + 32, 8 + 32 + 32);
    // Convert root to hex string (little-endian bytes -> bigint -> hex)
    let rootBigInt = BigInt(0);
    for (let i = 31; i >= 0; i--) {
      rootBigInt = (rootBigInt << BigInt(8)) | BigInt(rootBytes[i]);
    }
    this._onChainRoot = rootBigInt.toString();
    this._onChainLeafCount = Number(data.readBigUInt64LE(8 + 32 + 32));
  }

  /**
   * Scan all historical transactions for the merkle tree PDA
   */
  private async scanHistory(): Promise<void> {
    this.logger.info('[Indexer] Scanning transaction history...');

    // Fetch all signatures
    let allSignatures: Array<{ signature: string; slot: number }> = [];
    let lastSig: string | undefined;

    while (true) {
      const batch = await this.connection.getSignaturesForAddress(
        this.merkleTreePDA,
        { limit: 100, before: lastSig }
      );
      if (batch.length === 0) break;

      allSignatures.push(
        ...batch.filter(s => !s.err).map(s => ({ signature: s.signature, slot: s.slot }))
      );
      lastSig = batch[batch.length - 1].signature;

      if (allSignatures.length > 5000) break; // safety limit
    }

    // Sort chronologically (oldest first)
    allSignatures.sort((a, b) => a.slot - b.slot);
    this.logger.info(`[Indexer] Found ${allSignatures.length} signatures to process`);

    // Process in batches for efficiency
    const BATCH_SIZE = 20;
    for (let i = 0; i < allSignatures.length; i += BATCH_SIZE) {
      const batch = allSignatures.slice(i, i + BATCH_SIZE);

      // Fetch transactions in parallel within batch
      const txPromises = batch.map(({ signature }) =>
        this.fetchTxWithRetry(signature).catch(() => null)
      );
      const txResults = await Promise.all(txPromises);

      for (const tx of txResults) {
        if (tx?.meta?.logMessages) {
          this.parseTxCommitments(tx);
        }
      }

      // Small delay between batches to avoid rate limiting
      if (i + BATCH_SIZE < allSignatures.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // Update last signature for incremental scanning
    if (allSignatures.length > 0) {
      this.lastSignature = allSignatures[allSignatures.length - 1].signature;
    }

    this.saveCache();
    this.logger.info(`[Indexer] History scan complete: ${this.commitments.size} commitments indexed`);
  }

  /**
   * Subscribe to on-chain logs for real-time commitment tracking
   */
  private subscribeToLogs(): void {
    try {
      this.logSubscriptionId = this.connection.onLogs(
        this.merkleTreePDA,
        async (logInfo) => {
          if (logInfo.err) return;

          // Check if any log line contains commitment info
          const hasCommitment = logInfo.logs.some(
            log =>
              log.includes('Commitment added at index:') ||
              log.includes('Change commitment at index:') ||
              log.includes('New commitments at indices:')
          );

          if (hasCommitment) {
            this.logger.info(`[Indexer] New commitment detected in tx ${logInfo.signature}`);

            // Track commitment count before parsing to detect new additions
            const prevCount = this.commitments.size;

            // Fetch full transaction to extract commitment data
            await new Promise(r => setTimeout(r, 2000)); // Wait for finalization
            try {
              const tx = await this.fetchTxWithRetry(logInfo.signature);
              if (tx?.meta?.logMessages) {
                this.parseTxCommitments(tx);
                await this.refreshOnChainState();
                this.saveCache();

                // Broadcast any new commitments to WebSocket clients
                if (this.commitments.size > prevCount) {
                  for (let i = prevCount; i < this._onChainLeafCount; i++) {
                    const c = this.commitments.get(i);
                    if (c) {
                      this.broadcastCommitment(i, c);
                    }
                  }
                }
              }
            } catch (e: any) {
              this.logger.warn(`[Indexer] Failed to process live tx: ${e.message}`);
            }
          }
        },
        'confirmed'
      );
      this.logger.info('[Indexer] Subscribed to real-time log updates');
    } catch (e: any) {
      this.logger.warn(`[Indexer] Failed to subscribe to logs: ${e.message}`);
    }
  }

  /**
   * Parse a transaction and extract commitment data
   */
  private parseTxCommitments(tx: any): void {
    const logs: string[] = tx.meta.logMessages;

    let isShield = false;
    let isUnshield = false;
    let isTransfer = false;
    let leafIndex: number | null = null;
    let transferIndices: [number, number] | null = null;

    for (const log of logs) {
      if (log.includes('Shield') && !log.includes('Unshield')) isShield = true;
      if (log.includes('Unshield')) isUnshield = true;
      if (log.includes('Private transfer completed') || log.includes('Instruction: Transfer')) isTransfer = true;

      const indexMatch = log.match(/Commitment added at index: (\d+)/);
      if (indexMatch) leafIndex = parseInt(indexMatch[1], 10);

      const changeIndexMatch = log.match(/Change commitment at index: (\d+)/);
      if (changeIndexMatch) leafIndex = parseInt(changeIndexMatch[1], 10);

      const transferMatch = log.match(/New commitments at indices: (\d+), (\d+)/);
      if (transferMatch) transferIndices = [parseInt(transferMatch[1], 10), parseInt(transferMatch[2], 10)];
    }

    const txData = tx.transaction.message;

    const extractCommitmentBytes = (data: Uint8Array, offset: number): string => {
      const bytes = data.slice(offset, offset + 32);
      let c = BigInt(0);
      for (let i = 31; i >= 0; i--) {
        c = (c << BigInt(8)) | BigInt(bytes[i]);
      }
      return c.toString();
    };

    // Find our program's instruction
    const findProgramIx = (): { data: Uint8Array } | null => {
      if ('compiledInstructions' in txData) {
        const pi = txData.staticAccountKeys.findIndex((k: PublicKey) => k.equals(this.programId));
        if (pi !== -1) {
          for (const ix of txData.compiledInstructions) {
            if (ix.programIdIndex === pi) return { data: Buffer.from(ix.data) };
          }
        }
      } else {
        for (const ix of txData.instructions) {
          if (ix.programId.equals(this.programId)) {
            const ixData = typeof ix.data === 'string'
              ? Buffer.from(ix.data, 'base64')
              : ix.data;
            return { data: ixData };
          }
        }
      }
      return null;
    };

    const ix = findProgramIx();
    if (!ix) return;

    if (isShield && leafIndex !== null && ix.data.length >= 80) {
      // Shield: discriminator(8) + amount(8) + commitment(32) + newRoot(32)
      const commitment = extractCommitmentBytes(ix.data, 16);
      this.commitments.set(leafIndex, commitment);
    }

    if (isUnshield && leafIndex !== null && ix.data.length > 400) {
      // Unshield: discriminator(8) + proof(256) + nullifiers(32+32) + commitment(32) + ...
      const OFFSET = 8 + 256 + 32 + 32; // 328
      const commitment = extractCommitmentBytes(ix.data, OFFSET);
      this.commitments.set(leafIndex, commitment);
    }

    if (isTransfer && transferIndices && ix.data.length > 400) {
      const OFF1 = 8 + 256 + 32 + 32; // 328
      const OFF2 = OFF1 + 32; // 360
      this.commitments.set(transferIndices[0], extractCommitmentBytes(ix.data, OFF1));
      this.commitments.set(transferIndices[1], extractCommitmentBytes(ix.data, OFF2));
    }
  }

  /**
   * Fetch a transaction with exponential backoff retry
   */
  private async fetchTxWithRetry(sig: string, retries = 3): Promise<any> {
    for (let i = 0; i < retries; i++) {
      try {
        const tx = await this.connection.getTransaction(sig, {
          maxSupportedTransactionVersion: 0,
        });
        return tx;
      } catch (e: any) {
        if (e?.message?.includes('429') || e?.message?.includes('rate')) {
          const delay = Math.pow(2, i) * 1000;
          await new Promise(r => setTimeout(r, delay));
        } else {
          throw e;
        }
      }
    }
    return null;
  }

  /**
   * Load commitment cache from disk
   */
  private loadCache(): void {
    try {
      if (fs.existsSync(CACHE_FILE)) {
        const data: CacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        for (const [idx, commitment] of Object.entries(data.commitments)) {
          this.commitments.set(parseInt(idx), commitment);
        }
        this.lastSignature = data.lastSignature;
        this.logger.info(`[Indexer] Loaded ${this.commitments.size} cached commitments`);
      }
    } catch (e: any) {
      this.logger.warn(`[Indexer] Failed to load cache: ${e.message}`);
    }
  }

  /**
   * Save commitment cache to disk
   */
  private saveCache(): void {
    try {
      const data: CacheData = {
        commitments: {},
        lastSignature: this.lastSignature,
        lastUpdated: new Date().toISOString(),
      };
      for (const [idx, commitment] of this.commitments) {
        data.commitments[idx.toString()] = commitment;
      }
      fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
    } catch (e: any) {
      this.logger.error(`[Indexer] Failed to save cache: ${e.message}`);
    }
  }
}
