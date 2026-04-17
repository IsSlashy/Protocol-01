import {
  Connection,
  PublicKey,
  ParsedTransactionWithMeta,
} from '@solana/web3.js';
import type { StealthPayment, ScanOptions } from '../types';
import { SpecterError, SpecterErrorCode } from '../types';
import {
  computeViewTag,
  deriveSharedSecret,
  deriveHybridSharedSecret,
  kemDecapsulate,
} from '../utils/crypto';
import { verifyStealthOwnership } from './derive';
import { parseStealthAnnouncement } from './generate';
import { StealthIndexer } from '../indexing/stealth-indexer';

/**
 * Scanner for detecting incoming stealth payments (supports v1 and v2 hybrid)
 */
export class StealthScanner {
  private connection: Connection;
  private viewingPrivateKey: Uint8Array;
  private spendingPubKey: Uint8Array;
  private kemSecretKey?: Uint8Array;
  private lastScannedSlot: number = 0;

  /**
   * @param connection - Solana RPC connection
   * @param viewingPrivateKey - Viewing private key for scanning
   * @param spendingPubKey - Spending public key for verification
   * @param kemSecretKey - ML-KEM-768 secret key for v2 hybrid payments (optional)
   */
  constructor(
    connection: Connection,
    viewingPrivateKey: Uint8Array,
    spendingPubKey: Uint8Array,
    kemSecretKey?: Uint8Array
  ) {
    this.connection = connection;
    this.viewingPrivateKey = viewingPrivateKey;
    this.spendingPubKey = spendingPubKey;
    this.kemSecretKey = kemSecretKey;
  }

  /**
   * Scan for incoming stealth payments
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

      if (payments.length > 0) {
        const maxBlockTime = Math.max(...payments.map((p) => p.blockTime));
        this.lastScannedSlot = maxBlockTime;
      }

      return payments;
    } catch (error) {
      throw new SpecterError(
        SpecterErrorCode.SCAN_FAILED,
        'Failed to scan for stealth payments: RPC error or invalid slot range. ' +
        'Check your rpcEndpoint configuration and ensure the Specter program is deployed on your target network. ' +
        `Scanned from slot ${fromSlot}${toSlot ? ` to ${toSlot}` : ''}.`,
        error as Error
      );
    }
  }

  /**
   * Check if a specific transaction contains a payment for this wallet
   */
  async checkTransaction(signature: string): Promise<StealthPayment | null> {
    try {
      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });

