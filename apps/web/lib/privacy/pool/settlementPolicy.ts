/**
 * When the till may settle into the float, and how much the float must hold.
 *
 * WHY THIS IS A MODULE AND NOT A FEW LINES IN THE ROUTE
 * ────────────────────────────────────────────────────
 * Every number here was previously prose. `relay-to-buyer/route.ts` said, in a
 * comment: "F drains by roughly one denomination per deposit until R settles
 * with it in batches. F needs a balance alarm and a settlement runbook." A
 * runbook is a person remembering, and on 2026-08-22 the person was me and I
 * settled ONE purchase ninety minutes after it happened — the exact shape the
 * invariant forbids, on leaf 72, while writing the invariant.
 *
 * 🚨 THE TWO RULES PULL IN OPPOSITE DIRECTIONS AND THIS FILE REFUSES TO HIDE IT.
 *
 *   privacy   wants settlements LATE and LARGE — a transfer carrying k buyers
 *             is a set of k, and k = 1 is a name.
 *   continuity wants settlements EARLY — the float pays a whole denomination
 *             out of pocket per deposit and stops serving when it runs dry.
 *
 * There is no setting that satisfies both. What satisfies both is CAPITAL: a
 * float big enough to fund the whole batch before the batch is due. So the
 * decision function never trades one against the other — when they conflict it
 * returns `float-too-small-for-batch-floor` and says how much SOL closes the
 * gap. ⛔ It must never resolve the conflict by settling a small batch. A
 * protocol that stops is restarted with a transfer; a buyer who was named
 * stays named, and no later transfer takes it back.
 *
 * PURE ON PURPOSE. No RPC, no clock, no KV — every input is passed in. The
 * arithmetic below is the same arithmetic the operator has to trust with real
 * money, and arithmetic that needs a devnet connection to test is arithmetic
 * nobody re-checks.
 */

/**
 * What one purchase pays the till.
 *
 * The denomination plus the protocol's own 0.3%, which for the 1 SOL pool is
 * exactly 1,003,000,000 (`shieldEphemeral.ts:293`).
 *
 * ⛔ NOT 1,003,475,300. That figure was recorded in `denominatedPool.ts` and
 * copied outward, and it is the value leg PLUS 475,300 lamports of buffer rent
 * mislabelled as value. It matters here more than anywhere: this constant is
 * the divisor that turns a till balance into a PURCHASE COUNT, so an inflated
 * value rounds k down and would let a settlement carrying two buyers read as
 * one — or, worse, let one read as zero and never settle at all.
 */
export const ONE_PURCHASE_LAMPORTS = 1_003_000_000;

/**
 * The most a single deposit needs free in the float while it runs.
 *
 * Value (1,003,000,000) plus proof-buffer rent (570,486,080) plus the jitter
 * `prefundAmount.ts` adds, rounded up — the same worst case
 * `MAX_RENT_SUBSIDY_LAMPORTS` was derived from in `relay-to-buyer/route.ts`.
 * Most of it comes back when the buffers close; none of it is available while
 * the deposit is in flight, which is what makes it the capacity bound rather
 * than the net cost.
 */
export const PREFUND_WORST_CASE_LAMPORTS = 1_620_000_000;

export interface SettlementConfig {
  /** Fewest purchases a settlement may carry. The privacy floor. */
  minPurchases: number;
  /**
   * How long the till must have been quiet before a settlement may leave.
   *
   * 🚨 THE COUNT IS ONLY HALF THE RULE AND THIS IS THE OTHER HALF. A batch of
   * twenty sent ninety seconds after the twentieth purchase re-pairs that buyer
   * with the settlement by the clock, which is public and free to read. A
   * settlement is anonymous among the purchases it carries only if it is not
   * adjacent to any of them.
   */
  minQuietSeconds: number;
  /**
   * The width of the randomised hold applied on top of the quiet period.
   *
   * ⚠️ WITHOUT THIS THE DELAY IS A CONSTANT, AND A CONSTANT IS SUBTRACTABLE.
   * "Always exactly one hour after the last payment" is as good a pointer as
   * "immediately after" — an observer subtracts 3600 and lands on the same
   * transaction. The hold is drawn once per settlement window and stored, so it
   * is stable across cron ticks (a hold redrawn every tick converges on its own
   * minimum, which is the constant again).
   */
  holdSpreadSeconds: number;
  /** Remaining sequential deposits at or below which the float alarm fires. */
  alarmBelowDeposits: number;
}

