/**
 * Tests for Welcome page
 *
 * The Welcome page is the entry point for new users. Post Privy-removal it
 * presents only the two local-wallet onboarding paths:
 * - Protocol 01 branding with the GlitchLogo
 * - "Create New Wallet" (local seed-based)
 * - "Import Seed Phrase"
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

    expect(screen.getByText('CREATE NEW WALLET')).toBeInTheDocument();
  });

  it('shows the IMPORT SEED PHRASE button', () => {
    render(
      <MemoryRouter>
        <Welcome />
      </MemoryRouter>,
    );

    expect(screen.getByText('IMPORT SEED PHRASE')).toBeInTheDocument();
  });

  it('navigates to /create-wallet when CREATE NEW WALLET is clicked', () => {
    render(
      <MemoryRouter>
        <Welcome />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('CREATE NEW WALLET'));

    expect(mockNavigate).toHaveBeenCalledWith('/create-wallet');
  });

  it('navigates to /import-wallet when IMPORT SEED PHRASE is clicked', () => {
    render(
      <MemoryRouter>
        <Welcome />
      </MemoryRouter>,
    );

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
