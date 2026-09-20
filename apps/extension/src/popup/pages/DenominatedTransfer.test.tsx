/**
 * WHAT THE SEND-A-NOTE SCREEN CALLS A NOTE.
 *
 * The picker showed `leaf {note.leafIndex}` beside each amount (lines 252 and
 * 283 before EXT-UI). A leaf number is the index of the deposit that created the
 * note: anyone with the pool's `LeafInserted` events reads the depositing wallet
 * and the slot straight off it, so a screenshot of this screen names the
 * deposit. It is now named by its tag (`shared/services/noteLabel.ts`).
 *
 * ⚠️ WHAT THIS FILE DOES NOT MEASURE. The store is a double, so nothing here
 * says a transfer proves, submits or hides anything on chain. It measures what
 * this screen puts in front of a camera.
 *
 * The strongest case is not the canary but `two notes that differ only in their
 * public fields render the same text`: a canary pins one spelling of one value,
 * while that case fails for ANY value derived from the leaf, the commitment or
 * the shield time, however it is spelled. It carries its own positive control —
 * a pair that differs in the amount must render DIFFERENT text — so a comparison
 * that could no longer see a difference goes red.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import DenominatedTransfer from './DenominatedTransfer';
import { noteTag } from '@/shared/services/noteTag';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockTransferNote = vi.fn();
let notes: Array<Record<string, unknown>> = [];

const poolState = () => ({
  getNotes: () => notes,
  transferNote: mockTransferNote,
  loading: false,
});

vi.mock('@/shared/store/denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/store/denominatedPool')>();
  return {
    ...actual,
    useDenominatedPoolStore: Object.assign(() => poolState(), { getState: () => poolState() }),
  };
});

const POOL = '6NUS4E5PhQLxnYca6mCVGs3HcwXcgF1qEZtzm392jrBS';
/** The canary the plan names: a leaf number no other digit string collides with. */
const CANARY_LEAF = 987654;
/** A commitment whose head ("13579135") would show if a prefix were rendered. */
const CANARY_COMMITMENT = 1_357_913_579_135_791_357n;

function note(over: Record<string, unknown> = {}) {
  const secret = 3_141_592_653_589_793_238n;
  const nullifierPreimage = 2_718_281_828_459_045_235n;
  const commitment = (over.commitment as bigint) ?? CANARY_COMMITMENT;
  return {
    secret,
    nullifierPreimage,
    depositEpoch: 7_284_991_002_338_477_113n,
    tokenMint: 0n,
    commitment: { toString: () => commitment.toString() },
    leafIndex: CANARY_LEAF,
    denomination: 1_000_000_000n,
    pool: POOL,
    token: 'SOL' as const,
    denominationHuman: 1,
    shieldedAt: 1_700_000_000_000,
    ...over,
  };
}

const tagOf = (n: { pool: string; secret: bigint; nullifierPreimage: bigint }) =>
  noteTag({ pool: n.pool, secret: n.secret, nullifierPreimage: n.nullifierPreimage }).text;

const view = () =>
  render(
    <MemoryRouter>
      <DenominatedTransfer />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  notes = [];
});

describe('the note in the send picker is named by its tag', () => {
  it('one note: the tag is on screen and the leaf is not', () => {
    const only = note();
    notes = [only];
    const { container } = view();
    const text = container.textContent ?? '';

    expect(text).toContain(tagOf(only));
    expect(text).not.toContain(String(CANARY_LEAF));
    expect(text).not.toContain('13579135');
    expect(text).not.toMatch(/leaf\s*#?\s*\d/i);
  });

  it('several notes: every row is named, and none by its leaf', () => {
    const a = note();
    const b = note({
      secret: 1_111_111_111_111_111_111n,
      leafIndex: 424242,
      commitment: 2_468_024_680_246_802_468n,
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

  it('two notes that differ only in leaf, commitment and shield time look identical', () => {
    notes = [note()];
    const first = view();
    const textA = first.container.textContent ?? '';
    const htmlA = first.container.innerHTML;
    first.unmount();

    notes = [
      note({
        leafIndex: 12,
        commitment: 9_999_999_999_999_999_999n,
        shieldedAt: 1_500_000_000_000,
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

    // Positive control: the comparison can still see a difference. Without it,
    // a render that returned nothing would satisfy the case above.
    notes = [note({ denominationHuman: 10, denomination: 10_000_000_000n })];
    const third = view();
    expect(third.container.textContent ?? '').not.toBe(textA);
  });
});

/**
 * THE PICKER ROWS, NOT ONLY THE SINGLE-NOTE PANEL (EXT-UI fix round 1).
 *
 * The invariance case above renders ONE note, so it only walks the
 * `notes.length === 1` panel. The round-1 verifier added a commitment suffix
 * and the shield date to the multi-note rows and every test stayed green
 * (`wp-logs/verify/EXT-UI-r1-mut/mutants.log`, T1 and T2). This case renders two
 * notes, then the same two with only their leaf, commitment and shield time
 * changed, and asks for the same text.
 */
describe('the send picker rows are named by their tag, not by their leaf', () => {
  const pair = (world: 'a' | 'b', over: Record<string, unknown> = {}) => [
    note({
      commitment: world === 'a' ? CANARY_COMMITMENT : 8_642_086_420_864_208_642n,
      leafIndex: world === 'a' ? CANARY_LEAF : 555333,
      shieldedAt: world === 'a' ? 1_700_000_000_000 : 1_500_000_000_000,
    }),
    note({
      secret: 1_111_111_111_111_111_111n,
      commitment: world === 'a' ? 2_468_024_680_246_802_468n : 9_753_197_531_975_319_753n,
      leafIndex: world === 'a' ? 424242 : 131313,
      shieldedAt: world === 'a' ? 1_700_000_100_000 : 1_500_000_100_000,
      ...over,
    }),
  ];

  it('two note lists that differ only in leaf, commitment and shield time look identical', () => {
    notes = pair('a');
    const first = view();
    const textA = first.container.textContent ?? '';
    const htmlA = first.container.innerHTML;
    expect(first.getAllByRole('radio')).toHaveLength(2);
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

    // Positive control: a change in the SECOND row's amount must show.
    notes = pair('a', { denominationHuman: 10, denomination: 10_000_000_000n });
    const third = view();
    expect(third.container.textContent ?? '').not.toBe(textA);
  });
});
