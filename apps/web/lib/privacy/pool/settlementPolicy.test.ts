import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTLEMENT_CONFIG,
  MIN_PURCHASE_CREDIT_LAMPORTS,
  ONE_NOTE_IN_LAMPORTS,
  ONE_PURCHASE_LAMPORTS,
  PREFUND_WORST_CASE_LAMPORTS,
  type SettlementConfig,
  concurrentDepositCapacity,
  decideQuietTime,
  decideSettlement,
  drawHoldUntil,
  envInt,
  floatRequiredForBatch,
  purchasesCarried,
  purchasesHeld,
  sequentialDepositCapacity,
  settlementConfigFromEnv,
} from './settlementPolicy';
import { UNSHIELD_FEE_BPS, findPoolV3 } from './denominatedPool';

const HOUR = 3600;
const cfg = DEFAULT_SETTLEMENT_CONFIG;

/** Long enough to clear both the quiet period and any hold, unless overridden. */
const LONG_AGO = 48 * HOUR;

function inputs(over: Partial<Parameters<typeof decideSettlement>[0]> = {}) {
  return {
    tillLamports: 0,
    floatLamports: 20 * 1e9,
    secondsSinceLastTillCredit: LONG_AGO,
    holdUntilSeconds: null,
    nowSeconds: 1_800_000_000,
    ...over,
  };
}

describe('capacity arithmetic — pinned to the balances actually measured on devnet', () => {
  /**
   * 🚨 THESE TWO NUMBERS ARE THE REASON THIS MODULE IS TRUSTED WITH MONEY.
   *
   * Measured 2026-08-22 with the float at 7,603,221,500 lamports: six deposits
   * ran back to back and the seventh was refused at 1,585,221,500; four could
   * be in flight at once. If a refactor changes either formula, these fail —
   * and a capacity formula that drifts silently is how a float runs dry mid
   * demo while the dashboard says it is fine.
   */
  const MEASURED_FLOAT = 7_603_221_500;

  it('reproduces the measured sequential capacity of 6', () => {
    expect(sequentialDepositCapacity(MEASURED_FLOAT)).toBe(6);
  });

  it('reproduces the measured concurrent capacity of 4', () => {
    expect(concurrentDepositCapacity(MEASURED_FLOAT)).toBe(4);
  });

  it('reproduces the measured refusal point of the 7th deposit', () => {
    // After six deposits the float is down six note values, and the observed
    // balance at refusal was exactly that.
    const afterSix = MEASURED_FLOAT - 6 * ONE_PURCHASE_LAMPORTS;
    expect(afterSix).toBe(1_585_221_500);
    expect(afterSix).toBeLessThan(PREFUND_WORST_CASE_LAMPORTS);
    expect(sequentialDepositCapacity(afterSix)).toBe(0);
  });

  it('serves nothing below one pre-fund', () => {
    expect(sequentialDepositCapacity(PREFUND_WORST_CASE_LAMPORTS - 1)).toBe(0);
    expect(sequentialDepositCapacity(PREFUND_WORST_CASE_LAMPORTS)).toBe(1);
    expect(concurrentDepositCapacity(PREFUND_WORST_CASE_LAMPORTS - 1)).toBe(0);
  });

  it('floatRequiredForBatch inverts sequentialDepositCapacity exactly', () => {
    // The operator-facing number must not be off by one in the direction that
    // funds too little: the whole point is that funding this amount reaches the
    // floor. Checked across the range an operator would plausibly choose.
    for (let n = 1; n <= 25; n++) {
      const required = floatRequiredForBatch(n);
      expect(sequentialDepositCapacity(required)).toBe(n);
      // And one lamport short is genuinely short.
      expect(sequentialDepositCapacity(required - 1)).toBe(n - 1);
    }
  });

  it('counts purchases with the value leg, not the leg inflated by buffer rent', () => {
    // ⛔ 1,003,475,300 is the figure that was copied around; using it here would
    // round a two-purchase till down to one.
    expect(ONE_PURCHASE_LAMPORTS).toBe(1_003_000_000);
    expect(purchasesHeld(2 * ONE_PURCHASE_LAMPORTS)).toBe(2);
    expect(purchasesHeld(2 * 1_003_475_300)).toBe(2);
    // One lamport short of a plain purchase is still one whole note-in credit
    // plus dust, so since 2026-09-02 it reads as 1. It used to read as 0, and
    // so did a till holding exactly one note-in.
    expect(purchasesHeld(ONE_PURCHASE_LAMPORTS - 1)).toBe(1);
    expect(purchasesHeld(MIN_PURCHASE_CREDIT_LAMPORTS - 1)).toBe(0);
  });
});

