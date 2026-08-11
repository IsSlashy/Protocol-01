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
    // The shared header is now <StyxHeader />, whose wordmark is "Styx" plus a
    // "Protocol" suffix in two nodes, labelled "Styx Protocol, home". The old
    // single "PROTOCOL 01" text node no longer exists anywhere in the tree.
    // Still scoped to the banner, because the footer repeats the wordmark.
    it('displays the Styx Protocol brand link to homepage', () => {
      const header = screen.getByRole('banner');
      const brand = within(header).getByRole('link', { name: 'Styx Protocol, home' });
      expect(brand).toHaveAttribute('href', '/');
      expect(within(brand).getByText('Styx')).toBeInTheDocument();
      expect(within(brand).getByText('Protocol')).toBeInTheDocument();
    });

    // "SDK Demo" is also a footer link (footer.sdkDemo), so this pins the <h1>.
    it('shows "SDK Demo" page title', () => {
      expect(screen.getByRole('heading', { level: 1, name: 'SDK Demo' })).toBeInTheDocument();
    });

    it('shows the "Developer Preview" hero kicker', () => {
      expect(screen.getByText('Developer Preview')).toBeInTheDocument();
    });

    // Was the "100% Serverless" badge (sdkDemo.serverless). Deleted from the
    // page on 2026-08-11, not restyled: the developer access form in the same
    // file POSTs to /api/whitelist and mirrors the request to a Discord
    // webhook, so the badge contradicted its own page. The hero now wears
    // sdkDemo.beta, and this pins that chip so a silent drop still fails.
    it('displays the "Beta" badge', () => {
      expect(screen.getByText('Beta')).toBeInTheDocument();
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
