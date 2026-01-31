import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SDKDemoPage from '@/app/sdk-demo/page';

// The SDK Demo page uses its own internal P01WalletProvider, not the global one
// so we need to mock window.protocol01

describe('SDKDemoPage -- Developer SDK playground and widget showcase', () => {
  beforeEach(() => {
    // Reset window.protocol01 to not installed state
    delete (window as Record<string, unknown>).protocol01;
    render(<SDKDemoPage />);
  });

  describe('Page Header', () => {
    it('displays the "P-01" brand link to homepage', () => {
      expect(screen.getByText('P-01')).toBeInTheDocument();
      const brandLink = screen.getByText('P-01').closest('a');
      expect(brandLink).toHaveAttribute('href', '/');
    });

    it('shows "SDK Demo" page title', () => {
      expect(screen.getByText('SDK Demo')).toBeInTheDocument();
    });

    it('displays "100% Serverless" badge', () => {
      expect(screen.getByText('100% Serverless')).toBeInTheDocument();
    });

    it('displays "On-chain verification" badge', () => {
      expect(screen.getByText('On-chain verification')).toBeInTheDocument();
    });
  });

  describe('Tab Navigation', () => {
    it('renders the "Devnet" tab', () => {
      expect(screen.getByText('Devnet')).toBeInTheDocument();
    });

    it('renders the "Stream SDK" tab', () => {
      expect(screen.getByText('Stream SDK')).toBeInTheDocument();
    });

    it('renders the "Widgets" tab', () => {
      expect(screen.getByText('Widgets')).toBeInTheDocument();
    });

    it('renders the "Buttons" tab', () => {
      expect(screen.getByText('Buttons')).toBeInTheDocument();
    });

    it('renders the "Cards" tab', () => {
      expect(screen.getByText('Cards')).toBeInTheDocument();
    });

    it('starts with the Devnet tab active by default', () => {
      // Devnet section content should be visible
      expect(screen.getByText('Devnet Testing')).toBeInTheDocument();
    });

    it('switches to Stream SDK tab when clicked', async () => {
      const user = userEvent.setup();
      await user.click(screen.getByText('Stream SDK'));
      expect(screen.getByText(/Stream Payments/)).toBeInTheDocument();
    });
  });

  describe('Devnet Section -- Wallet Connection', () => {
    it('shows "Connect Wallet" as the first step', () => {
      expect(screen.getByText('1. Connect Wallet')).toBeInTheDocument();
    });

    it('shows "Protocol 01 wallet not detected" when extension is not installed', () => {
      expect(screen.getByText('Protocol 01 wallet not detected')).toBeInTheDocument();
    });

    it('shows installation hint when wallet is not available', () => {
      expect(screen.getByText(/Make sure the extension is installed and enabled/)).toBeInTheDocument();
    });
  });

  describe('Tab Switching', () => {
    it('shows Widgets section content when Widgets tab is clicked', async () => {
      const user = userEvent.setup();
      await user.click(screen.getByText('Widgets'));
      expect(screen.getByText(/Subscription Widget/)).toBeInTheDocument();
    });

    it('shows Buttons section content when Buttons tab is clicked', async () => {
      const user = userEvent.setup();
      await user.click(screen.getByText('Buttons'));
      expect(screen.getByText(/Wallet Button/)).toBeInTheDocument();
    });

    it('shows Cards section content when Cards tab is clicked', async () => {
      const user = userEvent.setup();
      await user.click(screen.getByText('Cards'));
      expect(screen.getByText(/Subscription Card/)).toBeInTheDocument();
    });
  });
});
