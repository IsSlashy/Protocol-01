/**
 * Denomination Splitter
 *
 * Converts an arbitrary fiat amount into a set of canonical SOL denominations
 * accepted by the privacy pools. The greedy split runs from largest to smallest
 * denomination, always rounding DOWN so the user never pays more than they sent.
 *
 * Any leftover that cannot fit into the canonical ladder is returned as a
 * tracked residual in the original fiat currency, along with a privacy warning
 * when the residual exceeds a configurable ratio of the input (default 30%).
 *
 * This is the first integration layer of the 12-layer privacy stack used by the
 * fiat-to-crypto purchases. Math is currency-agnostic; the fiat
 * currency field is kept only for audit trails.
 */

import { DENOMINATIONS } from '../constants';

/**
 * Canonical SOL denominations used by the splitter, largest first.
 *
 * NOTE: The 1000 SOL bucket is future-proofing — current on-chain pools
 * (see `DENOMINATIONS.SOL` in `constants.ts`) only support up to 100 SOL.
 * The 1000 SOL slot is reserved for the Layer 5 upgrade. For splits
 * against what pools accept today, pass `POOL_SUPPORTED_DENOMINATIONS_SOL`
 * as an override via `SplitInput.denominations`.
 */
export const CANONICAL_DENOMINATIONS_SOL = [1000, 100, 10, 1, 0.1] as const;

/**
 * SOL denominations currently accepted by deployed privacy pools,
 * derived from `DENOMINATIONS.SOL` (lamports → SOL) and sorted descending.
 */
export const POOL_SUPPORTED_DENOMINATIONS_SOL: readonly number[] = [
  ...DENOMINATIONS.SOL,
]
  .map((lamports) => lamports / 1e9)
  .sort((a, b) => b - a);

/**
 * Back-compat alias.
 * @deprecated Use `CANONICAL_DENOMINATIONS_SOL` (future-proof) or
 * `POOL_SUPPORTED_DENOMINATIONS_SOL` (what pools accept today).
 */
export const CANONICAL_DENOMINATIONS = CANONICAL_DENOMINATIONS_SOL;

/** Floating-point tolerance used when computing denomination counts. */
const FLOAT_EPSILON = 1e-9;

export interface DenominationSplit {
  /** SOL amount, one of CANONICAL_DENOMINATIONS. */
  denomination: number;
  /** How many notes of this denomination. */
  count: number;
}

export interface SplitResult {
  /** Breakdown by denomination. Only includes entries with count > 0. */
  splits: DenominationSplit[];
  /** Sum of all splits in SOL. */
  canonicalSolTotal: number;
  /** Leftover that couldn't fit canonical denominations (in input currency). */
  residualFiat: number;
  /** Non-null when the residual exceeds `minimumResidualRatio` of the input. */
  privacyWarning: string | null;
}

export interface SplitInput {
  /** Arbitrary fiat amount the user is paying (e.g. 847.32). */
  fiatAmount: number;
  /** Currency of `fiatAmount`. Used for audit trail only. */
  fiatCurrency: 'EUR' | 'USD';
  /** Spot price: how many fiat units equal 1 SOL (e.g. 91.42). */
  solPriceInFiat: number;
  /**
   * Ratio above which a privacy warning is emitted.
   * Default 0.3 (warn if residual > 30% of input).
   */
  minimumResidualRatio?: number;
  /**
   * Override for the denomination ladder to split against (SOL units).
   * Defaults to `CANONICAL_DENOMINATIONS_SOL` (future-proof). Pass
   * `POOL_SUPPORTED_DENOMINATIONS_SOL` to constrain to pools deployed today.
   * Will be sorted descending internally.
   */
  denominations?: readonly number[];
}

/**
 * Split a fiat amount into canonical SOL denominations.
 *
 * @throws {Error} if `fiatAmount` or `solPriceInFiat` is not positive.
 */
export function splitAmount(input: SplitInput): SplitResult {
  const {
    fiatAmount,
    fiatCurrency,
    solPriceInFiat,
    minimumResidualRatio = 0.3,
    denominations = CANONICAL_DENOMINATIONS_SOL,
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
    // Add an epsilon so that values like 9.999999... / 1 correctly floor to 10.
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

  // Residual can go slightly negative due to fp error — clamp to zero.
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
