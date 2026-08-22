/**
 * Activity: the history screen, and the one thing it must never go back to.
 *
 * 🚨 THE LOAD-BEARING ASSERTION IS THAT A ROW IS NOT A LINK. Every row used to
 * be an `<a target="_blank">` to Solscan. A popup closes when focus moves to a
 * new tab, so the natural gesture — tap the row to read it — destroyed the
 * screen, and there was no other way to see a signature or a fee. If a future
 * change makes the row an anchor again, `queryAllByRole('link')` on a collapsed
 * list stops being empty and this fails, which is the earliest possible
 * warning: the regression is invisible in a browser until someone taps.
 *
 * There was no test file here at all before 2026-08-23.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import Activity from './Activity';

const mockNavigate = vi.fn();
const mockFetchTransactions = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const TX_SENT = {
  signature: 'sig-sent-0001',
  type: 'send' as const,
  amount: 1.5,
  tokenSymbol: 'SOL',
  tokenMint: '',
  counterparty: 'AAAABBBBCCCCDDDD',
  timestamp: Date.now() - 60_000,
  status: 'confirmed' as const,
  isPrivate: false,
  fee: 0.000005,
};

const TX_RECEIVED = {
  signature: 'sig-recv-0002',
  type: 'receive' as const,
  amount: 2,
  tokenSymbol: 'SOL',
  tokenMint: '',
  timestamp: Date.now() - 120_000,
  status: 'pending' as const,
  isPrivate: true,
  fee: 0,
};

vi.mock('@/shared/store/wallet', () => ({
  useWalletStore: () => ({
    transactions: [TX_SENT, TX_RECEIVED],
    isLoadingTransactions: false,
    fetchTransactions: mockFetchTransactions,
    network: 'devnet',
  }),
}));

vi.mock('@/shared/services/price', () => ({
  getSolPrice: () => Promise.resolve(100),
}));

function renderActivity() {
  return render(
    <MemoryRouter>
      <Activity />
    </MemoryRouter>,
  );
}

describe('Activity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has a header naming the screen', () => {
    renderActivity();
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument();
  });

  it('offers a way back', () => {
    renderActivity();
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });

  it('does not make any row a link out of the popup', () => {
    renderActivity();
    // 🚨 Collapsed list: nothing here may navigate away.
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('expands a row in place, with the signature and the fee', () => {
    renderActivity();

    const row = screen.getByRole('button', { name: /Sent to/ });
    expect(row).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(row);

    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(TX_SENT.signature)).toBeInTheDocument();
    expect(screen.getByText(/Network fee 0\.000005 SOL/)).toBeInTheDocument();
  });

  it('puts the explorer behind one deliberate link inside the open row', () => {
    renderActivity();

    fireEvent.click(screen.getByRole('button', { name: /Sent to/ }));

    const link = screen.getByRole('link', { name: /Open in Solscan/ });
    expect(link).toHaveAttribute('href', expect.stringContaining(TX_SENT.signature));
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('opens one row at a time', () => {
    renderActivity();

    fireEvent.click(screen.getByRole('button', { name: /Sent to/ }));
    expect(screen.getByText(TX_SENT.signature)).toBeInTheDocument();

    // Named by its amount: "Received" alone also matches the filter chip.
    fireEvent.click(screen.getByRole('button', { name: /\+2\.0000 SOL/ }));
    expect(screen.queryByText(TX_SENT.signature)).not.toBeInTheDocument();
    expect(screen.getByText(TX_RECEIVED.signature)).toBeInTheDocument();
  });

  it('filters, and says so when the filter empties the list', () => {
    renderActivity();

    fireEvent.click(screen.getByRole('button', { name: 'Streams' }));

    expect(screen.queryByText(/Sent to/)).not.toBeInTheDocument();
    expect(screen.getByText('Nothing under this filter')).toBeInTheDocument();
  });

  it('refetches on demand', () => {
    renderActivity();

    mockFetchTransactions.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh transactions' }));

    expect(mockFetchTransactions).toHaveBeenCalled();
  });
});
