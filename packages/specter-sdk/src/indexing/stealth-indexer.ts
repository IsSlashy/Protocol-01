/**
 * Client-Side Stealth Payment Indexer
 *
 * Scans the Solana blockchain directly for stealth payment announcements,
 * replacing the relayer's `/relay/stealth-payments` endpoint.
 * Uses view-tag optimization (99.6% quick-rejection) for fast scanning.
 *
 * Supports:
 *   v1 — classical ECDH stealth (65-byte announcement)
 *   v2 — hybrid X25519 + ML-KEM (1153-byte announcement, future)
 *
 * Philosophy: TRUST THE MATH, NOT THE NODES.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { SpecterError, SpecterErrorCode } from '../types';
import type { StealthPayment } from '../types';
import { deriveSharedSecret, computeViewTag } from '../utils/crypto';
import { verifyStealthOwnership } from '../stealth/derive';
import { parseStealthAnnouncement } from '../stealth/generate';
import type { IndexerCache } from './cache';
import { MemoryCache } from './cache';

// ============================================================================
// Types
// ============================================================================

export interface StealthIndexerOptions {
  /** Batch size for parallel tx fetches (default 20) */
  batchSize?: number;
  /** Delay between batches in ms (default 200) */
  batchDelayMs?: number;
  /** Maximum signatures to scan (default 5000) */
  maxSignatures?: number;
  /** Optional cache for persistence */
  cache?: IndexerCache;
  /** Cache key prefix (default 'stealth_payments') */
  cacheKey?: string;
  /** Enable debug logging (default false) */
  debug?: boolean;
}

/** Announcement data format for v2 hybrid KEM */
const V1_ANNOUNCEMENT_SIZE = 65;
const V2_ANNOUNCEMENT_SIZE = 1153;

// ============================================================================
// StealthIndexer
// ============================================================================

export class StealthIndexer {
  private connection: Connection;
  private specterProgramId: PublicKey;
  private batchSize: number;
  private batchDelayMs: number;
  private maxSignatures: number;
  private cache: IndexerCache;
  private cacheKey: string;
  private debug: boolean;

