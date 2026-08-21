import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findPoolV3, shieldValueLamports } from './denominatedPool';
import { operatorFeeAtomic } from './ephemeralFunder';

/**
 * What a deposit costs the BUYER, and whether the screen says so.
 *
 * 🚨 THE DEFECT THIS PINS. `PoolPanel` priced a deposit as
 * `denomination * 1.003 + 1.006` — a hand-kept copy of the proof-buffer rent,
 * 0.44 SOL above the measured figure — and described it as "mostly a refundable
 * deposit that comes back at the end". After 2026-08-21 both halves are wrong at
 * once: the deposit path always asks to be relayed, so the buyer pays the VALUE
 * plus the operator's 1% and the float fronts the rent. Nothing comes back to
 * the buyer, and the 1% was disclosed on no screen at all while riding inside
 * the one transaction they sign.
 *
 * The source scan is the idiom this repository already uses in
 * `relayCapDenominations.test.ts`: a constant that must agree with another file
 * is asserted against that file's own text, so a drift goes red here instead of
 * reaching a user.
 */
const PANEL = join(__dirname, '../../../components/pay/PoolPanel.tsx');
const panelSource = (): string => readFileSync(PANEL, 'utf8');

describe('the value leg is derived from the pool table, never remembered', () => {
  it('is the denomination plus the protocol 0.3%, and nothing else', () => {
    const pool = findPoolV3('SOL', 1);
    expect(pool, 'the 1 SOL pool must exist').toBeTruthy();
    // Mirrors `shieldEphemeral.ts:293` term for term. 1 SOL + 0.3% = 1.003 SOL
    // EXACTLY — not 1,003,475,300, which is a measured pre-fund total minus a
    // rent constant and carries 475,300 lamports of buffer rent as if it were
    // value.
    expect(shieldValueLamports(pool!)).toBe(1_003_000_000);
    expect(shieldValueLamports(pool!)).not.toBe(1_003_475_300);
  });

  it('agrees with the fee floor the relay enforces', () => {
    // The route refuses a fee below 99 bps of what landed at the till. That
    // number is only safe while an honest fee sits above it, so the two are
    // asserted against each other rather than each against a memory.
    const pool = findPoolV3('SOL', 1)!;
    const value = shieldValueLamports(pool);
    const honestFee = Number(
      operatorFeeAtomic({
        token: pool.token,
        denominationAtomic: pool.denominationAtomic,
        decimals: pool.decimals,
      }),
    );
    const floor = Math.floor((value * 99) / 10_000);
    expect(honestFee).toBe(10_000_000);
    expect(floor).toBe(9_929_700);
    expect(honestFee).toBeGreaterThan(floor);
    // 99.70 bps: the client charges 1% of the DENOMINATION while the till
    // receives the denomination plus 0.3%.
    expect(((honestFee / value) * 10_000).toFixed(2)).toBe('99.70');
  });
});

describe('the screen quotes what the buyer actually pays', () => {
  it('no longer carries the hand-kept rent constant', () => {
    // `+ 1.006` was 0.44 SOL above the measured rent AND belonged to a shape the
    // buyer no longer funds.
    //
    // ⚠️ THE ASSIGNMENT, NOT THE STRING. The comment above the new figure quotes
    // the old expression on purpose — the defect is the instructive part — so a
    // bare text search here would fail on the explanation of its own fix.
    expect(panelSource()).not.toMatch(
      /const shieldCost\s*=\s*\(denomination \* 1\.003 \+ 1\.006\)/,
    );
  });

  it('derives its figure from the same functions the engine and relay use', () => {
    const src = panelSource();
    expect(src).toContain('shieldValueLamports');
    expect(src).toContain('operatorFeeAtomic');
  });

  it('discloses the operator fee, which rides inside the buyer’s own signature', () => {
    // A fee the buyer cannot decline and cannot see is the one disclosure that
    // must not be implicit: it is in the transaction they approve.
    expect(panelSource()).toMatch(/1%[\s\S]{0,40}operator fee/);
  });

  it('no longer promises the buyer a refund that goes to the deployment', () => {
    const src = panelSource();
    expect(src).not.toMatch(/Most\s*\n?\s*of it is a refundable deposit that comes back at the end/);
    expect(src).not.toMatch(/Most of it is a refundable deposit, returned at the end/);
    expect(src).toMatch(/none of it comes back/);
  });
});