      if (!tx) return null;
      return this.processTransaction(tx, signature);
    } catch (error) {
      throw new SpecterError(
        SpecterErrorCode.SCAN_FAILED,
        `Failed to check transaction ${signature}: RPC error. ` +
        'Verify the transaction signature is correct and the RPC endpoint is reachable.',
        error as Error
      );
    }
  }

  /**
   * Quick check using view tag for efficient scanning.
   * For v2 hybrid payments with kemCiphertext, the view tag is derived from
   * the hybrid shared secret (X25519 + ML-KEM).
   */
  checkViewTag(
    viewTag: number,
    ephemeralPubKey: Uint8Array,
    kemCiphertext?: Uint8Array
  ): boolean {
    const classicSecret = deriveSharedSecret(this.viewingPrivateKey, ephemeralPubKey);

    let sharedSecret: Uint8Array;

    if (this.kemSecretKey && kemCiphertext) {
      const kemSharedSecret = kemDecapsulate(kemCiphertext, this.kemSecretKey);
      sharedSecret = deriveHybridSharedSecret(classicSecret, kemSharedSecret, {
        ephemeralPubKey,
        kemCiphertext,
      });
    } else {
      sharedSecret = classicSecret;
    }

    return computeViewTag(sharedSecret) === viewTag;
  }

  /**
   * Verify ownership and get the spending keypair for a stealth payment
   */
  verifyAndDeriveKey(
    ephemeralPubKey: Uint8Array,
    stealthAddress: PublicKey,
    kemCiphertext?: Uint8Array
  ): { isOwner: boolean; keypair?: import('@solana/web3.js').Keypair } {
    const isOwner = verifyStealthOwnership(
      stealthAddress,
      ephemeralPubKey,
      this.viewingPrivateKey,
      this.spendingPubKey,
      undefined,
      this.kemSecretKey,
      kemCiphertext
    );

    if (!isOwner) {
      return { isOwner: false };
    }

    return { isOwner: true };
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  /**
   * Fetch stealth announcements from the blockchain.
   *
   * Uses the StealthIndexer to scan on-chain transactions directly,
   * bypassing any relayer dependency. The indexer handles batched fetching,
   * rate-limit retries, and parses both log messages and instruction data.
   */
  private async fetchAnnouncements(
    fromSlot: number,
    _toSlot: number | undefined,
    limit: number
  ): Promise<AnnouncementData[]> {
    const SPECTER_PROGRAM_ID = new PublicKey(
      '2tuztgD9RhdaBkiP79fHkrFbfWBX75v7UjSNN4ULfbSp',
    );

    const indexer = new StealthIndexer(this.connection, SPECTER_PROGRAM_ID, {
      maxSignatures: limit * 10,
    });

    const payments = await indexer.scanPayments(
      this.viewingPrivateKey,
      this.spendingPubKey,
      { fromSlot: fromSlot > 0 ? fromSlot : undefined },
    );

    return payments.slice(0, limit).map((p) => ({
      stealthAddress: p.stealthAddress,
      ephemeralPubKey: p.ephemeralPubKey,
      viewTag: p.viewTag,
      amount: p.amount,
      tokenMint: p.tokenMint,
      signature: p.signature,
      blockTime: p.blockTime,
    }));
  }

  private async processAnnouncement(
    announcement: AnnouncementData,
    tokenMints?: PublicKey[]
  ): Promise<StealthPayment | null> {
    // Quick filter using view tag (handles both v1 and v2)
    if (!this.checkViewTag(announcement.viewTag, announcement.ephemeralPubKey, announcement.kemCiphertext)) {
      return null;
    }

    // Full verification
    const isOwner = verifyStealthOwnership(
      announcement.stealthAddress,
      announcement.ephemeralPubKey,
      this.viewingPrivateKey,
      this.spendingPubKey,
      announcement.viewTag,
      this.kemSecretKey,
      announcement.kemCiphertext
    );

    if (!isOwner) return null;

    if (tokenMints && announcement.tokenMint) {
      const mintMatches = tokenMints.some((mint) =>
        mint.equals(announcement.tokenMint!)
      );
      if (!mintMatches) return null;
    }

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
      kemCiphertext: announcement.kemCiphertext,
    };
  }

  private async processTransaction(
    tx: ParsedTransactionWithMeta,
    signature: string
  ): Promise<StealthPayment | null> {
    const logs = tx.meta?.logMessages || [];

    for (const log of logs) {
      if (log.includes('Specter:StealthTransfer')) {
        const announcementData = this.parseLogAnnouncement(log);
        if (announcementData) {
          if (
            !this.checkViewTag(
              announcementData.viewTag,
              announcementData.ephemeralPubKey,
              announcementData.kemCiphertext
            )
          ) {
            continue;
          }

          const isOwner = verifyStealthOwnership(
            announcementData.stealthAddress,
            announcementData.ephemeralPubKey,
            this.viewingPrivateKey,
            this.spendingPubKey,
            undefined,
            this.kemSecretKey,
            announcementData.kemCiphertext
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
              kemCiphertext: announcementData.kemCiphertext,
            };
          }
        }
      }
    }

    return null;
  }

  private parseLogAnnouncement(_log: string): AnnouncementData | null {
    // Implementation depends on the log format from the Specter program
    return null;
  }

  private async checkIfClaimed(stealthAddress: PublicKey): Promise<boolean> {
    try {
      const balance = await this.connection.getBalance(stealthAddress);
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
  kemCiphertext?: Uint8Array;
}

/**
 * Scan for stealth payments using viewing key
 */
export async function scanForPayments(
  connection: Connection,
  viewingPrivateKey: Uint8Array,
  spendingPubKey: Uint8Array,
  options: ScanOptions = {},
  kemSecretKey?: Uint8Array
): Promise<StealthPayment[]> {
  const scanner = new StealthScanner(connection, viewingPrivateKey, spendingPubKey, kemSecretKey);
  return scanner.scan(options);
}

/**
 * Create a stealth scanner instance
 */
export function createScanner(
  connection: Connection,
  viewingPrivateKey: Uint8Array,
  spendingPubKey: Uint8Array,
  kemSecretKey?: Uint8Array
): StealthScanner {
  return new StealthScanner(connection, viewingPrivateKey, spendingPubKey, kemSecretKey);
}

/**
 * Subscribe to incoming stealth payments (polls every 5 seconds)
 */
export function subscribeToPayments(
  connection: Connection,
  viewingPrivateKey: Uint8Array,
  spendingPubKey: Uint8Array,
  callback: (payment: StealthPayment) => void,
  kemSecretKey?: Uint8Array
): { unsubscribe: () => void } {
  const scanner = new StealthScanner(connection, viewingPrivateKey, spendingPubKey, kemSecretKey);
  let isActive = true;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

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
      timeoutId = setTimeout(poll, 5000);
    }
  };

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
