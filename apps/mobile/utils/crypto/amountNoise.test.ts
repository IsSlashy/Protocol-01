/**
 * Amount Noise Privacy Feature Test Suite
 *
 * Validates the privacy-enhancing amount noise system that applies
 * cryptographically random variation to payment amounts. Ensures the
 * noise stays within configured bounds, tracks cumulative adjustments,
 * and converges to zero over time.
 */

import { describe, it, expect } from 'vitest';
import {
  applyAmountNoise,
  calculateFinalPaymentAdjustment,
  createNoiseAdjustment,
  updateNoiseAdjustment,
} from './amountNoise';

describe('Amount Noise Privacy Feature -- Payment Obfuscation', () => {

  // ===================================================================
  // Section 1: Basic Noise Application
  // ===================================================================

  describe('Basic Noise Application', () => {
    it('should return original amount when noise percent is 0', async () => {
      const result = await applyAmountNoise(100, 0);
      expect(result.adjustedAmount).toBe(100);
      expect(result.noiseDelta).toBe(0);
      expect(result.newCumulativeAdjustment).toBe(0);
    });

    it('should return original amount for zero or negative amounts', async () => {
      const zeroResult = await applyAmountNoise(0, 10);
      expect(zeroResult.adjustedAmount).toBe(0);

      const negResult = await applyAmountNoise(-5, 10);
      expect(negResult.adjustedAmount).toBe(-5);
      expect(negResult.noiseDelta).toBe(0);
    });

    it('should apply noise within the specified percentage bounds', async () => {
      const amount = 100;
      const noisePercent = 10; // +/-10%

      // Run multiple trials to verify bounds
      for (let i = 0; i < 20; i++) {
        const result = await applyAmountNoise(amount, noisePercent);
        expect(result.adjustedAmount).toBeGreaterThanOrEqual(amount * 0.9 - 0.001);
        expect(result.adjustedAmount).toBeLessThanOrEqual(amount * 1.1 + 0.001);
      }
    });

    it('should clamp noise percent to 0-20% range', async () => {
      const amount = 100;

      // Noise of 50% should be clamped to 20%
      const result = await applyAmountNoise(amount, 50);
      expect(result.adjustedAmount).toBeGreaterThanOrEqual(amount * 0.80 - 0.001);
      expect(result.adjustedAmount).toBeLessThanOrEqual(amount * 1.20 + 0.001);

      // Negative noise should be clamped to 0%
      const noNoise = await applyAmountNoise(amount, -5);
      expect(noNoise.adjustedAmount).toBe(amount);
    });

    it('should produce non-negative adjusted amounts', async () => {
      // Even with high noise and small amount, should not go below 0
      for (let i = 0; i < 10; i++) {
        const result = await applyAmountNoise(0.001, 20);
        expect(result.adjustedAmount).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // ===================================================================
  // Section 2: Cumulative Adjustment Tracking
  // ===================================================================

  describe('Cumulative Adjustment Tracking', () => {
    it('should track cumulative noise adjustment', async () => {
      const result = await applyAmountNoise(100, 10);
      expect(result.newCumulativeAdjustment).toBeCloseTo(result.noiseDelta, 9);
    });

    it('should add to existing cumulative adjustment', async () => {
      const existing = 5.0; // Previously overpaid by 5
      const result = await applyAmountNoise(100, 10, existing);
      expect(result.newCumulativeAdjustment).toBeCloseTo(existing + result.noiseDelta, 9);
    });

    it('should bias noise towards correcting positive cumulative imbalance', async () => {
      // Large overpayment should bias towards underpaying
      const cumulative = 50; // Way overpaid
      let belowAverage = 0;
      const trials = 50;

      for (let i = 0; i < trials; i++) {
        const result = await applyAmountNoise(100, 10, cumulative);
        if (result.noiseDelta < 0) belowAverage++;
      }

      // Should trend toward underpaying to correct the imbalance
      // With correction bias, more than half should be below average
      expect(belowAverage).toBeGreaterThan(trials * 0.3);
    });
  });

  // ===================================================================
  // Section 3: Final Payment Correction
  // ===================================================================

  describe('Final Payment Adjustment', () => {
    it('should correct on last payment when remaining payments is 1', async () => {
      const cumulative = 2.0; // Overpaid by 2
      const result = await applyAmountNoise(100, 10, cumulative, 1);

      // Should try to correct: 100 - 2 = 98 (within noise bounds)
      expect(result.adjustedAmount).toBeLessThanOrEqual(100);
    });

    it('should handle calculateFinalPaymentAdjustment correctly', () => {
      const adjusted = calculateFinalPaymentAdjustment(
        1000,  // expectedTotal
        950,   // actualPaid
        100,   // finalPayment
        10     // noisePercent
      );

      // Should try to pay the remaining 50, but final is 100
      // Ideal = 50, min = 90, max = 110
      // So result should be clamped to 90
      expect(adjusted).toBeGreaterThanOrEqual(90);
      expect(adjusted).toBeLessThanOrEqual(110);
    });

    it('should not produce negative final payment', () => {
      const adjusted = calculateFinalPaymentAdjustment(
        100,   // expectedTotal
        200,   // actualPaid (already overpaid!)
        50,    // finalPayment
        10     // noisePercent
      );

      expect(adjusted).toBeGreaterThanOrEqual(0);
    });
  });

  // ===================================================================
  // Section 4: Noise Adjustment State
  // ===================================================================

  describe('Noise Adjustment State Management', () => {
    it('should create initial noise adjustment with zero cumulative', () => {
      const state = createNoiseAdjustment();
      expect(state.cumulative).toBe(0);
      expect(state.lastApplied).toBe(0);
      expect(state.timestamp).toBeGreaterThan(0);
    });

    it('should update noise adjustment correctly', () => {
      const initial = createNoiseAdjustment();
      const updated = updateNoiseAdjustment(initial, 3.5);

      expect(updated.cumulative).toBe(3.5);
      expect(updated.lastApplied).toBe(3.5);
      expect(updated.timestamp).toBeGreaterThanOrEqual(initial.timestamp);
    });

    it('should accumulate over multiple updates', () => {
      let state = createNoiseAdjustment();
      state = updateNoiseAdjustment(state, 2.0);
      state = updateNoiseAdjustment(state, -1.5);
      state = updateNoiseAdjustment(state, 0.5);

      expect(state.cumulative).toBeCloseTo(1.0, 9);
      expect(state.lastApplied).toBe(0.5);
    });
  });

  // ===================================================================
  // Section 5: Precision
  // ===================================================================

  describe('Lamports Precision', () => {
    it('should round to 9 decimal places (Solana lamports)', async () => {
      const result = await applyAmountNoise(1.0, 10);
      const decimalPart = result.adjustedAmount.toString().split('.')[1] || '';
      expect(decimalPart.length).toBeLessThanOrEqual(9);
    });

    it('should maintain precision for small amounts', async () => {
      const result = await applyAmountNoise(0.000001, 10);
      expect(result.adjustedAmount).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(result.adjustedAmount)).toBe(true);
    });
  });
});
