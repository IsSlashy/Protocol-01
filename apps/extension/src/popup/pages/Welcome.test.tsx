/**
 * Tests for Welcome page
 *
 * The Welcome page is the entry point for new users. Post Privy-removal it
 * presents only the local-wallet onboarding paths:
 * - Styx branding with the Wordmark
 * - "Create a new wallet" (local seed-based), the single primary action
 * - "Import a seed phrase", secondary
 * - "Connect with phone", a text link
 *
 * ⚠️ The copy assertions moved to sentence case with the 2026-08-23 design
 * pass. Mono ALL-CAPS button labels are the house style being removed, so the
 * old strings are not restored here.
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
import manifest from '../../../manifest.json';
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

// Mock Wordmark to avoid animation complexity
vi.mock('../components/Wordmark', () => ({
  __esModule: true,
  default: ({ showText }: { showText: boolean; size: number; animated: boolean }) => (
    <div data-testid="wordmark">{showText && 'Styx'}</div>
  ),
}));

describe('Welcome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Styx logo', () => {
    render(
      <MemoryRouter>
        <Welcome />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('wordmark')).toBeInTheDocument();
  });

  it('displays the "Total invisibility" tagline', () => {
    render(
      <MemoryRouter>
        <Welcome />
      </MemoryRouter>,
    );

    expect(screen.getByText('Total invisibility')).toBeInTheDocument();
  });

  it('shows the create wallet button', () => {
    render(
      <MemoryRouter>
        <Welcome />
      </MemoryRouter>,
    );

    expect(screen.getByText('Create a new wallet')).toBeInTheDocument();
  });

  it('shows the import seed phrase button', () => {
    render(
      <MemoryRouter>
        <Welcome />
      </MemoryRouter>,
    );

    expect(screen.getByText('Import a seed phrase')).toBeInTheDocument();
  });

  it('navigates to /create-wallet when the create button is clicked', () => {
    render(
      <MemoryRouter>
        <Welcome />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('Create a new wallet'));

    expect(mockNavigate).toHaveBeenCalledWith('/create-wallet');
  });

  it('navigates to /import-wallet when the import button is clicked', () => {
    render(
      <MemoryRouter>
        <Welcome />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('Import a seed phrase'));

    expect(mockNavigate).toHaveBeenCalledWith('/import-wallet');
  });

  it('displays the version string', () => {
    render(
      <MemoryRouter>
        <Welcome />
      </MemoryRouter>,
    );

    // Pinned to manifest.json rather than to a literal: this assertion was
    // frozen at v0.1.0 while the extension shipped 0.5.0, and nothing caught it
    // because the whole popup suite was excluded from the run. Reading the
    // manifest makes the drift itself the failure.
    expect(
      screen.getByText(new RegExp(`v${manifest.version.replace(/[.]/g, String.fromCharCode(92) + '.')}`)),
    ).toBeInTheDocument();
    expect(screen.getByText(/Devnet/)).toBeInTheDocument();
  });
});
