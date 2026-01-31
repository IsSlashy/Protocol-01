/**
 * Tests for Receive page
 *
 * The Receive page displays the user's Solana address for receiving funds,
 * with support for:
 * - Standard Solana address with QR code
 * - Stealth meta-address mode toggle
 * - Solana Pay URI format in the QR code
 * - Copy to clipboard
 * - Explorer link to Solscan
 * - Devnet badge and warning
 * - Stealth payments navigation
 *
 * Validates:
 * - QR code rendering with correct address
 * - Address display and truncation
 * - Copy button functionality
 * - Stealth mode toggle
 * - Network badge display
 * - Navigation to stealth payments page
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

  it('renders the RECEIVE SOL header', () => {
    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    expect(screen.getByText('RECEIVE SOL')).toBeInTheDocument();
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

  it('shows the truncated wallet address', () => {
    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    expect(screen.getByText(/7xKXtg2C\.\.\.uJosgAsU/)).toBeInTheDocument();
  });

  it('displays the YOUR SOLANA ADDRESS label', () => {
    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    expect(screen.getByText('YOUR SOLANA ADDRESS')).toBeInTheDocument();
  });

  it('displays the full public key in the address section', () => {
    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    expect(screen.getByText(MOCK_PUBLIC_KEY)).toBeInTheDocument();
  });

  it('shows the COPY ADDRESS button', () => {
    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    expect(screen.getByText('COPY ADDRESS')).toBeInTheDocument();
  });

  it('copies address to clipboard when copy button is clicked', async () => {
    const { copyToClipboard: mockCopy } = await import('@/shared/utils');

    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('COPY ADDRESS'));

    await waitFor(() => {
      expect(mockCopy).toHaveBeenCalledWith(MOCK_PUBLIC_KEY);
    });
  });

  it('shows "COPIED TO CLIPBOARD" text after copying', async () => {
    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('COPY ADDRESS'));

    await waitFor(() => {
      expect(screen.getByText('COPIED TO CLIPBOARD')).toBeInTheDocument();
    });
  });

  it('shows the stealth mode toggle (NORMAL)', () => {
    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    expect(screen.getByText('NORMAL')).toBeInTheDocument();
  });

  it('shows the DEVNET badge', () => {
    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    const badges = screen.getAllByText('[ DEVNET ]');
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it('shows the receiving info card', () => {
    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    expect(screen.getByText('[ RECEIVING ]')).toBeInTheDocument();
    expect(
      screen.getByText(/SCAN THIS QR CODE OR SHARE YOUR ADDRESS/),
    ).toBeInTheDocument();
  });

  it('shows the devnet warning', () => {
    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    const badges = screen.getAllByText('[ DEVNET ]');
    expect(badges.length).toBeGreaterThanOrEqual(2);
    expect(
      screen.getByText(/THIS IS A DEVNET ADDRESS/),
    ).toBeInTheDocument();
  });

  it('renders the STEALTH PAYMENTS navigation link', () => {
    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    expect(screen.getByText('STEALTH PAYMENTS')).toBeInTheDocument();
    expect(screen.getByText(/1 pending/)).toBeInTheDocument();
  });

  it('navigates to /stealth-payments when the link is clicked', () => {
    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('STEALTH PAYMENTS'));

    expect(mockNavigate).toHaveBeenCalledWith('/stealth-payments');
  });

  it('shows the VIEW link to Solscan explorer', () => {
    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    expect(screen.getByText('VIEW')).toBeInTheDocument();
    const viewLink = screen.getByText('VIEW').closest('a');
    expect(viewLink?.getAttribute('href')).toContain('solscan.io');
    expect(viewLink?.getAttribute('href')).toContain('devnet');
  });

  it('navigates back when the back button is clicked', () => {
    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>,
    );

    const backButton = screen.getAllByRole('button')[0];
    fireEvent.click(backButton);

    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });
});