describe('note-in credits: the till is counted at the smallest credit a purchase can leave', () => {
  /**
   * A note-in exchange withdraws the buyer's pool note straight to the till.
   * The handler keeps the 0.5 percent withdrawal fee, so the till receives
   * 995,000,000 for a 1 SOL note, not 1,003,000,000. Counting a till of those
   * with the plain-purchase divisor read one purchase short per purchase, and
   * a till of note-in proceeds could sit under the batch floor forever.
   */
  it('derives the note-in credit from the pool module\'s fee, and it is 995,000,000', () => {
    const value = findPoolV3('SOL', 1)!.denominationAtomic;
    expect(ONE_NOTE_IN_LAMPORTS).toBe(Number(value - (value * UNSHIELD_FEE_BPS) / 10_000n));
    expect(ONE_NOTE_IN_LAMPORTS).toBe(995_000_000);
    expect(MIN_PURCHASE_CREDIT_LAMPORTS).toBe(ONE_NOTE_IN_LAMPORTS);
    expect(MIN_PURCHASE_CREDIT_LAMPORTS).toBeLessThan(ONE_PURCHASE_LAMPORTS);
  });

  it('counts a till of note-in proceeds exactly, where the old divisor lost one per purchase', () => {
    for (let k = 1; k <= 10; k++) {
      expect(purchasesHeld(k * ONE_NOTE_IN_LAMPORTS)).toBe(k);
      // The bug, pinned so the reason for the change stays checkable.
      expect(Math.floor((k * ONE_NOTE_IN_LAMPORTS) / ONE_PURCHASE_LAMPORTS)).toBe(k - 1);
    }
    expect(purchasesHeld(ONE_NOTE_IN_LAMPORTS - 1)).toBe(0);
  });

  it('still counts plain purchases exactly up to 124, and over-reads by one from 125', () => {
    // The over-read is the price of the floor direction, and it is documented
    // at MIN_PURCHASE_CREDIT_LAMPORTS with this exact number. If the fee
    // constants move, this test moves the number in the comment.
    for (let k = 1; k <= 124; k++) expect(purchasesHeld(k * ONE_PURCHASE_LAMPORTS)).toBe(k);
    expect(purchasesHeld(125 * ONE_PURCHASE_LAMPORTS)).toBe(126);
  });

  it('counts a mixed till without dropping anyone', () => {
    expect(purchasesHeld(2 * ONE_PURCHASE_LAMPORTS + ONE_NOTE_IN_LAMPORTS)).toBe(3);
    expect(purchasesHeld(ONE_PURCHASE_LAMPORTS + 2 * ONE_NOTE_IN_LAMPORTS)).toBe(3);
  });

  it('a till of exactly the floor in note-ins settles, and one fewer does not', () => {
    const at = decideSettlement(inputs({ tillLamports: cfg.minPurchases * ONE_NOTE_IN_LAMPORTS }));
    expect(at.verdict).toBe('settle');
    expect(at.purchases).toBe(cfg.minPurchases);
    expect(at.amountLamports).toBe(cfg.minPurchases * ONE_NOTE_IN_LAMPORTS);
    const short = decideSettlement(
      inputs({ tillLamports: (cfg.minPurchases - 1) * ONE_NOTE_IN_LAMPORTS }),
    );
    expect(short.verdict).toBe('below-batch-floor');
    expect(short.purchases).toBe(cfg.minPurchases - 1);
  });

  it('the fund-ephemeral detector tells one from more than one for both credit sizes', () => {
    // One purchase of either kind is the violation; two of either kind is not.
    expect(purchasesCarried(ONE_PURCHASE_LAMPORTS)).toBe(1);
    expect(purchasesCarried(ONE_NOTE_IN_LAMPORTS)).toBe(1);
    expect(purchasesCarried(ONE_PURCHASE_LAMPORTS - 5000)).toBe(1);
    expect(purchasesCarried(2 * ONE_NOTE_IN_LAMPORTS)).toBe(2);
    expect(purchasesCarried(2 * ONE_PURCHASE_LAMPORTS)).toBe(2);
    expect(purchasesCarried(7 * ONE_PURCHASE_LAMPORTS)).toBe(7);
    expect(purchasesCarried(7 * ONE_NOTE_IN_LAMPORTS)).toBe(7);
    // Generous at the boundary: a batch that also swept dust is not a violation.
    expect(purchasesCarried(ONE_PURCHASE_LAMPORTS * 1.5 - 1)).toBe(1);
    expect(purchasesCarried(ONE_PURCHASE_LAMPORTS * 1.5)).toBe(2);
    // A shared transaction that moved nothing at the till reads as one, as it
    // always has: it is the only case the detector may block on.
    expect(purchasesCarried(0)).toBe(1);
  });
});

