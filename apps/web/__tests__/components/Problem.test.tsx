import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import Problem from '@/components/Problem';

describe('Problem -- Why privacy matters on blockchain', () => {
  beforeEach(() => {
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

    it('displays "73%" statistic -- users deanonymized by analytics', async () => {
      expect(screen.getByText('of users have been deanonymized')).toBeInTheDocument();
      // The figure is rendered by <CountUp> (commit 2164f1a5): it animates from 0
      // to its final value over 2s via requestAnimationFrame, so the exact number
      // only appears once the animation lands.
      await waitFor(() => expect(screen.getByText('73%')).toBeInTheDocument(), {
        timeout: 4000,
      });
    });

    it('displays "24/7" statistic -- constant government surveillance', () => {
      expect(screen.getByText('24/7')).toBeInTheDocument();
      expect(screen.getByText('surveillance by governments & corporations')).toBeInTheDocument();
    });

    it('displays "$4.3B" statistic -- money stolen through wallet tracking', async () => {
      expect(screen.getByText('stolen through wallet tracking')).toBeInTheDocument();
      // Same <CountUp> animation as the 73% stat: $0.0B -> $4.3B over 2s.
      await waitFor(() => expect(screen.getByText('$4.3B')).toBeInTheDocument(), {
        timeout: 4000,
      });
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
