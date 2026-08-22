/**
 * Tests for Receive page
 *
 * The Receive page displays the user's Solana address for receiving funds,
 * with support for:
 * - Standard Solana address with QR code
 * - Stealth meta-address mode toggle
 * - Solana Pay URI format in the QR code
 * - Copy to clipboard
 * - Devnet warning
 *
 * Validates:
 * - QR code rendering with correct address
 * - Address display in full
 * - The single copy button
 * - Stealth mode toggle
 * - Devnet caution shown once
 *
 * ⛔ THE STEALTH PAYMENTS ASSERTIONS ARE GONE ON PURPOSE. They pinned a block
 * that navigated to `/stealth-payments`, and that route was parked on
 * 2026-08-23: `App.tsx` now redirects it to `/shield`. The test was green while
 * the button it described sent the user to an unrelated screen — which is
 * exactly the failure a route test cannot see and a page test should not
 * enshrine. The block was removed from the page; its assertions go with it.
 *
 * ⛔ SO IS THE DOUBLE-COPY ASSERTION. There were two copy controls wired to one
 * handler. One remains, in the footer, so there is one thing to assert.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Receive from './Receive';
import { MOCK_PUBLIC_KEY } from '../../__tests__/helpers';

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
    publicKey: MOCK_PUBLIC_KEY,
    network: 'devnet',
  }),
}));

vi.mock('@/shared/store/stealth', () => ({
  useStealthStore: () => ({
    metaAddress: 'st:01_mock_stealth_meta_address_for_testing',
    stealthModeEnabled: false,
    toggleStealthMode: vi.fn(),
    isInitialized: true,
    payments: [
      { id: '1', claimed: false },
      { id: '2', claimed: true },
    ],
    stealthBalance: 500_000_000, // 0.5 SOL
  }),
}));

vi.mock('@/shared/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
  truncateAddress: (addr: string, chars: number) =>
    `${addr.slice(0, chars)}...${addr.slice(-chars)}`,
  copyToClipboard: vi.fn(() => Promise.resolve(true)),
}));

// Mock QRCodeSVG
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => (
    <div data-testid="qr-code" data-value={value}>
      QR Code
    </div>
  ),
}));

describe('Receive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Receive header', () => {
    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Receive' })).toBeInTheDocument();
  });

  it('displays the QR code with the Solana Pay URI', () => {
    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    const qrCode = screen.getByTestId('qr-code');
    expect(qrCode).toBeInTheDocument();
    // In normal mode, QR value should be a solana: URI
    expect(qrCode.getAttribute('data-value')).toBe(`solana:${MOCK_PUBLIC_KEY}`);
  });

  it('shows the address in full, once', () => {
    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    expect(screen.getAllByText(MOCK_PUBLIC_KEY)).toHaveLength(1);
  });

  it('offers exactly one copy control', () => {
    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole('button', { name: /copy/i })).toHaveLength(1);
  });

  it('copies address to clipboard when the copy button is clicked', async () => {
    const { copyToClipboard: mockCopy } = await import('@/shared/utils');

    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy address' }));

    await waitFor(() => {
      expect(mockCopy).toHaveBeenCalledWith(MOCK_PUBLIC_KEY);
    });
  });

  it('confirms the copy on the button itself', async () => {
    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy address' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    });
  });

  it('shows the stealth mode toggle, unpressed in normal mode', () => {
    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    const toggle = screen.getByRole('button', { name: 'Stealth' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('warns about devnet once', () => {
    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    expect(
      screen.getAllByText(/this is a devnet address/i),
    ).toHaveLength(1);
  });

  it('does not offer the parked stealth payments route', () => {
    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    expect(screen.queryByText(/stealth payments/i)).not.toBeInTheDocument();
  });

  it('navigates back when the back button is clicked', () => {
    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));

    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });
});
