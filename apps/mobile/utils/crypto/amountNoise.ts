/**
 * Amount Noise Privacy Feature
 *
 * Applies random variation to payment amounts for enhanced privacy.
 * Uses cryptographically secure randomness from expo-crypto.
 *
 * The noise system tracks cumulative adjustments to ensure the total
 * amount paid over time equals the expected total.
 */

import * as Crypto from 'expo-crypto';

/**
 * Noise adjustment tracking for a stream
 * Positive = overpaid, Negative = underpaid
 */
export interface NoiseAdjustment {
  cumulative: number;  // Total adjustment so far (positive = overpaid)
  lastApplied: number; // Last noise amount applied
  timestamp: number;   // When last adjustment was made
}

/**
 * Result of applying amount noise
 */
export interface NoiseResult {
  /** The final amount to send (with noise applied) */
  adjustedAmount: number;
  /** The noise delta applied to original amount (can be negative) */
  noiseDelta: number;
  /** Updated cumulative adjustment (for tracking) */
  newCumulativeAdjustment: number;
}

/**
 * Generate a cryptographically secure random float between 0 and 1
 * Uses expo-crypto for secure randomness
 */
async function secureRandomFloat(): Promise<number> {
  // Get 8 random bytes (64 bits)
  const bytes = await Crypto.getRandomBytesAsync(8);

  // Convert to a number between 0 and 1
  // Use first 4 bytes as a 32-bit unsigned integer
  const value = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];

  // Convert to [0, 1) range
  return (value >>> 0) / 0xFFFFFFFF;
}

/**
 * Apply amount noise to a payment amount
 *
 * @param amount - Original payment amount
 * @param noisePercent - Noise percentage (0-20), e.g., 10 means +/-10%
 * @param cumulativeAdjustment - Current cumulative adjustment (positive = overpaid)
 * @param remainingPayments - Estimated remaining payments (optional, for smart adjustment)
 * @returns NoiseResult with adjusted amount and tracking info
 *
 * @example
 * // Apply 10% noise to 100 SOL payment
 * const result = await applyAmountNoise(100, 10, 0);
 * // result.adjustedAmount might be 95.5 or 108.2 (random within +/-10%)
 */
export async function applyAmountNoise(
  amount: number,
  noisePercent: number,
  cumulativeAdjustment: number = 0,
  remainingPayments?: number
): Promise<NoiseResult> {
  // Validate inputs
  if (amount <= 0) {
    return {
      adjustedAmount: amount,
      noiseDelta: 0,
      newCumulativeAdjustment: cumulativeAdjustment,
    };
  }

  // Clamp noise percent to valid range (0-20%)
  const clampedNoisePercent = Math.max(0, Math.min(20, noisePercent));

  // If no noise, return original amount
  if (clampedNoisePercent === 0) {
    return {
      adjustedAmount: amount,
      noiseDelta: 0,
      newCumulativeAdjustment: cumulativeAdjustment,
    };
  }

  // Calculate max noise in absolute terms
  const maxNoise = amount * (clampedNoisePercent / 100);

  // Generate secure random value [-1, 1]
  const randomValue = await secureRandomFloat();
  const randomFactor = (randomValue * 2) - 1; // Convert [0,1] to [-1,1]

  // Calculate raw noise
  let noise = randomFactor * maxNoise;

  // Smart adjustment: bias noise towards correcting cumulative imbalance
  // If we've overpaid (positive cumulative), bias towards underpaying
  // If we've underpaid (negative cumulative), bias towards overpaying
  if (Math.abs(cumulativeAdjustment) > 0) {
    // Calculate correction factor (how much to bias)
    // Use a soft correction that increases with larger imbalances
    const correctionStrength = 0.3; // 30% bias strength
    const imbalanceRatio = cumulativeAdjustment / amount;

    // Clamp imbalance correction to prevent overcorrection
    const correction = Math.max(-maxNoise, Math.min(maxNoise,
      -imbalanceRatio * correctionStrength * amount
    ));

    // Blend noise with correction
    noise = noise * (1 - correctionStrength) + correction;
  }

  // If this is the last payment (or near last), adjust to zero out cumulative
  if (remainingPayments !== undefined && remainingPayments <= 1) {
    // Last payment: correct any remaining imbalance
    const maxCorrection = maxNoise;
    const neededCorrection = -cumulativeAdjustment;

    // Clamp correction to max noise bounds
    noise = Math.max(-maxCorrection, Math.min(maxCorrection, neededCorrection));
  }

  // Calculate final adjusted amount
  const adjustedAmount = Math.max(0, amount + noise);

  // Round to 9 decimal places (Solana lamports precision)
  const roundedAmount = Math.round(adjustedAmount * 1e9) / 1e9;
  const actualNoise = roundedAmount - amount;

  return {
    adjustedAmount: roundedAmount,
    noiseDelta: actualNoise,
    newCumulativeAdjustment: cumulativeAdjustment + actualNoise,
  };
}

/**
 * Calculate the noise adjustment needed to balance cumulative payments
 * Used for the final payment in a stream to ensure total matches expected
 *
 * @param expectedTotal - Total amount that should have been paid
 * @param actualPaid - Total amount actually paid so far
 * @param finalPayment - The final scheduled payment amount
 * @param noisePercent - Noise percentage (to cap adjustment within reasonable bounds)
 * @returns Adjusted final payment amount
 */
export function calculateFinalPaymentAdjustment(
  expectedTotal: number,
  actualPaid: number,
  finalPayment: number,
  noisePercent: number
): number {
  const remaining = expectedTotal - actualPaid;
  const maxNoise = finalPayment * (noisePercent / 100);

  // The ideal final payment is whatever makes the total correct
  const idealFinal = remaining;

  // But we should cap it to reasonable bounds
  const minFinal = Math.max(0, finalPayment - maxNoise);
  const maxFinal = finalPayment + maxNoise;

  // Clamp to bounds
  return Math.max(minFinal, Math.min(maxFinal, idealFinal));
}

/**
 * Create initial noise adjustment state
 */
export function createNoiseAdjustment(): NoiseAdjustment {
  return {
    cumulative: 0,
    lastApplied: 0,
    timestamp: Date.now(),
  };
}

/**
 * Update noise adjustment state after a payment
 */
export function updateNoiseAdjustment(
  current: NoiseAdjustment,
  noiseDelta: number
): NoiseAdjustment {
  return {
    cumulative: current.cumulative + noiseDelta,
    lastApplied: noiseDelta,
    timestamp: Date.now(),
  };
}
