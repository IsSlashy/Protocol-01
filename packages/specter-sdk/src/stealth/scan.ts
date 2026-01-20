import {
  Connection,
  PublicKey,
  ParsedTransactionWithMeta,
  ConfirmedSignatureInfo,
} from '@solana/web3.js';
import type { StealthPayment, ScanOptions, StealthMetaAddress } from '../types';
import { SpecterError, SpecterErrorCode } from '../types';
import { computeViewTag, deriveSharedSecret } from '../utils/crypto';
import { verifyStealthOwnership, deriveStealthPrivateKey } from './derive';
import { parseStealthAnnouncement } from './generate';

/**
 * Scanner for detecting incoming stealth payments
 */
export class StealthScanner {
  private connection: Connection;
  private viewingPrivateKey: Uint8Array;
  private spendingPubKey: Uint8Array;
  private lastScannedSlot: number = 0;

  constructor(
    connection: Connection,
    viewingPrivateKey: Uint8Array,
    spendingPubKey: Uint8Array
  ) {
    this.connection = connection;
    this.viewingPrivateKey = viewingPrivateKey;
    this.spendingPubKey = spendingPubKey;
  }

  /**
   * Scan for incoming stealth payments
   * @param options - Scan options
   */
  async scan(options: ScanOptions = {}): Promise<StealthPayment[]> {
    const {
      fromSlot = this.lastScannedSlot,
      toSlot,
      tokenMints,
      includeClaimed = false,
      limit = 100,
    } = options;

    try {
      // Get recent signatures for the announcement program account
      // In production, this would query the Specter program's announcement account
      const announcements = await this.fetchAnnouncements(fromSlot, toSlot, limit);

      const payments: StealthPayment[] = [];

      for (const announcement of announcements) {
        const payment = await this.processAnnouncement(announcement, tokenMints);
        if (payment) {
          if (includeClaimed || !payment.claimed) {
            payments.push(payment);
          }
        }
      }

      // Update last scanned slot
      if (payments.length > 0) {
        const maxBlockTime = Math.max(...payments.map((p) => p.blockTime));
        this.lastScannedSlot = maxBlockTime;
      }

      return payments;
    } catch (error) {
      throw new SpecterError(
        SpecterErrorCode.SCAN_FAILED,
        'Failed to scan for stealth payments',
        error as Error
      );
    }
  }

  /**
   * Check if a specific transaction contains a payment for this wallet
   * @param signature - Transaction signature to check
   */
  async checkTransaction(signature: string): Promise<StealthPayment | null> {
    try {
      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });

      if (!tx) {
        return null;
      }

