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
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import DenominatedUnshield from './DenominatedUnshield';
import { noteTag } from '@/shared/services/noteTag';

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

/** The 1 SOL V3 pool, which is the pool a note's tag is computed against. */
const POOL = '6NUS4E5PhQLxnYca6mCVGs3HcwXcgF1qEZtzm392jrBS';

/**
 * The secrets a note carries on the wire. Synthetic, never a real note: they are
 * the vector TAG-0 pinned (`apps/web/lib/privacy/pool/fixtures/noteTagVector.json`),
 * so the tag these fixtures produce is the one three clients agree on.
 */
const SECRET = 3_141_592_653_589_793_238n;
const NULLIFIER_PREIMAGE = 2_718_281_828_459_045_235n;

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
    pool: POOL,
    secret: SECRET,
    nullifierPreimage: NULLIFIER_PREIMAGE,
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
    pool: POOL,
    secret: SECRET + 1n,
    nullifierPreimage: NULLIFIER_PREIMAGE,
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

/**
 * WHAT THIS SCREEN CALLS A NOTE.
 *
 * The picker read `leaf {note.leafIndex}` (lines 204 and 235 before EXT-UI). The
 * leaf index is the position of the deposit that created the note, published by
 * the pool's `LeafInserted` event together with the wallet that paid for it and
 * the slot it landed in — so a screenshot of this screen, or a support ticket
 * with one attached, named the deposit. Rows are now named by the tag of the
 * note's secrets (`shared/services/noteLabel.ts`, `noteLabel.test.ts`).
 *
 * The invariance case is what carries the property: two notes that differ only
 * in what a chain reader can already see must render the same text. A canary
 * pins one value; this fails for any value derived from the leaf, the commitment
 * or the shield time, however it is later spelled. Its positive control is a
 * pair that differs in the amount and must therefore render differently.
 */
