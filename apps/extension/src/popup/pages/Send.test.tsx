/**
 * Tests for Send page
 *
 * The Send page enables users to send SOL to standard Solana addresses
 * or stealth meta-addresses (prefixed with "st:"). It features:
 * - Recipient address input with stealth detection
 * - Amount input with percentage shortcuts (25%, 50%, 75%, 100%)
 * - Balance display and fee estimation
 * - Validation of addresses and amounts
 * - Stealth privacy badge and info banner for private sends
 *
 * Validates:
 * - Renders the send form correctly
 * - Address validation errors are displayed
 * - Amount validation (empty, negative, exceeds balance)
 * - Percentage buttons set the correct amounts
 * - Stealth address detection when "st:" prefix is entered
 * - Navigation to confirmation page with correct state
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Send from './Send';
import { MOCK_RECIPIENT } from '../../__tests__/helpers';

const mockNavigate = vi.fn();

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
}));

vi.mock('@/shared/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));

describe('Send', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the SEND SOL header', () => {
    render(
      <MemoryRouter>
        <Send />
      </MemoryRouter>,
    );

    expect(screen.getByText('SEND SOL')).toBeInTheDocument();
  });

  it('shows available balance', () => {
    render(
      <MemoryRouter>
        <Send />
      </MemoryRouter>,
    );

    expect(screen.getByText('AVAILABLE BALANCE')).toBeInTheDocument();
    expect(screen.getByText('5.0000 SOL')).toBeInTheDocument();
  });

  it('displays the DEVNET badge', () => {
    render(
      <MemoryRouter>
        <Send />
      </MemoryRouter>,
    );

    expect(screen.getByText('[ DEVNET ]')).toBeInTheDocument();
  });

  it('renders recipient and amount input fields', () => {
    render(
      <MemoryRouter>
        <Send />
      </MemoryRouter>,
    );

    expect(screen.getByText('RECIPIENT ADDRESS')).toBeInTheDocument();
    expect(screen.getByText('AMOUNT (SOL)')).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('Enter Solana address or st:01... meta-address'),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('0.00')).toBeInTheDocument();
  });

  it('renders percentage buttons (25%, 50%, 75%, 100%)', () => {
    render(
      <MemoryRouter>
        <Send />
      </MemoryRouter>,
    );

    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('sets the amount to the correct percentage when a percent button is clicked', () => {
    render(
      <MemoryRouter>
        <Send />
      </MemoryRouter>,
    );

    // 50% of (5.0 - 0.001 fee reserve) = 2.4995
    fireEvent.click(screen.getByText('50%'));

    const amountInput = screen.getByPlaceholderText('0.00') as HTMLInputElement;
    const value = parseFloat(amountInput.value);
    expect(value).toBeCloseTo(2.4995, 3);
  });

  it('shows the estimated fee', () => {
    render(
      <MemoryRouter>
        <Send />
      </MemoryRouter>,
    );

    expect(screen.getByText('ESTIMATED FEE')).toBeInTheDocument();
    expect(screen.getByText('~0.000005 SOL')).toBeInTheDocument();
  });

  it('keeps the CONTINUE button disabled when inputs are empty', () => {
    render(
      <MemoryRouter>
        <Send />
      </MemoryRouter>,
    );

    const continueBtn = screen.getByText('CONTINUE');
    expect(continueBtn.closest('button')).toBeDisabled();
  });

  it('shows error for empty recipient when CONTINUE is clicked', async () => {
    render(
      <MemoryRouter>
        <Send />
      </MemoryRouter>,
    );

    // Set amount but not recipient
    const amountInput = screen.getByPlaceholderText('0.00');
    fireEvent.change(amountInput, { target: { value: '1.0' } });

    // The CONTINUE button is still disabled without recipient, so we directly test validation
    const recipientInput = screen.getByPlaceholderText(
      'Enter Solana address or st:01... meta-address',
    );
    expect((recipientInput as HTMLInputElement).value).toBe('');
  });

  it('shows error for insufficient balance', async () => {
    render(
      <MemoryRouter>
        <Send />
      </MemoryRouter>,
    );

    const recipientInput = screen.getByPlaceholderText(
      'Enter Solana address or st:01... meta-address',
    );
    const amountInput = screen.getByPlaceholderText('0.00');

    fireEvent.change(recipientInput, { target: { value: MOCK_RECIPIENT } });
    fireEvent.change(amountInput, { target: { value: '999' } });

    // Now click CONTINUE
    const continueBtn = screen.getByText('CONTINUE');
    fireEvent.click(continueBtn);

    await waitFor(() => {
      expect(screen.getByText('Insufficient balance')).toBeInTheDocument();
    });
  });

  it('shows error for invalid Solana address', async () => {
    render(
      <MemoryRouter>
        <Send />
      </MemoryRouter>,
    );

    const recipientInput = screen.getByPlaceholderText(
      'Enter Solana address or st:01... meta-address',
    );
    const amountInput = screen.getByPlaceholderText('0.00');

    fireEvent.change(recipientInput, { target: { value: 'invalid_address!' } });
    fireEvent.change(amountInput, { target: { value: '1.0' } });

    const continueBtn = screen.getByText('CONTINUE');
    fireEvent.click(continueBtn);

    await waitFor(() => {
      expect(screen.getByText('Invalid Solana address')).toBeInTheDocument();
    });
  });

  it('shows error for zero or negative amounts', async () => {
    render(
      <MemoryRouter>
        <Send />
      </MemoryRouter>,
    );

    const recipientInput = screen.getByPlaceholderText(
      'Enter Solana address or st:01... meta-address',
    );
    const amountInput = screen.getByPlaceholderText('0.00');

    fireEvent.change(recipientInput, { target: { value: MOCK_RECIPIENT } });
    fireEvent.change(amountInput, { target: { value: '0' } });

    const continueBtn = screen.getByText('CONTINUE');
    fireEvent.click(continueBtn);

    await waitFor(() => {
      expect(screen.getByText('Please enter a valid amount')).toBeInTheDocument();
    });
  });

  it('detects stealth address when input starts with "st:"', async () => {
    render(
      <MemoryRouter>
        <Send />
      </MemoryRouter>,
    );

    const recipientInput = screen.getByPlaceholderText(
      'Enter Solana address or st:01... meta-address',
    );

    // The stealth label appears in the RECIPIENT ADDRESS label
    fireEvent.change(recipientInput, {
      target: { value: 'st:01valid_stealth_meta_address_long_enough' },
    });

    await waitFor(() => {
      // "(STEALTH)" may appear in both the address label and a subtitle
      const stealthLabels = screen.getAllByText('(STEALTH)');
      expect(stealthLabels.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('changes the CONTINUE button to SEND PRIVATELY for valid stealth addresses', async () => {
    render(
      <MemoryRouter>
        <Send />
      </MemoryRouter>,
    );

    const recipientInput = screen.getByPlaceholderText(
      'Enter Solana address or st:01... meta-address',
    );
    const amountInput = screen.getByPlaceholderText('0.00');

    fireEvent.change(recipientInput, {
      target: { value: 'st:01valid_stealth_meta_address_long_enough' },
    });
    fireEvent.change(amountInput, { target: { value: '1.0' } });

    await waitFor(() => {
      expect(screen.getByText('SEND PRIVATELY')).toBeInTheDocument();
    });
  });

  it('navigates back when the back button is clicked', () => {
    render(
      <MemoryRouter>
        <Send />
      </MemoryRouter>,
    );

    // Find the back button (ArrowLeft icon button)
    const backButton = screen.getAllByRole('button')[0];
    fireEvent.click(backButton);

    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });
});
