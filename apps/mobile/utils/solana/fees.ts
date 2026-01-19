/**
 * Fee estimation utilities for Protocol 01
 */

import {
  Connection,
  Transaction,
  PublicKey,
  LAMPORTS_PER_SOL,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { getConnection, getRecentBlockhash } from './connection';

export interface FeeEstimate {
  baseFee: number;
  priorityFee: number;
  totalFee: number;
  computeUnits: number;
}

export interface PriorityFeeLevel {
  level: 'low' | 'medium' | 'high' | 'turbo';
  microLamports: number;
  estimatedTime: string;
}

// Base transaction fee (5000 lamports = 0.000005 SOL)
const BASE_FEE_LAMPORTS = 5000;

// Default compute units
const DEFAULT_COMPUTE_UNITS = 200_000;

// Priority fee levels (in micro-lamports per compute unit)
export const PRIORITY_FEE_LEVELS: PriorityFeeLevel[] = [
  { level: 'low', microLamports: 1, estimatedTime: '~60s' },
  { level: 'medium', microLamports: 1000, estimatedTime: '~30s' },
  { level: 'high', microLamports: 10000, estimatedTime: '~15s' },
  { level: 'turbo', microLamports: 100000, estimatedTime: '~5s' },
];

/**
 * Estimate transaction fee
 */
export async function estimateTransactionFee(
  transaction: Transaction,
  connection?: Connection
): Promise<FeeEstimate> {
  const conn = connection || getConnection();

  try {
    // Get fee for message
    const { blockhash } = await getRecentBlockhash(conn);
    transaction.recentBlockhash = blockhash;

    const message = transaction.compileMessage();
    const feeCalculator = await conn.getFeeForMessage(message);

    const baseFee = feeCalculator.value || BASE_FEE_LAMPORTS;

    return {
      baseFee,
      priorityFee: 0,
      totalFee: baseFee,
      computeUnits: DEFAULT_COMPUTE_UNITS,
    };
  } catch {
    // Fallback to default fee
    return {
      baseFee: BASE_FEE_LAMPORTS,
      priorityFee: 0,
      totalFee: BASE_FEE_LAMPORTS,
      computeUnits: DEFAULT_COMPUTE_UNITS,
    };
  }
}

/**
 * Calculate priority fee based on compute units
 */
export function calculatePriorityFee(
  computeUnits: number,
  microLamportsPerUnit: number
): number {
  return Math.ceil((computeUnits * microLamportsPerUnit) / 1_000_000);
}

/**
 * Get total fee with priority
 */
export function getTotalFee(
  baseFee: number,
  computeUnits: number,
  priorityLevel: PriorityFeeLevel['level']
): number {
  const level = PRIORITY_FEE_LEVELS.find(l => l.level === priorityLevel);
  if (!level) {
    return baseFee;
  }

  const priorityFee = calculatePriorityFee(computeUnits, level.microLamports);
  return baseFee + priorityFee;
}

/**
 * Get recommended priority fee based on recent transactions
 */
export async function getRecommendedPriorityFee(
  connection?: Connection
): Promise<number> {
  const conn = connection || getConnection();

  try {
    const recentFees = await conn.getRecentPrioritizationFees();

    if (recentFees.length === 0) {
      return PRIORITY_FEE_LEVELS[1].microLamports; // Return medium as default
    }

    // Calculate median priority fee
    const fees = recentFees
      .map(f => f.prioritizationFee)
      .filter(f => f > 0)
      .sort((a, b) => a - b);

    if (fees.length === 0) {
      return PRIORITY_FEE_LEVELS[1].microLamports;
    }

    const medianIndex = Math.floor(fees.length / 2);
    return fees[medianIndex];
  } catch {
    return PRIORITY_FEE_LEVELS[1].microLamports;
  }
}

/**
 * Get priority fee levels with current estimates
 */
export async function getPriorityFeeLevels(
  computeUnits: number = DEFAULT_COMPUTE_UNITS,
  connection?: Connection
): Promise<Array<PriorityFeeLevel & { totalFeeLamports: number; totalFeeSOL: string }>> {
  const recommendedFee = await getRecommendedPriorityFee(connection);

  return PRIORITY_FEE_LEVELS.map(level => {
    // Adjust levels based on network conditions
    let adjustedMicroLamports = level.microLamports;
    if (level.level === 'medium') {
      adjustedMicroLamports = Math.max(level.microLamports, recommendedFee);
    } else if (level.level === 'high') {
      adjustedMicroLamports = Math.max(level.microLamports, recommendedFee * 2);
    } else if (level.level === 'turbo') {
      adjustedMicroLamports = Math.max(level.microLamports, recommendedFee * 5);
    }

    const priorityFee = calculatePriorityFee(computeUnits, adjustedMicroLamports);
    const totalFeeLamports = BASE_FEE_LAMPORTS + priorityFee;

    return {
      ...level,
      microLamports: adjustedMicroLamports,
      totalFeeLamports,
      totalFeeSOL: (totalFeeLamports / LAMPORTS_PER_SOL).toFixed(9),
    };
  });
}

/**
 * Create compute budget instructions
 */
export function createComputeBudgetInstructions(
  computeUnits: number,
  microLamportsPerUnit: number
): {
  setComputeUnitLimit: ReturnType<typeof ComputeBudgetProgram.setComputeUnitLimit>;
  setComputeUnitPrice: ReturnType<typeof ComputeBudgetProgram.setComputeUnitPrice>;
} {
  return {
    setComputeUnitLimit: ComputeBudgetProgram.setComputeUnitLimit({
      units: computeUnits,
    }),
    setComputeUnitPrice: ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: microLamportsPerUnit,
    }),
  };
}

