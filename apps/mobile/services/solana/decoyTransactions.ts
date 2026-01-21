/**
 * Decoy Transactions Service for Specter Protocol
 *
 * Implements privacy-enhancing decoy transactions to confuse chain analysis.
 * Decoy transactions are small SOL transfers sent before the real transaction
 * to create noise and make it harder to identify the actual payment.
 *
 * Privacy levels:
 * - Standard: 1 decoy transaction
 * - Enhanced: 5 decoy transactions
 * - Maximum: 10 decoy transactions + timing delays
 */

import {
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  Connection,
  TransactionInstruction,
} from '@solana/web3.js';
import { getConnection } from './connection';
import { getKeypair } from './wallet';

// Privacy level configuration
export const PRIVACY_LEVELS = {
  standard: {
    name: 'Standard',
    decoyCount: 1,
    minDelay: 500,    // ms
    maxDelay: 1500,   // ms
    amountNoisePercent: 10,
    useSelfTransfers: true,
    useTimingObfuscation: false,
  },
  enhanced: {
    name: 'Enhanced',
    decoyCount: 5,
    minDelay: 1000,
    maxDelay: 3000,
    amountNoisePercent: 20,
    useSelfTransfers: true,
    useTimingObfuscation: true,
  },
  maximum: {
    name: 'Maximum',
    decoyCount: 10,
    minDelay: 2000,
    maxDelay: 5000,
    amountNoisePercent: 30,
    useSelfTransfers: true,
    useTimingObfuscation: true,
  },
} as const;

export type PrivacyLevel = keyof typeof PRIVACY_LEVELS;

// Minimum amount for decoy transactions (0.001 SOL)
const MIN_DECOY_AMOUNT = 0.001;
// Maximum amount for decoy transactions (0.01 SOL)
const MAX_DECOY_AMOUNT = 0.01;
// Base fee per transaction (approximate)
const BASE_TX_FEE = 0.000005;

export interface DecoyTransaction {
  signature: string;
  amount: number;
  destination: string;
  timestamp: number;
  isSelfTransfer: boolean;
}

export interface DecoyBatchResult {
  success: boolean;
  decoys: DecoyTransaction[];
  totalFeesLamports: number;
  totalFeesSOL: number;
  errors: string[];
}

export interface DecoyProgress {
  current: number;
  total: number;
  phase: 'preparing' | 'sending_decoys' | 'sending_real' | 'complete';
  currentSignature?: string;
}

export type DecoyProgressCallback = (progress: DecoyProgress) => void;

/**
 * Generate a random delay between min and max milliseconds
 */
function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate a random decoy amount with noise based on the real transaction amount
 * Amounts are designed to look similar to real transactions
 */
function generateDecoyAmount(realAmount: number, noisePercent: number): number {
  // Base amount is a percentage of real amount (5-15%)
  const basePercent = 0.05 + Math.random() * 0.10;
  let amount = realAmount * basePercent;

  // Add noise
  const noise = (Math.random() - 0.5) * 2 * (noisePercent / 100) * amount;
  amount += noise;

  // Clamp to min/max
  amount = Math.max(MIN_DECOY_AMOUNT, Math.min(MAX_DECOY_AMOUNT, amount));

  // Round to 6 decimal places
  return Math.round(amount * 1000000) / 1000000;
}

/**
 * Generate a random Solana address for decoy destination
 * These are valid addresses but effectively "burn" addresses
 */
function generateRandomAddress(): PublicKey {
  return Keypair.generate().publicKey;
}

/**
 * Calculate total fees for decoy transactions
 */
export function calculateDecoyFees(
  privacyLevel: PrivacyLevel,
  realAmount: number
): { totalFees: number; perTxFee: number; decoyCount: number } {
  const config = PRIVACY_LEVELS[privacyLevel];
  const perTxFee = BASE_TX_FEE;
  const decoyCount = config.decoyCount;

  // Fees include: decoy tx fees + amounts sent as decoys
  // For self-transfers, we only pay fees (amounts return to us)
  // For random addresses, we "lose" the decoy amounts
  const totalFees = config.useSelfTransfers
    ? perTxFee * decoyCount
    : perTxFee * decoyCount + (MIN_DECOY_AMOUNT + MAX_DECOY_AMOUNT) / 2 * decoyCount;

  return {
    totalFees: Math.round(totalFees * 1000000) / 1000000,
    perTxFee,
    decoyCount,
  };
}