export const DEFAULT_SETTLEMENT_CONFIG: SettlementConfig = {
  // Three, not two. The detector in `fund-ephemeral` calls anything under one
  // and a half notes a settlement of one, so two is the first count it can
  // distinguish — and a floor set to the first value that escapes the detector
  // is a floor tuned to the alarm rather than to the property. Three is the
  // smallest set that survives one buyer being identified by other means.
  minPurchases: 3,
  minQuietSeconds: 6 * 3600,
  holdSpreadSeconds: 6 * 3600,
  alarmBelowDeposits: 2,
};

/**
 * How many deposits this float can serve back to back, with no settlement.
 *
 * Each deposit needs `PREFUND_WORST_CASE_LAMPORTS` free at the moment it runs
 * and permanently costs `ONE_PURCHASE_LAMPORTS` (the value ends up in the pool
 * as the buyer's note; only the rent comes back). So from balance B the k-th
 * deposit needs `B - (k-1) * value >= prefund`.
 *
 * ✅ REPRODUCES THE MEASUREMENT. At 7,603,221,500 this returns 6, and the
 * 7th was observed refused at 1,585,221,500 on 2026-08-22. A test pins it.
 */
export function sequentialDepositCapacity(floatLamports: number): number {
  if (floatLamports < PREFUND_WORST_CASE_LAMPORTS) return 0;
  return (
    Math.floor(
      (floatLamports - PREFUND_WORST_CASE_LAMPORTS) / ONE_PURCHASE_LAMPORTS,
    ) + 1
  );
}

/**
 * How many deposits can be in flight AT ONCE.
 *
 * Different question, different answer: concurrent deposits each hold their
 * whole pre-fund at the same time, so this divides by the pre-fund rather than
 * by the value. ✅ Returns 4 at 7,603,221,500, matching the measurement.
 */
export function concurrentDepositCapacity(floatLamports: number): number {
  return Math.floor(floatLamports / PREFUND_WORST_CASE_LAMPORTS);
}

/**
 * The float balance required to reach a batch of `purchases` without stopping.
 *
 * The inverse of `sequentialDepositCapacity`, and the number the operator
 * actually needs: it converts a privacy floor into an amount of SOL. A float
 * below this cannot reach its own batch minimum, so the deployment refuses
 * deposits before the till is allowed to settle — a deadlock that reads, from
 * the outside, as "the relay is broken".
 */
export function floatRequiredForBatch(purchases: number): number {
  if (purchases <= 0) return PREFUND_WORST_CASE_LAMPORTS;
  return (purchases - 1) * ONE_PURCHASE_LAMPORTS + PREFUND_WORST_CASE_LAMPORTS;
}

/** How many purchases a till balance represents. */
export function purchasesHeld(tillLamports: number): number {
  return Math.floor(tillLamports / ONE_PURCHASE_LAMPORTS);
}

export type SettlementVerdict =
  /** The till holds less than one purchase. Ordinary idle state. */
  | 'nothing-to-settle'
  /** Real money, but fewer purchases than the privacy floor. Wait. */
  | 'below-batch-floor'
  /** The floor can never be reached: the float dies first. Operator must fund. */
  | 'float-too-small-for-batch-floor'
  /** A purchase landed too recently; settling now would sit beside it. */
  | 'too-soon-after-purchase'
  /** Quiet long enough, but the randomised hold has not expired. */
  | 'holding-off'
  /** ⚠️ Cannot tell how recent the last purchase is. Refuse, never assume old. */
  | 'till-history-unknown'
  /** Go. */
  | 'settle';