describe('decideQuietTime: the clock half of the rule, shared with the restock top-up', () => {
  it('refuses an unreadable clock', () => {
    expect(
      decideQuietTime({ secondsSinceLastActivity: null, holdUntilSeconds: null, nowSeconds: 0 }, cfg),
    ).toEqual({ verdict: 'history-unknown', waitSeconds: 0 });
  });

  it('refuses inside the quiet period and says how long is left', () => {
    const d = decideQuietTime(
      { secondsSinceLastActivity: cfg.minQuietSeconds - 90, holdUntilSeconds: null, nowSeconds: 0 },
      cfg,
    );
    expect(d).toEqual({ verdict: 'too-soon', waitSeconds: 90 });
    expect(
      decideQuietTime(
        { secondsSinceLastActivity: cfg.minQuietSeconds, holdUntilSeconds: null, nowSeconds: 0 },
        cfg,
      ).verdict,
    ).toBe('go');
  });

  it('honours a stored hold and then releases it', () => {
    const now = 1_800_000_000;
    const quiet = { secondsSinceLastActivity: LONG_AGO, nowSeconds: now };
    expect(decideQuietTime({ ...quiet, holdUntilSeconds: now + 1 }, cfg).verdict).toBe('holding-off');
    expect(decideQuietTime({ ...quiet, holdUntilSeconds: now }, cfg).verdict).toBe('go');
    expect(decideQuietTime({ ...quiet, holdUntilSeconds: null }, cfg).verdict).toBe('go');
  });

  it('is the decision decideSettlement makes, verdict for verdict', () => {
    const full = cfg.minPurchases * ONE_PURCHASE_LAMPORTS;
    const now = 1_800_000_000;
    const cases: [number | null, number | null, string][] = [
      [null, null, 'till-history-unknown'],
      [cfg.minQuietSeconds - 1, null, 'too-soon-after-purchase'],
      [LONG_AGO, now + 60, 'holding-off'],
      [LONG_AGO, now - 1, 'settle'],
      [LONG_AGO, null, 'settle'],
    ];
    const map = { 'history-unknown': 'till-history-unknown', 'too-soon': 'too-soon-after-purchase', 'holding-off': 'holding-off', go: 'settle' };
    for (const [since, hold, expected] of cases) {
      const shared = decideQuietTime(
        { secondsSinceLastActivity: since, holdUntilSeconds: hold, nowSeconds: now },
        cfg,
      );
      const whole = decideSettlement(
        inputs({ tillLamports: full, secondsSinceLastTillCredit: since, holdUntilSeconds: hold, nowSeconds: now }),
      );
      expect(map[shared.verdict]).toBe(expected);
      expect(whole.verdict).toBe(expected);
    }
  });
});

