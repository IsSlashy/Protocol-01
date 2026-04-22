/**
 * Fiat → SOL denomination splitter (mobile-local copy).
 *
 * Mirrors the canonical splitter in `@protocol-01/privacy-sdk`
 * (src/modules/denomination.ts). We keep a local copy here because:
 *   1. The mobile app does not currently depend on `@protocol-01/privacy-sdk`.
 *   2. The SDK's module graph pulls Node-only deps (e.g. `fs` via zk helpers)
 *      that break Metro when imported wholesale on React Native.
 *
 * Keep this file in sync with the SDK module. Tests (if added) should cover
 * the same cases as `packages/privacy-sdk/tests/denomination.test.ts`.
 */

/** Canonical SOL denominations (largest first). 1000 is future-proofing. */
export const CANONICAL_DENOMINATIONS_SOL = [1000, 100, 10, 1, 0.1] as const;

/** Currently deployed pool tiers. */
export const POOL_SUPPORTED_DENOMINATIONS_SOL: readonly number[] = [100, 10, 1, 0.1];

const FLOAT_EPSILON = 1e-9;

export interface DenominationSplit {
  denomination: number;
  count: number;
}

export interface SplitResult {
  splits: DenominationSplit[];
  canonicalSolTotal: number;
  residualFiat: number;
  privacyWarning: string | null;
}

export interface SplitInput {
  fiatAmount: number;
  fiatCurrency: 'EUR' | 'USD' | 'GBP';
  solPriceInFiat: number;
  minimumResidualRatio?: number;
  denominations?: readonly number[];
}

export function splitAmount(input: SplitInput): SplitResult {
  const {
    fiatAmount,
    fiatCurrency,
    solPriceInFiat,
    minimumResidualRatio = 0.3,
    denominations = POOL_SUPPORTED_DENOMINATIONS_SOL,
  } = input;

  if (!Number.isFinite(fiatAmount) || fiatAmount <= 0) {
    throw new Error('fiatAmount must be positive');
  }
  if (!Number.isFinite(solPriceInFiat) || solPriceInFiat <= 0) {
    throw new Error('solPriceInFiat must be positive');
  }

  const ladder = [...denominations].sort((a, b) => b - a);

  const solBudgetInitial = fiatAmount / solPriceInFiat;
  let solBudget = solBudgetInitial;
  const splits: DenominationSplit[] = [];

  for (const denomination of ladder) {
    const count = Math.floor(solBudget / denomination + FLOAT_EPSILON);
    if (count > 0) {
      splits.push({ denomination, count });
      solBudget -= count * denomination;
    }
  }

  const canonicalSolTotal = splits.reduce(
    (acc, s) => acc + s.denomination * s.count,
    0,
  );

  const residualSolRaw = solBudgetInitial - canonicalSolTotal;
  const residualSol = residualSolRaw < FLOAT_EPSILON ? 0 : residualSolRaw;
  const residualFiat = residualSol * solPriceInFiat;

  let privacyWarning: string | null = null;
  if (residualFiat / fiatAmount > minimumResidualRatio) {
    const smallestDenomFiat = ladder[ladder.length - 1]! * solPriceInFiat;
    const suggested = Math.ceil(smallestDenomFiat * 100) / 100;
    const ratioPct = ((residualFiat / fiatAmount) * 100).toFixed(1);
    privacyWarning =
      `Residual ${residualFiat.toFixed(2)} ${fiatCurrency} is ${ratioPct}% of input ` +
      `— consider paying at least ${suggested.toFixed(2)} ${fiatCurrency} for better privacy`;
  }

  return {
    splits,
    canonicalSolTotal,
    residualFiat,
    privacyWarning,
  };
}
