/**
 * The four things a private balance can do, and the one path off it.
 *
 * WHY THIS SUITE EXISTS
 * ─────────────────────
 * Shield, withdraw, send a note and recover were spread across a dashboard and
 * three separate screens, and the only test coverage was `ShieldedWallet.test`
 * asserting that four buttons had four labels. Nothing checked that pressing
 * them reached the store, that a refusal surfaced, or that a note which cannot
 * be spent yet says so.
 *
 * 🚨 THE ASSERTION THAT MATTERS MOST IS THE MATURITY ONE. A freshly shielded
 * note is not spendable until the chain says it is. The old flow let the user
 * find that out as a greyed-out button on a different screen, minutes later,
 * with no reason given. If the countdown regresses, the product's main journey
 * silently becomes "press Subscribe, get nothing, no explanation".
 *
 * ⚠️ These are behaviour tests against mocked stores, not chain tests. They
 * pin that the SCREEN calls the right action with the right argument and
 * renders what comes back. Whether `shieldNote` itself lands on devnet is
 * `liveRelayedShield` and `liveDevnetShield`'s job, and neither can run here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import Shield from './Shield';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

/* ── Store doubles ─────────────────────────────────────────────────────── */

const mockShieldNote = vi.fn();
const mockScan = vi.fn();
const mockSweepAll = vi.fn();
const mockSetError = vi.fn();

/**
 * 🚨 A stored note carries BOTH `denomination` (atomic, bigint) and
 * `denominationHuman` (the number a person reads). A fixture that carries only
 * one of them does not fail loudly — the headline balance quietly renders NaN.
 * That is the exact mistake `Shield.tsx` warns about above its sum, so the
 * doubles here have to be faithful to `SerializedReceipt` on both fields.
 */
function noteFields(denominationHuman: number) {
  return {
    denomination: BigInt(Math.round(denominationHuman * 1e9)),
    denominationHuman,
    token: 'SOL' as const,
  };
}

/** A note the chain would accept a spend of. */
function matureNote(denominationHuman = 1, id = 'commit-mature') {
  return {
    commitment: { toString: () => id },
    ...noteFields(denominationHuman),
    // Well past the maturity window, so `Ready` is not a matter of timing luck.
    shieldedAt: Date.now() - 1000 * 60 * 60 * 24,
    source: undefined,
  };
}

/** A note created seconds ago. The chain will refuse to spend it. */
function freshNote(denominationHuman = 1, id = 'commit-fresh') {
  return {
    commitment: { toString: () => id },
    ...noteFields(denominationHuman),
    shieldedAt: Date.now(),
    source: undefined,
  };
}

let notes: ReturnType<typeof matureNote>[] = [];
let poolError: string | null = null;
let poolLoading = false;
let shieldedInitialized = true;

const poolState = () => ({
  getNotes: () => notes,
  shieldNote: mockShieldNote,
  loading: poolLoading,
  error: poolError,
  setError: mockSetError,
  getMyNoteAddress: () => 'p01pq:abcdef0123456789',
});

vi.mock('@/shared/store/denominatedPool', () => ({
  useDenominatedPoolStore: Object.assign(() => poolState(), {
    getState: () => poolState(),
  }),
}));

vi.mock('@/shared/store/shielded', () => ({
  useShieldedStore: () => ({
    scanStealthPayments: mockScan,
    sweepAllStealthPayments: mockSweepAll,
    isInitialized: shieldedInitialized,
  }),
}));

