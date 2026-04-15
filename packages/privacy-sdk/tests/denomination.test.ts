import { describe, it, expect } from 'vitest';
import {
  splitAmount,
  CANONICAL_DENOMINATIONS,
  CANONICAL_DENOMINATIONS_SOL,
  POOL_SUPPORTED_DENOMINATIONS_SOL,
  type SplitInput,
} from '../src/modules/denomination';

function baseInput(overrides: Partial<SplitInput> = {}): SplitInput {
  return {
    fiatAmount: 1000,
    fiatCurrency: 'EUR',
    solPriceInFiat: 100,
    ...overrides,
  };
}

describe('CANONICAL_DENOMINATIONS', () => {
  it('should be [1000, 100, 10, 1, 0.1] in descending order', () => {
    expect(CANONICAL_DENOMINATIONS).toEqual([1000, 100, 10, 1, 0.1]);
  });

  it('CANONICAL_DENOMINATIONS_SOL alias matches', () => {
    expect(CANONICAL_DENOMINATIONS_SOL).toEqual([1000, 100, 10, 1, 0.1]);
  });

  it('POOL_SUPPORTED_DENOMINATIONS_SOL derives from constants.ts (no 1000 bucket)', () => {
    expect(POOL_SUPPORTED_DENOMINATIONS_SOL).toEqual([100, 10, 1, 0.1]);
  });
});

