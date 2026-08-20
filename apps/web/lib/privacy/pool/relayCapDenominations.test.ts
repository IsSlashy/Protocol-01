/**
 * PORTE 2 (UI half) — the picker must not OFFER what the relay cannot serve.
 *
 * THE DEFECT, MEASURED FROM SOURCE 2026-08-20
 * ───────────────────────────────────────────
 *   relay-to-buyer/route.ts:48   MAX_RELAY_LAMPORTS        = 2_500_000_000
 *   relay-to-buyer/route.ts:70   MAX_RENT_SUBSIDY_LAMPORTS = 1_500_000_000
 *   fund-ephemeral/route.ts:73   MAX_LAMPORTS_PER_REQUEST  = 2_000_000_000
 *
 * A shield pre-funds `denomination * 1.003` (the denomination plus the 0.3%
 * protocol fee, `shield_denominated_v3.rs:218-220`) PLUS ~0.57 SOL of
 * refundable proof-buffer rent — measured on devnet at 1_573_486_080 lamports
 * for a 1 SOL note, of which 570_010_780 is the rent leg
 * (`shieldEphemeral.ts:270`). The relay refuses anything above its cap, so a
 * 10 SOL deposit is not "slow" or "sometimes": it takes the buyer's money and
 * delivers NOTHING, 100% of the time. Offering it in a picker is the whole bug.
 *
 * WHY THE CEILING IS COMPUTED AND NOT LISTED. A hardcoded list of "good"
 * denominations goes stale the instant either constant moves, and it goes stale
 * silently — which is the same failure shape as the flag only one view read.
 * The ceiling here is arithmetic over the real constants, and the last test
 * re-reads the relay route's own source so a change there fails this file
 * instead of shipping a picker that lies.
 *
 * Runs under `vitest.pool.config.mts` (node) — hence `fs` is available.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ALL_POOLS_V3, SOL_POOLS_V3, type PoolConfig } from './denominatedPool';
// Namespace import ON PURPOSE — see the note in poolDepositsClosed.test.ts:
// these helpers do not exist yet and a named import would fail the whole file
// at link time instead of failing each assertion for its own reason.
import * as denominatedPool from './denominatedPool';
import { PREFUND_MAX_EXTRA_STEPS, PREFUND_STEP_LAMPORTS } from './prefundAmount';

/** The prefund measured on devnet for a 1 SOL deposit (`shieldEphemeral.ts:270`). */
const MEASURED_1_SOL_PREFUND = 1_573_486_080;

/** Its rent leg: buffer rent + tx-fee budget + rent margin. */
const MEASURED_RENT_LEG = 570_010_780;

const cap = (): number => denominatedPool.MAX_RELAY_LAMPORTS;
const estimate = (p: PoolConfig): number => denominatedPool.estimateShieldPrefundLamports(p);
const openForDeposit = (): PoolConfig[] => denominatedPool.poolsOpenForDeposit('SOL');

describe('the relay cap is mirrored from the route that enforces it', () => {
  it('matches the literal in app/api/relay-to-buyer/route.ts', () => {
    // The route is another lot's file — this cannot import it (a Next route
    // module in a node unit test), so it reads the source and pins the number.
    // If that constant moves, this fails here rather than in a user's wallet.
    const src = readFileSync(
      path.resolve(__dirname, '../../../app/api/relay-to-buyer/route.ts'),
      'utf8',
    );
    const m = src.match(/MAX_RELAY_LAMPORTS\s*=\s*([0-9_]+)/);
    expect(m, 'MAX_RELAY_LAMPORTS must still exist in the relay route').not.toBeNull();
    expect(cap()).toBe(Number(m![1].replace(/_/g, '')));
    expect(cap()).toBe(2_500_000_000);
  });
});

