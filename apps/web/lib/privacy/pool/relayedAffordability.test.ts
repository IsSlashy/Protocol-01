import { describe, expect, it } from 'vitest';
import { relayedWithdrawalAffordability } from './denominatedPool';

describe('which notes can pay a relayer', () => {
  it('the 1 SOL note can, and that is the demo path', () => {
    const a = relayedWithdrawalAffordability(1);
    expect(a.affordable).toBe(true);
    expect(a.feeLamports).toBe(5_000_000n); // 50 bps of 1 SOL
    expect(a.rewardLamports).toBe(2_500_000n);
  });

  it('🚨 the 0.1 SOL note cannot, and the chain would refuse it', () => {
    const a = relayedWithdrawalAffordability(0.1);
    expect(a.affordable).toBe(false);
    // 500,000 against a 2,500,000 reward: `fee_to_escrow` underflows and the
    // program answers RelayerRewardExceedsNote.
    expect(a.feeLamports).toBe(500_000n);
    expect(a.feeLamports).toBeLessThan(a.rewardLamports);
  });

  it('is exact at the boundary rather than generous', () => {
    // 0.5 SOL: 50 bps = 2,500,000 = exactly the reward. Escrow gets nothing,
    // which the program permits — checked_sub only refuses going below zero.
    const a = relayedWithdrawalAffordability(0.5);
    expect(a.feeLamports).toBe(2_500_000n);
    expect(a.affordable).toBe(true);
  });

  it('does not drift on binary fractions', () => {
    // 0.1 has no exact float representation; rounding through lamports is what
    // keeps this from answering 499,999.
    expect(relayedWithdrawalAffordability(0.1).feeLamports).toBe(500_000n);
    expect(relayedWithdrawalAffordability(0.3).feeLamports).toBe(1_500_000n);
  });
});