/**
 * Generate and send decoy transactions
 *
 * @param realAmount - The amount of the real transaction (used to calibrate decoy amounts)
 * @param privacyLevel - The privacy level (standard, enhanced, maximum)
 * @param onProgress - Optional callback for progress updates
 * @returns Result object with signatures and fee information
 */
export async function sendDecoyTransactions(
  realAmount: number,
  privacyLevel: PrivacyLevel,
  onProgress?: DecoyProgressCallback
): Promise<DecoyBatchResult> {
  const config = PRIVACY_LEVELS[privacyLevel];
  const connection = getConnection();
  const keypair = await getKeypair();

  if (!keypair) {
    throw new Error('No wallet found');
  }

  const decoys: DecoyTransaction[] = [];
  const errors: string[] = [];
  let totalFeesLamports = 0;

  console.log(`[Decoy] Starting ${config.decoyCount} decoy transactions for privacy level: ${privacyLevel}`);

  onProgress?.({
    current: 0,
    total: config.decoyCount,
    phase: 'preparing',
  });

  // Pre-generate all decoy parameters
  const decoyParams = Array.from({ length: config.decoyCount }, () => ({
    amount: generateDecoyAmount(realAmount, config.amountNoisePercent),
    destination: config.useSelfTransfers
      ? keypair.publicKey  // Self-transfer for privacy
      : generateRandomAddress(), // Random address
    delay: config.useTimingObfuscation
      ? randomDelay(config.minDelay, config.maxDelay)
      : randomDelay(config.minDelay, config.minDelay + 500),
  }));

  // Send decoys with timing obfuscation
  for (let i = 0; i < decoyParams.length; i++) {
    const { amount, destination, delay } = decoyParams[i];

    onProgress?.({
      current: i + 1,
      total: config.decoyCount,
      phase: 'sending_decoys',
    });

    try {
      // Apply timing delay before sending
      if (i > 0 && config.useTimingObfuscation) {
        console.log(`[Decoy] Waiting ${delay}ms before next decoy...`);
        await sleep(delay);
      }

      const lamports = Math.floor(amount * LAMPORTS_PER_SOL);

      // Create transaction
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: destination,
          lamports,
        })
      );

      // Add a memo to make it look like a regular transaction
      // (optional - can be omitted to reduce fees)

      // Get recent blockhash
      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = keypair.publicKey;

      // Sign and send
      console.log(`[Decoy] Sending decoy ${i + 1}/${config.decoyCount}: ${amount} SOL to ${destination.toBase58().slice(0, 8)}...`);

      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [keypair],
        { commitment: 'confirmed' }
      );

      console.log(`[Decoy] Decoy ${i + 1} confirmed: ${signature.slice(0, 16)}...`);

      // Estimate fee (5000 lamports = 0.000005 SOL typical)
      const txFee = 5000;
      totalFeesLamports += txFee;

      // For non-self-transfers, also count the amount as "spent"
      if (!config.useSelfTransfers) {
        totalFeesLamports += lamports;
      }

      decoys.push({
        signature,
        amount,
        destination: destination.toBase58(),
        timestamp: Date.now(),
        isSelfTransfer: config.useSelfTransfers,
      });

      onProgress?.({
        current: i + 1,
        total: config.decoyCount,
        phase: 'sending_decoys',
        currentSignature: signature,
      });

    } catch (error: any) {
      console.error(`[Decoy] Failed to send decoy ${i + 1}:`, error.message);
      errors.push(`Decoy ${i + 1}: ${error.message}`);
      // Continue with remaining decoys even if one fails
    }
  }

  const result: DecoyBatchResult = {
    success: decoys.length > 0,
    decoys,
    totalFeesLamports,
    totalFeesSOL: totalFeesLamports / LAMPORTS_PER_SOL,
    errors,
  };

  console.log(`[Decoy] Completed ${decoys.length}/${config.decoyCount} decoys. Total fees: ${result.totalFeesSOL} SOL`);

  return result;
}

/**
 * Execute a private transaction with decoy obfuscation
 *
 * This function:
 * 1. Sends decoy transactions first (with random delays)
 * 2. Adds a final random delay
 * 3. Sends the real transaction
 *
 * @param toAddress - Destination address
 * @param amount - Amount to send in SOL
 * @param privacyLevel - Privacy level (standard, enhanced, maximum)
 * @param onProgress - Progress callback
 * @returns Transaction result
 */