describe('decideSettlement — the privacy floor', () => {
  it('does nothing on an empty till', () => {
    const d = decideSettlement(inputs({ tillLamports: 0 }));
    expect(d.verdict).toBe('nothing-to-settle');
    expect(d.amountLamports).toBe(0);
  });

  it('waits below the floor when the float can still reach it', () => {
    const d = decideSettlement(
      inputs({ tillLamports: 2 * ONE_PURCHASE_LAMPORTS, floatLamports: 20 * 1e9 }),
    );
    expect(d.verdict).toBe('below-batch-floor');
    expect(d.purchases).toBe(2);
    expect(d.amountLamports).toBe(0);
  });

  it('settles at exactly the floor, never one short', () => {
    const short = decideSettlement(
      inputs({ tillLamports: (cfg.minPurchases - 1) * ONE_PURCHASE_LAMPORTS }),
    );
    expect(short.verdict).not.toBe('settle');
    const at = decideSettlement(
      inputs({ tillLamports: cfg.minPurchases * ONE_PURCHASE_LAMPORTS }),
    );
    expect(at.verdict).toBe('settle');
  });

  /**
   * 🚨 THE DEADLOCK. The float can serve one more deposit; the till needs two
   * more purchases to reach the floor. Waiting cannot work — the relay refuses
   * before the second one arrives — so this must NOT report `below-batch-floor`,
   * which tells a human to be patient about a condition patience cannot fix.
   */
  it('names the deadlock instead of telling the operator to wait', () => {
    const d = decideSettlement(
      inputs({
        tillLamports: 1 * ONE_PURCHASE_LAMPORTS,
        floatLamports: PREFUND_WORST_CASE_LAMPORTS, // exactly one deposit left
      }),
    );
    expect(d.verdict).toBe('float-too-small-for-batch-floor');
    expect(d.depositsRemaining).toBe(1);
    expect(d.floatShortfallLamports).toBeGreaterThan(0);
    expect(d.reason).toContain('Add');
  });

  it('refuses to suggest lowering the floor as the way out of the deadlock', () => {
    // The cheap escape is a smaller batch, and it is the one thing that cannot
    // be undone. The advice has to say so where the operator reads it.
    const d = decideSettlement(
      inputs({ tillLamports: ONE_PURCHASE_LAMPORTS, floatLamports: PREFUND_WORST_CASE_LAMPORTS }),
    );
    expect(d.reason).toMatch(/Do not lower the floor/);
  });

  it('the shortfall it quotes actually clears the deadlock', () => {
    const till = 1 * ONE_PURCHASE_LAMPORTS;
    const floatLamports = PREFUND_WORST_CASE_LAMPORTS;
    const d = decideSettlement(inputs({ tillLamports: till, floatLamports }));
    const funded = decideSettlement(
      inputs({ tillLamports: till, floatLamports: floatLamports + d.floatShortfallLamports }),
    );
    expect(funded.verdict).toBe('below-batch-floor');
    expect(funded.depositsRemaining).toBeGreaterThanOrEqual(cfg.minPurchases - 1);
  });
});

describe('decideSettlement — the clock half of the rule', () => {
  const full = cfg.minPurchases * ONE_PURCHASE_LAMPORTS;

  it('refuses while a purchase is still recent, even with a full batch', () => {
    const d = decideSettlement(
      inputs({ tillLamports: full, secondsSinceLastTillCredit: cfg.minQuietSeconds - 1 }),
    );
    expect(d.verdict).toBe('too-soon-after-purchase');
    expect(d.amountLamports).toBe(0);
  });

  /**
   * ⛔ THE UNKNOWN MUST NOT READ AS OLD. An RPC blink is the cheapest way to
   * manufacture the one transfer that names a buyer, and every other unknown on
   * this path already fails closed.
   */
  it('refuses when the till history could not be read', () => {
    const d = decideSettlement(
      inputs({ tillLamports: full, secondsSinceLastTillCredit: null }),
    );
    expect(d.verdict).toBe('till-history-unknown');
    expect(d.amountLamports).toBe(0);
  });

  it('honours a stored hold and then releases it', () => {
    const now = 1_800_000_000;
    const held = decideSettlement(
      inputs({ tillLamports: full, nowSeconds: now, holdUntilSeconds: now + 60 }),
    );
    expect(held.verdict).toBe('holding-off');
    const released = decideSettlement(
      inputs({ tillLamports: full, nowSeconds: now, holdUntilSeconds: now - 1 }),
    );
    expect(released.verdict).toBe('settle');
  });

  it('draws a hold inside the configured spread, and never a constant', () => {
    const now = 1_800_000_000;
    expect(drawHoldUntil(now, cfg, () => 0)).toBe(now);
    expect(drawHoldUntil(now, cfg, () => 0.999999)).toBeLessThan(now + cfg.holdSpreadSeconds);
    expect(drawHoldUntil(now, cfg, () => 0.5)).toBe(now + Math.floor(0.5 * cfg.holdSpreadSeconds));
  });
});

