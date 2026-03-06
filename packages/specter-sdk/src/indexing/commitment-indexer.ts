/**
 * Client-Side Commitment Indexer
 *
 * Replaces the relayer's CommitmentIndexer so clients talk directly to Solana.
 * Scans historical transactions for the pool PDA, parses instruction data to
 * extract commitments at the same byte offsets the on-chain program uses,
 * subscribes to real-time logs, and maintains a local Merkle tree.
 *
 * Philosophy: TRUST THE MATH, NOT THE NODES.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { poseidon2 } from 'poseidon-lite';
import { SpecterError, SpecterErrorCode } from '../types';

/**
 * Compute zero hashes for an empty Merkle tree of the given depth.
 * zeroHashes[0] = zeroLeaf, zeroHashes[i] = poseidon2(zeroHashes[i-1], zeroHashes[i-1])
 */
function computeZeroHashes(depth: number, zeroLeaf: bigint): bigint[] {
  const hashes: bigint[] = [zeroLeaf];
  for (let i = 1; i <= depth; i++) {
    hashes.push(poseidon2([hashes[i - 1]!, hashes[i - 1]!]));
  }
  return hashes;
}
import type { IndexerCache } from './cache';
import { MemoryCache } from './cache';

// ============================================================================
// Types
// ============================================================================

export type IndexerStatus = 'idle' | 'syncing' | 'synced' | 'error';

export interface CommitmentIndexerOptions {
  /** Merkle tree depth (default 20) */
  depth?: number;
  /** Batch size for parallel tx fetches (default 20) */
  batchSize?: number;
  /** Delay between batches in ms to avoid rate-limits (default 200) */
  batchDelayMs?: number;
  /** Maximum signatures to scan (safety limit, default 5000) */
  maxSignatures?: number;
  /** Optional cache for persistence across sessions */
  cache?: IndexerCache;
  /** Cache key prefix (default 'commitments') */
  cacheKey?: string;
  /** Enable debug logging (default false) */
  debug?: boolean;
}

interface SignatureEntry {
  signature: string;
  slot: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_DEPTH = 20;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_BATCH_DELAY_MS = 200;
const DEFAULT_MAX_SIGNATURES = 5000;
const DEFAULT_ZERO = BigInt(
  '21663839004416932945382355908790599225266501822907911457504978515578255421292',
);

// Instruction data offsets (must match on-chain Groth16Proof layout)
// Groth16Proof: pi_a(64) + pi_b(128) + pi_c(64) = 256 bytes
const SHIELD_COMMITMENT_OFFSET = 16; // disc(8) + amount(8)
const UNSHIELD_COMMITMENT_OFFSET = 328; // disc(8) + proof(256) + null1(32) + null2(32)
const TRANSFER_COMMITMENT_1_OFFSET = 328;
const TRANSFER_COMMITMENT_2_OFFSET = 360;

// ============================================================================
// CommitmentIndexer
// ============================================================================

export class CommitmentIndexer {
  private connection: Connection;
  private programId: PublicKey;
  private poolPda: PublicKey;
  private depth: number;
  private batchSize: number;
  private batchDelayMs: number;
  private maxSignatures: number;
  private cache: IndexerCache;
  private cacheKey: string;
  private debug: boolean;

  // Merkle tree state
  private leaves: string[] = [];
  private filledSubtrees: bigint[];
  private currentRoot: bigint;
  private zeroHashes: bigint[];

  // On-chain state
  private onChainRoot: string = '';
  private onChainLeafCount: number = 0;

  // Status
  private _status: IndexerStatus = 'idle';
  private logSubscriptionId: number | null = null;

