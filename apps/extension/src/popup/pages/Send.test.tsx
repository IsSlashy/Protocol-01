/**
 * Tests for the Send page.
 *
 * ⚠️ REWRITTEN WITH THE MERGE OF SendConfirm INTO Send (UI pass, 2026-08-23).
 * The old suite pinned the copy of a two-screen flow: "SEND SOL", "CONTINUE",
 * "[ DEVNET ]", "AVAILABLE BALANCE" and the mono-capital labels. CONTINUE no
 * longer exists — the button signs and broadcasts from this screen — so the
 * expectations move with it rather than being deleted.
 *
 * Still covered, one for one with the old file:
 * - the form renders (balance, both fields, percentage shortcuts, fee)
 * - each validation failure appears, and now under its own field
 * - stealth detection on the "st:" prefix, and the button label that follows
 * - back navigation
 *
 * New, because the behaviour is new:
 * - pressing the button actually calls sendTransaction
 * - a stealth send carries an on-chain memo
 * - success returns to the wallet instead of a full-screen Done page
 * - a failed send reports under the button
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Send from './Send';
import { MOCK_RECIPIENT } from '../../__tests__/helpers';

const mockNavigate = vi.fn();
const mockSendTransaction = vi.fn(() => Promise.resolve('SIG123'));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('@/shared/store/wallet', () => ({
  useWalletStore: () => ({
    solBalance: 5.0,
    network: 'devnet',
    publicKey: 'DRtXHDgC312wpNdNCSb8vCoXDcofCJcPHdAynHjnB5eY',
    isLoading: false,
    error: null,
    sendTransaction: mockSendTransaction,
  }),
}));

vi.mock('@/shared/services/wallet', () => ({
  isValidSolanaAddress: (addr: string) => {
    // Simulate valid Solana address (base58, 32-44 chars)
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
  },
}));

vi.mock('@/shared/services/stealth', () => ({
  parseMetaAddress: vi.fn((addr: string) => {
    if (addr === 'st:01valid_stealth_meta_address_long_enough') {
      return { viewKey: 'view', spendKey: 'spend' };
    }
    throw new Error('Invalid meta-address');
  }),
  generateStealthAddress: vi.fn(() =>
    Promise.resolve({
      stealthAddress: { toBase58: () => 'StealthAddr123' },
      ephemeralPubKey: new Uint8Array(32),
    }),
  ),
  createStealthMemo: vi.fn(() => 'stealth-memo'),
}));

vi.mock('@/shared/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));

const STEALTH_META = 'st:01valid_stealth_meta_address_long_enough';
const RECIPIENT_PLACEHOLDER = 'Address or st:… meta-address';

function renderSend() {
  return render(
    <MemoryRouter>
      <Send />
    </MemoryRouter>,
  );
}

const recipientInput = () => screen.getByPlaceholderText(RECIPIENT_PLACEHOLDER);
const amountInput = () => screen.getByPlaceholderText('0.00');
const sendButton = () => screen.getByRole('button', { name: /^Send( privately)?$/ });

describe('Send', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendTransaction.mockResolvedValue('SIG123');
  });

  it('renders the Send heading', () => {
    renderSend();

    expect(screen.getByRole('heading', { name: 'Send' })).toBeInTheDocument();
  });

  it('shows available balance', () => {
    renderSend();

    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.getByText('5.0000')).toBeInTheDocument();
  });

  it('displays the devnet marker', () => {
    renderSend();

    expect(screen.getByText('Devnet')).toBeInTheDocument();
  });

  it('renders recipient and amount input fields', () => {
    renderSend();

    expect(screen.getByLabelText('Recipient')).toBeInTheDocument();
    expect(screen.getByLabelText('Amount')).toBeInTheDocument();
    expect(recipientInput()).toBeInTheDocument();
    expect(amountInput()).toBeInTheDocument();
  });

  it('renders percentage buttons (25%, 50%, 75%, 100%)', () => {
    renderSend();

    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('sets the amount to the correct percentage when a percent button is clicked', () => {
    renderSend();

    // 50% of (5.0 - 0.001 fee reserve) = 2.4995
    fireEvent.click(screen.getByText('50%'));

    const value = parseFloat((amountInput() as HTMLInputElement).value);
    expect(value).toBeCloseTo(2.4995, 3);
  });

  it('shows the network fee exactly once', () => {
    renderSend();

    expect(screen.getByText('Network fee')).toBeInTheDocument();
    // ⚠️ getAllByText, deliberately: the two-screen flow printed this constant
    // three times. One occurrence is the requirement, not an implementation
    // detail.
    expect(screen.getAllByText('~0.000005 SOL')).toHaveLength(1);
  });

  it('keeps the send button disabled when inputs are empty', () => {
    renderSend();

    expect(sendButton()).toBeDisabled();
  });

  it('leaves the recipient empty until it is typed into', () => {
    renderSend();

    fireEvent.change(amountInput(), { target: { value: '1.0' } });

    expect((recipientInput() as HTMLInputElement).value).toBe('');
  });

  it('shows error for insufficient balance', async () => {
    renderSend();

    fireEvent.change(recipientInput(), { target: { value: MOCK_RECIPIENT } });
    fireEvent.change(amountInput(), { target: { value: '999' } });
    fireEvent.click(sendButton());

    await waitFor(() => {
      expect(screen.getByText('Insufficient balance')).toBeInTheDocument();
    });
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it('shows error for invalid Solana address', async () => {
    renderSend();

    fireEvent.change(recipientInput(), { target: { value: 'invalid_address!' } });
    fireEvent.change(amountInput(), { target: { value: '1.0' } });
    fireEvent.click(sendButton());

    await waitFor(() => {
      expect(screen.getByText('Invalid Solana address')).toBeInTheDocument();
    });
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it('shows error for zero or negative amounts', async () => {
    renderSend();

    fireEvent.change(recipientInput(), { target: { value: MOCK_RECIPIENT } });
    fireEvent.change(amountInput(), { target: { value: '0' } });
    fireEvent.click(sendButton());

    await waitFor(() => {
      expect(screen.getByText('Please enter a valid amount')).toBeInTheDocument();
    });
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it('detects stealth address when input starts with "st:"', async () => {
    renderSend();

    fireEvent.change(recipientInput(), { target: { value: STEALTH_META } });

    await waitFor(() => {
      expect(screen.getByText(/fresh address derived for this payment alone/)).toBeInTheDocument();
    });
  });

  it('labels the button "Send privately" for valid stealth addresses', async () => {
    renderSend();

    fireEvent.change(recipientInput(), { target: { value: STEALTH_META } });
    fireEvent.change(amountInput(), { target: { value: '1.0' } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send privately' })).toBeInTheDocument();
    });
  });

  it('signs and broadcasts from this screen, then returns to the wallet', async () => {
    renderSend();

    fireEvent.change(recipientInput(), { target: { value: MOCK_RECIPIENT } });
    fireEvent.change(amountInput(), { target: { value: '1.5' } });
    fireEvent.click(sendButton());

    await waitFor(() => {
      expect(mockSendTransaction).toHaveBeenCalledWith(MOCK_RECIPIENT, 1.5, undefined);
    });
    // ⛔ No full-screen success page with a Done button.
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('sends a stealth payment to the derived address with its memo', async () => {
    renderSend();

    fireEvent.change(recipientInput(), { target: { value: STEALTH_META } });
    fireEvent.change(amountInput(), { target: { value: '1.0' } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send privately' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send privately' }));

    await waitFor(() => {
      expect(mockSendTransaction).toHaveBeenCalledWith('StealthAddr123', 1.0, 'stealth-memo');
    });
  });

  it('reports a failed send under the button and stays put', async () => {
    mockSendTransaction.mockRejectedValueOnce(new Error('Blockhash not found'));
    renderSend();

    fireEvent.change(recipientInput(), { target: { value: MOCK_RECIPIENT } });
    fireEvent.change(amountInput(), { target: { value: '1.0' } });
    fireEvent.click(sendButton());

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Blockhash not found');
    });
    expect(mockNavigate).not.toHaveBeenCalledWith('/');
  });

  it('navigates back when the back button is clicked', () => {
    renderSend();

    fireEvent.click(screen.getByLabelText('Go back'));

    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });
});
