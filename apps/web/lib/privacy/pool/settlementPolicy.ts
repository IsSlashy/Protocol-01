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
 *
 * The one import below is two CONSTANTS from the pool module (the withdrawal
 * fee and the 1 SOL pool's denomination), not a connection. The note-in
 * credit has to move when the fee moves, and a literal here would not.
 */

import { UNSHIELD_FEE_BPS, findPoolV3 } from './denominatedPool';

/**
 * What one purchase pays the till.
 *
 * The denomination plus the protocol's own 0.3%, which for the 1 SOL pool is
 * exactly 1,003,000,000 (`shieldEphemeral.ts:293`).
 *
 * ⛔ NOT 1,003,475,300. That figure was recorded in `denominatedPool.ts` and
 * copied outward, and it is the value leg PLUS 475,300 lamports of buffer rent
 * mislabelled as value. It matters here more than anywhere: this constant is
 * the value one deposit costs the float, and until 2026-09-02 it was also the
 * divisor that turns a till balance into a PURCHASE COUNT (that divisor is now
 * `MIN_PURCHASE_CREDIT_LAMPORTS`, for the reason given there). An inflated
 * value rounds k down and would let a settlement carrying two buyers read as
 * one — or, worse, let one read as zero and never settle at all.
 */
export const ONE_PURCHASE_LAMPORTS = 1_003_000_000;

/**
 * What one NOTE-IN exchange pays the till.
 *
 * A buyer can also pay for an issued note by withdrawing one of their own pool
 * notes straight to the till (circuit 7, `unshield_denominated_stark_v4`, the
 * direct path). The handler keeps the protocol's withdrawal fee, so the till
 * is credited the denomination MINUS that fee: 995,000,000 lamports for the
 * 1 SOL pool, measured as "payee +0.995 SOL" in `denominatedPool.ts`. No 0.3
 * percent shield fee rides on top, because nothing is deposited.
 *
 * Derived from `UNSHIELD_FEE_BPS`, the same constant the client checks before
 * a withdrawal, so a fee change in the pool module moves this number with it.
 * The 1 SOL pool is the one every purchase constant in this file is written
 * for; its absence from the static table is a configuration error, not a case.
 */
export const ONE_NOTE_IN_LAMPORTS = ((): number => {
  const pool = findPoolV3('SOL', 1);
  if (!pool) throw new Error('settlementPolicy: the 1 SOL pool is missing from the pool table');
  const value = pool.denominationAtomic;
  return Number(value - (value * UNSHIELD_FEE_BPS) / 10_000n);
})();

/**
 * The smallest credit ONE purchase, of either kind, leaves in the till.
 *
 * 🚨 THIS IS THE DIVISOR THAT TURNS A TILL BALANCE INTO A PURCHASE COUNT, and
 * the balance does not say which kind of purchase it holds. Dividing by the
 * larger credit (`ONE_PURCHASE_LAMPORTS`) under-reads a till of note-in
 * proceeds by one purchase per purchase: three note-ins, 2,985,000,000
 * lamports, read as 2 and sat under a batch floor of 3 indefinitely, so the
 * money never settled and the float never refilled. Dividing by the smaller
 * one is the conservative direction for a FLOOR: a till can read as more
 * purchases than it holds only once about 125 plain purchases are in it (the
 * 8,000,000-lamport difference per purchase has to add up to one whole
 * credit), and a settlement carrying 125 buyers is not the case the floor
 * exists for.
 */
export const MIN_PURCHASE_CREDIT_LAMPORTS = Math.min(ONE_PURCHASE_LAMPORTS, ONE_NOTE_IN_LAMPORTS);

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

/**
 * How many purchases a till balance represents.
 *
 * Counted at the smallest credit a purchase can leave, so a till of note-in
 * proceeds is never under-counted. See `MIN_PURCHASE_CREDIT_LAMPORTS` for why
 * the floor direction is the safe one.
 */
export function purchasesHeld(tillLamports: number): number {
  return Math.floor(tillLamports / MIN_PURCHASE_CREDIT_LAMPORTS);
}

/**
 * How many purchases a settlement of `movedLamports` carried.
 *
 * For the detector in `fund-ephemeral`, which only has to tell ONE from more
 * than one: a settlement carrying one purchase names that buyer, a settlement
 * carrying several is a set. Generous at the boundary on purpose: anything
 * under one and a half plain purchases counts as one, so a batch that also
 * swept dust is not called a violation. Above that it rounds on the smallest
 * credit a purchase can leave, for the reason `purchasesHeld` gives, so two
 * note-ins (1,990,000,000) read as two and not as one point nine.
 */
export function purchasesCarried(movedLamports: number): number {
  if (movedLamports < ONE_PURCHASE_LAMPORTS * 1.5) return 1;
  return Math.round(movedLamports / MIN_PURCHASE_CREDIT_LAMPORTS);
}

export type QuietTimeVerdict =
  /** The clock could not be read. Refuse, never assume old. */
  | 'history-unknown'
  /** Activity landed less than `minQuietSeconds` ago. */
  | 'too-soon'
  /** Quiet long enough, but the stored randomised hold has not expired. */
  | 'holding-off'
  /** The clock allows it. */
  | 'go';

export interface QuietTimeInputs {
  /**
   * Seconds since the most recent activity on the address being watched, or
   * `null` if its history could not be read. The same rule as
   * `SettlementInputs.secondsSinceLastTillCredit`: `null` is not "long ago".
   */
  secondsSinceLastActivity: number | null;
  /** The stored hold deadline, in unix seconds, or `null` if none is recorded. */
  holdUntilSeconds: number | null;
  nowSeconds: number;
}

export interface QuietTimeDecision {
  verdict: QuietTimeVerdict;
  /** Seconds still to wait when `too-soon`, otherwise 0. */
  waitSeconds: number;
}

/**
 * The clock half of the rule, on its own.
 *
 * Shared by the settlement (till to float) and the restock top-up (float to
 * restock wallet, `restockTopUp.ts`). Both move operator money along a public
 * edge, and both must not sit beside the event they follow on a public clock.
 * One copy of the arithmetic, so there is one place where an unreadable clock
 * refuses; a second copy would be a second place for the unknown to read as
 * old. The callers own the prose, this owns the decision.
 */
export function decideQuietTime(
  input: QuietTimeInputs,
  cfg: SettlementConfig = DEFAULT_SETTLEMENT_CONFIG,
): QuietTimeDecision {
  if (input.secondsSinceLastActivity === null) {
    return { verdict: 'history-unknown', waitSeconds: 0 };
  }
  if (input.secondsSinceLastActivity < cfg.minQuietSeconds) {
    return {
      verdict: 'too-soon',
      waitSeconds: cfg.minQuietSeconds - input.secondsSinceLastActivity,
    };
  }
  if (input.holdUntilSeconds !== null && input.nowSeconds < input.holdUntilSeconds) {
    return { verdict: 'holding-off', waitSeconds: 0 };
  }
  return { verdict: 'go', waitSeconds: 0 };
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

  // The clock half is decided in one place and only worded here, so the
  // restock top-up cannot drift from it. `since === null` is repeated for the
  // type narrowing below; the rule itself lives in `decideQuietTime`.
  const since = input.secondsSinceLastTillCredit;
  const quiet = decideQuietTime(
    {
      secondsSinceLastActivity: since,
      holdUntilSeconds: input.holdUntilSeconds,
      nowSeconds: input.nowSeconds,
    },
    cfg,
  );

  if (quiet.verdict === 'history-unknown' || since === null) {
    return {
      ...base,
      verdict: 'till-history-unknown',
      reason:
        'The till\'s recent history could not be read, so how long ago the last purchase ' +
        'landed is unknown. Refusing: an unknown clock is not an old one.',
    };
  }

  if (quiet.verdict === 'too-soon') {
    return {
      ...base,
      verdict: 'too-soon-after-purchase',
      reason:
        `A purchase landed ${Math.round(since / 60)} minute(s) ago. ` +
        `A settlement sent now sits beside it on a public clock. Waiting ${Math.ceil(quiet.waitSeconds / 60)} ` +
        `more minute(s).`,
    };
  }

  if (quiet.verdict === 'holding-off' && input.holdUntilSeconds !== null) {
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
      `${since >= 86400
        ? `${Math.floor(since / 86400)} day(s)`
        : `${Math.round(since / 3600)} hour(s)`} after the last one.`,
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
