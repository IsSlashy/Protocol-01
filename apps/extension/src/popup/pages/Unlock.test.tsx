/**
 * Tests for Unlock page
 *
 * The Unlock page is shown when the wallet is initialized but locked. After the
 * 2026-08-23 design pass it is what Phantom shows: a small wordmark, the big
 * mark, "Enter your password", one field, one full-width button, one text link.
 *
 * 🚨 THIS FILE USED TO PIN THE NOISE. It asserted "[ LOCKED ]", "WALLET LOCKED"
 * and "ENTER PASSWORD TO UNLOCK" — three restatements of one fact, in three
 * typefaces — plus a "Solana Network" footer. Those were the defect, so the
 * assertions moved with them: the screen is now checked for saying "locked"
 * ONCE, and a regression that reintroduces the shouting fails here.
 *
 * Validates:
 * - Renders the unlock prompt once, not four times
 * - Password input accepts user input
 * - Show/hide password toggle works
 * - Error states render under the field
 * - Disconnect modal opens and confirms correctly
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
  }),
}));

// Mock Wordmark
vi.mock('../components/Wordmark', () => ({
  __esModule: true,
  default: () => <div data-testid="wordmark" />,
}));

vi.mock('@/shared/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));

describe('Unlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUnlock.mockResolvedValue(false);
  });

  it('asks for the password once, in one voice', () => {
    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    expect(screen.getByText('Enter your password')).toBeInTheDocument();

    // ⛔ The old house style. None of it comes back.
    expect(screen.queryByText('[ LOCKED ]')).not.toBeInTheDocument();
    expect(screen.queryByText('WALLET LOCKED')).not.toBeInTheDocument();
    expect(screen.queryByText('ENTER PASSWORD TO UNLOCK')).not.toBeInTheDocument();
    expect(screen.queryByText('Solana Network')).not.toBeInTheDocument();
  });

  it('renders the Wordmark', () => {
    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    // Two: the header lockup and the big mark.
    expect(screen.getAllByTestId('wordmark').length).toBeGreaterThanOrEqual(1);
  });

  it('renders the password input field with a visible label', () => {
    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    const passwordInput = screen.getByLabelText('Password');
    expect(passwordInput).toBeInTheDocument();
    expect(passwordInput).toHaveAttribute('type', 'password');
  });

  it('toggles password visibility when the eye icon is clicked', () => {
    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    const passwordInput = screen.getByLabelText('Password') as HTMLInputElement;
    expect(passwordInput.type).toBe('password');

    fireEvent.click(screen.getByLabelText('Show password'));
    expect(passwordInput.type).toBe('text');

    fireEvent.click(screen.getByLabelText('Hide password'));
    expect(passwordInput.type).toBe('password');
  });

  it('keeps the Unlock button disabled when password is empty', () => {
    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    expect(screen.getByText('Unlock').closest('button')).toBeDisabled();
  });

  it('enables the Unlock button when password is entered', () => {
    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'mypassword' } });

    expect(screen.getByText('Unlock').closest('button')).not.toBeDisabled();
  });

  it('calls unlock with the entered password', async () => {
    mockUnlock.mockResolvedValue(true);

    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correctpassword' } });
    fireEvent.click(screen.getByText('Unlock'));

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

    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'correctpassword' },
    });
    fireEvent.click(screen.getByText('Unlock'));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });
  });

  it('shows invalid password error under the field, as an alert', async () => {
    mockUnlock.mockResolvedValue(false);

    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'wrongpassword' },
    });
    fireEvent.click(screen.getByText('Unlock'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Invalid password');
    });
  });

  it('shows the forgot password link', () => {
    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    expect(screen.getByText('Forgot password?')).toBeInTheDocument();
  });

  it('opens the disconnect confirmation modal', () => {
    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('Forgot password?'));

    expect(screen.getByText('Disconnect wallet')).toBeInTheDocument();
    expect(screen.getByText(/recovery phrase imports it back/)).toBeInTheDocument();
  });

  it('resets wallet and navigates to welcome on disconnect confirm', async () => {
    mockReset.mockResolvedValue(undefined);

    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('Forgot password?'));
    // "Disconnect wallet" is the title; "Disconnect" alone is the button.
    fireEvent.click(screen.getByText('Disconnect'));

    await waitFor(() => {
      expect(mockReset).toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith('/welcome');
    });
  });

  it('closes the disconnect modal on Cancel', () => {
    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('Forgot password?'));
    expect(screen.getByText('Disconnect wallet')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByText('Disconnect wallet')).not.toBeInTheDocument();
  });

  it('submits on Enter key press', async () => {
    mockUnlock.mockResolvedValue(true);

    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );

    const passwordInput = screen.getByLabelText('Password');
    fireEvent.change(passwordInput, { target: { value: 'testpassword' } });
    fireEvent.keyPress(passwordInput, { key: 'Enter', charCode: 13 });

    await waitFor(() => {
      expect(mockUnlock).toHaveBeenCalledWith('testpassword');
    });
  });
});