vi.mock('@/shared/store/wallet', () => ({
  useWalletStore: () => ({ publicKey: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' }),
}));

const view = () => render(<MemoryRouter><Shield /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  notes = [];
  poolError = null;
  poolLoading = false;
  shieldedInitialized = true;
  mockShieldNote.mockResolvedValue({
    txSig: 'sig',
    receipt: { commitment: { toString: () => 'commit-new' } },
  });
  mockScan.mockResolvedValue({ found: 0, amount: 0, payments: [] });
  mockSweepAll.mockResolvedValue({ swept: 0 });
  Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
});

/* ── SHIELD ────────────────────────────────────────────────────────────── */

describe('shield', () => {
  it('shields the open denomination in one press, from this screen', () => {
    // The whole point of the merge: no second screen between the tab and the
    // deposit. If this ever needs a navigate() to complete, the picker has
    // been pulled back out into its own route.
    view();
    fireEvent.click(screen.getByRole('button', { name: /Shield 1 SOL/i }));
    expect(mockShieldNote).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'SOL', denomination: 1 }),
    );
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('refuses a closed denomination and says why, rather than hiding it', async () => {
    // A holder of an older 0.1 note has to be able to see where it lives. The
    // refusal carries the anonymity-set reason, which is the actual argument.
    view();
    fireEvent.click(screen.getByRole('button', { name: /0\.1 SOL/ }));
    await waitFor(() => {
      expect(screen.getByText(/closed to new deposits/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Shield 0\.1 SOL/i })).toBeDisabled();
    expect(mockShieldNote).not.toHaveBeenCalled();
  });

  it('quotes the real cost, including the operator fee', () => {
    // 1.003 to the till plus 1% to the sink. A shield screen that shows the
    // denomination and not the total is the "unclear fees" anti-pattern.
    view();
    expect(screen.getByText(/1\.013 SOL/)).toBeInTheDocument();
    expect(screen.getByText(/None of it comes back/i)).toBeInTheDocument();
  });

  it('surfaces a failure instead of pretending it worked', async () => {
    poolError = 'insufficient funds for rent';
    view();
    expect(await screen.findByRole('alert')).toHaveTextContent('insufficient funds for rent');
  });

  it('disables the button while a deposit is in flight', () => {
    poolLoading = true;
    view();
    expect(screen.getByRole('button', { name: /Shield/i })).toBeDisabled();
  });
});

/* ── MATURITY, AND THE PATH TO SUBSCRIBING ─────────────────────────────── */

describe('the path from a note to a subscription', () => {
  it('offers Subscribe on a mature note and carries the note with it', () => {
    notes = [matureNote(1, 'commit-A')];
    view();
    fireEvent.click(screen.getByRole('button', { name: /^Subscribe$/i }));
    // The note id must travel. Without it the subscribe screen re-asks which
    // note to use, which is the picker this rework deleted.
    expect(mockNavigate).toHaveBeenCalledWith('/subscriptions/new', {
      state: { noteId: 'commit-A' },
    });
  });

  it('refuses a note that the chain will not let you spend yet, with the wait', () => {
    // 🚨 The regression that would hurt most. Not "disabled": disabled AND the
    // reason, on the note itself.
    notes = [freshNote()];
    view();
    expect(screen.getByRole('button', { name: /^Subscribe$/i })).toBeDisabled();
    expect(screen.getByText(/ready in/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Ready$/)).not.toBeInTheDocument();
  });

  it('separates ready from maturing in the summary', () => {
    notes = [matureNote(1, 'a'), freshNote(1, 'b')];
    view();
    expect(screen.getByText(/1 ready to spend, 1 still maturing/i)).toBeInTheDocument();
  });

  it('tells a user with no notes what to do, not just that there are none', () => {
    view();
    expect(screen.getByText(/No notes yet/i)).toBeInTheDocument();
    expect(screen.getByText(/lets you subscribe without naming yourself/i)).toBeInTheDocument();
  });
});

/* ── UNSHIELD / WITHDRAW ───────────────────────────────────────────────── */

describe('withdraw', () => {
  it('reaches the withdraw flow under the shield tab', () => {
    notes = [matureNote()];
    view();
    fireEvent.click(screen.getByRole('button', { name: /Withdraw/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/shield/withdraw');
  });

  it('is unavailable with nothing spendable, rather than failing later', () => {
    notes = [freshNote()];
    view();
    expect(screen.getByRole('button', { name: /Withdraw/i })).toBeDisabled();
  });
});

/* ── TRANSFER / NOTE SHARING ───────────────────────────────────────────── */

describe('note sharing', () => {
  it('reaches send-note under the shield tab', () => {
    notes = [matureNote()];
    view();
    fireEvent.click(screen.getByRole('button', { name: /Send note/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/shield/send-note');
  });

  it('cannot send a note it does not have', () => {
    view();
    expect(screen.getByRole('button', { name: /Send note/i })).toBeDisabled();
  });

  it('can always receive, even with an empty balance', () => {
    // The asymmetry is deliberate: receiving is how an empty wallet stops
    // being empty, so it must never be gated on already having something.
    view();
    const receive = screen.getByRole('button', { name: /Receive/i });
    expect(receive).not.toBeDisabled();
    fireEvent.click(receive);
    expect(mockNavigate).toHaveBeenCalledWith('/shield/receive-note');
  });

  it('publishes the note address so someone can send you one', () => {
    view();
    expect(screen.getByText(/p01pq:abcdef0123456789/)).toBeInTheDocument();
  });
});

/* ── RECOVER ───────────────────────────────────────────────────────────── */

describe('recover', () => {
  it('says nothing about unswept funds until a scan has actually run', () => {
    // An untouched screen must not imply "you have nothing out there". That is
    // an absence the screen has not checked.
    view();
    expect(screen.queryByText(/unswept/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing unswept/i)).not.toBeInTheDocument();
  });

  it('scans and reports an empty result as a checked fact', async () => {
    view();
    fireEvent.click(screen.getByRole('button', { name: /Recover/i }));
    await waitFor(() => expect(mockScan).toHaveBeenCalled());
    expect(await screen.findByText(/Nothing unswept/i)).toBeInTheDocument();
  });

  it('reports what it found and offers to sweep it', async () => {
    mockScan.mockResolvedValue({ found: 2, amount: 0.75, payments: [] });
    view();
    fireEvent.click(screen.getByRole('button', { name: /Recover/i }));
    expect(await screen.findByText(/2 unswept payments, 0\.7500 SOL/i)).toBeInTheDocument();
    // ⚠️ And it says what sweeping costs in privacy, because it moves money to
    // the user's public wallet.
    expect(screen.getByText(/to your wallet, in public/i)).toBeInTheDocument();
  });

  it('sweeps to the connected wallet, never to an address it invented', async () => {
    mockScan.mockResolvedValue({ found: 1, amount: 0.1, payments: [] });
    view();
    fireEvent.click(screen.getByRole('button', { name: /Recover/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Sweep to my wallet/i }));
    await waitFor(() =>
      expect(mockSweepAll).toHaveBeenCalledWith('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'),
    );
  });

  it('is unavailable before the shielded service is up', () => {
    // Pressing it uninitialised returns an empty result, which reads as
    // "nothing to recover" and is a different claim entirely.
    shieldedInitialized = false;
    view();
    expect(screen.getByRole('button', { name: /Recover/i })).toBeDisabled();
  });
});

/* ── LEGACY V1 ─────────────────────────────────────────────────────────── */

describe('the headline balance', () => {
  it('sums only the notes it lists', () => {
    // ⛔ The screen this replaced added retired V1 balance into the headline
    // and called the total spendable, while Home called the same money "no
    // exit, V1 retired". A balance is a promise; this one only counts what
    // the list below it can actually spend.
    notes = [matureNote(1, 'a'), matureNote(1, 'b')];
    view();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText(/2 ready to spend/i)).toBeInTheDocument();
  });
});