describe('the shield prefund estimate is the real cost model', () => {
  it('reproduces the measured 1 SOL deposit, with the jitter headroom on top', () => {
    const oneSol = SOL_POOLS_V3.find((p) => p.denomination === 1)!;

    // `jitterPrefund` rounds UP to a whole 0.01 SOL and adds 0-4 more of them,
    // so the amount a wallet must actually hold is up to five steps above the
    // bare sum. A ceiling computed without that headroom would offer a
    // denomination that fails on the unlucky draw only — the worst kind.
    const headroom = PREFUND_STEP_LAMPORTS * (PREFUND_MAX_EXTRA_STEPS + 1);
    expect(headroom).toBe(50_000_000);

    expect(estimate(oneSol)).toBeGreaterThanOrEqual(MEASURED_1_SOL_PREFUND);
    expect(estimate(oneSol)).toBeLessThanOrEqual(MEASURED_1_SOL_PREFUND + headroom);
    // Value leg + rent leg, sanity-checked against the two measured halves.
    expect(estimate(oneSol)).toBeGreaterThanOrEqual(1_003_000_000 + MEASURED_RENT_LEG);
  });

  it('puts the 1 SOL pool under the cap and every larger pool over it', () => {
    const byDenom = (d: number) => SOL_POOLS_V3.find((p) => p.denomination === d)!;

    expect(estimate(byDenom(0.1))).toBeLessThan(cap());
    expect(estimate(byDenom(1))).toBeLessThan(cap());
    for (const d of [10, 100, 500, 1000]) {
      expect(estimate(byDenom(d)), `${d} SOL must exceed the relay cap`).toBeGreaterThan(
        cap(),
      );
    }
  });

  it('binds between 1 and 10 SOL, which is why only 1 SOL survives', () => {
    // Not an exact figure: the bare arithmetic binds at ~1.92 SOL and the
    // jitter headroom pulls it to ~1.87. What matters, and what this pins, is
    // that the ceiling sits above the demo pool and far below the next rung.
    const ceiling = denominatedPool.maxRelayableDenomination('SOL');
    expect(ceiling).toBeGreaterThan(1);
    expect(ceiling).toBeLessThan(10);
  });
});

describe('an over-cap denomination is not selectable', () => {
  it('offers exactly the two pools under the cap', () => {
    // 0.1 reopened 2026-08-21 as the campaign target. Both sit far under the
    // relay ceiling; everything above 1 SOL stays out, which is the property
    // this file exists for.
    expect(openForDeposit().map((p) => p.denomination)).toEqual([0.1, 1]);
  });

  it('never offers a denomination the relay would refuse', () => {
    // THE GUARD. Not a list of bad denominations — a property over whatever the
    // table holds, so adding a pool or moving a cap cannot quietly reopen one.
    for (const pool of ALL_POOLS_V3) {
      if (estimate(pool) <= cap()) continue;
      expect(
        openForDeposit().some((p) => p.poolPDA.equals(pool.poolPDA)),
        `${pool.denomination} ${pool.token} needs ${estimate(pool)} lamports, over the ` +
          `${cap()} relay cap — it must not be selectable`,
      ).toBe(false);
      expect(denominatedPool.depositBlockFor(pool)).not.toBeNull();
    }
  });

  it('says WHY on every blocked denomination, and the cap outranks the flag', () => {
    const byDenom = (d: number) => SOL_POOLS_V3.find((p) => p.denomination === d)!;

    // Open, servable: nothing to say.
    expect(denominatedPool.depositBlockFor(byDenom(1))).toBeNull();
    expect(denominatedPool.depositBlockFor(byDenom(0.1))).toBeNull();

    // Closed but well within the relay's reach: the honest reason is the
    // closure, not the arithmetic.
    //
    // The exemplar had to move on 2026-08-21. It was the 0.1 SOL pool, which
    // reopened as the deposit campaign's target, and after that NO SOL pool is
    // both flag-closed and under the cap - the two open ones are the only two
    // under it. A USDC pool is now the only shape that exercises this branch,
    // and it is the honest one: it is closed by decision, not by arithmetic,
    // because no USDC relay leg was ever funded.
    const closedUnderCap = ALL_POOLS_V3.find(
      (p) => p.token !== 'SOL' && denominatedPool.depositBlockFor(p) !== null,
    )!;
    expect(closedUnderCap, 'a flag-closed pool under the cap must exist').toBeDefined();
    const small = denominatedPool.depositBlockFor(closedUnderCap)!;
    expect(small.reason).toBe('closed');
    expect(small.message).toMatch(/closed to new deposits/i);
    expect(small.message).toMatch(/spend|spendable|withdraw/i);
    // And it must NOT claim a lamport cost: the relay cap is a lamport bound and
    // USDC atoms are not lamports. That confusion once printed "needs about
    // 1.57 SOL up front" for a 1000 USDC deposit, verbatim, to the buyer.
    expect(small.message).not.toMatch(/SOL up front/i);

    // Over the cap: that reason WINS over the flag, because it is the fact that
    // stays true if someone flips the flag back. A pool reopened by hand must
    // still not be offered while the relay cannot fund it.
    for (const d of [10, 100, 500, 1000]) {
      const block = denominatedPool.depositBlockFor(byDenom(d))!;
      expect(block.reason, `${d} SOL`).toBe('over-relay-cap');
      expect(block.message).toMatch(/2\.5|relay/i);
      expect(block.message.length).toBeGreaterThan(20);
    }
  });

  it('keeps every pool in the read-side table regardless', () => {
    // The picker filters; the table does not. Restating it here because this
    // file is where someone would be tempted to filter at the source.
    expect(SOL_POOLS_V3.map((p) => p.denomination)).toEqual([0.1, 1, 10, 100, 500, 1000]);
    expect(ALL_POOLS_V3.length).toBe(13);
  });
});
