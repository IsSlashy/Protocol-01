/**
 * Transaction Splitter Service
 *
 * Splits payments into multiple parts routed through temporary wallets
 * with randomized timing to maximize privacy and break transaction correlation.
 *
 * Flow:
 * 1. User wants to send X SOL to Recipient
 * 2. Splitter creates N temporary wallets
 * 3. Splits X into random amounts (a1, a2, ... aN)
 * 4. Schedules transfers at random times within a window
 * 5. Each temp wallet forwards to recipient after delay
 *
 * Result: Recipient receives X SOL over time from multiple sources
 */

import {
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  Connection,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import * as SecureStore from 'expo-secure-store';
import { getConnection } from '../solana/connection';

// Types
export interface SplitConfig {
  /** Number of splits (2-10) */
  numSplits: number;
  /** Time window in hours for delivery (1-24) */
  timeWindowHours: number;
  /** Minimum delay between splits in minutes */
  minDelayMinutes: number;
  /** Add random noise to amounts */
  noiseEnabled: boolean;
  /** Noise percentage (0-10%) */
  noisePercent: number;
}

export interface SplitPart {
  id: string;
  amount: number; // in SOL
  tempWallet: string; // temp wallet pubkey
  scheduledTime: number; // timestamp
  status: 'pending' | 'funded' | 'forwarding' | 'completed' | 'failed';
  fundingTx?: string;
  forwardTx?: string;
  error?: string;
}

export interface SplitTransaction {
  id: string;
  sender: string;
  recipient: string;
  totalAmount: number;
  parts: SplitPart[];
  config: SplitConfig;
  createdAt: number;
  status: 'preparing' | 'in_progress' | 'completed' | 'failed';
  completedAt?: number;
}

// Default configuration
export const DEFAULT_SPLIT_CONFIG: SplitConfig = {
  numSplits: 4,
  timeWindowHours: 6,
  minDelayMinutes: 15,
  noiseEnabled: true,
  noisePercent: 5,
};

// Storage key for temp wallet keys
const TEMP_WALLETS_KEY = 'p01_temp_wallets';

/**
 * Generate a unique ID
 */
function generateId(): string {
  return `split_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Generate random amounts that sum to total
 */
function splitAmount(total: number, numParts: number, noisePercent: number): number[] {
  const parts: number[] = [];
  let remaining = total;

  for (let i = 0; i < numParts - 1; i++) {
    // Random portion between 10% and 40% of remaining
    const minPortion = 0.1;
    const maxPortion = 0.4;
    const portion = minPortion + Math.random() * (maxPortion - minPortion);

    let amount = remaining * portion;

    // Add noise if enabled
    if (noisePercent > 0) {
      const noise = amount * (noisePercent / 100) * (Math.random() * 2 - 1);
      amount += noise;
    }

    // Round to 6 decimal places
    amount = Math.round(amount * 1e6) / 1e6;

    // Ensure minimum amount for rent
    amount = Math.max(amount, 0.001);

    parts.push(amount);
    remaining -= amount;
  }

  // Last part gets the remainder
  parts.push(Math.round(remaining * 1e6) / 1e6);

  // Shuffle the parts
  for (let i = parts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [parts[i], parts[j]] = [parts[j], parts[i]];
  }

  return parts;
}

/**
 * Generate random delivery times within window
 */
function generateScheduleTimes(
  numParts: number,
  windowHours: number,
  minDelayMinutes: number
): number[] {
  const now = Date.now();
  const windowMs = windowHours * 60 * 60 * 1000;
  const minDelayMs = minDelayMinutes * 60 * 1000;

  const times: number[] = [];
  let lastTime = now;

  for (let i = 0; i < numParts; i++) {
    // Random time after minDelay but within remaining window
    const remainingWindow = windowMs - (lastTime - now);
    const maxDelay = Math.max(minDelayMs, remainingWindow / (numParts - i));

    const delay = minDelayMs + Math.random() * (maxDelay - minDelayMs);
    const scheduledTime = lastTime + delay;

    times.push(scheduledTime);
    lastTime = scheduledTime;
  }

  // Shuffle times for less predictable ordering
  for (let i = times.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [times[i], times[j]] = [times[j], times[i]];
  }

  return times;
}

/**
 * Create temporary wallet keypairs
 */
async function createTempWallets(count: number): Promise<Keypair[]> {
  const wallets: Keypair[] = [];

  for (let i = 0; i < count; i++) {
    const keypair = Keypair.generate();
    wallets.push(keypair);
  }

  return wallets;
}

/**
 * Store temp wallet secret keys securely
 */
async function storeTempWalletKeys(
  splitId: string,
  wallets: Keypair[]
): Promise<void> {
  const keysData = wallets.map(w => ({
    pubkey: w.publicKey.toBase58(),
    secret: Array.from(w.secretKey),
  }));

  await SecureStore.setItemAsync(
    `${TEMP_WALLETS_KEY}_${splitId}`,
    JSON.stringify(keysData)
  );
}

/**
 * Retrieve temp wallet keypairs
 */
async function getTempWalletKeys(splitId: string): Promise<Keypair[]> {
  const data = await SecureStore.getItemAsync(`${TEMP_WALLETS_KEY}_${splitId}`);

  if (!data) {
    throw new Error('Temp wallet keys not found');
  }

  const keysData = JSON.parse(data) as Array<{ pubkey: string; secret: number[] }>;

  return keysData.map(k => Keypair.fromSecretKey(Uint8Array.from(k.secret)));
}

/**
 * Delete temp wallet keys after completion
 */
async function deleteTempWalletKeys(splitId: string): Promise<void> {
  await SecureStore.deleteItemAsync(`${TEMP_WALLETS_KEY}_${splitId}`);
}

/**
 * Transaction Splitter Class
 */
export class TransactionSplitter {
  private connection: Connection;
  private senderKeypair: Keypair;

  constructor(senderKeypair: Keypair) {
    this.connection = getConnection();
    this.senderKeypair = senderKeypair;
  }

  /**
   * Prepare a split transaction (doesn't execute yet)
   */
  async prepareSplit(
    recipientAddress: string,
    amount: number,
    config: SplitConfig = DEFAULT_SPLIT_CONFIG
  ): Promise<SplitTransaction> {
    const splitId = generateId();
    const recipient = new PublicKey(recipientAddress);

    // Validate
    if (amount < 0.01) {
      throw new Error('Minimum split amount is 0.01 SOL');
    }

    if (config.numSplits < 2 || config.numSplits > 10) {
      throw new Error('Number of splits must be between 2 and 10');
    }

    // Create temp wallets
    const tempWallets = await createTempWallets(config.numSplits);
    await storeTempWalletKeys(splitId, tempWallets);

    // Split amount
    const amounts = splitAmount(amount, config.numSplits, config.noiseEnabled ? config.noisePercent : 0);

    // Generate schedule
    const times = generateScheduleTimes(
      config.numSplits,
      config.timeWindowHours,
      config.minDelayMinutes
    );

    // Create split parts
    const parts: SplitPart[] = tempWallets.map((wallet, i) => ({
      id: `${splitId}_part_${i}`,
      amount: amounts[i],
      tempWallet: wallet.publicKey.toBase58(),
      scheduledTime: times[i],
      status: 'pending' as const,
    }));

    // Sort by scheduled time for execution order
    parts.sort((a, b) => a.scheduledTime - b.scheduledTime);

    const splitTx: SplitTransaction = {
      id: splitId,
      sender: this.senderKeypair.publicKey.toBase58(),
      recipient: recipientAddress,
      totalAmount: amount,
      parts,
      config,
      createdAt: Date.now(),
      status: 'preparing',
    };

    return splitTx;
  }

  /**
   * Execute the first phase: fund all temp wallets
   */
  async fundTempWallets(
    splitTx: SplitTransaction,
    onProgress?: (part: SplitPart, index: number) => void
  ): Promise<SplitTransaction> {
    const tempWallets = await getTempWalletKeys(splitTx.id);

    for (let i = 0; i < splitTx.parts.length; i++) {
      const part = splitTx.parts[i];
      const tempWallet = tempWallets[i];

      try {
        // Add extra for forwarding tx fee
        const amountWithFee = part.amount + 0.000005; // ~5000 lamports for fee

        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: this.senderKeypair.publicKey,
            toPubkey: tempWallet.publicKey,
            lamports: Math.floor(amountWithFee * LAMPORTS_PER_SOL),
          })
        );

        const signature = await sendAndConfirmTransaction(
          this.connection,
          tx,
          [this.senderKeypair]
        );

        part.status = 'funded';
        part.fundingTx = signature;

        onProgress?.(part, i);

        // Small delay between funding transactions
        await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));

      } catch (error) {
        part.status = 'failed';
        part.error = (error as Error).message;
        throw error;
      }
    }

    splitTx.status = 'in_progress';
    return splitTx;
  }

  /**
   * Forward funds from a temp wallet to recipient
   */
  async forwardPart(
    splitTx: SplitTransaction,
    partIndex: number
  ): Promise<SplitPart> {
    const part = splitTx.parts[partIndex];
    const tempWallets = await getTempWalletKeys(splitTx.id);
    const tempWallet = tempWallets[partIndex];
    const recipient = new PublicKey(splitTx.recipient);

    if (part.status !== 'funded') {
      throw new Error('Part is not funded');
    }

    part.status = 'forwarding';

    try {
      // Get actual balance (might have small dust)
      const balance = await this.connection.getBalance(tempWallet.publicKey);

      // Calculate amount to send (leave enough for fee)
      const fee = 5000; // lamports
      const sendAmount = balance - fee;

      if (sendAmount <= 0) {
        throw new Error('Insufficient balance in temp wallet');
      }

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: tempWallet.publicKey,
          toPubkey: recipient,
          lamports: sendAmount,
        })
      );

      const signature = await sendAndConfirmTransaction(
        this.connection,
        tx,
        [tempWallet]
      );

      part.status = 'completed';
      part.forwardTx = signature;

      return part;

    } catch (error) {
      part.status = 'failed';
      part.error = (error as Error).message;
      throw error;
    }
  }

  /**
   * Check if all parts are completed
   */
  isCompleted(splitTx: SplitTransaction): boolean {
    return splitTx.parts.every(p => p.status === 'completed');
  }

  /**
   * Get next part to forward based on schedule
   */
  getNextScheduledPart(splitTx: SplitTransaction): SplitPart | null {
    const now = Date.now();

    return splitTx.parts.find(p =>
      p.status === 'funded' && p.scheduledTime <= now
    ) || null;
  }

  /**
   * Cleanup after completion
   */
  async cleanup(splitTx: SplitTransaction): Promise<void> {
    await deleteTempWalletKeys(splitTx.id);
    splitTx.status = 'completed';
    splitTx.completedAt = Date.now();
  }

  /**
   * Get estimated total fees
   */
  static estimateFees(numSplits: number): number {
    // Each split has 2 transactions: fund + forward
    const txFee = 0.000005; // ~5000 lamports
    return numSplits * 2 * txFee;
  }

  /**
   * Format schedule for display
   */
  static formatSchedule(splitTx: SplitTransaction): string[] {
    return splitTx.parts.map((part, i) => {
      const date = new Date(part.scheduledTime);
      const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `Part ${i + 1}: ${part.amount.toFixed(4)} SOL @ ${time}`;
    });
  }
}

export default TransactionSplitter;
