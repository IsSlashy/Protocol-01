/**
 * Tests for Home page (main dashboard)
 *
 * The Home page is the primary view of the Protocol 01 wallet, displaying:
 * - Wallet header with PROTOCOL branding and DEVNET badge
 * - Balance card with USD value and SOL amount
 * - Action buttons (Send, Receive, Swap, Buy)
 * - Shielded Wallet card (ZK-protected privacy)
 * - Devnet faucet card (test SOL)
 * - Assets section with SOL and SPL tokens
 * - Recent Activity section with transaction history
 *
 * Validates:
 * - Balance display and formatting
 * - Action button navigation
 * - Shielded wallet card rendering
 * - Faucet card on devnet
 * - Transaction list rendering
 * - Loading states
 * - Copy address functionality
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Home from './Home';
import { createMockTransaction } from '../../__tests__/helpers';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockRefreshBalance = vi.fn();
const mockRequestFaucet = vi.fn();
const mockFetchTransactions = vi.fn();

vi.mock('@/shared/store/wallet', () => ({
  useWalletStore: () => ({
    publicKey: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    solBalance: 12.3456,
    tokens: [
      {
        mint: 'TokenMint123',
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6,
        balance: 100000000,
        uiBalance: '100.00',
      },
    ],
    network: 'devnet',
    isRefreshing: false,
    isUnlocked: true,
    refreshBalance: mockRefreshBalance,
    requestFaucet: mockRequestFaucet,
    transactions: [
      createMockTransaction({ type: 'send', amount: 2.5 }),
      createMockTransaction({
        type: 'receive',
        amount: 5.0,
        signature: 'rx-sig-1',
        counterparty: 'SenderAddr123',
      }),
    ],
    isLoadingTransactions: false,
    fetchTransactions: mockFetchTransactions,
  }),
}));

vi.mock('@/shared/store/settings', () => ({
  useSettingsStore: () => ({ shieldedWalletEnabled: true, initialize: vi.fn() }),
}));

vi.mock('@/shared/store/shielded', () => ({
  useShieldedStore: () => ({
    shieldedBalance: 1.5,
    isInitialized: true,
  }),
}));

vi.mock('@/shared/services/transactions', () => ({
  getSolscanUrl: (type: string, id: string, network: string) =>
    `https://solscan.io/${type}/${id}?cluster=${network}`,
}));

vi.mock('@/shared/services/price', () => ({
  getSolPrice: vi.fn(() => Promise.resolve(175.0)),
}));

vi.mock('@/shared/utils', () => ({
  formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
  truncateAddress: (addr: string, chars: number) =>
    `${addr.slice(0, chars)}...${addr.slice(-chars)}`,
  copyToClipboard: vi.fn(() => Promise.resolve(true)),
  formatRelativeTime: () => '2h ago',
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));

describe('Home', () => {
  /**
   * 🎯 REWRITTEN WITH THE SCREEN, 2026-08-23. Every assertion below replaces
   * one that pinned copy the redesign deliberately changed. What each one was
   * CHECKING is preserved; only the string moved. The two exceptions are noted
   * where they appear, because they pin behaviour the old screen got wrong
   * rather than behaviour it got right.
   */
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const view = () =>
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>,
    );

  it('renders the Styx wordmark', () => {
    // Was "renders the PROTOCOL header". The header said PROTOCOL in a bold
    // display face beside a separate 01 raster; both are retired.
    view();
    expect(screen.getByLabelText('Styx')).toBeInTheDocument();
    expect(screen.getByText('Styx')).toBeInTheDocument();
  });

  it('shows the devnet chip when on devnet', () => {
    view();
    expect(screen.getByText(/devnet/i)).toBeInTheDocument();
  });

  it('displays the SOL balance', () => {
    // ⚠️ Twice on purpose, and the test says so rather than picking one: the
    // hero states the balance and the asset row repeats it as a holding. A
    // wallet that shows a total and then omits it from the list reads as if
    // something is missing.
    view();
    expect(screen.getAllByText('12.3456')).toHaveLength(2);
  });

  it('offers four actions, and Shield is one of them', () => {
    // Was "renders the three action buttons" (Send, Receive, Swap). Swap is
    // parked; Shield and Subscribe are the product.
    view();
    expect(screen.getByRole('button', { name: /^Send$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Receive$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Shield$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Subscribe$/i })).toBeInTheDocument();
  });

  it('navigates to /send', () => {
    view();
    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/send');
  });

  it('navigates to /receive', () => {
    view();
    fireEvent.click(screen.getByRole('button', { name: /^Receive$/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/receive');
  });

  it('sends Shield to the shield tab, not to a dashboard about it', () => {
    // Was "navigates to /swap". The route it replaces is the one the old
    // screen reached in two taps through an intermediate dashboard.
    view();
    fireEvent.click(screen.getByRole('button', { name: /^Shield$/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/shield');
  });

  it('has an entry point to subscriptions, which it did not before', () => {
    // 🚨 NEW, AND IT PINS A GAP RATHER THAN A RENAME. Under a merchant
    // subscription pivot the home screen mentioned subscriptions nowhere: the
    // tab bar was the only way in.
    view();
    fireEvent.click(screen.getByRole('button', { name: /^Subscribe$/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/discover');
    expect(screen.getByText(/Pay a merchant without an account/i)).toBeInTheDocument();
  });

  it('shows one private balance strip, reporting the shielded balance', () => {
    // Was two cards pointing at the same screen, one of which advertised
    // itself as a dead end.
    view();
    expect(screen.getByText('Private balance')).toBeInTheDocument();
    expect(screen.getByText(/1\.50 SOL shielded/)).toBeInTheDocument();
    expect(screen.queryByText(/Legacy/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no exit/i)).not.toBeInTheDocument();
  });

  it('opens the shield tab from the private balance strip', () => {
    view();
    fireEvent.click(screen.getByText('Private balance'));
    expect(mockNavigate).toHaveBeenCalledWith('/shield');
  });

  it('offers the devnet faucet without giving it a card above the product', () => {
    view();
    expect(screen.getByRole('button', { name: /Get test SOL/i })).toBeInTheDocument();
  });

  it('lists assets', () => {
    view();
    expect(screen.getByText('Assets')).toBeInTheDocument();
    // "SOL" is both the hero's unit and the asset's name, so the row is
    // identified by the thing only the row has.
    expect(screen.getByText('Solana')).toBeInTheDocument();
  });

  it('lists SPL tokens without inventing a fiat value for them', () => {
    // 🚨 NEW BEHAVIOUR, NOT A RENAME. Every token row used to print "$0.00" as
    // its fiat value. It was hardcoded and shown as fact.
    view();
    expect(screen.getByText('USDC')).toBeInTheDocument();
    expect(screen.getByText('100.00')).toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('renders recent activity', () => {
    view();
    expect(screen.getByText('Recent activity')).toBeInTheDocument();
  });

  it('navigates to /activity from See all', () => {
    view();
    fireEvent.click(screen.getByText(/See all/i));
    expect(mockNavigate).toHaveBeenCalledWith('/activity');
  });

  it('navigates to /settings', () => {
    view();
    fireEvent.click(screen.getByLabelText('Settings'));
    expect(mockNavigate).toHaveBeenCalledWith('/settings');
  });

  it('calls refreshBalance and fetchTransactions on mount', () => {
    view();
    expect(mockRefreshBalance).toHaveBeenCalled();
    expect(mockFetchTransactions).toHaveBeenCalled();
  });

  it('shows the truncated address behind a single copy control', () => {
    // 🚨 ONE, not two. The old screen had a copy button in the header and
    // another in the balance card, eight lines apart, firing the same handler.
    view();
    const copies = screen.getAllByLabelText(/Copy wallet address/i);
    expect(copies).toHaveLength(1);
    expect(screen.getByText('7xKX...gAsU')).toBeInTheDocument();
  });
});
