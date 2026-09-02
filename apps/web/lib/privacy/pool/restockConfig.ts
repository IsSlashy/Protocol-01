/**
 * The restock's numbers, in one place, read by two callers.
 *
 * `restockInventory.test.ts` (the deposit loop the workflow runs) and
 * `restockTopUp.ts` (the transfer that keeps its wallet funded) both need the
 * same four values, and both read them from the same environment variables
 * the workflow sets. Two copies of `Number(process.env.X ?? default)` would be
 * two places for a default to drift, and the top-up would then fill a wallet
 * to a target the restock does not recognise.
 *
 * PURE. No RPC, no clock: the environment is passed in, so a test can hand it
 * a map and get arithmetic back.
 */

import { floatRequiredForBatch } from './settlementPolicy';

export interface RestockConfig {
  /** How many notes the pot should hold. */
  target: number;
  /**
   * Below this, restock. Above it, do nothing: a tick that deposits every time
   * is a tick that tracks demand, which is what the clock is there to avoid.
   */
  lowWater: number;
  /** Bound per run, so one tick cannot spend the whole treasury on a miscount. */
  maxPerRun: number;
  /** Never spend the restock wallet below this: it still has to pay fees. */
  floorLamports: number;
}

export const DEFAULT_RESTOCK_CONFIG: RestockConfig = {
  target: 10,
  // 7 of 10, not 9: the live-stock count the restock reads is a CEILING on
  // availability (it cannot see the issued markers the issuer keeps in KV),
  // so the pot can be emptier than it says and never fuller. The margin is
  // the buffer for that. See the header of `restockInventory.test.ts`.
  lowWater: 7,
  maxPerRun: 3,
  floorLamports: 1_100_000_000,
};

/** Read one non-negative number from the environment, or fall back. */
function envNumber(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** The whole config, from the environment, with every default intact. */
export function restockConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RestockConfig {
  return {
    target: envNumber('P01_TREASURY_TARGET', DEFAULT_RESTOCK_CONFIG.target, env),
    lowWater: envNumber('P01_TREASURY_LOW_WATER', DEFAULT_RESTOCK_CONFIG.lowWater, env),
    maxPerRun: envNumber('P01_TREASURY_MAX_PER_RUN', DEFAULT_RESTOCK_CONFIG.maxPerRun, env),
    floorLamports: envNumber('P01_TREASURY_FLOOR', DEFAULT_RESTOCK_CONFIG.floorLamports, env),
  };
}

/**
 * The balance the restock wallet should hold when a tick begins.
 *
 * Its floor, plus enough to land `maxPerRun` deposits back to back. The
 * restock sweeps each deposit's rent back to the wallet before the next one
 * starts, so the deposits are SEQUENTIAL in the sense `sequentialDepositCapacity`
 * uses: each permanently costs one note's value and needs one pre-fund free
 * while it runs. `floatRequiredForBatch` is the inverse of that capacity, and
 * reusing it here means the restock wallet is sized by the same arithmetic as
 * the float, measured on devnet rather than guessed.
 */
export function restockWalletTargetLamports(cfg: RestockConfig): number {
  return cfg.floorLamports + floatRequiredForBatch(cfg.maxPerRun);
}
