/**
 * Tests for ConnectDapp page
 *
 * The ConnectDapp page handles dApp connection requests from external sites.
 * It shows:
 * - The requesting site's name, origin, and icon
 * - The wallet address the site would be connected to
 * - One sentence describing the whole grant
 * - Cancel and Connect, side by side
 *
 * Validates:
 * - Loading state while fetching approval request
 * - Site info display
 * - That the three pre-ticked permission checkboxes are GONE, and that the
 *   grant sent to the background is unchanged
 * - Correct calls to approve/reject messaging
 *
 * ⚠️ WHY THE COPY ASSERTIONS CHANGED. This screen used monospace capitals as
 * UI labels ("JUPITER EXCHANGE", "P-01 WALLET", "[ CONNECTION REQUEST ]") and
 * offered three permission checkboxes that were pre-ticked, could not
 * meaningfully be unticked, and were never re-asked. The house style is gone
 * and so are the checkboxes; these tests follow the screen rather than pinning
 * it in place.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ConnectDapp from './ConnectDapp';

vi.mock('@/shared/store/wallet', () => ({
  useWalletStore: () => ({
    publicKey: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  }),
}));

// Partial mock: the UI kit imports `cn` from the same module, so replacing the
// whole module leaves every shared component without its class merger.
vi.mock('@/shared/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/utils')>()),
  truncateAddress: (addr: string, chars: number) =>
    `${addr.slice(0, chars)}...${addr.slice(-chars)}`,
}));

const mockApproveRequest = vi.fn(() => Promise.resolve());
const mockRejectRequest = vi.fn(() => Promise.resolve());

vi.mock('@/shared/messaging', () => ({
  approveRequest: (...args: unknown[]) => mockApproveRequest(...args),
  rejectRequest: (...args: unknown[]) => mockRejectRequest(...args),
}));

describe('ConnectDapp', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Pre-load the approval request into chrome.storage.session
    (chrome.storage.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentApproval: {
        id: 'connect-req-1',
        type: 'connect',
        origin: 'https://app.jupiter.exchange',
        originName: 'Jupiter Exchange',
        originIcon: undefined,
        payload: {},
        createdAt: Date.now(),
      },
    });
  });

  it('shows the loading state initially', () => {
    // Override to return empty so loading persists
    (chrome.storage.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({});

    render(
      <MemoryRouter>
        <ConnectDapp />
      </MemoryRouter>,
    );

    expect(screen.getByText('Loading request')).toBeInTheDocument();
  });

  it('displays the dApp name and origin once loaded', async () => {
    render(
      <MemoryRouter>
        <ConnectDapp />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Jupiter Exchange')).toBeInTheDocument();
      expect(screen.getByText('https://app.jupiter.exchange')).toBeInTheDocument();
    });
  });

  it('titles the screen with the action, in sentence case', async () => {
    render(
      <MemoryRouter>
        <ConnectDapp />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Connect' })).toBeInTheDocument();
    });
  });

  it('displays the wallet address that would be connected', async () => {
    render(
      <MemoryRouter>
        <ConnectDapp />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Wallet')).toBeInTheDocument();
      expect(screen.getByText(/7xKXtg\.\.\.osgAsU/)).toBeInTheDocument();
    });
  });

  it('offers no permission checkboxes', async () => {
    render(
      <MemoryRouter>
        <ConnectDapp />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Jupiter Exchange')).toBeInTheDocument();
    });

    // The three pre-ticked boxes were a decision in name only.
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('states the whole grant in one sentence', async () => {
    render(
      <MemoryRouter>
        <ConnectDapp />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        screen.getByText(/see your balance and ask you to approve transactions and subscriptions/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/You can disconnect at any time from Settings/),
      ).toBeInTheDocument();
    });
  });

  it('renders Connect and Cancel', async () => {
    render(
      <MemoryRouter>
        <ConnectDapp />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });
  });

  it('calls rejectRequest and closes window on Cancel', async () => {
    render(
      <MemoryRouter>
        <ConnectDapp />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(mockRejectRequest).toHaveBeenCalledWith('connect-req-1', 'User rejected');
      expect(window.close).toHaveBeenCalled();
    });
  });

  it('calls approveRequest with the full grant on Connect', async () => {
    render(
      <MemoryRouter>
        <ConnectDapp />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    // Unchanged from when all three boxes were ticked, which is the state every
    // real connection was approved in.
    await waitFor(() => {
      expect(mockApproveRequest).toHaveBeenCalledWith('connect-req-1', {
        permissions: expect.arrayContaining([
          'viewBalance',
          'requestTransaction',
          'requestSubscription',
        ]),
      });
    });
  });
});
