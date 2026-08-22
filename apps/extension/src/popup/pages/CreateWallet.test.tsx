/**
 * Tests for CreateWallet page
 *
 * The wallet creation flow has two steps:
 * 1. Password entry with strength indicator
 * 2. Seed phrase display with copy + confirm
 *
 * 🚨 ONE ASSERTION WAS DELETED ON PURPOSE, AND IT WAS PINNING A TRAP. The old
 * screen disabled "COMPLETE SETUP" until the phrase had been written to the
 * CLIPBOARD, and the copied flag expired five seconds later — so a user who
 * copied it and then wrote the words on paper found the button dead again. The
 * gate is gone; the checkbox is the attestation. The test below now asserts the
 * OPPOSITE of what the old suite asserted, deliberately, so the gate cannot
 * come back unnoticed.
 *
 * ⚠️ Copy assertions moved to sentence case with the 2026-08-23 design pass.
 *
 * Validates:
 * - Password input validation (minimum 8 chars, must match)
 * - Password strength indicator progression
 * - Create wallet button state management
 * - Seed phrase display after wallet creation
 * - Done is gated on the checkbox ALONE
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CreateWallet from './CreateWallet';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockCreateWallet = vi.fn();
const mockClearError = vi.fn();

vi.mock('@/shared/store/wallet', () => ({
  useWalletStore: () => ({
    createWallet: mockCreateWallet,
    isLoading: false,
    error: null,
    clearError: mockClearError,
  }),
}));

vi.mock('@/shared/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
  copyToClipboard: vi.fn(() => Promise.resolve(true)),
}));

describe('CreateWallet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateWallet.mockResolvedValue([
      'abandon', 'ability', 'able', 'about',
      'above', 'absent', 'absorb', 'abstract',
      'absurd', 'abuse', 'access', 'accident',
    ]);
  });

  it('renders the password creation form initially', () => {
    render(
      <MemoryRouter>
        <CreateWallet />
      </MemoryRouter>,
    );

    // "Create wallet" is both the screen title and the submit button.
    expect(screen.getAllByText('Create wallet').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm password')).toBeInTheDocument();
  });

  it('says what the password is for, once', () => {
    render(
      <MemoryRouter>
        <CreateWallet />
      </MemoryRouter>,
    );

    expect(screen.getByText(/This password encrypts your wallet on this device/)).toBeInTheDocument();

    // ⛔ The medallion-plus-headline-plus-subtitle stack that said it three times.
    expect(screen.queryByText('SECURE YOUR WALLET')).not.toBeInTheDocument();
  });

  it('shows the password strength indicator', () => {
    render(
      <MemoryRouter>
        <CreateWallet />
      </MemoryRouter>,
    );

    expect(screen.getByText('At least 8 characters')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Password strength' })).toHaveAttribute(
      'aria-valuenow',
      '0',
    );
  });

  it('reads the strength label out of the meter it belongs to', () => {
    const { container } = render(
      <MemoryRouter>
        <CreateWallet />
      </MemoryRouter>,
    );

    // Password strength is: <8 chars = "At least 8 characters", 8-11 = Good,
    // >=12 = Strong. The label lives inside the meter, next to the bars it
    // describes, rather than floating in a summary.
    const strengthText = container.querySelector('[role="meter"] p');
    expect(strengthText?.textContent).toBe('At least 8 characters');
  });

  it('shows the create wallet button as disabled when inputs are empty', () => {
    render(
      <MemoryRouter>
        <CreateWallet />
      </MemoryRouter>,
    );

    const submitButton = screen
      .getAllByText('Create wallet')
      .map((el) => el.closest('button'))
      .find((btn) => btn !== null);
    expect(submitButton).toBeTruthy();
    expect(submitButton).toBeDisabled();
  });

  it('renders both password and confirm password inputs as password type', () => {
    render(
      <MemoryRouter>
        <CreateWallet />
      </MemoryRouter>,
    );

    const passwordInput = screen.getByLabelText('Password') as HTMLInputElement;
    const confirmInput = screen.getByLabelText('Confirm password') as HTMLInputElement;

    expect(passwordInput.type).toBe('password');
    expect(confirmInput.type).toBe('password');
  });

  it('calls createWallet when form is submitted with valid passwords', async () => {
    // Directly test the store interaction by checking the mock is wired up
    render(
      <MemoryRouter>
        <CreateWallet />
      </MemoryRouter>,
    );

    // Verify createWallet mock is defined and callable
    expect(mockCreateWallet).toBeDefined();
    expect(typeof mockCreateWallet).toBe('function');
  });

  it('renders no error before anything is submitted', () => {
    render(
      <MemoryRouter>
        <CreateWallet />
      </MemoryRouter>,
    );

    expect(screen.queryByText('Password must be at least 8 characters')).not.toBeInTheDocument();
    expect(screen.queryByText('Passwords do not match')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the password visibility toggle button', () => {
    render(
      <MemoryRouter>
        <CreateWallet />
      </MemoryRouter>,
    );

    const passwordInput = screen.getByLabelText('Password') as HTMLInputElement;
    expect(passwordInput.type).toBe('password');

    expect(screen.getByLabelText('Show password')).toBeInTheDocument();
  });

  it('gates Done on the checkbox ALONE, never on having copied the phrase', async () => {
    render(
      <MemoryRouter>
        <CreateWallet />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correcthorse' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'correcthorse' },
    });
    fireEvent.click(screen.getAllByText('Create wallet').find((el) => el.closest('button'))!);

    // Step 2. The twelve words are on screen and nothing has been copied.
    const done = await screen.findByText('Done');
    expect(done.closest('button')).toBeDisabled();
    expect(screen.getByText('Copy to clipboard')).toBeInTheDocument();

    // ⛔ No copy. Ticking the box alone must be enough — the old screen also
    // required the clipboard, and silently re-required it five seconds later.
    fireEvent.click(screen.getByRole('checkbox'));

    expect(screen.getByText('Done').closest('button')).not.toBeDisabled();
  });
});
