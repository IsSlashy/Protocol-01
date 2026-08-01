import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SDKDemoPage from '@/app/sdk-demo/page';

// The SDK Demo page uses its own internal P01WalletProvider, not the global one
// so we need to mock window.protocol01

describe('SDKDemoPage -- Developer SDK playground and widget showcase', () => {
  beforeEach(() => {
    // Reset window.protocol01 to not installed state
    delete (window as unknown as Record<string, unknown>).protocol01;
    render(<SDKDemoPage />);
  });

  describe('Page Header', () => {
    // The page-local header was replaced by the shared <SiteHeader />, whose
    // wordmark is "PROTOCOL 01" (next to the /icon.png logo), not "P-01".
    // Scoped to the banner because the footer repeats the wordmark twice.
    it('displays the "PROTOCOL 01" brand link to homepage', () => {
      const header = screen.getByRole('banner');
      const brand = within(header).getByText('PROTOCOL 01');
      expect(brand).toBeInTheDocument();
      expect(brand.closest('a')).toHaveAttribute('href', '/');
    });

    // "SDK Demo" is also a footer link (footer.sdkDemo), so this pins the <h1>.
    it('shows "SDK Demo" page title', () => {
      expect(screen.getByRole('heading', { level: 1, name: 'SDK Demo' })).toBeInTheDocument();
    });

    it('shows the "Developer Preview" hero kicker', () => {
      expect(screen.getByText('Developer Preview')).toBeInTheDocument();
    });

    it('displays "100% Serverless" badge', () => {
      expect(screen.getByText('100% Serverless')).toBeInTheDocument();
    });

    it('displays "On-chain verification" badge', () => {
      expect(screen.getByText('On-chain verification')).toBeInTheDocument();
    });
  });

  describe('Tab Navigation', () => {
    // "Devnet" is rendered twice: as the network badge in the hero and as the
    // tab label. Query the tab by its button role so this still fails if the
    // tab is renamed or dropped.
    it('renders the "Devnet" tab', () => {
      expect(screen.getByRole('button', { name: 'Devnet' })).toBeInTheDocument();
    });

    // Tab added after this suite was written (Privacy SDKs section).
    it('renders the "Privacy SDKs" tab', () => {
      expect(screen.getByRole('button', { name: 'Privacy SDKs' })).toBeInTheDocument();
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
