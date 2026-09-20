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
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ShieldedWallet from './ShieldedWallet';
import { noteTag } from '@/shared/services/noteTag';

const mockNavigate = vi.fn();
const mockGetSlot = vi.fn(() => Promise.resolve(10_000_000));
const mockGetConnection = vi.fn(() => ({ getSlot: mockGetSlot }));

/**
 * The RPC, doubled so a request can be COUNTED. The page used to fetch the
 * current slot on mount to drive a "Matures in …" countdown off each note's
 * deposit epoch; EXT-UI removed both. Spreading the real module keeps every
 * other export intact — the confidential store is not mocked in this file and
 * imports from here.
 */
vi.mock('@/shared/services/wallet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/services/wallet')>();
  return { ...actual, getConnection: (...args: unknown[]) => mockGetConnection(...(args as [])) };
});
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

/**
 * The legacy `zk:` notes. The default pair is what every older case expects; the
 * EXT-UI fix-round-1 cases below swap in notes with distinctive commitments and
 * leaf indices, and put the default back after each.
 */
const defaultLegacyNotes = () => [
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
];
let legacyNotes: Array<Record<string, unknown>> = defaultLegacyNotes();

vi.mock('@/shared/store/shielded', () => ({
  useShieldedStore: () => ({
    isInitialized: true,
    isLoading: false,
    shieldedBalance: 2.5,
    notes: legacyNotes,
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
let denomNotes: Array<Record<string, unknown>> = [];
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

/**
 * WHAT THE FUNDS LIST CALLS A NOTE.
 *
 * Each row used to read `Index: {note.index}` with the head of the note's
 * commitment beside it, and a countdown computed from its deposit epoch. All
 * three are values the deposit published: the index and the commitment appear in
 * the pool's `LeafInserted` event, and the epoch dates it. A screenshot of this
 * list therefore named the deposits. Rows are now named by the tag of the note's
 * secrets (`shared/services/noteLabel.ts`, `noteLabel.test.ts`).
 *
 * The canary cases pin one spelling of one value. The invariance case is the one
 * that holds the property: two notes that differ ONLY in what a chain reader can
 * see must render the same text, whatever the row is later rewritten to print.
 * It carries a positive control (a pair differing in the amount must differ) so
 * that a render which stopped producing text cannot pass it.
 */
describe('ShieldedWallet — a note is named by its tag, not by its place in the tree', () => {
  const POOL = '6NUS4E5PhQLxnYca6mCVGs3HcwXcgF1qEZtzm392jrBS';
  /** The canary the plan names. */
  const CANARY_LEAF = 987654;
  /** Its head, "13579135", is what a commitment prefix would show. */
  const CANARY_COMMITMENT = '1357913579135791357';

  /** A note in the shape the STORE persists: decimal strings, not bigints. */
  const storedNote = (over: Record<string, unknown> = {}) => ({
    secret: '3141592653589793238462643383279502884197169399375105820974944592',
    nullifierPreimage: '2718281828459045235360287471352662497757247093699959574966967627',
    depositEpoch: '7284991002338477113',
    tokenMint: '0',
    commitment: CANARY_COMMITMENT,
    leafIndex: CANARY_LEAF,
    denomination: '1000000000',
    pool: POOL,
    token: 'SOL',
    denominationHuman: 1,
    shieldedAt: 1_700_000_000_000,
    ...over,
  });

  const tagOf = (n: Record<string, unknown>) =>
    noteTag({
      pool: n.pool as string,
      secret: n.secret as string,
      nullifierPreimage: n.nullifierPreimage as string,
    }).text;

  const view = () =>
    render(
      <MemoryRouter>
        <ShieldedWallet />
      </MemoryRouter>,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    denomNotes = [];
  });

  it('shows the tag and neither the leaf index nor the commitment', () => {
    const note = storedNote();
    denomNotes = [note];
    const { container } = view();
    const text = container.textContent ?? '';

    expect(text).toContain(tagOf(note));
    expect(text).not.toContain(String(CANARY_LEAF));
    expect(text).not.toContain('13579135');
    expect(text).not.toContain('Index:');
  });

  /**
   * Legacy notes with digits no other text on this screen carries. The first
   * version of this case used the double's `commitment_hash_1`, whose 8-character
   * prefix ("commitme") never contains the string it looked for, so a row that
   * put the prefix back passed (round-1 verifier, mutants L1b and L2b in
   * `wp-logs/verify/EXT-UI-r1-mut/mutants.log`).
   */
  const LEGACY_A = { commitment: '8642086420864208642', nullifier: '7531975319753197531', leafIndex: 555333 };
  const LEGACY_B = { commitment: '2718271827182718271', nullifier: '3141531415314153141', leafIndex: 777111 };
  const legacy = (
    a: Record<string, unknown>,
    b: Record<string, unknown>,
    amounts: [bigint, bigint] = [1_500_000_000n, 1_000_000_000n],
  ) => [
    { amount: amounts[0].toString(), ...a },
    { amount: amounts[1].toString(), ...b },
  ];
  const windows = (s: string, n = 8) =>
    Array.from({ length: Math.max(0, s.length - n + 1) }, (_, k) => s.slice(k, k + n));

  it('shows a legacy zk note by its amount alone', () => {
    // A legacy note has a commitment and a leaf index and no nullifier
    // preimage, so there is nothing to compute a tag from — and neither may
    // stand in for one, whole or in part.
    denomNotes = [];
    legacyNotes = legacy(LEGACY_A, LEGACY_B);
    try {
      const { container } = view();
      const text = container.textContent ?? '';

      expect(text).toContain('1.5000 SOL');
      expect(text).toContain('1.0000 SOL');
      for (const n of [LEGACY_A, LEGACY_B]) {
        for (const w of windows(n.commitment)) expect(text).not.toContain(w);
        for (const w of windows(n.nullifier)) expect(text).not.toContain(w);
        expect(text).not.toContain(String(n.leafIndex));
      }
      expect(text).not.toContain('Index:');
    } finally {
      legacyNotes = defaultLegacyNotes();
    }
  });

  it('renders the same text for two legacy lists that differ only in commitment, nullifier and leaf', () => {
    denomNotes = [];
    try {
      legacyNotes = legacy(LEGACY_A, LEGACY_B);
      const first = view();
      const textA = first.container.textContent ?? '';
      const htmlA = first.container.innerHTML;
      first.unmount();

      legacyNotes = legacy(
        { commitment: '1111122222333334444', nullifier: '5555566666777778888', leafIndex: 3 },
        { commitment: '9999988888777776666', nullifier: '4444433333222221111', leafIndex: 4 },
      );
      const second = view();
      const textB = second.container.textContent ?? '';
      const htmlB = second.container.innerHTML;
      second.unmount();

      expect(textB).toBe(textA);
      // Attributes too: a leaf in a title, an aria-label or a colour derived from it
      // changes no text (EXT-UI fix round 2, wp-logs/EXT-UI-fix2/mutants.log).
      expect(htmlB).toBe(htmlA);

      // Positive control: a different amount on the SECOND legacy row must show.
      legacyNotes = legacy(LEGACY_A, LEGACY_B, [1_500_000_000n, 2_000_000_000n]);
      const third = view();
      expect(third.container.textContent ?? '').not.toBe(textA);
    } finally {
      legacyNotes = defaultLegacyNotes();
    }
  });

  it('renders the same text for two notes that differ only in leaf, commitment and shield time', () => {
    denomNotes = [storedNote()];
    const first = view();
    const textA = first.container.textContent ?? '';
    const htmlA = first.container.innerHTML;
    first.unmount();

    denomNotes = [
      storedNote({
        leafIndex: 12,
        commitment: '9999999999999999999',
        shieldedAt: 1_500_000_000_000,
        depositEpoch: '1618033988749894848204586834365638117720',
      }),
    ];
    const second = view();
    const textB = second.container.textContent ?? '';
    const htmlB = second.container.innerHTML;
    second.unmount();

    expect(textB).toBe(textA);
    // Attributes too: a leaf in a title, an aria-label or a colour derived from it
    // changes no text (EXT-UI fix round 2, wp-logs/EXT-UI-fix2/mutants.log).
    expect(htmlB).toBe(htmlA);

    // Positive control: the comparison still sees a real difference.
    denomNotes = [storedNote({ denominationHuman: 10, denomination: '10000000000' })];
    const third = view();
    expect(third.container.textContent ?? '').not.toBe(textA);
  });

  it('asks the chain for nothing, and dates no note on screen', async () => {
    // The mount used to fetch the current slot to tick a countdown off the
    // note's deposit epoch — a chain read on a screen that needs none, and a
    // deposit time on a screen that should carry none.
    denomNotes = [storedNote({ depositEpoch: '67838' })];
    const { container } = view();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockGetConnection).not.toHaveBeenCalled();
    expect(mockGetSlot).not.toHaveBeenCalled();
    expect(container.textContent ?? '').not.toMatch(/Matur|Ready|✓/);
  });

  it('a failed sync names neither tree root on screen', async () => {
    // EXT-UI fix round 2: the mismatch toast printed a 20-character prefix of
    // the local and the on-chain root (`wp-logs/verify/EXT-UI-r2-verdict.log`).
    const LOCAL = '4242424242424242424242424242424242';
    const ON_CHAIN = '8383838383838383838383838383838383';
    mockSyncFromBlockchain.mockResolvedValueOnce({
      success: false,
      localRoot: LOCAL,
      onChainRoot: ON_CHAIN,
    });
    view();
    fireEvent.click(screen.getByRole('button', { name: /Sync from blockchain/i }));
    const status = await screen.findByRole('status');

    // Positive control: the failure did reach the screen.
    expect(status.textContent ?? '').toMatch(/mismatch|does not match/i);
    for (const root of [LOCAL, ON_CHAIN]) {
      for (const w of windows(root)) expect(status.textContent ?? '').not.toContain(w);
    }
  });
});
