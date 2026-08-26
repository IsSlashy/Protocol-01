/**
 * WHAT THE WITHDRAWAL SCREEN TELLS THE USER, NOW THAT TWO CIRCUITS CAN RUN.
 *
 * 🚨 THIS IS THE HONESTY SURFACE, and it is the half of a circuit-7 rollout that
 * has no compiler. The store can route perfectly and the screen can still say
 * "your withdrawal is private", and nothing in the tree would notice. Both
 * directions are dangerous:
 *   - keep the old copy and a v4 withdrawal is described as republishing a
 *     commitment it does not publish;
 *   - soften it and a v4 withdrawal is described as anonymous, which it is NOT
 *     on this surface — `createWalletSigner` hands the user's own wallet to the
 *     proof upload and to the instruction as payer, so the depositor's signature
 *     is on the withdrawal either way ("v4 seul = FAUX VERT", 2026-08-16).
 *
 * ⚠️ WHAT IT DOES NOT MEASURE. The store is a double here, so nothing below says
 * a proof verifies or a byte is absent from the wire. It says the screen asks
 * the REAL classifier which route a note takes, and renders the matching
 * sentence — `whyCircuit7Cannot` is deliberately NOT mocked, which is what stops
 * this file agreeing with itself.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import DenominatedUnshield from './DenominatedUnshield';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const ELSEWHERE = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

const mockUnshieldNote = vi.fn();
let notes: Array<Record<string, unknown>> = [];

const poolState = () => ({
  getNotes: () => notes,
  unshieldNote: mockUnshieldNote,
  loading: false,
});

/**
 * ⛔ SPREAD, DO NOT REPLACE. The screen imports `whyCircuit7Cannot` from this
 * same module, and that function is the thing under test — a stubbed one would
 * make every assertion below agree with a fixture instead of with the code that
 * ships. Only the store hook is doubled.
 */
vi.mock('@/shared/store/denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/store/denominatedPool')>();
  return {
    ...actual,
    useDenominatedPoolStore: Object.assign(() => poolState(), { getState: () => poolState() }),
  };
});

vi.mock('@/shared/store/wallet', () => ({
  useWalletStore: () => ({ publicKey: WALLET }),
}));

/** MEASURED 2026-08-26: the live epoch is slot/7200 = 67,838. Five digits. */
function preBlindingNote() {
  return {
    commitment: { toString: () => 'note-legacy' },
    depositEpoch: 67_838n,
    leafIndex: 30,
    denomination: 1_000_000_000n,
    denominationHuman: 1,
    token: 'SOL' as const,
    shieldedAt: Date.now() - 86_400_000,
  };
}

/** What `deriveNoteBlinding` puts there instead: a 63-bit PRF draw. */
function blindedNote() {
  return {
    commitment: { toString: () => 'note-blinded' },
    depositEpoch: 7_284_991_002_338_477_113n,
    leafIndex: 41,
    denomination: 1_000_000_000n,
    denominationHuman: 1,
    token: 'SOL' as const,
    shieldedAt: Date.now() - 86_400_000,
  };
}

const view = () =>
  render(
    <MemoryRouter>
      <DenominatedUnshield />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  notes = [];
  mockUnshieldNote.mockResolvedValue({ txSig: 'sig', version: 'v4' });
});

describe('the disclosure follows the note, not the screen', () => {
  it('a circuit-7 note is NOT described as republishing its commitment', () => {
    notes = [blindedNote()];
    view();
    expect(screen.getByText(/keeps the note.s commitment off-chain/i)).toBeInTheDocument();
    expect(screen.queryByText(/points back at your deposit/i)).not.toBeInTheDocument();
  });

  it('and it is NOT described as anonymous either', () => {
    // 🚨 The sentence that must survive every future copy edit. Circuit 7
    // removes the commitment; it does not remove the wallet's signature, and on
    // this client the wallet signs and rents the proof buffer.
    notes = [blindedNote()];
    const { container } = view();
    expect(screen.getByText(/Your wallet still signs this withdrawal/i)).toBeInTheDocument();
    expect(screen.getByText(/It is not anonymous/i)).toBeInTheDocument();
    expect(container.textContent ?? '').not.toMatch(/unlinkable|untraceable|fully private|no one can/i);
  });

  it('a pre-blinding note keeps the old warning, in full', () => {
    // Leaf 30 of the 0.1 SOL pool is one of these, and so is every note ever
    // received through an extension transfer — `prepareTransfer` still mints
    // those with a real epoch. The C1 + C3 pair republishes the commitment and
    // the screen has to keep saying so.
    notes = [preBlindingNote()];
    view();
    expect(screen.getByText(/points back at your deposit/i)).toBeInTheDocument();
    expect(screen.getByText(/predates commitment blinding/i)).toBeInTheDocument();
  });

  it('prices the right number of proof buffers for the route', () => {
    notes = [blindedNote()];
    const { unmount } = view();
    expect(screen.getByText(/one proof buffer where the older pair rents two/i)).toBeInTheDocument();
    unmount();

    notes = [preBlindingNote()];
    view();
    expect(screen.getByText(/Proof rent, about 2 SOL/i)).toBeInTheDocument();
  });
});

describe('the recipient field, now that blank is a refused value', () => {
  it('will not submit with the field empty', () => {
    // Blank used to mean "my own wallet". The store refuses exactly that, so
    // leaving the button enabled would hand the user a red error 0 seconds
    // after a press instead of before it.
    notes = [blindedNote()];
    view();
    expect(screen.getByRole('button', { name: /Withdraw 1 SOL/i })).toBeDisabled();
    expect(mockUnshieldNote).not.toHaveBeenCalled();
  });

  it('says the field is required, and why this wallet is not an answer', () => {
    notes = [blindedNote()];
    view();
    expect(screen.getByText(/Required\. It cannot be this wallet/i)).toBeInTheDocument();
  });

  it('refuses the connected wallet typed out, before any store call', () => {
    notes = [blindedNote()];
    view();
    fireEvent.change(screen.getByLabelText(/Send to/i), { target: { value: WALLET } });
    expect(screen.getByRole('alert')).toHaveTextContent(/wallet paying for this withdrawal/i);
    expect(screen.getByRole('button', { name: /Withdraw 1 SOL/i })).toBeDisabled();
  });

  it('still refuses an address that is not an address', () => {
    notes = [blindedNote()];
    view();
    fireEvent.change(screen.getByLabelText(/Send to/i), { target: { value: 'not-a-key' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/Not a Solana address/i);
  });

  it('sends a third-party payee through, and sends it EXPLICITLY', async () => {
    notes = [blindedNote()];
    view();
    fireEvent.change(screen.getByLabelText(/Send to/i), { target: { value: ELSEWHERE } });
    const button = screen.getByRole('button', { name: /Withdraw 1 SOL/i });
    expect(button).toBeEnabled();
    fireEvent.click(button);

    await waitFor(() => expect(mockUnshieldNote).toHaveBeenCalledTimes(1));
    // ⛔ Not `undefined`. `undefined` still means "my own wallet" inside the
    // store, which is the value it refuses — the address has to be on the call.
    expect(mockUnshieldNote.mock.calls[0][0]).toMatchObject({
      noteId: 'note-blinded',
      recipient: ELSEWHERE,
    });
  });
});
