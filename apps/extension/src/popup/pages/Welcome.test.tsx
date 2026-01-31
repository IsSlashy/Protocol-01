/**
 * Tests for Welcome page
 *
 * The Welcome page is the entry point for new users. It presents:
 * - Protocol 01 branding with the GlitchLogo
 * - "Continue with Email" (Privy) flow
 * - "Create New Wallet" (legacy seed-based)
 * - "Import Seed Phrase"
 * - An "ADVANCED" toggle to reveal legacy options when Privy is enabled
 *
 * Validates:
 * - Renders the logo and tagline
 * - Shows wallet creation buttons
 * - Navigation to create-wallet and import-wallet routes
 * - Version string is displayed
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Welcome from './Welcome';

// Track navigation calls
const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    Navigate: ({ to }: { to: string }) => <div data-testid="navigate">{to}</div>,
  };
});

// Mock GlitchLogo to avoid animation complexity
vi.mock('../components/GlitchLogo', () => ({
  __esModule: true,
  default: ({ showText }: { showText: boolean; size: number; animated: boolean }) => (
    <div data-testid="glitch-logo">{showText && 'PROTOCOL'}</div>
  ),
}));

// Mock Privy provider - PRIVY_ENABLED depends on env var
vi.mock('../../shared/providers/PrivyProvider', () => ({
  usePrivy: () => ({
    authenticated: false,
    ready: true,
  }),
  useLoginWithEmail: () => ({
    sendCode: vi.fn(),
    loginWithCode: vi.fn(),
    state: { status: 'initial' },
  }),
}));

describe('Welcome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Protocol 01 logo', () => {
    render(
      <MemoryRouter>
        <Welcome />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('glitch-logo')).toBeInTheDocument();
  });

  it('displays the "Total Invisibility" tagline', () => {
    render(
      <MemoryRouter>
        <Welcome />
      </MemoryRouter>,
    );

    expect(screen.getByText('Total Invisibility')).toBeInTheDocument();
  });

  it('shows the CREATE NEW WALLET button', () => {
    render(
      <MemoryRouter>
        <Welcome />
      </MemoryRouter>,
    );

    // When Privy is enabled, the legacy buttons are behind the ADVANCED toggle
    const advancedBtn = screen.queryByText('ADVANCED');
    if (advancedBtn) {
      fireEvent.click(advancedBtn);
    }

    expect(screen.getByText('CREATE NEW WALLET')).toBeInTheDocument();
  });

  it('shows the IMPORT SEED PHRASE button', () => {
    render(
      <MemoryRouter>
        <Welcome />
      </MemoryRouter>,
    );

    // When Privy is enabled, the legacy buttons are behind the ADVANCED toggle
    const advancedBtn = screen.queryByText('ADVANCED');
    if (advancedBtn) {
      fireEvent.click(advancedBtn);
    }

    expect(screen.getByText('IMPORT SEED PHRASE')).toBeInTheDocument();
  });

  it('navigates to /create-wallet when CREATE NEW WALLET is clicked', () => {
    render(
      <MemoryRouter>
        <Welcome />
      </MemoryRouter>,
    );

    // When Privy is enabled, expand ADVANCED first
    const advancedBtn = screen.queryByText('ADVANCED');
    if (advancedBtn) {
      fireEvent.click(advancedBtn);
    }

    fireEvent.click(screen.getByText('CREATE NEW WALLET'));

    expect(mockNavigate).toHaveBeenCalledWith('/create-wallet');
  });

  it('navigates to /import-wallet when IMPORT SEED PHRASE is clicked', () => {
    render(
      <MemoryRouter>
        <Welcome />
      </MemoryRouter>,
    );

    // When Privy is enabled, expand ADVANCED first
    const advancedBtn = screen.queryByText('ADVANCED');
    if (advancedBtn) {
      fireEvent.click(advancedBtn);
    }

    fireEvent.click(screen.getByText('IMPORT SEED PHRASE'));

    expect(mockNavigate).toHaveBeenCalledWith('/import-wallet');
  });

  it('displays the version string', () => {
    render(
      <MemoryRouter>
        <Welcome />
      </MemoryRouter>,
    );

    expect(screen.getByText(/PROTOCOL v0\.1\.0/)).toBeInTheDocument();
    expect(screen.getByText(/DEVNET/)).toBeInTheDocument();
  });
});
