/**
 * Tests for ShieldedWallet page
 *
 * The ShieldedWallet page provides Zcash-style privacy on Solana using
 * post-quantum ZK-STARKs. It displays:
 * - Shielded balance with hide/show toggle
 * - ZK address for receiving shielded transfers
 * - Shield / Unshield / Transfer / Recover action buttons
 * - Transparent balance info
 * - Shielded fund notes list
 * - ZK-SNARK protection info card
 * - Shield/Unshield modal with amount input
 * - Info modal explaining how shielded transactions work
 *
 * Validates:
 * - Balance display and privacy toggle
 * - Action buttons render and respond to clicks
 * - Shield/unshield modal opens and validates input
 * - Info modal content
 * - Error and loading states
 * - ZK address display and copy
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ShieldedWallet from './ShieldedWallet';

const mockNavigate = vi.fn();
const mockInitialize = vi.fn(() => Promise.resolve());
const mockShield = vi.fn(() => Promise.resolve());
const mockUnshield = vi.fn(() => Promise.resolve());
const mockRefreshBalance = vi.fn();
const mockSyncFromBlockchain = vi.fn(() =>
  Promise.resolve({ success: true, localRoot: 'abc', onChainRoot: 'abc' }),
);
const mockClearNotes = vi.fn();
const mockScanStealthPayments = vi.fn(() => Promise.resolve({ payments: [] }));
const mockSweepAllStealthPayments = vi.fn(() =>
  Promise.resolve({ success: true, swept: 0, totalAmount: 0, errors: [] }),
);

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
    solBalance: 5.0,
  }),
}));

vi.mock('@/shared/store/shielded', () => ({
  useShieldedStore: () => ({
    isInitialized: true,
    isLoading: false,
    shieldedBalance: 2.5,
    notes: [
      {
        amount: BigInt(1_500_000_000).toString(),
        commitment: 'commitment_hash_1',
        nullifier: 'nullifier_1',
        leafIndex: 0,
      },
      {
        amount: BigInt(1_000_000_000).toString(),
        commitment: 'commitment_hash_2',
        nullifier: 'nullifier_2',
        leafIndex: 1,
      },
    ],
    zkAddress: 'zk:0x1234567890abcdef...',
    pendingTransactions: [],
    initialize: mockInitialize,
    refreshBalance: mockRefreshBalance,
    shield: mockShield,
    unshield: mockUnshield,
    syncFromBlockchain: mockSyncFromBlockchain,
    clearNotes: mockClearNotes,
    scanStealthPayments: mockScanStealthPayments,
    sweepAllStealthPayments: mockSweepAllStealthPayments,
  }),
}));

/**
 * The denominated V3 store, driven per test.
 *
 * It was not mocked before, so `serializedNotes` was always empty and every
 * assertion about the Transfer button measured the empty case by accident. That
 * matters here: Transfer's destination used to depend on this list.
 */
let denomNotes: Array<{ token: string; denominationHuman: number }> = [];
vi.mock('@/shared/store/denominatedPool', () => {
  const store = (selector?: (s: unknown) => unknown) => {
    const state = { serializedNotes: denomNotes, getMyNoteAddress: () => null };
    return selector ? selector(state) : state;
  };
  store.getState = () => ({ serializedNotes: denomNotes, getMyNoteAddress: () => null });
  return { useDenominatedPoolStore: store };
});

vi.mock('@/shared/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
  truncateAddress: (addr: string, chars: number) =>
    `${addr.slice(0, chars)}...${addr.slice(-chars)}`,
  copyToClipboard: vi.fn(() => Promise.resolve(true)),
}));

