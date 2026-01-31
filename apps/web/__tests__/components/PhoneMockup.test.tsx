import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PhoneMockup from '@/components/PhoneMockup';

describe('PhoneMockup -- Mobile wallet app preview', () => {
  beforeEach(() => {
    render(<PhoneMockup />);
  });

  describe('Phone Frame', () => {
    it('renders the phone mockup container', () => {
      const { container } = render(<PhoneMockup />);
      expect(container.firstElementChild).toBeTruthy();
    });

    it('shows the status bar time "9:41"', () => {
      expect(screen.getByText('9:41')).toBeInTheDocument();
    });
  });

  describe('App Header', () => {
    it('displays the "01" logo mark in the app header', () => {
      expect(screen.getByText('01')).toBeInTheDocument();
    });

    it('displays "PROTOCOL 01" as the app name', () => {
      expect(screen.getByText('PROTOCOL 01')).toBeInTheDocument();
    });

    it('shows the "DEVNET" network badge', () => {
      expect(screen.getByText('DEVNET')).toBeInTheDocument();
    });
  });

  describe('Balance Display', () => {
    it('displays the wallet balance "$2,847.00" (shown in header and assets)', () => {
      const balances = screen.getAllByText('$2,847.00');
      expect(balances.length).toBeGreaterThanOrEqual(1);
    });

    it('shows the SOL balance "12.5 SOL"', () => {
      expect(screen.getByText('12.5 SOL')).toBeInTheDocument();
    });

    it('displays "Wallet Address" label', () => {
      expect(screen.getByText('Wallet Address')).toBeInTheDocument();
    });
  });

  describe('Action Buttons', () => {
    it('renders the "Send" action button (appears in actions and activity)', () => {
      const sends = screen.getAllByText('Send');
      expect(sends.length).toBeGreaterThanOrEqual(1);
    });

    it('renders the "Receive" action button', () => {
      expect(screen.getByText('Receive')).toBeInTheDocument();
    });

    it('renders the "Swap" action button', () => {
      expect(screen.getByText('Swap')).toBeInTheDocument();
    });

    it('renders the "Buy" action button', () => {
      expect(screen.getByText('Buy')).toBeInTheDocument();
    });
  });

  describe('Faucet Card', () => {
    it('displays "Get Test SOL" faucet option for devnet testing', () => {
      expect(screen.getByText('Get Test SOL')).toBeInTheDocument();
    });

    it('shows faucet instruction to receive 1 SOL', () => {
      expect(screen.getByText('Tap to receive 1 SOL from faucet')).toBeInTheDocument();
    });
  });

  describe('Assets Section', () => {
    it('shows the "ASSETS" section header', () => {
      expect(screen.getByText('ASSETS')).toBeInTheDocument();
    });

    it('displays Solana as an asset', () => {
      expect(screen.getByText('Solana')).toBeInTheDocument();
    });

    it('shows SOL token ticker', () => {
      expect(screen.getByText('SOL')).toBeInTheDocument();
    });

    it('displays the SOL balance of 12.5', () => {
      expect(screen.getByText('12.5')).toBeInTheDocument();
    });
  });

  describe('Recent Activity', () => {
    it('shows the "RECENT ACTIVITY" section header', () => {
      expect(screen.getByText('RECENT ACTIVITY')).toBeInTheDocument();
    });

    it('displays a "See All" button for full transaction history', () => {
      expect(screen.getByText('See All')).toBeInTheDocument();
    });

    it('shows a recent send transaction "-0.5 SOL"', () => {
      expect(screen.getByText('-0.5 SOL')).toBeInTheDocument();
    });

    it('shows a recent receive transaction "+1.2 SOL"', () => {
      expect(screen.getByText('+1.2 SOL')).toBeInTheDocument();
    });

    it('shows transaction timestamps', () => {
      expect(screen.getByText('2m ago')).toBeInTheDocument();
      expect(screen.getByText('1h ago')).toBeInTheDocument();
    });
  });

  describe('Bottom Navigation', () => {
    it('renders the "Wallet" tab', () => {
      expect(screen.getByText('Wallet')).toBeInTheDocument();
    });

    it('renders the "Streams" tab for subscription payments', () => {
      expect(screen.getByText('Streams')).toBeInTheDocument();
    });

    it('renders the "Agent" tab for AI-powered transactions', () => {
      expect(screen.getByText('Agent')).toBeInTheDocument();
    });
  });
});