      return this.processTransaction(tx, signature);
    } catch (error) {
      throw new SpecterError(
        SpecterErrorCode.SCAN_FAILED,
        `Failed to check transaction: ${signature}`,
        error as Error
      );
    }
  }

  /**
   * Quick check using view tag for efficient scanning
   * @param viewTag - The view tag from the announcement
   * @param ephemeralPubKey - The ephemeral public key
   */
  checkViewTag(viewTag: number, ephemeralPubKey: Uint8Array): boolean {
    const sharedSecret = deriveSharedSecret(this.viewingPrivateKey, ephemeralPubKey);
    const computedTag = computeViewTag(sharedSecret);
    return computedTag === viewTag;
  }

  /**
   * Verify ownership and get the spending keypair for a stealth payment
   * @param ephemeralPubKey - Ephemeral public key from the announcement
   * @param stealthAddress - The stealth address
   */
  verifyAndDeriveKey(
    ephemeralPubKey: Uint8Array,
    stealthAddress: PublicKey
  ): { isOwner: boolean; keypair?: import('@solana/web3.js').Keypair } {
    const isOwner = verifyStealthOwnership(
      stealthAddress,
      ephemeralPubKey,
      this.viewingPrivateKey,
      this.spendingPubKey
    );

    if (!isOwner) {
      return { isOwner: false };
    }

    // Derive the spending keypair
    // Note: This requires the spending private key, which should be passed separately
    // For now, we return just the ownership status
    return { isOwner: true };
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  /**
   * Fetch stealth announcements from the blockchain
   */
  private async fetchAnnouncements(
    fromSlot: number,
    toSlot: number | undefined,
    limit: number
  ): Promise<AnnouncementData[]> {
    // In production, this would:
    // 1. Query the Specter program's announcement PDA
    // 2. Parse the memo/log data for stealth announcements
    // 3. Return parsed announcement data

    // For now, return empty array - actual implementation depends on program structure
    return [];
  }

  /**
   * Process a stealth announcement and check if it belongs to this wallet
   */
  private async processAnnouncement(
    announcement: AnnouncementData,
    tokenMints?: PublicKey[]
  ): Promise<StealthPayment | null> {
    // Quick filter using view tag
    if (!this.checkViewTag(announcement.viewTag, announcement.ephemeralPubKey)) {
      return null;
    }

    // Full verification
    const isOwner = verifyStealthOwnership(
      announcement.stealthAddress,
      announcement.ephemeralPubKey,
      this.viewingPrivateKey,
      this.spendingPubKey,
      announcement.viewTag
    );

    if (!isOwner) {
      return null;
    }

    // Check token mint filter
    if (tokenMints && announcement.tokenMint) {
      const mintMatches = tokenMints.some((mint) =>
        mint.equals(announcement.tokenMint!)
      );
      if (!mintMatches) {
        return null;
      }
    }

    // Check if already claimed
    const claimed = await this.checkIfClaimed(announcement.stealthAddress);

    return {
      stealthAddress: announcement.stealthAddress,
      ephemeralPubKey: announcement.ephemeralPubKey,
      amount: announcement.amount,
      tokenMint: announcement.tokenMint,
      signature: announcement.signature,
      blockTime: announcement.blockTime,
      claimed,
      viewTag: announcement.viewTag,
    };
  }

  /**
   * Process a transaction to extract stealth payment data
   */
  private async processTransaction(
    tx: ParsedTransactionWithMeta,
    signature: string
  ): Promise<StealthPayment | null> {
    // Parse transaction logs/memo for stealth announcement
    const logs = tx.meta?.logMessages || [];

    for (const log of logs) {
      // Look for Specter program log entries
      if (log.includes('Specter:StealthTransfer')) {
        // Parse the announcement data from logs
        const announcementData = this.parseLogAnnouncement(log);
        if (announcementData) {
          // Check view tag
          if (
            !this.checkViewTag(
              announcementData.viewTag,
              announcementData.ephemeralPubKey
            )
          ) {
            continue;
          }

          // Verify ownership
          const isOwner = verifyStealthOwnership(
            announcementData.stealthAddress,
            announcementData.ephemeralPubKey,
            this.viewingPrivateKey,
            this.spendingPubKey
          );

          if (isOwner) {
            const claimed = await this.checkIfClaimed(
              announcementData.stealthAddress
            );

            return {
              stealthAddress: announcementData.stealthAddress,
              ephemeralPubKey: announcementData.ephemeralPubKey,
              amount: announcementData.amount,
              tokenMint: announcementData.tokenMint,
              signature,
              blockTime: tx.blockTime || 0,
              claimed,
              viewTag: announcementData.viewTag,
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * Parse announcement data from log entry
   */
  private parseLogAnnouncement(log: string): AnnouncementData | null {
    // Implementation depends on the log format from the Specter program
    // This is a placeholder
    return null;
  }

  /**
   * Check if a stealth address has already been claimed
   */
  private async checkIfClaimed(stealthAddress: PublicKey): Promise<boolean> {
    try {
      const balance = await this.connection.getBalance(stealthAddress);
      // If balance is very low (just rent), consider it claimed
      return balance < 890880; // Minimum rent exemption
    } catch {
      return false;
    }
  }
}

/**
 * Internal type for announcement data
 */
interface AnnouncementData {
  stealthAddress: PublicKey;
  ephemeralPubKey: Uint8Array;
  viewTag: number;
  amount: bigint;
  tokenMint: PublicKey | null;
  signature: string;
  blockTime: number;
}

/**
 * Scan for stealth payments using viewing key
 * @param connection - Solana connection
 * @param viewingPrivateKey - Viewing private key for scanning
 * @param spendingPubKey - Spending public key for verification
 * @param options - Scan options
 */
export async function scanForPayments(
  connection: Connection,
  viewingPrivateKey: Uint8Array,
  spendingPubKey: Uint8Array,
  options: ScanOptions = {}
): Promise<StealthPayment[]> {
  const scanner = new StealthScanner(connection, viewingPrivateKey, spendingPubKey);
  return scanner.scan(options);
}

/**
 * Create a stealth scanner instance
 * @param connection - Solana connection
 * @param viewingPrivateKey - Viewing private key
 * @param spendingPubKey - Spending public key
 */
export function createScanner(
  connection: Connection,
  viewingPrivateKey: Uint8Array,
  spendingPubKey: Uint8Array
): StealthScanner {
  return new StealthScanner(connection, viewingPrivateKey, spendingPubKey);
}

/**
 * Subscribe to incoming stealth payments
 * @param connection - Solana connection
 * @param viewingPrivateKey - Viewing private key
 * @param spendingPubKey - Spending public key
 * @param callback - Callback for new payments
 */
export function subscribeToPayments(
  connection: Connection,
  viewingPrivateKey: Uint8Array,
  spendingPubKey: Uint8Array,
  callback: (payment: StealthPayment) => void
): { unsubscribe: () => void } {
  const scanner = new StealthScanner(connection, viewingPrivateKey, spendingPubKey);
  let isActive = true;
  let timeoutId: NodeJS.Timeout | null = null;

  const poll = async () => {
    if (!isActive) return;

    try {
      const payments = await scanner.scan({ limit: 10 });
      for (const payment of payments) {
        callback(payment);
      }
    } catch (error) {
      console.error('Scan error:', error);
    }

    if (isActive) {
      timeoutId = setTimeout(poll, 5000); // Poll every 5 seconds
    }
  };

  // Start polling
  poll();

  return {
    unsubscribe: () => {
      isActive = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    },
  };
}
