/**
 * What a note is CALLED on the extension's screens.
 *
 * Every screen needs a short name for a note: the withdrawal picker, the send
 * picker and the funds list all show several notes at once and the user has to
 * tell them apart. Until now that name was the note's leaf index or the head of
 * its commitment (`ShieldedWallet.tsx` 632-640, `DenominatedUnshield.tsx`
 * 204/235, `DenominatedTransfer.tsx` 252/283). Both of those values are written
 * on chain by the deposit that created the leaf, so a screenshot, a screen share
 * or a support ticket hands the reader the row of the chain that says who
 * deposited it and when.
 *
 * `noteTag` (TAG-0) computes a name from the note's SECRETS instead. This module
 * is the adapter between it and a screen:
 *
 *  - a denominated note carries `pool`, `secret` and `nullifierPreimage`, so it
 *    gets a tag;
 *  - anything else — a legacy `zk:` note, which has an amount and a commitment
 *    and no nullifier preimage — gets `null`, and the screen shows the amount
 *    only;
 *  - a note whose fields are present but malformed also gets `null`. A screen
 *    renders this during React's render pass, and a throw there blanks the whole
 *    popup, which is a worse outcome than an unnamed row.
 *
 * Pinned by `noteLabel.test.ts` (the tag of the shared vector, the invariance
 * over leaf / commitment / shield time, the legacy note, the malformed field,
 * and the store's own receipt through `getNotes()`), and by the render tests of
 * the three screens. `noteIdentifierScan.test.ts` is what keeps the old names
 * from coming back anywhere else in this package.
 */

import { noteTag, type NoteTag } from './noteTag';

/**
 * The fields a name is computed from. Deliberately `unknown`: this is fed both
 * `ShieldReceipt` (bigints) and whatever a legacy note turns out to be, and the
 * point of the function is to answer "can this be named?" without the caller
 * having to know.
 */
export interface TaggableNote {
  pool?: unknown;
  secret?: unknown;
  nullifierPreimage?: unknown;
}

/** A decimal string or a bigint, which is what `noteTag` accepts. */
function decimalish(v: unknown): bigint | string | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string' && /^[0-9]+$/.test(v.trim())) return v.trim();
  return null;
}

/**
 * The name to show for a note, or `null` when this note has no secrets to
 * compute one from. Never throws.
 */
export function noteLabel(note: TaggableNote | null | undefined): NoteTag | null {
  if (!note || typeof note !== 'object') return null;
  const pool = typeof note.pool === 'string' ? note.pool.trim() : '';
  const secret = decimalish(note.secret);
  const nullifierPreimage = decimalish(note.nullifierPreimage);
  if (pool.length === 0 || secret === null || nullifierPreimage === null) return null;
  try {
    return noteTag({ pool, secret, nullifierPreimage });
  } catch {
    // A negative bigint is refused by `noteTag`; see the header for why a
    // render gets `null` rather than the throw.
    return null;
  }
}
