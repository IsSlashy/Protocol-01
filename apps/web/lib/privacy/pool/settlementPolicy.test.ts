import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTLEMENT_CONFIG,
  ONE_PURCHASE_LAMPORTS,
  PREFUND_WORST_CASE_LAMPORTS,
  type SettlementConfig,
  concurrentDepositCapacity,
  decideSettlement,
  drawHoldUntil,
  envInt,
  floatRequiredForBatch,
  purchasesHeld,
  sequentialDepositCapacity,
  settlementConfigFromEnv,
} from './settlementPolicy';

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
    expect(purchasesHeld(ONE_PURCHASE_LAMPORTS - 1)).toBe(0);
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
