/**
 * Timing Noise Privacy Feature
 *
 * Adds cryptographically secure random variation to payment schedules
 * to make payment patterns harder to analyze and correlate.
 */

import * as Crypto from 'expo-crypto';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Apply timing noise to a scheduled timestamp
 *
 * @param scheduledTime - The original scheduled timestamp (ms since epoch)
 * @param noiseHours - The noise range in hours (e.g., 4 means +/- 4 hours)
 * @returns A randomized timestamp within the noise range
 *
 * @example
 * // Scheduled at noon, with +/- 4 hours noise
 * const noisyTime = await applyTimingNoise(scheduledTime, 4);
 * // Result will be between 8am and 4pm
 */
export async function applyTimingNoise(
  scheduledTime: number,
  noiseHours: number
): Promise<number> {
  // No noise requested - return original time
  if (noiseHours <= 0) {
    return scheduledTime;
  }

  // Clamp noise to reasonable range (0-24 hours)
  const clampedNoise = Math.min(Math.max(noiseHours, 0), 24);

  // Get cryptographically secure random bytes
  // 4 bytes gives us a 32-bit number which is plenty for this purpose
  const randomBytes = await Crypto.getRandomBytesAsync(4);

  // Convert to unsigned 32-bit integer
  const randomValue =
    (randomBytes[0] << 24) |
    (randomBytes[1] << 16) |
    (randomBytes[2] << 8) |
    randomBytes[3];

  // Normalize to 0-1 range
  const normalized = (randomValue >>> 0) / 0xFFFFFFFF;

  // Convert to range: -noiseHours to +noiseHours
  // Formula: value * 2 * range - range = value in [-range, +range]
  const offsetHours = (normalized * 2 * clampedNoise) - clampedNoise;

  // Convert hours to milliseconds and apply offset
  const offsetMs = Math.round(offsetHours * HOUR_MS);

  return scheduledTime + offsetMs;
}

/**
 * Check if a payment is due considering timing noise
 *
 * This function determines if a payment should be processed based on:
 * 1. The base scheduled time
 * 2. A pre-computed noisy timestamp (stored when scheduling)
 *
 * @param currentTime - Current timestamp
 * @param scheduledTime - Original scheduled timestamp
 * @param noisyTime - The pre-computed noisy timestamp (optional, for when noise was already applied)
 * @returns Whether the payment is due
 */
export function isPaymentDue(
  currentTime: number,
  scheduledTime: number,
  noisyTime?: number
): boolean {
  // If a noisy time was pre-computed, use that
  if (noisyTime !== undefined) {
    return currentTime >= noisyTime;
  }

  // Fallback to original scheduled time
  return currentTime >= scheduledTime;
}

/**
 * Calculate the next payment time with noise pre-applied
 *
 * This should be called when scheduling the next payment to:
 * 1. Store both the base scheduled time (for reference)
 * 2. Store the noisy time (for actual execution)
 *
 * @param baseScheduledTime - The base scheduled timestamp
 * @param noiseHours - The noise range in hours
 * @returns Object with both base and noisy timestamps
 */
export async function calculateNextPaymentWithNoise(
  baseScheduledTime: number,
  noiseHours: number
): Promise<{
  baseTime: number;
  noisyTime: number;
  appliedOffsetHours: number;
}> {
  const noisyTime = await applyTimingNoise(baseScheduledTime, noiseHours);
  const appliedOffsetHours = (noisyTime - baseScheduledTime) / HOUR_MS;

  return {
    baseTime: baseScheduledTime,
    noisyTime,
    appliedOffsetHours: Math.round(appliedOffsetHours * 100) / 100, // Round to 2 decimals
  };
}

/**
 * Ensure a noisy payment time doesn't skip the payment entirely
 *
 * If noise pushes the payment time past the next scheduled interval,
 * this ensures the payment still happens within a reasonable window.
 *
 * @param noisyTime - The noisy payment time
 * @param intervalMs - The payment interval in milliseconds
 * @param maxDelayMs - Maximum acceptable delay (defaults to interval / 2)
 * @returns Adjusted noisy time that won't skip the payment
 */
export function ensurePaymentNotSkipped(
  noisyTime: number,
  baseTime: number,
  intervalMs: number,
  maxDelayMs?: number
): number {
  // Default max delay is half the interval or 24 hours, whichever is smaller
  const defaultMaxDelay = Math.min(intervalMs / 2, 24 * HOUR_MS);
  const maxDelay = maxDelayMs ?? defaultMaxDelay;

  // Calculate the next scheduled base time
  const nextBaseTime = baseTime + intervalMs;

  // If noisy time would be after next scheduled base time,
  // cap it to avoid skipping payments
  if (noisyTime > nextBaseTime - maxDelay) {
    // Set to halfway between base time and next base time
    return baseTime + (intervalMs / 2);
  }

  // Also ensure we don't go too far before the base time
  // (prevent payment from being way too early)
  const minTime = baseTime - maxDelay;
  if (noisyTime < minTime) {
    return minTime;
  }

  return noisyTime;
}

/**
 * Format timing noise for display
 *
 * @param noiseHours - The noise range in hours
 * @returns Human-readable description
 */
export function formatTimingNoise(noiseHours: number): string {
  if (noiseHours <= 0) {
    return 'No timing variation';
  }

  if (noiseHours === 1) {
    return '+/- 1 hour';
  }

  if (noiseHours < 1) {
    const minutes = Math.round(noiseHours * 60);
    return `+/- ${minutes} minutes`;
  }

  return `+/- ${noiseHours} hours`;
}