export interface SettlementInputs {
  tillLamports: number;
  floatLamports: number;
  /**
   * Seconds since the most recent credit to the till, or `null` if the history
   * could not be read.
   *
   * ⛔ `null` IS NOT "LONG AGO". Every other unknown on this path fails closed
   * for the same reason (`fund-ephemeral` on an unreadable float balance,
   * `issue-note` on an unreadable slot): an unreadable clock resolves to the
   * answer that spends nothing, and here that is refusing to settle. An RPC
   * hiccup must not be able to produce the one transfer that names a buyer.
   */
  secondsSinceLastTillCredit: number | null;
  /**
   * The stored hold deadline, in unix seconds, or `null` if none is recorded.
   * The caller draws and persists it the first time a window becomes eligible.
   */
  holdUntilSeconds: number | null;
  nowSeconds: number;
  config?: SettlementConfig;
}

export interface SettlementDecision {
  verdict: SettlementVerdict;
  /** Purchases the till currently carries. */
  purchases: number;
  /** Deposits the float can still serve back to back. */
  depositsRemaining: number;
  /** True when the float is at or under the alarm threshold. */
  floatAlarm: boolean;
  /** Lamports the operator must add to reach the batch floor, 0 when none. */
  floatShortfallLamports: number;
  /** Filled only on `settle`: how many lamports to move. */
  amountLamports: number;
  /** One sentence, safe to show an operator. */
  reason: string;
}

/**
 * The whole decision, from numbers already read.
 *
 * ⚠️ ORDER IS LOAD-BEARING, and it is the opposite of the obvious one. The
 * capacity checks run BEFORE the timing checks, because `below-batch-floor` and
 * `float-too-small-for-batch-floor` need opposite reactions from a human —
 * "wait" versus "send SOL now" — and a deployment stuck in the second while
 * reporting the first waits forever. The same mistake in reverse cost a day on
 * 2026-08-21, when a readiness check ordered after a config check reduced every
 * operator error to one untyped refusal.
 */
export function decideSettlement(input: SettlementInputs): SettlementDecision {
  const cfg = input.config ?? DEFAULT_SETTLEMENT_CONFIG;
  const purchases = purchasesHeld(input.tillLamports);
  const depositsRemaining = sequentialDepositCapacity(input.floatLamports);
  const floatAlarm = depositsRemaining <= cfg.alarmBelowDeposits;
  const needed = floatRequiredForBatch(cfg.minPurchases);
  const floatShortfallLamports = Math.max(0, needed - input.floatLamports);

  const base = {
    purchases,
    depositsRemaining,
    floatAlarm,
    floatShortfallLamports,
    amountLamports: 0,
  };

  if (purchases <= 0) {
    return {
      ...base,
      verdict: 'nothing-to-settle',
      reason: 'The till holds less than one purchase.',
    };
  }

  if (purchases < cfg.minPurchases) {
    // 🚨 THE DEADLOCK, NAMED BEFORE IT IS HIT. The float can only serve
    // `depositsRemaining` more deposits, and each one is a purchase. If that is
    // fewer than the purchases still missing from the floor, the till will
    // never reach the floor: the relay starts refusing first, no more purchases
    // arrive, and nothing settles. Reported as its own verdict because the
    // remedy is capital, not patience, and no amount of waiting produces it.
    const missing = cfg.minPurchases - purchases;
    if (depositsRemaining < missing) {
      return {
        ...base,
        verdict: 'float-too-small-for-batch-floor',
        reason:
          `The till holds ${purchases} of the ${cfg.minPurchases} purchases a settlement must ` +
          `carry, and the float can only serve ${depositsRemaining} more deposit(s) — fewer than ` +
          `the ${missing} still needed. The floor cannot be reached and the relay will refuse ` +
          `before it is. Add ${(floatShortfallLamports / 1e9).toFixed(4)} SOL to the float. ` +
          `⛔ Do not lower the floor to escape this: a settlement carrying one purchase names ` +
          `that buyer permanently, and the SOL is recoverable where the name is not.`,
      };
    }
    return {
      ...base,
      verdict: 'below-batch-floor',
      reason:
        `The till holds ${purchases} purchase(s); a settlement must carry at least ` +
        `${cfg.minPurchases}. Waiting.`,
    };
  }

  if (input.secondsSinceLastTillCredit === null) {
    return {
      ...base,
      verdict: 'till-history-unknown',
      reason:
        'The till\'s recent history could not be read, so how long ago the last purchase ' +
        'landed is unknown. Refusing: an unknown clock is not an old one.',
    };
  }

  if (input.secondsSinceLastTillCredit < cfg.minQuietSeconds) {
    const wait = cfg.minQuietSeconds - input.secondsSinceLastTillCredit;
    return {
      ...base,
      verdict: 'too-soon-after-purchase',
      reason:
        `A purchase landed ${Math.round(input.secondsSinceLastTillCredit / 60)} minute(s) ago. ` +
        `A settlement sent now sits beside it on a public clock. Waiting ${Math.ceil(wait / 60)} ` +
        `more minute(s).`,
    };
  }

  if (input.holdUntilSeconds !== null && input.nowSeconds < input.holdUntilSeconds) {
    return {
      ...base,
      verdict: 'holding-off',
      reason:
        `Eligible, holding until ${new Date(input.holdUntilSeconds * 1000).toISOString()} so the ` +
        `delay between the last purchase and the settlement is not a constant an observer can ` +
        `subtract.`,
    };
  }

  return {
    ...base,
    verdict: 'settle',
    // ⚠️ The AMOUNT is the whole till, not `purchases * ONE_PURCHASE`. Leaving a
    // remainder behind would publish, in the till's surviving balance, exactly
    // how much of the next batch has already arrived — a running counter of
    // purchases readable by anyone, which is the thing the batching exists to
    // withhold. The caller subtracts the network fee.
    amountLamports: input.tillLamports,
    reason:
      `Settling ${purchases} purchase(s), ` +
      `${input.secondsSinceLastTillCredit >= 86400
        ? `${Math.floor(input.secondsSinceLastTillCredit / 86400)} day(s)`
        : `${Math.round(input.secondsSinceLastTillCredit / 3600)} hour(s)`} after the last one.`,
  };
}