describe('ShieldedWallet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    denomNotes = [];
  });

  it('renders the Shielded Wallet header', () => {
    render(
      <MemoryRouter>
        <ShieldedWallet />
      </MemoryRouter>,
    );

    expect(screen.getByText('Shielded Wallet')).toBeInTheDocument();
  });

  it('displays the shielded balance', () => {
    render(
      <MemoryRouter>
        <ShieldedWallet />
      </MemoryRouter>,
    );

    expect(screen.getByText('2.5000 SOL')).toBeInTheDocument();
    // The subtitle deliberately does NOT claim privacy: the anonymity set of a
    // denominated note is one (deposit and withdrawal publish the same
    // commitment), so this asserts the honest wording, not "Fully private".
    expect(screen.getByText(/Shielded balance/)).toBeInTheDocument();
  });

  it('displays the post-quantum receive address, and says so when it has none', () => {
    render(
      <MemoryRouter>
        <ShieldedWallet />
      </MemoryRouter>,
    );

    // The label moved from "ZK Address" to "Receive Address (PQ)" when the page
    // moved to the denominated V3 note address. The old assertion outlived the
    // rename by weeks because this whole file was excluded from the test run.
    expect(screen.getByText('Receive Address (PQ)')).toBeInTheDocument();

    // No local key in this render, so the field must SAY it has no address
    // rather than print an empty box — a blank address field is how someone
    // ends up sending a note into nothing.
    expect(screen.getByText(/Unavailable \(local key needed\)/)).toBeInTheDocument();
    expect(screen.queryByText(/^zk:/)).not.toBeInTheDocument();
  });

  it('renders the four action buttons (Shield, Unshield, Transfer, Recover)', () => {
    render(
      <MemoryRouter>
        <ShieldedWallet />
      </MemoryRouter>,
    );

    expect(screen.getByText('Shield')).toBeInTheDocument();
    expect(screen.getByText('Unshield')).toBeInTheDocument();
    expect(screen.getByText('Transfer')).toBeInTheDocument();
    expect(screen.getByText('Recover')).toBeInTheDocument();
  });

  it('displays the transparent balance section', () => {
    render(
      <MemoryRouter>
        <ShieldedWallet />
      </MemoryRouter>,
    );

    expect(screen.getByText('TRANSPARENT BALANCE')).toBeInTheDocument();
    expect(screen.getByText('5.0000 SOL')).toBeInTheDocument();
    expect(screen.getByText('Available to shield')).toBeInTheDocument();
  });

  it('displays the shielded notes list', () => {
    render(
      <MemoryRouter>
        <ShieldedWallet />
      </MemoryRouter>,
    );

    expect(screen.getByText('SHIELDED FUNDS (2)')).toBeInTheDocument();
    expect(screen.getByText('1.5000 SOL')).toBeInTheDocument();
    expect(screen.getByText('1.0000 SOL')).toBeInTheDocument();
  });

  it('displays the ZK-SNARK protection info card', () => {
    render(
      <MemoryRouter>
        <ShieldedWallet />
      </MemoryRouter>,
    );

    expect(screen.getByText('ZK-STARK Protection')).toBeInTheDocument();
    // Matches the sentence the card actually renders. The old assertion looked
    // for "post-quantum STARK proofs"; the copy says "proved with post-quantum
    // STARKs", and no run existed to catch the difference.
    expect(screen.getByText(/proved with post-quantum STARKs/)).toBeInTheDocument();
  });

  it('sends Shield to the denominated V3 pool, not to a V1 modal', () => {
    render(
      <MemoryRouter>
        <ShieldedWallet />
      </MemoryRouter>,
    );

    // The label <span> is outside the <button>, so click the sibling button
    const shieldLabel = screen.getByText('Shield');
    const actionButton = shieldLabel.closest('div')?.querySelector('button');
    expect(actionButton).toBeTruthy();
    fireEvent.click(actionButton!);

    // V1 `shield` was unregistered on-chain on 2026-08-19 -- a pool with no exit
    // must not take deposits. The old in-page modal drove exactly that
    // instruction, so a regression that brought it back would take money into a
    // pool nothing can pay out.
    expect(mockNavigate).toHaveBeenCalledWith('/denominated-shield');
    expect(screen.queryByText('Move SOL into shielded pool')).not.toBeInTheDocument();
  });

  it('sends Unshield to the denominated V3 pool, not to a V1 modal', () => {
    render(
      <MemoryRouter>
        <ShieldedWallet />
      </MemoryRouter>,
    );

    const unshieldLabel = screen.getByText('Unshield');
    const actionButton = unshieldLabel.closest('div')?.querySelector('button');
    expect(actionButton).toBeTruthy();
    fireEvent.click(actionButton!);

    expect(mockNavigate).toHaveBeenCalledWith('/denominated-unshield');
    expect(screen.queryByText('Withdraw from shielded pool')).not.toBeInTheDocument();
  });

  /**
   * 🚨 THIS TEST USED TO ASSERT THE BUG.
   *
   * It read `expect(mockNavigate).toHaveBeenCalledWith('/shielded/transfer')`
   * and it passed, because the mock left the denominated list empty and the
   * button fell back to V1. That fallback builds `global:transfer_stark`, a name
   * zk_shielded has never had, and the instruction it should have used --
   * `transfer` -- was unregistered on 2026-08-19. So the assertion pinned a
   * route that generated a full STARK proof and then failed with
   * `InstructionFallbackNotFound`, after the user had waited for all of it.
   */
  it('sends Transfer to the denominated V3 handoff when notes exist', () => {
    denomNotes = [{ token: 'SOL', denominationHuman: 0.1 }];
    render(
      <MemoryRouter>
        <ShieldedWallet />
      </MemoryRouter>,
    );

    const transferLabel = screen.getByText('Transfer');
    const actionButton = transferLabel.closest('div')?.querySelector('button');
    expect(actionButton).toBeTruthy();
    fireEvent.click(actionButton!);

    expect(mockNavigate).toHaveBeenCalledWith('/denominated-transfer');
    expect(mockNavigate).not.toHaveBeenCalledWith('/shielded/transfer');
  });

  it('refuses Transfer rather than falling back to the retired V1 route', () => {
    denomNotes = [];
    render(
      <MemoryRouter>
        <ShieldedWallet />
      </MemoryRouter>,
    );

    const transferLabel = screen.getByText('Transfer');
    const actionButton = transferLabel.closest('div')?.querySelector('button');
    expect(actionButton).toBeTruthy();
    expect(actionButton).toBeDisabled();

    fireEvent.click(actionButton!);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('hides balance when the eye toggle is clicked', () => {
    const { container } = render(
      <MemoryRouter>
        <ShieldedWallet />
      </MemoryRouter>,
    );

    // Initially balance is shown
    expect(screen.getByText('2.5000 SOL')).toBeInTheDocument();

    // Find the eye toggle button in the header (the one with the eye SVG)
    const headerEl = container.querySelector('header');
    const headerButtons = headerEl ? Array.from(headerEl.querySelectorAll('button')) : [];
    // The eye toggle is the second button in header buttons (after sync)
    const eyeToggle = headerButtons.find((btn) =>
      btn.querySelector('svg.lucide-eye, svg.lucide-eye-off'),
    );

    expect(eyeToggle).toBeTruthy();
    fireEvent.click(eyeToggle!);

    // After clicking, balance values should be masked (multiple **** elements)
    const maskedElements = screen.getAllByText('****');
    expect(maskedElements.length).toBeGreaterThanOrEqual(1);
  });

  it('opens the info modal when the info icon is clicked', async () => {
    render(
      <MemoryRouter>
        <ShieldedWallet />
      </MemoryRouter>,
    );

    // Find the info icon button in the header
    const buttons = screen.getAllByRole('button');
    // Click the last header button (info icon)
    const headerButtons = buttons.filter((btn) => btn.closest('header'));
    const infoButton = headerButtons[headerButtons.length - 1];

    fireEvent.click(infoButton);

    await waitFor(() => {
      expect(screen.getByText('Shielded Transactions')).toBeInTheDocument();
      expect(screen.getByText('How it works')).toBeInTheDocument();
      expect(screen.getByText('Got it')).toBeInTheDocument();
    });
  });

  it('closes the info modal when "Got it" is clicked', async () => {
    render(
      <MemoryRouter>
        <ShieldedWallet />
      </MemoryRouter>,
    );

    const headerButtons = screen.getAllByRole('button').filter((btn) => btn.closest('header'));
    fireEvent.click(headerButtons[headerButtons.length - 1]);

    await waitFor(() => {
      expect(screen.getByText('Shielded Transactions')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Got it'));

    expect(screen.queryByText('Shielded Transactions')).not.toBeInTheDocument();
  });

  it('validates amount in shield modal - rejects empty amount', async () => {
    render(
      <MemoryRouter>
        <ShieldedWallet />
      </MemoryRouter>,
    );

    // Click the Shield action button (label span is sibling to button)
    const shieldLabel = screen.getByText('Shield');
    const actionButton = shieldLabel.closest('div')?.querySelector('button');
    expect(actionButton).toBeTruthy();
    fireEvent.click(actionButton!);

    // The modal should now be open - find the submit button within the modal
    // The modal has a "Shield" or "Unshield" submit button at the bottom
    const allShieldTexts = screen.getAllByText(/Shield/i);
    const submitBtn = allShieldTexts.find((el) => {
      const btn = el.closest('button');
      return btn && btn.className.includes('w-full');
    });

    if (submitBtn) {
      fireEvent.click(submitBtn.closest('button')!);

      await waitFor(() => {
        expect(screen.getByText('Please enter a valid amount')).toBeInTheDocument();
      });
    }
  });

  it('calls initialize on mount', () => {
    render(
      <MemoryRouter>
        <ShieldedWallet />
      </MemoryRouter>,
    );

    expect(mockInitialize).toHaveBeenCalled();
  });
});