describe('splitAmount', () => {
  it('exact round conversion: 1000 EUR at 100 EUR/SOL -> 1 x 10 SOL', () => {
    const result = splitAmount(baseInput());
    expect(result.splits).toEqual([{ denomination: 10, count: 1 }]);
    expect(result.canonicalSolTotal).toBe(10);
    expect(result.residualFiat).toBe(0);
    expect(result.privacyWarning).toBeNull();
  });

  it('with residual: 1000 EUR at 91.42 EUR/SOL', () => {
    // solBudget = 1000 / 91.42 ≈ 10.9386
    // 1 x 10 SOL + 9 x 0.1 SOL = 10.9 SOL
    // residual SOL ≈ 0.0386, residual fiat ≈ 3.53 EUR
    const result = splitAmount(
      baseInput({ fiatAmount: 1000, solPriceInFiat: 91.42 }),
    );
    expect(result.splits).toEqual([
      { denomination: 10, count: 1 },
      { denomination: 0.1, count: 9 },
    ]);
    expect(result.canonicalSolTotal).toBeCloseTo(10.9, 9);
    expect(result.residualFiat).toBeGreaterThan(3);
    expect(result.residualFiat).toBeLessThan(4);
    expect(result.privacyWarning).toBeNull();
  });

  it('multi-denom spread: 123456 EUR at 91 EUR/SOL', () => {
    // solBudget = 123456 / 91 ≈ 1356.6593
    // 1 x 1000, 3 x 100, 5 x 10, 6 x 1, 6 x 0.1
    // canonical = 1000 + 300 + 50 + 6 + 0.6 = 1356.6
    const result = splitAmount(
      baseInput({ fiatAmount: 123456, solPriceInFiat: 91 }),
    );
    expect(result.splits).toEqual([
      { denomination: 1000, count: 1 },
      { denomination: 100, count: 3 },
      { denomination: 10, count: 5 },
      { denomination: 1, count: 6 },
      { denomination: 0.1, count: 6 },
    ]);
    expect(result.canonicalSolTotal).toBeCloseTo(1356.6, 9);
    expect(result.privacyWarning).toBeNull();
  });

  it('tiny amount below smallest denom: 5 EUR at 91 EUR/SOL', () => {
    // solBudget ≈ 0.0549 — below 0.1 SOL threshold
    const result = splitAmount(
      baseInput({ fiatAmount: 5, solPriceInFiat: 91 }),
    );
    expect(result.splits).toEqual([]);
    expect(result.canonicalSolTotal).toBe(0);
    expect(result.residualFiat).toBeCloseTo(5, 9);
    expect(result.privacyWarning).not.toBeNull();
    expect(result.privacyWarning).toContain('EUR');
  });

  it('rejects negative fiatAmount', () => {
    expect(() => splitAmount(baseInput({ fiatAmount: -10 }))).toThrow(
      'fiatAmount must be positive',
    );
  });

  it('rejects zero fiatAmount', () => {
    expect(() => splitAmount(baseInput({ fiatAmount: 0 }))).toThrow(
      'fiatAmount must be positive',
    );
  });

  it('rejects zero solPriceInFiat', () => {
    expect(() => splitAmount(baseInput({ solPriceInFiat: 0 }))).toThrow(
      'solPriceInFiat must be positive',
    );
  });

  it('rejects negative solPriceInFiat', () => {
    expect(() => splitAmount(baseInput({ solPriceInFiat: -5 }))).toThrow(
      'solPriceInFiat must be positive',
    );
  });

  it('floating-point edge: 100 EUR at 10 EUR/SOL -> exactly 10 SOL', () => {
    // 100 / 10 = 10 exactly — must not drop into 9 x 1 + 9 x 0.1 due to fp
    const result = splitAmount(
      baseInput({ fiatAmount: 100, solPriceInFiat: 10 }),
    );
    expect(result.splits).toEqual([{ denomination: 10, count: 1 }]);
    expect(result.canonicalSolTotal).toBe(10);
    expect(result.residualFiat).toBe(0);
    expect(result.privacyWarning).toBeNull();
  });

  it('custom warning ratio triggers stricter warning', () => {
    // 1000 EUR @ 91.42 gives ~3.53 EUR residual = 0.353% — no warning at default
    // But with minimumResidualRatio=0.001 (0.1%), it should warn
    const result = splitAmount(
      baseInput({
        fiatAmount: 1000,
        solPriceInFiat: 91.42,
        minimumResidualRatio: 0.001,
      }),
    );
    expect(result.privacyWarning).not.toBeNull();
    expect(result.privacyWarning).toContain('EUR');
  });

  it('currency label is included in warning', () => {
    const result = splitAmount(
      baseInput({
        fiatAmount: 5,
        fiatCurrency: 'USD',
        solPriceInFiat: 91,
      }),
    );
    expect(result.privacyWarning).toContain('USD');
  });

  it('pool-supported override: 1234 EUR at 91 EUR/SOL splits without 1000 SOL bucket', () => {
    // solBudget = 1234 / 91 ≈ 13.5604
    // Default ladder would try 1000 first (skip), 100 (skip), then 1 x 10, 3 x 1, 5 x 0.1
    // With POOL_SUPPORTED_DENOMINATIONS_SOL [100, 10, 1, 0.1] — same result but
    // the ladder itself must not contain 1000.
    const result = splitAmount(
      baseInput({
        fiatAmount: 1234,
        solPriceInFiat: 91,
        denominations: POOL_SUPPORTED_DENOMINATIONS_SOL,
      }),
    );
    // No split should reference the 1000 SOL bucket
    for (const s of result.splits) {
      expect(s.denomination).not.toBe(1000);
      expect(POOL_SUPPORTED_DENOMINATIONS_SOL).toContain(s.denomination);
    }
    expect(result.splits).toEqual([
      { denomination: 10, count: 1 },
      { denomination: 1, count: 3 },
      { denomination: 0.1, count: 5 },
    ]);
    expect(result.canonicalSolTotal).toBeCloseTo(13.5, 9);
  });

  it('default minimumResidualRatio is 0.3 (no warning at ~0.35%)', () => {
    // 1000 / 91.42 with residual 3.53/1000 = 0.353% << 30%
    const result = splitAmount(
      baseInput({ fiatAmount: 1000, solPriceInFiat: 91.42 }),
    );
    expect(result.privacyWarning).toBeNull();
  });
});
