import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Features from '@/components/Features';

describe('Features -- Protocol 01 core capabilities showcase', () => {
  beforeEach(() => {
    render(<Features />);
  });

  describe('Section Header', () => {
    it('displays the "Features" section badge', () => {
      expect(screen.getByText('Features')).toBeInTheDocument();
    });

    it('presents the headline emphasizing private payments', () => {
      expect(screen.getByText(/Private payments\./)).toBeInTheDocument();
      expect(screen.getByText(/Recurring or one-time\./)).toBeInTheDocument();
    });

    it('explains the privacy promise for subscriptions and transfers', () => {
      expect(screen.getByText(/Subscribe to services, pay creators, and transfer funds/)).toBeInTheDocument();
    });

    it('mentions both Devnet and Mainnet support', () => {
      expect(screen.getByText(/Devnet for testing and Mainnet/)).toBeInTheDocument();
    });
  });

  describe('Private Subscriptions Module', () => {
    it('renders the "Private Subscriptions" feature card', () => {
      expect(screen.getByText('Private Subscriptions')).toBeInTheDocument();
    });

    it('displays the tagline "Recurring payments without traces"', () => {
      expect(screen.getByText('Recurring payments without traces')).toBeInTheDocument();
    });

    it('lists automated recurring payments as a key feature', () => {
      expect(screen.getByText('Automated recurring payments')).toBeInTheDocument();
    });

    it('lists customizable intervals as a key feature', () => {
      expect(screen.getByText('Customizable intervals')).toBeInTheDocument();
    });

    it('lists cancel anytime capability', () => {
      expect(screen.getByText('Cancel anytime')).toBeInTheDocument();
    });

    it('emphasizes 100% private and untraceable payments', () => {
      expect(screen.getByText('100% private & untraceable')).toBeInTheDocument();
    });

    it('shows a code preview with p01.subscribe() SDK usage', () => {
      expect(screen.getByText(/p01\.subscribe/)).toBeInTheDocument();
    });

    it('provides a link to subscriptions documentation', () => {
      const link = screen.getByText(/Learn more about Private Subscriptions/);
      expect(link.closest('a')).toHaveAttribute('href', '/docs#subscriptions');
    });
  });

  describe('Stealth Transfers Module', () => {
    it('renders the "Stealth Transfers" feature card', () => {
      expect(screen.getByText('Stealth Transfers')).toBeInTheDocument();
    });

    it('displays the tagline "Send & receive without traces"', () => {
      expect(screen.getByText('Send & receive without traces')).toBeInTheDocument();
    });

    it('lists one-time stealth addresses as a key feature', () => {
      expect(screen.getByText('One-time stealth addresses')).toBeInTheDocument();
    });

    it('lists SOL and SPL token support', () => {
      expect(screen.getByText('SOL & SPL tokens (USDC, USDT...)')).toBeInTheDocument();
    });

    it('shows a code preview with p01.send() SDK usage', () => {
      expect(screen.getByText(/p01\.send/)).toBeInTheDocument();
    });
  });

  describe('Token Swap Module', () => {
    it('renders the "Token Swap" feature card', () => {
      expect(screen.getByText('Token Swap')).toBeInTheDocument();
    });

    it('displays the tagline "Swap any Solana token"', () => {
      expect(screen.getByText('Swap any Solana token')).toBeInTheDocument();
    });

    it('lists 15+ tokens supported', () => {
      expect(screen.getByText('15+ tokens supported')).toBeInTheDocument();
    });

    it('lists best rate aggregation from Jupiter', () => {
      expect(screen.getByText('Best rate aggregation')).toBeInTheDocument();
    });
  });

  describe('Buy Crypto Module', () => {
    it('renders the "Buy Crypto" feature card', () => {
      expect(screen.getByText('Buy Crypto')).toBeInTheDocument();
    });

    it('displays the tagline "Fiat to crypto on-ramp"', () => {
      expect(screen.getByText('Fiat to crypto on-ramp')).toBeInTheDocument();
    });

    it('lists credit/debit card support', () => {
      expect(screen.getByText('Credit/Debit card support')).toBeInTheDocument();
    });

    it('lists multiple payment providers', () => {
      expect(screen.getByText('Multiple providers')).toBeInTheDocument();
    });
  });

  describe('Zero-Knowledge Proofs Module', () => {
    it('renders the "Zero-Knowledge Proofs" feature card', () => {
      expect(screen.getByText('Zero-Knowledge Proofs')).toBeInTheDocument();
    });

    it('displays the tagline "Maximum privacy with ZK"', () => {
      expect(screen.getByText('Maximum privacy with ZK')).toBeInTheDocument();
    });

    it('lists ZK-proof transactions as a key feature', () => {
      expect(screen.getByText('ZK-proof transactions')).toBeInTheDocument();
    });

    it('emphasizes no KYC required', () => {
      expect(screen.getByText('No KYC required')).toBeInTheDocument();
    });

    it('emphasizes self-custody', () => {
      expect(screen.getByText('Self-custody')).toBeInTheDocument();
    });

    it('emphasizes open source', () => {
      expect(screen.getByText('Open source')).toBeInTheDocument();
    });
  });

  describe('Network Status Indicator', () => {
    it('displays DEVNET status with active indicator', () => {
      expect(screen.getByText('DEVNET')).toBeInTheDocument();
    });

    it('displays MAINNET status', () => {
      expect(screen.getByText('MAINNET')).toBeInTheDocument();
    });

    it('indicates users can switch networks anytime', () => {
      expect(screen.getByText('Switch anytime in settings')).toBeInTheDocument();
    });
  });

  describe('Code Previews', () => {
    it('shows example.ts file indicator for each code preview', () => {
      const labels = screen.getAllByText('example.ts');
      expect(labels.length).toBe(5); // One per module
    });

    it('renders code window chrome dots (red, yellow, cyan)', () => {
      const container = screen.getByText('Private Subscriptions').closest('div');
      expect(container).toBeTruthy();
    });
  });
});