  constructor(
    connection: Connection,
    specterProgramId: PublicKey,
    options: StealthIndexerOptions = {},
  ) {
    this.connection = connection;
    this.specterProgramId = specterProgramId;
    this.batchSize = options.batchSize ?? 20;
    this.batchDelayMs = options.batchDelayMs ?? 200;
    this.maxSignatures = options.maxSignatures ?? 5000;
    this.cache = options.cache ?? new MemoryCache();
    this.cacheKey = options.cacheKey ?? 'stealth_payments';
    this.debug = options.debug ?? false;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Scan historical transactions for stealth payments belonging to the caller.
   *
   * Uses the view tag to quickly reject ~99.6% of announcements without
   * computing full ECDH, then performs full ownership verification on the
   * remaining candidates.
   *
   * @param viewingPrivateKey  - Recipient's viewing private key (32 bytes)
   * @param spendingPubKey     - Recipient's spending public key (32 bytes)
   * @param options            - Optional: fromSlot filter, kemSecretKey for v2
   */
  async scanPayments(
    viewingPrivateKey: Uint8Array,
    spendingPubKey: Uint8Array,
    options: {
      fromSlot?: number;
      kemSecretKey?: Uint8Array;
    } = {},
  ): Promise<StealthPayment[]> {
    const { fromSlot } = options;

    try {
      // Collect all transaction signatures for the program
      const signatures = await this.fetchSignatures(fromSlot);
      this.log(`Found ${signatures.length} signatures to scan`);

      const payments: StealthPayment[] = [];

      // Process in batches
      for (let i = 0; i < signatures.length; i += this.batchSize) {
        const batch = signatures.slice(i, i + this.batchSize);

        const txPromises = batch.map(({ signature }) =>
          this.fetchTxWithRetry(signature).catch(() => null),
        );
        const txResults = await Promise.all(txPromises);

        for (let j = 0; j < txResults.length; j++) {
          const tx = txResults[j];
          const sig = batch[j]!;
          if (!tx) continue;

          const found = this.processTxForStealth(
            tx,
            sig.signature,
            viewingPrivateKey,
            spendingPubKey,
          );
          payments.push(...found);
        }

        // Rate-limit
        if (i + this.batchSize < signatures.length) {
          await this.sleep(this.batchDelayMs);
        }
      }

      this.log(`Scan complete: found ${payments.length} payments`);
      return payments;
    } catch (error: unknown) {
      throw new SpecterError(
        SpecterErrorCode.SCAN_FAILED,
        `Stealth payment scan failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Subscribe to new stealth payments in real-time.
   * Uses `connection.onLogs()` to watch for stealth transfer events.
   *
   * @param viewingPrivateKey - Recipient's viewing private key
   * @param spendingPubKey    - Recipient's spending public key
   * @param callback          - Called when a payment belonging to the caller is detected
   * @param kemSecretKey      - Optional KEM secret key for v2 announcements
   */
  subscribe(
    viewingPrivateKey: Uint8Array,
    spendingPubKey: Uint8Array,
    callback: (payment: StealthPayment) => void,
    kemSecretKey?: Uint8Array,
  ): { unsubscribe: () => void } {
    let subId: number | null = null;

    try {
      subId = this.connection.onLogs(
        this.specterProgramId,
        async (logInfo) => {
          if (logInfo.err) return;

          // Quick check: does this tx contain stealth-related logs?
          const hasStealth = logInfo.logs.some(
            (log) =>
              log.includes('Private payment sent') ||
              log.includes('Stealth') ||
              log.includes('stealth'),
          );
          if (!hasStealth) return;

          // Wait for finalization
          await this.sleep(2000);

          try {
            const tx = await this.fetchTxWithRetry(logInfo.signature);
            if (!tx) return;

            const found = this.processTxForStealth(
              tx,
              logInfo.signature,
              viewingPrivateKey,
              spendingPubKey,
            );

            for (const payment of found) {
              callback(payment);
            }
          } catch (err: unknown) {
            this.log(
              `Failed to process live stealth tx: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
        'confirmed',
      );

      this.log('Subscribed to real-time stealth payment updates');
    } catch (err: unknown) {
      this.log(
        `Failed to subscribe: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {
      unsubscribe: () => {
        if (subId !== null) {
          this.connection.removeOnLogsListener(subId);
          subId = null;
          this.log('Unsubscribed from stealth payment updates');
        }
      },
    };
  }

  // ==========================================================================
  // Private — Transaction processing
  // ==========================================================================

  /**
   * Process a single transaction looking for stealth announcements.
   * Checks both instruction data (StealthAccount PDA init) and log messages.
   */
  private processTxForStealth(
    tx: TxData,
    signature: string,
    viewingPrivateKey: Uint8Array,
    spendingPubKey: Uint8Array,
  ): StealthPayment[] {
    const payments: StealthPayment[] = [];
    const logs: string[] = tx.meta?.logMessages ?? [];

    // Strategy 1: Parse log messages for stealth announcements
    // The program logs "Stealth address: <first 8 bytes>"
    // and "Amount: N (encrypted)"
    const logAnnouncements = this.parseLogsForStealth(logs, signature, tx);
    for (const ann of logAnnouncements) {
      // View tag quick-reject
      const sharedSecret = deriveSharedSecret(
        viewingPrivateKey,
        ann.ephemeralPubKey,
      );
      const expectedTag = computeViewTag(sharedSecret);
      if (expectedTag !== ann.viewTag) continue;

      // Full ownership verification
      const isOwner = verifyStealthOwnership(
        ann.stealthAddress,
        ann.ephemeralPubKey,
        viewingPrivateKey,
        spendingPubKey,
        ann.viewTag,
      );

      if (isOwner) {
        payments.push({
          stealthAddress: ann.stealthAddress,
          ephemeralPubKey: ann.ephemeralPubKey,
          amount: ann.amount,
          tokenMint: ann.tokenMint,
          signature,
          blockTime: tx.blockTime ?? 0,
          claimed: false,
          viewTag: ann.viewTag,
        });
      }
    }

    // Strategy 2: Parse instruction data for StealthAccount initialization
    // The send_private instruction creates a StealthAccount PDA with the
    // stealth_address as a seed. We can scan program account data directly.
    const ixAnnouncements = this.parseInstructionForStealth(tx, signature);
    for (const ann of ixAnnouncements) {
      // Skip if already found via logs
      if (
        logAnnouncements.some((la) =>
          la.stealthAddress.equals(ann.stealthAddress),
        )
      ) {
        continue;
      }

      const sharedSecret = deriveSharedSecret(
        viewingPrivateKey,
        ann.ephemeralPubKey,
      );
      const expectedTag = computeViewTag(sharedSecret);
      if (expectedTag !== ann.viewTag) continue;

      const isOwner = verifyStealthOwnership(
        ann.stealthAddress,
        ann.ephemeralPubKey,
        viewingPrivateKey,
        spendingPubKey,
        ann.viewTag,
      );

      if (isOwner) {
        payments.push({
          stealthAddress: ann.stealthAddress,
          ephemeralPubKey: ann.ephemeralPubKey,
          amount: ann.amount,
          tokenMint: ann.tokenMint,
          signature,
          blockTime: tx.blockTime ?? 0,
          claimed: false,
          viewTag: ann.viewTag,
        });
      }
    }

    return payments;
  }

  /**
   * Parse program log messages for stealth transfer data.
   * Looks for "Specter:StealthTransfer" or structured log patterns.
   */
  private parseLogsForStealth(
    logs: string[],
    signature: string,
    tx: TxData,
  ): InternalAnnouncement[] {
    const announcements: InternalAnnouncement[] = [];

    for (const log of logs) {
      // Look for structured stealth announcement in log data
      if (log.includes('Specter:StealthTransfer')) {
        // Try to extract hex-encoded announcement from the log line
        const hexMatch = log.match(/Specter:StealthTransfer:([0-9a-fA-F]+)/);
        if (hexMatch) {
          try {
            const announcementBytes = hexToBytes(hexMatch[1]!);

            if (announcementBytes.length === V1_ANNOUNCEMENT_SIZE) {
              // Legacy v1 scan: indexer must still recognize pre-P4.1 notes
              // so owners can recover historical funds. Send paths remain v1-closed.
              const parsed = parseStealthAnnouncement(announcementBytes, { allowLegacyV1: true });
              announcements.push({
                stealthAddress: parsed.stealthAddress,
                ephemeralPubKey: parsed.ephemeralPubKey,
                viewTag: parsed.viewTag,
                amount: BigInt(0), // Amount is encrypted, derived separately
                tokenMint: null,
              });
            } else if (announcementBytes.length === V2_ANNOUNCEMENT_SIZE) {
              // v2 hybrid KEM announcement
              // Format: viewTag(1) + ephemeralPubKey(32) + stealthAddress(32) + kemCiphertext(1088)
              const viewTag = announcementBytes[0]!;
              const ephemeralPubKey = announcementBytes.slice(1, 33);
              const stealthAddress = new PublicKey(
                announcementBytes.slice(33, 65),
              );
              announcements.push({
                stealthAddress,
                ephemeralPubKey,
                viewTag,
                amount: BigInt(0),
                tokenMint: null,
              });
            }
          } catch {
            // Malformed announcement, skip
          }
        }
      }
    }

    return announcements;
  }

  /**
   * Parse instruction data for stealth payment parameters.
   * The send_private instruction has:
   *   disc(8) + amount(8) + stealth_address(32) + encrypted_amount(32) + decoy_level(1)
   */
  private parseInstructionForStealth(
    tx: TxData,
    _signature: string,
  ): InternalAnnouncement[] {
    const announcements: InternalAnnouncement[] = [];
    const txMessage = tx.transaction?.message;
    if (!txMessage) return announcements;

    // Find instructions belonging to our program
    const instructions = this.extractProgramInstructions(txMessage);

    for (const ixData of instructions) {
      // send_private: disc(8) + amount(8) + stealth_address(32) + encrypted_amount(32) + decoy_level(1)
      // Minimum size: 81 bytes
      if (ixData.length < 81) continue;

      try {
        // Read amount (u64 LE at offset 8)
        let amount = BigInt(0);
        for (let i = 7; i >= 0; i--) {
          amount = (amount << BigInt(8)) | BigInt(ixData[8 + i]!);
        }

        // Read stealth address (32 bytes at offset 16)
        const stealthAddressBytes = ixData.slice(16, 48);
        const stealthAddress = new PublicKey(stealthAddressBytes);

        // We don't have the ephemeral public key in the instruction data —
        // it must be derived from the accounts or announcement.
        // For now, extract from the transaction's inner accounts if possible.

        // The ephemeral key is typically included in the account list
        // as one of the remaining accounts. This varies by implementation.
        // We create a placeholder that will be overridden by log-based parsing.
        const ephemeralPubKey = new Uint8Array(32);

        // View tag from first byte of stealth address hash
        const viewTag = stealthAddressBytes[0]!;

        announcements.push({
          stealthAddress,
          ephemeralPubKey,
          viewTag,
          amount,
          tokenMint: null,
        });
      } catch {
        // Malformed instruction, skip
      }
    }

    return announcements;
  }

  /**
   * Extract instruction data for our program from the transaction message.
   */
  private extractProgramInstructions(
    txMessage: TxMessage,
  ): Uint8Array[] {
    const results: Uint8Array[] = [];

    if ('compiledInstructions' in txMessage) {
      const versioned = txMessage as VersionedTxMessage;
      const pi = versioned.staticAccountKeys.findIndex((k: PublicKey) =>
        k.equals(this.specterProgramId),
      );
      if (pi !== -1) {
        for (const ix of versioned.compiledInstructions) {
          if (ix.programIdIndex === pi) {
            results.push(new Uint8Array(ix.data));
          }
        }
      }
    } else {
      const legacy = txMessage as LegacyTxMessage;
      for (const ix of legacy.instructions) {
        if (ix.programId.equals(this.specterProgramId)) {
          const data =
            typeof ix.data === 'string'
              ? Uint8Array.from(Buffer.from(ix.data, 'base64'))
              : ix.data;
          results.push(new Uint8Array(data));
        }
      }
    }

    return results;
  }

  // ==========================================================================
  // Private — Network helpers
  // ==========================================================================

  private async fetchSignatures(
    fromSlot?: number,
  ): Promise<Array<{ signature: string; slot: number }>> {
    const all: Array<{ signature: string; slot: number }> = [];
    let beforeSig: string | undefined;

    while (true) {
      const batch = await this.connection.getSignaturesForAddress(
        this.specterProgramId,
        { limit: 100, before: beforeSig },
      );
      if (batch.length === 0) break;

      for (const s of batch) {
        if (!s.err) {
          // Filter by slot if requested
          if (fromSlot !== undefined && s.slot < fromSlot) continue;
          all.push({ signature: s.signature, slot: s.slot });
        }
      }

      beforeSig = batch[batch.length - 1]!.signature;
      if (all.length >= this.maxSignatures) break;

      // If we've gone past the fromSlot boundary, stop
      if (fromSlot !== undefined && batch[batch.length - 1]!.slot < fromSlot) {
        break;
      }
    }

    // Sort chronologically
    all.sort((a, b) => a.slot - b.slot);
    return all;
  }

  private async fetchTxWithRetry(
    sig: string,
    retries: number = 3,
  ): Promise<TxData | null> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const tx = await this.connection.getTransaction(sig, {
          maxSupportedTransactionVersion: 0,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return tx as any as TxData | null;
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
  // Private — Utilities
  // ==========================================================================

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private log(msg: string): void {
    if (this.debug) {
      console.debug(`[StealthIndexer] ${msg}`);
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ============================================================================
// Internal types
// ============================================================================

interface InternalAnnouncement {
  stealthAddress: PublicKey;
  ephemeralPubKey: Uint8Array;
  viewTag: number;
  amount: bigint;
  tokenMint: PublicKey | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type TxMessage = VersionedTxMessage | LegacyTxMessage;

interface TxData {
  transaction: { message: TxMessage };
  meta: { logMessages: string[] } | null;
  blockTime: number | null;
}

interface VersionedTxMessage {
  compiledInstructions: Array<{
    programIdIndex: number;
    data: Uint8Array | Buffer;
  }>;
  staticAccountKeys: PublicKey[];
}

interface LegacyTxMessage {
  instructions: Array<{
    programId: PublicKey;
    data: string | Uint8Array;
  }>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