describe('the note is named by its tag, not by its leaf', () => {
  /** The canary the plan names, and a commitment whose head would show as a prefix. */
  const CANARY_LEAF = 987654;
  const CANARY_COMMITMENT = '1357913579135791357';

  const canaryNote = (over: Record<string, unknown> = {}) => ({
    ...blindedNote(),
    commitment: { toString: () => CANARY_COMMITMENT },
    leafIndex: CANARY_LEAF,
    ...over,
  });

  const tagOf = (n: { pool: string; secret: bigint; nullifierPreimage: bigint }) =>
    noteTag({ pool: n.pool, secret: n.secret, nullifierPreimage: n.nullifierPreimage }).text;

  it('one note: the tag is on screen and the leaf is not', () => {
    const only = canaryNote();
    notes = [only];
    const { container } = view();
    const text = container.textContent ?? '';

    expect(text).toContain(tagOf(only));
    expect(text).not.toContain(String(CANARY_LEAF));
    expect(text).not.toContain('13579135');
    expect(text).not.toMatch(/leaf\s*#?\s*\d/i);
  });

  it('several notes: every row is named, and the names differ', () => {
    const a = canaryNote();
    const b = canaryNote({
      commitment: { toString: () => 'note-other' },
      leafIndex: 424242,
      secret: SECRET + 7n,
    });
    notes = [a, b];
    const { container } = view();
    const text = container.textContent ?? '';

    expect(text).toContain(tagOf(a));
    expect(text).toContain(tagOf(b as never));
    expect(tagOf(a)).not.toBe(tagOf(b as never));
    expect(text).not.toContain(String(CANARY_LEAF));
    expect(text).not.toContain('424242');
    expect(text).not.toMatch(/leaf\s*#?\s*\d/i);
  });

  it('renders the same text for two notes that differ only in leaf, commitment and shield time', () => {
    notes = [canaryNote()];
    const first = view();
    const textA = first.container.textContent ?? '';
    const htmlA = first.container.innerHTML;
    first.unmount();

    notes = [
      canaryNote({
        commitment: { toString: () => '9999999999999999999' },
        leafIndex: 12,
        shieldedAt: Date.now() - 172_800_000,
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

    // Positive control: the comparison can still see a difference.
    notes = [canaryNote({ denominationHuman: 10, denomination: 10_000_000_000n })];
    const third = view();
    expect(third.container.textContent ?? '').not.toBe(textA);
  });
});

/**
 * THE PICKER ROWS, NOT ONLY THE SINGLE-NOTE PANEL (EXT-UI fix round 1).
 *
 * The invariance case above renders ONE note, so it only walks the
 * `notes.length === 1` panel. The round-1 verifier added a commitment suffix and
 * `#${leafIndex % 1000}` to the multi-note rows and every test stayed green
 * (`wp-logs/verify/EXT-UI-r1-mut/mutants.log`, U1 and U2). This case renders two
 * notes, then the same two with only their leaf, commitment and shield time
 * changed, and asks for the same text.
 */
describe('the picker rows are named by their tag, not by their leaf', () => {
  const pair = (world: 'a' | 'b', over: Record<string, unknown> = {}) => [
    {
      ...blindedNote(),
      commitment: { toString: () => (world === 'a' ? '1357913579135791357' : '8642086420864208642') },
      leafIndex: world === 'a' ? 987654 : 555333,
      shieldedAt: world === 'a' ? 1_700_000_000_000 : 1_500_000_000_000,
    },
    {
      ...blindedNote(),
      secret: SECRET + 7n,
      commitment: { toString: () => (world === 'a' ? '2468024680246802468' : '9753197531975319753') },
      leafIndex: world === 'a' ? 424242 : 131313,
      shieldedAt: world === 'a' ? 1_700_000_100_000 : 1_500_000_100_000,
      ...over,
    },
  ];

  it('renders the same text for two note lists that differ only in leaf, commitment and shield time', () => {
    notes = pair('a');
    const first = view();
    const textA = first.container.textContent ?? '';
    const htmlA = first.container.innerHTML;
    first.unmount();

    notes = pair('b');
    const second = view();
    const textB = second.container.textContent ?? '';
    const htmlB = second.container.innerHTML;
    second.unmount();

    expect(textB).toBe(textA);
    // Attributes too: a leaf in a title, an aria-label or a colour derived from it
    // changes no text (EXT-UI fix round 2, wp-logs/EXT-UI-fix2/mutants.log).
    expect(htmlB).toBe(htmlA);

    // Positive control: the rows, not only the panel, are read — a change in the
    // SECOND row's amount must show.
    notes = pair('a', { denominationHuman: 10, denomination: 10_000_000_000n });
    const third = view();
    expect(
      within(screen.getByRole('radiogroup', { name: /Note to withdraw/i })).getAllByRole('radio'),
    ).toHaveLength(2);
    expect(third.container.textContent ?? '').not.toBe(textA);
  });
});

/**
 * AN ERROR ON THE WAY TO A WITHDRAWAL NAMES NO LEAF (EXT-UI fix round 1).
 *
 * The screen renders `err.message` (`setError`, the `role="alert"` line). On a
 * note older than the fetched history, `buildMerkleProofFromLeavesV3` threw
 * "target leafIndex 987654 not found …", which put the user's own leaf number on
 * screen (`wp-logs/verify/EXT-UI-r1-closure-probe.log`). The store is a double,
 * so the error is produced by calling the REAL function with that note's leaf
 * missing from the history; only its delivery through the store is doubled.
 */
describe('an error on the way to a withdrawal names no leaf', () => {
  it('shows the history error in words, without the leaf number', async () => {
    const { buildMerkleProofFromLeavesV3 } = await vi.importActual<
      typeof import('@/shared/services/denominatedPool')
    >('@/shared/services/denominatedPool');
    let thrown: unknown;
    try {
      buildMerkleProofFromLeavesV3({ leavesByIndex: [11n, 22n, 33n], targetLeafIndex: 987654 });
    } catch (e) {
      thrown = e;
    }
    // Rethrown as itself if the harness is wrong, never wrapped in an assertion.
    if (!(thrown instanceof Error)) throw new Error('harness: the real function did not throw');
    mockUnshieldNote.mockRejectedValue(thrown);

    notes = [{ ...blindedNote(), leafIndex: 987654 }];
    view();
    fireEvent.change(screen.getByLabelText(/Send to/i), { target: { value: ELSEWHERE } });
    fireEvent.click(screen.getByRole('button', { name: /Withdraw 1 SOL/i }));

    const alert = await screen.findByRole('alert');
    // Positive control: the real message IS what reached the screen.
    expect(alert.textContent).toBe(thrown.message);
    expect(alert.textContent).not.toContain('987654');
    expect(alert.textContent).not.toMatch(/leaf\s*(index)?\s*#?\s*\d/i);
  });
});