  constructor(
    connection: Connection,
    poolProgramId: PublicKey,
    poolPda: PublicKey,
    options: CommitmentIndexerOptions = {},
  ) {
    this.connection = connection;
    this.programId = poolProgramId;
    this.poolPda = poolPda;
    this.depth = options.depth ?? DEFAULT_DEPTH;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.batchDelayMs = options.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS;
    this.maxSignatures = options.maxSignatures ?? DEFAULT_MAX_SIGNATURES;
    this.cache = options.cache ?? new MemoryCache();
    this.cacheKey = options.cacheKey ?? 'commitments';
    this.debug = options.debug ?? false;

    // Initialize zero hashes and empty tree
    this.zeroHashes = computeZeroHashes(this.depth, DEFAULT_ZERO);
    this.filledSubtrees = this.zeroHashes.slice(0, this.depth);
    this.currentRoot = this.zeroHashes[this.depth]!;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /** Current sync status */
  get status(): IndexerStatus {
    return this._status;
  }

  /** Current Merkle root as decimal string */
  getRoot(): string {
    return this.currentRoot.toString();
  }

  /** Number of leaves inserted into the local tree */
  getLeafCount(): number {
    return this.leaves.length;
  }

  /**
   * Return commitment strings from `fromIndex` onwards.
   * Each commitment is a decimal string of the field element.
   */
  getCommitments(fromIndex: number = 0): string[] {
    if (fromIndex < 0 || fromIndex > this.leaves.length) {
      return [];
    }
    return this.leaves.slice(fromIndex);
  }

  /**
   * Build a Merkle proof for a given leaf index.
   * Returns path elements and path indices (left/right indicators).
   */
  getMerkleProof(leafIndex: number): {
    pathElements: string[];
    pathIndices: number[];
  } {
    if (leafIndex < 0 || leafIndex >= this.leaves.length) {
      throw new SpecterError(
        SpecterErrorCode.SCAN_FAILED,
        `Leaf index ${leafIndex} is out of range [0, ${this.leaves.length})`,
      );
    }

    // Rebuild path by walking the tree from the leaf upward.
    // We recompute sibling hashes from the stored leaves layer by layer.
    const pathElements: string[] = [];
    const pathIndices: number[] = [];

    // Start with all leaves as the bottom layer
    let layer: bigint[] = this.leaves.map((c) => BigInt(c));
    let currentIdx = leafIndex;

    for (let level = 0; level < this.depth; level++) {
      const isRight = currentIdx & 1;
      pathIndices.push(isRight);

      if (isRight === 0) {
        // Current node is left child; sibling is to the right
        const siblingIdx = currentIdx + 1;
        const sibling =
          siblingIdx < layer.length ? layer[siblingIdx]! : this.zeroHashes[level]!;
        pathElements.push(sibling.toString());
      } else {
        // Current node is right child; sibling is to the left
        const siblingIdx = currentIdx - 1;
        const sibling = layer[siblingIdx]!;
        pathElements.push(sibling.toString());
      }

      // Compute next layer (parent nodes)
      const nextLayer: bigint[] = [];
      for (let i = 0; i < layer.length; i += 2) {
        const left = layer[i]!;
        const right = i + 1 < layer.length ? layer[i + 1]! : this.zeroHashes[level]!;
        nextLayer.push(poseidon2([left, right]));
      }
      layer = nextLayer;
      currentIdx = currentIdx >> 1;
    }

    return { pathElements, pathIndices };
  }

  /**
   * Full sync from genesis.
   * Fetches all historical commitments, builds the Merkle tree,
   * and optionally reports progress via callback.
   */
  async fullSync(
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<void> {
    this._status = 'syncing';

    try {
      // Attempt to load from cache
      this.loadFromCache();

      // Read current on-chain state
      await this.refreshOnChainState();

      // If cache already has all commitments, skip chain scan
      if (this.leaves.length >= this.onChainLeafCount && this.onChainLeafCount > 0) {
        this.log(`Cache is up to date (${this.leaves.length} commitments)`);
        this._status = 'synced';
        return;
      }

      // Scan historical transactions
      await this.scanHistory(onProgress);

      // Persist to cache
      this.saveToCache();

      this._status = 'synced';
      this.log(
        `Synced: ${this.leaves.length} commitments, root=${this.currentRoot.toString().slice(0, 16)}...`,
      );
    } catch (error: unknown) {
      this._status = 'error';
      throw new SpecterError(
        SpecterErrorCode.RPC_ERROR,
        `Commitment indexer sync failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Subscribe to real-time commitment updates via on-chain log subscription.
   * Returns an object with an `unsubscribe()` method.
   */
  subscribe(): { unsubscribe: () => void } {
    if (this.logSubscriptionId !== null) {
      // Already subscribed
      return { unsubscribe: () => this.unsubscribe() };
    }

    try {
      this.logSubscriptionId = this.connection.onLogs(
        this.poolPda,
        async (logInfo) => {
          if (logInfo.err) return;

          const hasCommitment = logInfo.logs.some(
            (log) =>
              log.includes('Commitment added at index:') ||
              log.includes('Change commitment at index:') ||
              log.includes('New commitments at indices:'),
          );

          if (!hasCommitment) return;

          this.log(`New commitment detected in tx ${logInfo.signature}`);

          // Wait for finalization before fetching
          await this.sleep(2000);

          try {
            const tx = await this.fetchTxWithRetry(logInfo.signature);
            if (tx?.meta?.logMessages) {
              this.parseTxCommitments(tx);
              await this.refreshOnChainState();
              this.saveToCache();
            }
          } catch (err: unknown) {
            this.log(
              `Failed to process live tx: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
        'confirmed',
      );

      this.log('Subscribed to real-time log updates');
    } catch (err: unknown) {
      this.log(
        `Failed to subscribe to logs: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { unsubscribe: () => this.unsubscribe() };
  }

  /**
   * Stop the real-time log subscription.
   */
  unsubscribe(): void {
    if (this.logSubscriptionId !== null) {
      this.connection.removeOnLogsListener(this.logSubscriptionId);
      this.logSubscriptionId = null;
      this.log('Unsubscribed from real-time log updates');
    }
  }

  // ==========================================================================
  // Private — On-chain state
  // ==========================================================================

  /**
   * Read the on-chain MerkleTreeState account to get root and leaf_count.
   * Layout: 8 (discriminator) + 32 (pool) + 32 (root) + 8 (leaf_count) + ...
   */
  private async refreshOnChainState(): Promise<void> {
    // Derive the MerkleTree PDA: seeds = ["merkle_tree", pool_pda]
    const [merkleTreePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('merkle_tree'), this.poolPda.toBytes()],
      this.programId,
    );

    const account = await this.connection.getAccountInfo(merkleTreePda);
    if (!account) {
      this.log('MerkleTree account not found on chain');
      return;
    }

    const data = account.data;
    // Root: 32 bytes starting at offset 40 (8 disc + 32 pool)
    const rootBytes = data.slice(40, 72);
    let rootBigInt = BigInt(0);
    for (let i = 31; i >= 0; i--) {
      rootBigInt = (rootBigInt << BigInt(8)) | BigInt(rootBytes[i]!);
    }
    this.onChainRoot = rootBigInt.toString();

    // Leaf count: u64 at offset 72
    this.onChainLeafCount = Number(data.readBigUInt64LE(72));
  }

  // ==========================================================================
  // Private — Historical scan
  // ==========================================================================

  private async scanHistory(
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<void> {
    this.log('Scanning transaction history...');

    // Collect all signatures for the pool PDA
    const allSignatures: SignatureEntry[] = [];
    let beforeSig: string | undefined;

    while (true) {
      const batch = await this.connection.getSignaturesForAddress(this.poolPda, {
        limit: 100,
        before: beforeSig,
      });
      if (batch.length === 0) break;

      for (const s of batch) {
        if (!s.err) {
          allSignatures.push({ signature: s.signature, slot: s.slot });
        }
      }

      beforeSig = batch[batch.length - 1]!.signature;
      if (allSignatures.length >= this.maxSignatures) break;
    }

    // Sort chronologically (oldest first)
    allSignatures.sort((a, b) => a.slot - b.slot);
    this.log(`Found ${allSignatures.length} signatures to process`);

    const total = allSignatures.length;

    // Process in batches
    for (let i = 0; i < total; i += this.batchSize) {
      const batch = allSignatures.slice(i, i + this.batchSize);

      const txPromises = batch.map(({ signature }) =>
        this.fetchTxWithRetry(signature).catch(() => null),
      );
      const txResults = await Promise.all(txPromises);

      for (const tx of txResults) {
        if (tx?.meta?.logMessages) {
          this.parseTxCommitments(tx);
        }
      }

      if (onProgress) {
        onProgress(Math.min(i + this.batchSize, total), total);
      }

      // Rate-limit delay between batches
      if (i + this.batchSize < total) {
        await this.sleep(this.batchDelayMs);
      }
    }

    this.log(`History scan complete: ${this.leaves.length} commitments indexed`);
  }

  // ==========================================================================
  // Private — Transaction parsing
  // ==========================================================================

  /**
   * Parse a single transaction and extract commitment(s).
   * Replicates the exact logic from the relayer's CommitmentIndexer.
   */
  private parseTxCommitments(tx: ParsedTx): void {
    const logs: string[] = tx.meta.logMessages;

    let isShield = false;
    let isUnshield = false;
    let isTransfer = false;
    let leafIndex: number | null = null;
    let transferIndices: [number, number] | null = null;
    let relayerIndices: [number, number, number] | null = null;

    for (const log of logs) {
      if (log.includes('Shield') && !log.includes('Unshield')) isShield = true;
      if (log.includes('Unshield')) isUnshield = true;
      if (log.includes('Private transfer completed') || log.includes('Instruction: Transfer'))
        isTransfer = true;
      if (log.includes('Relayer transfer completed')) isTransfer = true;

      const indexMatch = log.match(/Commitment added at index: (\d+)/);
      if (indexMatch) leafIndex = parseInt(indexMatch[1]!, 10);

      const changeMatch = log.match(/Change commitment at index: (\d+)/);
      if (changeMatch) leafIndex = parseInt(changeMatch[1]!, 10);

      const transferMatch = log.match(/New commitments at indices: (\d+), (\d+)$/);
      if (transferMatch) {
        transferIndices = [
          parseInt(transferMatch[1]!, 10),
          parseInt(transferMatch[2]!, 10),
        ];
      }

      // Relayer transfer has 3 indices: "N, M, K (fee)"
      const relayerMatch = log.match(
        /New commitments at indices: (\d+), (\d+), (\d+) \(fee\)/,
      );
      if (relayerMatch) {
        relayerIndices = [
          parseInt(relayerMatch[1]!, 10),
          parseInt(relayerMatch[2]!, 10),
          parseInt(relayerMatch[3]!, 10),
        ];
        // Override the two-index match if relayer match is found
        transferIndices = null;
      }
    }

    const ix = this.findProgramInstruction(tx);
    if (!ix) return;

    if (isShield && leafIndex !== null && ix.data.length >= 80) {
      const commitment = this.extractCommitmentBytes(ix.data, SHIELD_COMMITMENT_OFFSET);
      this.insertLeaf(leafIndex, commitment);
    }

    if (isUnshield && leafIndex !== null && ix.data.length > 400) {
      const commitment = this.extractCommitmentBytes(
        ix.data,
        UNSHIELD_COMMITMENT_OFFSET,
      );
      this.insertLeaf(leafIndex, commitment);
    }

    if (isTransfer && transferIndices && ix.data.length > 400) {
      const c1 = this.extractCommitmentBytes(
        ix.data,
        TRANSFER_COMMITMENT_1_OFFSET,
      );
      const c2 = this.extractCommitmentBytes(
        ix.data,
        TRANSFER_COMMITMENT_2_OFFSET,
      );
      this.insertLeaf(transferIndices[0], c1);
      this.insertLeaf(transferIndices[1], c2);
    }

    if (isTransfer && relayerIndices && ix.data.length > 400) {
      // Relayer transfer: 3 commitments
      const c1 = this.extractCommitmentBytes(
        ix.data,
        TRANSFER_COMMITMENT_1_OFFSET,
      );
      const c2 = this.extractCommitmentBytes(
        ix.data,
        TRANSFER_COMMITMENT_2_OFFSET,
      );
      // Third commitment (fee) is at offset 392 (360 + 32)
      const c3 = this.extractCommitmentBytes(ix.data, 392);
      this.insertLeaf(relayerIndices[0], c1);
      this.insertLeaf(relayerIndices[1], c2);
      this.insertLeaf(relayerIndices[2], c3);
    }
  }

  /**
   * Extract a 32-byte little-endian commitment from instruction data and
   * convert to a decimal string (matching the relayer logic exactly).
   */
  private extractCommitmentBytes(data: Uint8Array, offset: number): string {
    const bytes = data.slice(offset, offset + 32);
    let c = BigInt(0);
    for (let i = 31; i >= 0; i--) {
      c = (c << BigInt(8)) | BigInt(bytes[i]!);
    }
    return c.toString();
  }

  /**
   * Find the instruction that belongs to our program inside a transaction.
   * Handles both legacy and versioned transaction formats.
   */
  private findProgramInstruction(
    tx: ParsedTx,
  ): { data: Uint8Array } | null {
    const txData = tx.transaction.message;

    // Versioned (v0) transaction format
    if ('compiledInstructions' in txData) {
      const pi = (txData as VersionedMessage).staticAccountKeys.findIndex(
        (k: PublicKey) => k.equals(this.programId),
      );
      if (pi !== -1) {
        for (const ix of (txData as VersionedMessage).compiledInstructions) {
          if (ix.programIdIndex === pi) {
            return { data: new Uint8Array(ix.data) };
          }
        }
      }
    } else {
      // Legacy transaction format
      for (const ix of (txData as LegacyMessage).instructions) {
        if (ix.programId.equals(this.programId)) {
          const ixData =
            typeof ix.data === 'string'
              ? Uint8Array.from(Buffer.from(ix.data, 'base64'))
              : ix.data;
          return { data: ixData };
        }
      }
    }

    return null;
  }

  // ==========================================================================
  // Private — Merkle tree operations
  // ==========================================================================

  /**
   * Insert a leaf into the local incremental Merkle tree at a given index.
   * If the index matches the next expected position, insert normally.
   * Otherwise, fill gaps with zero values.
   */
  private insertLeaf(index: number, commitment: string): void {
    // Already have this leaf
    if (index < this.leaves.length) {
      // Update in place if different (e.g., change commitment in unshield)
      this.leaves[index] = commitment;
      this.rebuildTree();
      return;
    }

    // Fill gaps (shouldn't happen in practice, but be defensive)
    while (this.leaves.length < index) {
      this.leaves.push(DEFAULT_ZERO.toString());
      this.updateTreeWithLeaf(DEFAULT_ZERO);
    }

    // Insert the new leaf
    this.leaves.push(commitment);
    this.updateTreeWithLeaf(BigInt(commitment));
  }

  /**
   * Incrementally update the Merkle tree with a new leaf.
   * Uses the filled-subtrees approach for O(depth) updates.
   */
  private updateTreeWithLeaf(leaf: bigint): void {
    let current = leaf;
    let idx = this.leaves.length - 1;

    for (let level = 0; level < this.depth; level++) {
      const isRight = idx & 1;

      if (isRight === 0) {
        this.filledSubtrees[level] = current;
        current = poseidon2([current, this.zeroHashes[level]!]);
      } else {
        current = poseidon2([this.filledSubtrees[level]!, current]);
      }

      idx >>= 1;
    }

    this.currentRoot = current;
  }

  /**
   * Full tree rebuild from all leaves. Used after an in-place update.
   */
  private rebuildTree(): void {
    // Reset subtrees
    this.filledSubtrees = this.zeroHashes.slice(0, this.depth);
    this.currentRoot = this.zeroHashes[this.depth]!;

    // Temporarily remove all leaves and re-insert
    const saved = [...this.leaves];
    this.leaves = [];
    for (const leaf of saved) {
      this.leaves.push(leaf);
      this.updateTreeWithLeaf(BigInt(leaf));
    }
  }

  // ==========================================================================
  // Private — Network helpers
  // ==========================================================================

  /**
   * Fetch a transaction with exponential-backoff retry on rate-limit errors.
   */
  private async fetchTxWithRetry(
    sig: string,
    retries: number = 3,
  ): Promise<ParsedTx | null> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const tx = await this.connection.getTransaction(sig, {
          maxSupportedTransactionVersion: 0,
        });
        return tx as ParsedTx | null;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('429') || msg.includes('rate')) {
          const delay = Math.pow(2, attempt) * 1000;
          await this.sleep(delay);
        } else {
          throw e;
        }
      }
    }
    return null;
  }

  // ==========================================================================
  // Private — Cache
  // ==========================================================================

  private loadFromCache(): void {
    try {
      const raw = this.cache.get(this.cacheKey);
      if (!raw) return;

      const data = JSON.parse(raw) as {
        leaves: string[];
        onChainRoot: string;
        onChainLeafCount: number;
      };

      if (Array.isArray(data.leaves) && data.leaves.length > 0) {
        this.leaves = [];
        for (const leaf of data.leaves) {
          this.leaves.push(leaf);
          this.updateTreeWithLeaf(BigInt(leaf));
        }
        this.onChainRoot = data.onChainRoot ?? '';
        this.onChainLeafCount = data.onChainLeafCount ?? 0;
        this.log(`Loaded ${this.leaves.length} cached commitments`);
      }
    } catch {
      this.log('Failed to load cache, starting fresh');
    }
  }

  private saveToCache(): void {
    try {
      const data = JSON.stringify({
        leaves: this.leaves,
        onChainRoot: this.onChainRoot,
        onChainLeafCount: this.onChainLeafCount,
        savedAt: new Date().toISOString(),
      });
      this.cache.set(this.cacheKey, data);
    } catch {
      this.log('Failed to save cache');
    }
  }

  // ==========================================================================
  // Private — Utilities
  // ==========================================================================

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private log(msg: string): void {
    if (this.debug) {
      console.debug(`[CommitmentIndexer] ${msg}`);
    }
  }
}

// ============================================================================
// Internal type helpers — mirrors web3.js transaction shapes
// ============================================================================

/* eslint-disable @typescript-eslint/no-explicit-any */
interface ParsedTx {
  transaction: {
    message: VersionedMessage | LegacyMessage;
  };
  meta: {
    logMessages: string[];
  };
}

interface VersionedMessage {
  compiledInstructions: Array<{
    programIdIndex: number;
    data: Uint8Array | Buffer;
  }>;
  staticAccountKeys: PublicKey[];
}

interface LegacyMessage {
  instructions: Array<{
    programId: PublicKey;
    data: string | Uint8Array;
  }>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