/**
 * Draw the randomised hold for a window that has just become eligible.
 *
 * Separated from `decideSettlement` so the decision stays pure and the one
 * non-deterministic value in the whole feature has a single, obvious home.
 */
export function drawHoldUntil(
  nowSeconds: number,
  cfg: SettlementConfig = DEFAULT_SETTLEMENT_CONFIG,
  random: () => number = Math.random,
): number {
  return nowSeconds + Math.floor(random() * Math.max(0, cfg.holdSpreadSeconds));
}

/** Read one positive integer from the environment, or fall back. */
export function envInt(name: string, fallback: number, env = process.env): number {
  const raw = Number(env[name] ?? '');
  // Same posture as `ISSUES_PER_IP_PER_HOUR`: a malformed value must not become
  // 0, because 0 is the one value that turns the rule off — and for
  // `minQuietSeconds` and `minPurchases` "off" is the shape this file exists to
  // refuse. A floor of 1 and no ceiling: an operator raising a bound is making
  // a decision about their own privacy, and a silently clamped value is worse
  // than a high one they chose.
  return Number.isInteger(raw) && raw >= 1 ? raw : fallback;
}

/** The whole config, from the environment, with every default intact. */
export function settlementConfigFromEnv(env = process.env): SettlementConfig {
  return {
    minPurchases: envInt('P01_SETTLE_MIN_PURCHASES', DEFAULT_SETTLEMENT_CONFIG.minPurchases, env),
    minQuietSeconds: envInt(
      'P01_SETTLE_MIN_QUIET_SECONDS',
      DEFAULT_SETTLEMENT_CONFIG.minQuietSeconds,
      env,
    ),
    holdSpreadSeconds: envInt(
      'P01_SETTLE_HOLD_SPREAD_SECONDS',
      DEFAULT_SETTLEMENT_CONFIG.holdSpreadSeconds,
      env,
    ),
    alarmBelowDeposits: envInt(
      'P01_FLOAT_ALARM_DEPOSITS',
      DEFAULT_SETTLEMENT_CONFIG.alarmBelowDeposits,
      env,
    ),
  };
}
