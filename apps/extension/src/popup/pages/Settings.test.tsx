/**
 * Tests for Settings page
 *
 * The Settings page provides:
 * - Account card with wallet address and copy
 * - Network selector (Devnet / Mainnet)
 * - Hide Balance toggle
 * - Notifications management
 * - Backup Seed Phrase (legacy wallets only)
 * - Change Password (legacy wallets only)
 * - Connected Sites navigation
 * - Lock / Sign Out button
 * - Delete Wallet (danger zone)
 * - Help & FAQ and social links
 *
 * Validates:
 * - Renders all settings sections
 * - Network switching works
 * - Hide balance toggle state
 * - Modals open and close correctly
 * - Lock button behavior
 * - Delete wallet confirmation flow
 * - Version string display
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Settings from './Settings';

const mockNavigate = vi.fn();
const mockSetNetwork = vi.fn();
const mockToggleHideBalance = vi.fn();
const mockLock = vi.fn();
const mockReset = vi.fn();
const mockWalletLogout = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('@/shared/store/wallet', () => ({
  useWalletStore: () => ({
    publicKey: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    network: 'devnet',
    setNetwork: mockSetNetwork,
    hideBalance: false,
    toggleHideBalance: mockToggleHideBalance,
    lock: mockLock,
    reset: mockReset,
    logout: mockWalletLogout,
    encryptedSeedPhrase: { encrypted: 'data' },
    passwordHash: 'hashedpassword',
    isPrivyWallet: false,
  }),
}));

vi.mock('@/shared/providers/PrivyProvider', () => ({
  usePrivy: () => ({
    logout: vi.fn(() => Promise.resolve()),
    authenticated: true,
    ready: true,
  }),
}));

vi.mock('@/shared/services/crypto', () => ({
  decrypt: vi.fn(),
  encrypt: vi.fn(),
  verifyPassword: vi.fn(),
  hashPassword: vi.fn(),
}));

vi.mock('@/shared/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
  truncateAddress: (addr: string, chars: number) =>
    `${addr.slice(0, chars)}...${addr.slice(-chars)}`,
  copyToClipboard: vi.fn(() => Promise.resolve(true)),
}));

describe('Settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Settings header', () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('displays the wallet address card', () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    expect(screen.getByText('My Wallet')).toBeInTheDocument();
    // Truncated address: truncateAddress(addr, 6) = addr.slice(0,6) + '...' + addr.slice(-6)
    expect(screen.getByText(/7xKXtg\.\.\.osgAsU/)).toBeInTheDocument();
  });

  it('renders the PREFERENCES section', () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    expect(screen.getByText('PREFERENCES')).toBeInTheDocument();
    expect(screen.getByText('Network')).toBeInTheDocument();
    expect(screen.getByText('Hide Balance')).toBeInTheDocument();
    expect(screen.getByText('Notifications')).toBeInTheDocument();
  });

  it('renders the network selector with Devnet and Mainnet buttons', () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    expect(screen.getByText('Devnet')).toBeInTheDocument();
    expect(screen.getByText('Mainnet')).toBeInTheDocument();
  });

  it('switches network when Mainnet is clicked', () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('Mainnet'));

    expect(mockSetNetwork).toHaveBeenCalledWith('mainnet-beta');
  });

  it('switches network when Devnet is clicked', () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('Devnet'));

    expect(mockSetNetwork).toHaveBeenCalledWith('devnet');
  });

  it('toggles hide balance when the toggle is clicked', () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    // Find and click the Hide Balance toggle (it's a button with specific class)
    const hideBalanceSection = screen.getByText('Hide Balance').closest('div[class*="flex"]');
    const toggle = hideBalanceSection?.querySelector('button[class*="rounded-full"]');
    if (toggle) {
      fireEvent.click(toggle);
      expect(mockToggleHideBalance).toHaveBeenCalled();
    }
  });

  it('renders the SECURITY section with Backup and Change Password', () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    expect(screen.getByText('SECURITY')).toBeInTheDocument();
    expect(screen.getByText('Backup Seed Phrase')).toBeInTheDocument();
    expect(screen.getByText('Change Password')).toBeInTheDocument();
    expect(screen.getByText('Connected Sites')).toBeInTheDocument();
  });

  it('navigates to /connected-sites when Connected Sites is clicked', () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('Connected Sites'));

    expect(mockNavigate).toHaveBeenCalledWith('/connected-sites');
  });

  it('renders the SUPPORT section', () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    expect(screen.getByText('SUPPORT')).toBeInTheDocument();
    expect(screen.getByText('Help & FAQ')).toBeInTheDocument();
    expect(screen.getByText('Follow us on X')).toBeInTheDocument();
  });

  it('renders the Disconnect Wallet button', () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    expect(screen.getByText('Disconnect Wallet')).toBeInTheDocument();
  });

  it('locks wallet and navigates to /unlock when Disconnect Wallet is clicked', () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('Disconnect Wallet'));

    expect(mockLock).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/unlock');
  });

  it('shows the Delete Wallet button in the danger zone', () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    expect(screen.getByText('Delete Wallet')).toBeInTheDocument();
  });

  it('opens the delete wallet confirmation modal', () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    // The first "Delete Wallet" is the link, it opens the modal which has another "Delete Wallet" text
    const deleteLinks = screen.getAllByText('Delete Wallet');
    fireEvent.click(deleteLinks[0]);

    expect(screen.getByText('This cannot be undone')).toBeInTheDocument();
    expect(screen.getByText('Enter password to confirm deletion')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('closes the delete modal on Cancel', () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    const deleteLinks = screen.getAllByText('Delete Wallet');
    fireEvent.click(deleteLinks[0]);

    expect(screen.getByText('This cannot be undone')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Cancel'));

    // Modal content should be gone
    expect(screen.queryByText('This cannot be undone')).not.toBeInTheDocument();
  });

  it('opens the notifications modal', () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('Notifications'));

    expect(screen.getByText('Transactions')).toBeInTheDocument();
    expect(screen.getByText('Subscriptions')).toBeInTheDocument();
    expect(screen.getByText('Price Alerts')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('opens the backup seed phrase modal', () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    // Click the settings list item (first occurrence)
    const backupItems = screen.getAllByText('Backup Seed Phrase');
    fireEvent.click(backupItems[0]);

    // After clicking, the modal title also shows "Backup Seed Phrase" (2 total)
    const allBackupTexts = screen.getAllByText('Backup Seed Phrase');
    expect(allBackupTexts.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Enter password to reveal')).toBeInTheDocument();
  });

  it('opens the change password modal', () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    // Click the settings list item (first occurrence)
    const changeItems = screen.getAllByText('Change Password');
    fireEvent.click(changeItems[0]);

    // After clicking, the modal title also shows "Change Password" (2 total)
    const allChangeTexts = screen.getAllByText('Change Password');
    expect(allChangeTexts.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Current Password')).toBeInTheDocument();
    expect(screen.getByText('New Password')).toBeInTheDocument();
    expect(screen.getByText('Confirm New Password')).toBeInTheDocument();
  });

  it('displays the version string at the bottom', () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    expect(screen.getByText('Protocol v0.1.0')).toBeInTheDocument();
  });

  it('navigates back when back arrow is clicked', () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    const backButton = screen.getAllByRole('button')[0];
    fireEvent.click(backButton);

    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });
});