describe('decideSettlement — the amount', () => {
  it('moves the whole till, leaving no running counter behind', () => {
    // A remainder left in the till publishes how far into the next batch we
    // are. That is the counter the batching exists to withhold.
    const till = cfg.minPurchases * ONE_PURCHASE_LAMPORTS + 777_777;
    const d = decideSettlement(inputs({ tillLamports: till }));
    expect(d.verdict).toBe('settle');
    expect(d.amountLamports).toBe(till);
  });

  it('never returns an amount on any refusal', () => {
    const refusals = [
      inputs({ tillLamports: 0 }),
      inputs({ tillLamports: ONE_PURCHASE_LAMPORTS }),
      inputs({ tillLamports: ONE_PURCHASE_LAMPORTS, floatLamports: 0 }),
      inputs({
        tillLamports: cfg.minPurchases * ONE_PURCHASE_LAMPORTS,
        secondsSinceLastTillCredit: 0,
      }),
      inputs({
        tillLamports: cfg.minPurchases * ONE_PURCHASE_LAMPORTS,
        secondsSinceLastTillCredit: null,
      }),
      inputs({
        tillLamports: cfg.minPurchases * ONE_PURCHASE_LAMPORTS,
        nowSeconds: 100,
        holdUntilSeconds: 200,
      }),
    ];
    for (const i of refusals) {
      const d = decideSettlement(i);
      expect(d.verdict, `${d.verdict} must not carry an amount`).not.toBe('settle');
      expect(d.amountLamports).toBe(0);
    }
  });
});

describe('the float alarm', () => {
  it('fires at the configured remaining-deposit threshold and not above it', () => {
    const atThreshold = floatRequiredForBatch(cfg.alarmBelowDeposits);
    expect(decideSettlement(inputs({ floatLamports: atThreshold })).floatAlarm).toBe(true);
    const oneMore = floatRequiredForBatch(cfg.alarmBelowDeposits + 1);
    expect(decideSettlement(inputs({ floatLamports: oneMore })).floatAlarm).toBe(false);
  });

  it('fires on an empty float', () => {
    expect(decideSettlement(inputs({ floatLamports: 0 })).floatAlarm).toBe(true);
  });

  it('is reported on every verdict, including the ones that do nothing', () => {
    // An alarm that only reaches the operator on the settle path is an alarm
    // that stays silent exactly when the float is too low to settle.
    const low = floatRequiredForBatch(1);
    for (const till of [0, ONE_PURCHASE_LAMPORTS, 50 * ONE_PURCHASE_LAMPORTS]) {
      const d = decideSettlement(inputs({ tillLamports: till, floatLamports: low }));
      expect(d.floatAlarm).toBe(true);
    }
  });
});

describe('configuration from the environment', () => {
  it('falls back on anything malformed rather than to zero', () => {
    // ⛔ 0 is the value that turns each of these rules off.
    for (const bad of ['', '0', '-1', 'abc', '2.5', undefined]) {
      expect(envInt('X', 7, { X: bad } as NodeJS.ProcessEnv)).toBe(7);
    }
    expect(envInt('X', 7, { X: '12' } as NodeJS.ProcessEnv)).toBe(12);
  });

  it('reads every field, so no bound is silently unconfigurable', () => {
    const c: SettlementConfig = settlementConfigFromEnv({
      P01_SETTLE_MIN_PURCHASES: '9',
      P01_SETTLE_MIN_QUIET_SECONDS: '11',
      P01_SETTLE_HOLD_SPREAD_SECONDS: '13',
      P01_FLOAT_ALARM_DEPOSITS: '4',
    } as NodeJS.ProcessEnv);
    expect(c).toEqual({
      minPurchases: 9,
      minQuietSeconds: 11,
      holdSpreadSeconds: 13,
      alarmBelowDeposits: 4,
    });
  });

  it('an empty environment is the documented default, not an off switch', () => {
    expect(settlementConfigFromEnv({} as NodeJS.ProcessEnv)).toEqual(DEFAULT_SETTLEMENT_CONFIG);
    expect(DEFAULT_SETTLEMENT_CONFIG.minPurchases).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_SETTLEMENT_CONFIG.minQuietSeconds).toBeGreaterThan(0);
  });
});
