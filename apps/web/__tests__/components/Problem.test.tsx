import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import Problem from '@/components/Problem';

/**
 * The two <CountUp> statistics animate up from 0 over a 2s requestAnimationFrame
 * budget, so asserting the landed figure used to mean waiting on the wall clock.
 * That is not a property of the component and it cannot be made reliable: the
 * two assertions measured 3.7s on a 32-core box against their own 4s waitFor,
 * and failed outright on a CI runner. Raising the waitFor moves the cliff.
 *
 * CountUp now honours prefers-reduced-motion, like every other animation on the
 * site already did, so this file asks for reduced motion and reads the figure
 * synchronously. The pair at the bottom is the control: it proves the counter
 * still animates when motion is allowed, so this file cannot go green by having
 * quietly frozen the animation for every visitor.
 */
function setReducedMotion(reduced: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduced && query === '(prefers-reduced-motion: reduce)',
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

describe('Problem -- Why privacy matters on blockchain', () => {
  beforeEach(() => {
    setReducedMotion(true);
    render(<Problem />);
  });

  describe('Section Header', () => {
    it('displays "The Problem" badge', () => {
      expect(screen.getByText('The Problem')).toBeInTheDocument();
    });

    it('presents the headline about exposed blockchain activity', () => {
      expect(screen.getByText(/Your blockchain activity is/)).toBeInTheDocument();
      expect(screen.getByText('completely exposed')).toBeInTheDocument();
    });

    it('explains the difference between pseudonymity and privacy', () => {
      // `problem.subtitle1` now emphasises the payoff in <strong> (commit 57f9bd5c),
      // so the sentence is split across text nodes and getByText's default
      // direct-text-node matching no longer sees it whole. Assert the full
      // paragraph text so a rewrite of either half still fails this test.
      expect(
        screen.getByText(
          (_content, element) =>
            element?.tagName === 'P' &&
            element.textContent === 'Traditional blockchains offer pseudonymity, not privacy.'
        )
      ).toBeInTheDocument();
      expect(screen.getByText('not privacy')).toBeInTheDocument();
    });
  });

  describe('Privacy Threat Statistics', () => {
    it('displays "Anyone" statistic -- your whole financial history is visible', () => {
      // Was: '100% of blockchain transactions are public'. Reframed in commit
      // 04bdc107 from common knowledge to the consequence for the user.
      expect(screen.getByText('Anyone')).toBeInTheDocument();
      expect(screen.getByText('can see your entire financial history')).toBeInTheDocument();
    });

    it('displays "73%" statistic -- users deanonymized by analytics', () => {
      expect(screen.getByText('of users have been deanonymized')).toBeInTheDocument();
      // Rendered by <CountUp> (commit 2164f1a5). Under the reduced motion this
      // file asks for, the figure lands on first paint, so there is nothing to
      // wait for.
      expect(screen.getByText('73%')).toBeInTheDocument();
    });

    it('displays "24/7" statistic -- constant government surveillance', () => {
      expect(screen.getByText('24/7')).toBeInTheDocument();
      expect(screen.getByText('surveillance by governments & corporations')).toBeInTheDocument();
    });

    it('displays "$4.3B" statistic -- money stolen through wallet tracking', () => {
      expect(screen.getByText('stolen through wallet tracking')).toBeInTheDocument();
      // Same <CountUp> as the 73% stat: $0.0B -> $4.3B, landed at once here.
      expect(screen.getByText('$4.3B')).toBeInTheDocument();
    });
  });

  describe('Before/After Comparison', () => {
    it('shows the "Standard chain" exposed state', () => {
      expect(screen.getByText('Standard chain')).toBeInTheDocument();
    });

    it('shows the "Shielded pool" protected state', () => {
      expect(screen.getByText('Shielded pool')).toBeInTheDocument();
    });

    it('demonstrates exposed transaction data in "without" scenario', () => {
      expect(screen.getByText(/7xK9f...8c2e sent 100 SOL/)).toBeInTheDocument();
      expect(screen.getByText(/7xK9f...8c2e = John Smith/)).toBeInTheDocument();
    });

    it('shows "Identity Exposed" warning for unprotected transactions', () => {
      expect(screen.getByText(/Identity Exposed/)).toBeInTheDocument();
    });

    it('states what an observer actually sees, without claiming anonymity', () => {
      expect(
        screen.getByText(/Fixed denominations - an observer sees one note, not your balance/),
      ).toBeInTheDocument();
    });
  });

  describe('Threat Descriptions', () => {
    it('warns that one address traces every payment, balance and counterparty', () => {
      // Was: 'Every transfer you make is permanently recorded and visible to anyone'.
      // Rewritten alongside the stat-1 reframe in commit 04bdc107.
      expect(
        screen.getByText(
          'One wallet address is enough to trace every payment, your balance and who you deal with. Permanent, public, no permission needed.'
        )
      ).toBeInTheDocument();
    });

    it('warns about wallet-to-identity deanonymization', () => {
      expect(screen.getByText('Blockchain analytics can link your wallet to your real identity')).toBeInTheDocument();
    });

    it('warns about constant financial surveillance', () => {
      expect(screen.getByText('Your financial activity is constantly monitored and analyzed')).toBeInTheDocument();
    });

    it('warns about targeted attacks via public wallet data', () => {
      expect(screen.getByText('Bad actors use public data to target high-value wallets')).toBeInTheDocument();
    });
  });
});

describe('CountUp and prefers-reduced-motion', () => {
  it('lands the figure on first paint when the visitor asked for no motion', () => {
    setReducedMotion(true);
    render(<Problem />);
    expect(screen.getByText('73%')).toBeInTheDocument();
    expect(screen.getByText('$4.3B')).toBeInTheDocument();
  });

  // The control on the control. If CountUp ever stops animating for everyone,
  // the assertion above would still pass and would prove nothing. This one
  // fails in that case: with motion allowed, the first paint is still 0.
  it('has not landed on first paint when motion is allowed', () => {
    setReducedMotion(false);
    render(<Problem />);
    expect(screen.queryByText('73%')).not.toBeInTheDocument();
    expect(screen.queryByText('$4.3B')).not.toBeInTheDocument();
  });
});
