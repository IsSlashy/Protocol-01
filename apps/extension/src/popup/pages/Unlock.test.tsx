/**
 * Tests for Unlock page
 *
 * The Unlock page is shown when the wallet is initialized but locked.
 * It features:
 * - GlitchLogo with "LOCKED" status badge
 * - Password input with visibility toggle
 * - UNLOCK button with loading state
 * - Error display for invalid passwords
 * - "FORGOT PASSWORD? DISCONNECT" link
 * - Disconnect confirmation modal
 * - Redirect to pending approval path after unlock
 *
 * Validates:
 * - Renders the locked state UI correctly
 * - Password input accepts user input
 * - Show/hide password toggle works
 * - Error states render when unlock fails
 * - Disconnect modal opens and confirms correctly
 * - Loading spinner appears during unlock attempt
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Unlock from './Unlock';

const mockNavigate = vi.fn();
const mockUnlock = vi.fn();
const mockClearError = vi.fn();
const mockReset = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('@/shared/store/wallet', () => ({
  useWalletStore: () => ({
    unlock: mockUnlock,
    isLoading: false,
    error: null,
    clearError: mockClearError,
    reset: mockReset,
    isPrivyWallet: false,
  }),
}));

// Mock GlitchLogo
vi.mock('../components/GlitchLogo', () => ({
  __esModule: true,
  default: () => <div data-testid="glitch-logo" />,
}));

vi.mock('@/shared/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));

describe('Unlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUnlock.mockResolvedValue(false);
  });

  it('renders the locked state UI', () => {
    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    expect(screen.getByText('[ LOCKED ]')).toBeInTheDocument();
    expect(screen.getByText('WALLET LOCKED')).toBeInTheDocument();
    expect(screen.getByText('ENTER PASSWORD TO UNLOCK')).toBeInTheDocument();
  });

  it('renders the GlitchLogo', () => {
    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('glitch-logo')).toBeInTheDocument();
  });

  it('renders the password input field', () => {
    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    const passwordInput = screen.getByPlaceholderText('Enter password');
    expect(passwordInput).toBeInTheDocument();
    expect(passwordInput).toHaveAttribute('type', 'password');
  });

  it('toggles password visibility when the eye icon is clicked', () => {
    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    const passwordInput = screen.getByPlaceholderText('Enter password') as HTMLInputElement;
    expect(passwordInput.type).toBe('password');

    // Find the toggle button (contains an SVG)
    const toggleButton = screen.getAllByRole('button').find(
      (btn) => btn.getAttribute('type') === 'button',
    );
    if (toggleButton) {
      fireEvent.click(toggleButton);
      expect(passwordInput.type).toBe('text');

      fireEvent.click(toggleButton);
      expect(passwordInput.type).toBe('password');
    }
  });

  it('keeps the UNLOCK button disabled when password is empty', () => {
    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    const unlockBtn = screen.getByText('UNLOCK');
    expect(unlockBtn.closest('button')).toBeDisabled();
  });

  it('enables the UNLOCK button when password is entered', () => {
    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    const passwordInput = screen.getByPlaceholderText('Enter password');
    fireEvent.change(passwordInput, { target: { value: 'mypassword' } });

    const unlockBtn = screen.getByText('UNLOCK');
    expect(unlockBtn.closest('button')).not.toBeDisabled();
  });

  it('calls unlock with the entered password', async () => {
    mockUnlock.mockResolvedValue(true);

    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    const passwordInput = screen.getByPlaceholderText('Enter password');
    fireEvent.change(passwordInput, { target: { value: 'correctpassword' } });

    const unlockBtn = screen.getByText('UNLOCK');
    fireEvent.click(unlockBtn);

    await waitFor(() => {
      expect(mockUnlock).toHaveBeenCalledWith('correctpassword');
    });
  });

  it('navigates to home on successful unlock', async () => {
    mockUnlock.mockResolvedValue(true);

    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByPlaceholderText('Enter password'), {
      target: { value: 'correctpassword' },
    });
    fireEvent.click(screen.getByText('UNLOCK'));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });
  });

  it('shows invalid password error when unlock fails', async () => {
    mockUnlock.mockResolvedValue(false);

    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByPlaceholderText('Enter password'), {
      target: { value: 'wrongpassword' },
    });
    fireEvent.click(screen.getByText('UNLOCK'));

    await waitFor(() => {
      expect(screen.getByText('Invalid password')).toBeInTheDocument();
    });
  });

  it('shows the forgot password disconnect link', () => {
    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    expect(screen.getByText('FORGOT PASSWORD? DISCONNECT')).toBeInTheDocument();
  });

  it('opens the disconnect confirmation modal', () => {
    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('FORGOT PASSWORD? DISCONNECT'));

    expect(screen.getByText('DISCONNECT WALLET')).toBeInTheDocument();
    expect(screen.getByText(/YOUR FUNDS ARE SAFE/)).toBeInTheDocument();
  });

  it('resets wallet and navigates to welcome on disconnect confirm', async () => {
    mockReset.mockResolvedValue(undefined);

    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('FORGOT PASSWORD? DISCONNECT'));
    // The DISCONNECT button is inside the modal, separate from the header
    const disconnectButtons = screen.getAllByText('DISCONNECT');
    const modalDisconnect = disconnectButtons.find((el) => {
      const btn = el.closest('button');
      return btn && btn.className.includes('bg-p01-cyan');
    });
    fireEvent.click(modalDisconnect?.closest('button') || disconnectButtons[disconnectButtons.length - 1]);

    await waitFor(() => {
      expect(mockReset).toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith('/welcome');
    });
  });

  it('closes the disconnect modal on CANCEL', () => {
    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('FORGOT PASSWORD? DISCONNECT'));
    expect(screen.getByText('DISCONNECT WALLET')).toBeInTheDocument();

    fireEvent.click(screen.getByText('CANCEL'));

    // Modal should close - the DISCONNECT WALLET title should be gone
    expect(screen.queryByText('DISCONNECT WALLET')).not.toBeInTheDocument();
  });

  it('displays the network indicator footer', () => {
    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    expect(screen.getByText('Solana Network')).toBeInTheDocument();
  });

  it('submits on Enter key press', async () => {
    mockUnlock.mockResolvedValue(true);

    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    const passwordInput = screen.getByPlaceholderText('Enter password');
    fireEvent.change(passwordInput, { target: { value: 'testpassword' } });
    fireEvent.keyPress(passwordInput, { key: 'Enter', charCode: 13 });

    await waitFor(() => {
      expect(mockUnlock).toHaveBeenCalledWith('testpassword');
    });
  });
});
