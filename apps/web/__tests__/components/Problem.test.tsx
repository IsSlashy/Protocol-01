import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
      expect(screen.getByText(/Traditional blockchains offer pseudonymity, not privacy/)).toBeInTheDocument();
    });
  });

  describe('Privacy Threat Statistics', () => {
    it('displays "100%" statistic -- all blockchain transactions are public', () => {
      expect(screen.getByText('of blockchain transactions are public')).toBeInTheDocument();
    });

    it('displays "73%" statistic -- users deanonymized by analytics', () => {
      expect(screen.getByText('73%')).toBeInTheDocument();
      expect(screen.getByText('of users have been deanonymized')).toBeInTheDocument();
    });

    it('displays "24/7" statistic -- constant government surveillance', () => {
      expect(screen.getByText('24/7')).toBeInTheDocument();
      expect(screen.getByText('surveillance by governments & corporations')).toBeInTheDocument();
    });

    it('displays "$4.3B" statistic -- money stolen through wallet tracking', () => {
      expect(screen.getByText('$4.3B')).toBeInTheDocument();
      expect(screen.getByText('stolen through wallet tracking')).toBeInTheDocument();
    });
  });

  describe('Before/After Comparison', () => {
    it('shows the "WITHOUT PROTOCOL 01" exposed state', () => {
      expect(screen.getByText('WITHOUT PROTOCOL 01')).toBeInTheDocument();
    });

    it('shows the "WITH PROTOCOL 01" protected state', () => {
      expect(screen.getByText('WITH PROTOCOL 01')).toBeInTheDocument();
    });

    it('demonstrates exposed transaction data in "without" scenario', () => {
      expect(screen.getByText(/7xK9f...8c2e sent 100 SOL/)).toBeInTheDocument();
      expect(screen.getByText(/7xK9f...8c2e = John Smith/)).toBeInTheDocument();
    });

    it('shows "Identity Exposed" warning for unprotected transactions', () => {
      expect(screen.getByText(/Identity Exposed/)).toBeInTheDocument();
    });

    it('shows "Fully Anonymous - Zero knowledge" for protected transactions', () => {
      expect(screen.getByText(/Fully Anonymous - Zero knowledge/)).toBeInTheDocument();
    });
  });

  describe('Threat Descriptions', () => {
    it('warns about permanent public recording of transfers', () => {
      expect(screen.getByText('Every transfer you make is permanently recorded and visible to anyone')).toBeInTheDocument();
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
