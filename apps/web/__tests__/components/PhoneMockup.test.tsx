import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import PhoneMockup from '@/components/PhoneMockup';

describe('PhoneMockup -- Mobile wallet app preview', () => {
  beforeEach(() => {
    render(<PhoneMockup />);
  });

  describe('Phone Frame', () => {
    it('renders the phone mockup container', () => {
      const { container } = render(<PhoneMockup />);
      expect(container.querySelector('.phone-container')).toBeTruthy();
    });

    it('shows the status bar time "9:41"', () => {
      expect(screen.getByText('9:41')).toBeInTheDocument();
    });
  });

  describe('App Header', () => {
    // The styled "01" square logo mark was replaced by the real 01-miku
    // wordmark image (see the component's own header comment: "Real 01-miku
    // wordmark image header (not a styled '01' square)").
    it('renders the 01-miku wordmark image in the app header', () => {
      const wordmark = screen.getByAltText('Protocol 01');
      expect(wordmark).toBeInTheDocument();
      expect(wordmark).toHaveAttribute('src', '/01-miku.png');
    });

    it('displays "PROTOCOL 01" as the app name', () => {
      expect(screen.getByText('PROTOCOL 01')).toBeInTheDocument();
    });

    it('shows the "DEVNET" network badge', () => {
      expect(screen.getByText('DEVNET')).toBeInTheDocument();
    });
  });

  describe('Balance Display', () => {
    it('displays the wallet balance "$2,847.63" in the balance card and the Solana asset row', () => {
      // The balance card splits the cents into a smaller nested span, so the
      // dollars and the cents are separate text nodes of the same <p>.
      const totalBalance = screen.getByText('$2,847');
      expect(totalBalance.textContent).toBe('$2,847.63');
      // The Solana asset row repeats the same fiat value as one text node.
      expect(screen.getByText('$2,847.63')).toBeInTheDocument();
    });

    it('shows the SOL balance "12.5000 SOL" under the total', () => {
      expect(screen.getByText('12.5000 SOL')).toBeInTheDocument();
    });

    // The "Wallet Address" row was dropped in the redesign; the same slot now
    // carries the Privacy Summary Pill mirrored from the mobile app.
    it('shows the private balance pill with the shielded amount', () => {
      expect(screen.getByText('Private balance')).toBeInTheDocument();
      // "SOL" sits in a nested span, so match the amount node and assert the
      // full composed value.
      const shielded = screen.getByText('3.2000');
      expect(shielded.textContent).toBe('3.2000 SOL');
    });
  });

  describe('Action Buttons', () => {
    it('renders the "Send" action button', () => {
      expect(screen.getByText('Send')).toBeInTheDocument();
    });

    it('renders the "Receive" action button', () => {
      expect(screen.getByText('Receive')).toBeInTheDocument();
    });

    it('renders the "Swap" action button', () => {
      expect(screen.getByText('Swap')).toBeInTheDocument();
    });
  });

  describe('Assets Section', () => {
    it('shows the "ASSETS" section header', () => {
      expect(screen.getByText('ASSETS')).toBeInTheDocument();
    });

    it('displays Solana as an asset', () => {
      expect(screen.getByText('Solana')).toBeInTheDocument();
    });

    it('shows the SOL ticker on the Solana asset row', () => {
      // "SOL" also renders inside the private balance pill ("3.2000 SOL"), so
      // scope the lookup to the Solana row rather than the whole screen.
      const solanaCell = screen.getByText('Solana').parentElement!;
      expect(within(solanaCell).getByText('SOL')).toBeInTheDocument();
    });

    it('displays the SOL balance of 12.5000', () => {
      expect(screen.getByText('12.5000')).toBeInTheDocument();
    });

    it('displays USD Coin and Bonk as the other assets', () => {
      expect(screen.getByText('USD Coin')).toBeInTheDocument();
      expect(screen.getByText('Bonk')).toBeInTheDocument();
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
      expect(screen.getByText('Sent SOL')).toBeInTheDocument();
      expect(screen.getByText('-0.5 SOL')).toBeInTheDocument();
    });

    it('shows a recent receive transaction "+1.0 SOL"', () => {
      expect(screen.getByText('Received SOL')).toBeInTheDocument();
      expect(screen.getByText('+1.0 SOL')).toBeInTheDocument();
    });

    it('shows a shield transaction "-2.0 SOL"', () => {
      expect(screen.getByText('Shield')).toBeInTheDocument();
      expect(screen.getByText('-2.0 SOL')).toBeInTheDocument();
    });

    it('shows transaction counterparty and timestamp on one meta line', () => {
      // ActivityRow renders `{to} · {time}` inside a single <p>, so the
      // timestamp is only ever visible as part of that composed line.
      expect(screen.getByText('to 7xM4...kR2p · 2m ago')).toBeInTheDocument();
      expect(screen.getByText('from Faucet · 15m ago')).toBeInTheDocument();
      expect(screen.getByText('ZK Pool · 1h ago')).toBeInTheDocument();
    });
  });

  describe('Bottom Navigation', () => {
    it('renders the "Wallet" tab', () => {
      expect(screen.getByText('Wallet')).toBeInTheDocument();
    });

    it('renders the "Privacy" tab', () => {
      expect(screen.getByText('Privacy')).toBeInTheDocument();
    });

    it('renders the "Streams" tab for subscription payments', () => {
      expect(screen.getByText('Streams')).toBeInTheDocument();
    });

    it('renders the "Agent" tab for AI-powered transactions', () => {
      expect(screen.getByText('Agent')).toBeInTheDocument();
    });
  });
});