/**
 * Simulate to get actual compute units
 */
export async function simulateForComputeUnits(
  transaction: Transaction,
  payer: PublicKey,
  connection?: Connection
): Promise<number> {
  const conn = connection || getConnection();

  try {
    const { blockhash } = await getRecentBlockhash(conn);
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = payer;

    const simulation = await conn.simulateTransaction(transaction);

    if (simulation.value.err) {
      console.warn('Simulation error:', simulation.value.err);
      return DEFAULT_COMPUTE_UNITS;
    }

    // Add 10% buffer to actual usage
    const actualUnits = simulation.value.unitsConsumed || DEFAULT_COMPUTE_UNITS;
    return Math.ceil(actualUnits * 1.1);
  } catch {
    return DEFAULT_COMPUTE_UNITS;
  }
}

/**
 * Format fee for display
 */
export function formatFee(lamports: number): string {
  if (lamports < 1000) {
    return `${lamports} lamports`;
  }

  const sol = lamports / LAMPORTS_PER_SOL;
  if (sol < 0.0001) {
    return `${(sol * 1_000_000).toFixed(2)} micro SOL`;
  }

  return `${sol.toFixed(6)} SOL`;
}

/**
 * Format fee in USD
 */
export function formatFeeUSD(lamports: number, solPrice: number): string {
  const sol = lamports / LAMPORTS_PER_SOL;
  const usd = sol * solPrice;

  if (usd < 0.01) {
    return '< $0.01';
  }

  return `$${usd.toFixed(2)}`;
}

/**
 * Check if user has enough balance for fee
 */
export function hasEnoughForFee(
  balance: number,
  amount: number,
  fee: number
): boolean {
  return balance >= amount + fee;
}

/**
 * Calculate remaining balance after transaction
 */
export function calculateRemainingBalance(
  currentBalance: number,
  sendAmount: number,
  fee: number
): number {
  return Math.max(0, currentBalance - sendAmount - fee);
}

/**
 * Get minimum rent-exempt balance
 */
export async function getMinRentExemptBalance(
  dataSize: number = 0,
  connection?: Connection
): Promise<number> {
  const conn = connection || getConnection();
  return conn.getMinimumBalanceForRentExemption(dataSize);
}

/**
 * Check if transaction will leave enough for rent
 */
export async function willMaintainRentExemption(
  currentBalance: number,
  sendAmount: number,
  fee: number,
  accountDataSize: number = 0,
  connection?: Connection
): Promise<boolean> {
  const minRent = await getMinRentExemptBalance(accountDataSize, connection);
  const remaining = calculateRemainingBalance(currentBalance, sendAmount, fee);
  return remaining === 0 || remaining >= minRent;
}