export async function sendPrivateTransaction(
  toAddress: string,
  amount: number,
  privacyLevel: PrivacyLevel,
  onProgress?: DecoyProgressCallback
): Promise<{
  success: boolean;
  signature: string;
  decoyResult: DecoyBatchResult;
  error?: string;
}> {
  const config = PRIVACY_LEVELS[privacyLevel];
  const connection = getConnection();
  const keypair = await getKeypair();

  if (!keypair) {
    throw new Error('No wallet found');
  }

  console.log(`[Privacy] Starting private transaction: ${amount} SOL to ${toAddress.slice(0, 8)}... with ${privacyLevel} privacy`);

  // Step 1: Send decoy transactions
  let decoyResult: DecoyBatchResult;
  try {
    decoyResult = await sendDecoyTransactions(amount, privacyLevel, onProgress);
  } catch (error: any) {
    console.error('[Privacy] Decoy phase failed:', error.message);
    decoyResult = {
      success: false,
      decoys: [],
      totalFeesLamports: 0,
      totalFeesSOL: 0,
      errors: [error.message],
    };
  }

  // Step 2: Add final delay before real transaction
  if (config.useTimingObfuscation) {
    const finalDelay = randomDelay(config.minDelay, config.maxDelay);
    console.log(`[Privacy] Final delay before real transaction: ${finalDelay}ms`);
    await sleep(finalDelay);
  }

  // Step 3: Send the real transaction
  onProgress?.({
    current: config.decoyCount,
    total: config.decoyCount,
    phase: 'sending_real',
  });

  try {
    const toPubkey = new PublicKey(toAddress);
    const lamports = Math.floor(amount * LAMPORTS_PER_SOL);

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey,
        lamports,
      })
    );

    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = keypair.publicKey;

    console.log(`[Privacy] Sending real transaction: ${amount} SOL`);

    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [keypair],
      { commitment: 'confirmed' }
    );

    console.log(`[Privacy] Real transaction confirmed: ${signature}`);

    onProgress?.({
      current: config.decoyCount,
      total: config.decoyCount,
      phase: 'complete',
      currentSignature: signature,
    });

    return {
      success: true,
      signature,
      decoyResult,
    };

  } catch (error: any) {
    console.error('[Privacy] Real transaction failed:', error.message);
    return {
      success: false,
      signature: '',
      decoyResult,
      error: error.message,
    };
  }
}

/**
 * Validate if user has sufficient balance for private transaction
 * Includes decoy fees in the calculation
 */
export async function validatePrivateTransactionBalance(
  amount: number,
  privacyLevel: PrivacyLevel
): Promise<{
  valid: boolean;
  requiredBalance: number;
  decoyFees: number;
  networkFee: number;
  error?: string;
}> {
  const connection = getConnection();
  const keypair = await getKeypair();

  if (!keypair) {
    return {
      valid: false,
      requiredBalance: 0,
      decoyFees: 0,
      networkFee: 0,
      error: 'No wallet found',
    };
  }

  const balance = await connection.getBalance(keypair.publicKey);
  const balanceSOL = balance / LAMPORTS_PER_SOL;

  const { totalFees: decoyFees, decoyCount } = calculateDecoyFees(privacyLevel, amount);
  const networkFee = BASE_TX_FEE; // Fee for the real transaction
  const requiredBalance = amount + decoyFees + networkFee;

  console.log(`[Privacy] Balance check: ${balanceSOL} SOL available, ${requiredBalance} SOL required`);
  console.log(`[Privacy] Breakdown: ${amount} SOL amount + ${decoyFees} SOL decoy fees (${decoyCount} decoys) + ${networkFee} SOL network fee`);

  if (balanceSOL < requiredBalance) {
    return {
      valid: false,
      requiredBalance,
      decoyFees,
      networkFee,
      error: `Insufficient balance. Need ${requiredBalance.toFixed(6)} SOL (including ${decoyFees.toFixed(6)} SOL for ${decoyCount} decoy transactions)`,
    };
  }

  return {
    valid: true,
    requiredBalance,
    decoyFees,
    networkFee,
  };
}

/**
 * Get human-readable description of privacy level
 */
export function getPrivacyLevelDescription(level: PrivacyLevel): string {
  const config = PRIVACY_LEVELS[level];
  const features = [
    `${config.decoyCount} decoy transaction${config.decoyCount > 1 ? 's' : ''}`,
  ];

  if (config.useSelfTransfers) {
    features.push('self-transfers (minimal cost)');
  }

  if (config.useTimingObfuscation) {
    features.push('timing obfuscation');
  }

  return features.join(', ');
}

export default {
  PRIVACY_LEVELS,
  sendDecoyTransactions,
  sendPrivateTransaction,
  calculateDecoyFees,
  validatePrivateTransactionBalance,
  getPrivacyLevelDescription,
};
