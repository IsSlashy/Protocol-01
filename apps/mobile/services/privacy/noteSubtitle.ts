/**
 * What a note row is allowed to call a note.
 *
 * THE LEAK THIS CLOSES. Mobile shows no leaf number by design
 * (`denominated-notes.tsx:9`), but every row printed the note's DEPOSIT DATE —
 * `denominated-notes.tsx:394`, `denominated-unshield.tsx:519` and `:549` before
 * this change (map-B §1; the `ui-deposit-date` rule of
 * `scratchpad/ux-arch/leaf-surface-scan.mjs` counted 3). A date names a note
 * about as well as a leaf number does: the deposits of any one day are a short
 * list on a pool holding 126 leaves (`probes/logs/01-sizing.log`), so a
 * screenshot, a screen share or a support ticket narrows the note to that list,
 * and the chain says who funded each of those deposits.
 *
 * WHAT REPLACES IT. TAG-0's `noteTag`: `XXXX-XXXX`, a SHA-256 over the note's
 * own secrets and its pool, identical on all three clients. It names the note
 * to the person holding it and to nobody reading the chain.
 *
 * THE RULES, each pinned by a case in `noteSubtitle.test.ts`:
 *  - a subtitle is the caller's lead plus the tag, and nothing else
 *    ("names the note by its tag, and never by the day it was deposited");
 *  - handed a whole stored note, it reads none of the note's public record
 *    ("moves with the tag, not with the note's public record");
 *  - no tag means the lead alone, never a date as a fallback
 *    ("falls back to the lead alone when the secrets cannot be read");
 *  - a clock runs only while the note cannot be spent yet
 *    ("never puts a clock on a note that is not immature").
 *
 * The screens are held to going through here by `test/consolePolicy.test.ts`.
 */

import { noteTag } from './noteTag';

/**
 * The two states in which a note cannot be spent yet, and the only two in which
 * a countdown is shown. Same set as the `waiting` test the notes screen already
 * applied; it lives here so one rule serves every screen.
 */
export const IMMATURE_STATUSES: readonly string[] = ['pending', 'imported'];

/**
 * A stored note, as the screens hold it.
 *
 * Every field below except `status` is ACCEPTED SO A CALLER CAN PASS ITS NOTE
 * WHOLE, and is deliberately read for nothing: each one is published by the
 * deposit that created the leaf, so putting any of them on screen re-links the
 * note to that deposit. The invariance case in `noteSubtitle.test.ts` is what
 * keeps that true.
 */
export interface SubtitleNote {
  status?: string | null;
  shieldedAt?: number | null;
  id?: string | null;
  leafIndex?: number | null;
  commitment?: string | null;
}

/** What a tag is computed from. Nothing else about the note is read. */
export interface NoteSecrets {
  pool: string;
  secret: bigint | string;
  nullifierPreimage: bigint | string;
}

export interface SubtitleParts {
  /** What the row leads with: a source label, or a state label. */
  lead: string;
  /** The note's tag, or null when its secrets could not be read. */
  tag: string | null;
}

export interface CountdownParts {
  /** Milliseconds left, 0 when counted out, negative when not yet known. */
  remainingMs: number;
  fmt: (ms: number) => string;
  /** Shown at exactly 0. */
  ready: string;
  /** The state label, shown whenever a clock would not be truthful. */
  label: string;
}

/** Is this note still waiting out the pool's delay? */
export function isImmature(status?: string | null): boolean {
  return status != null && IMMATURE_STATUSES.includes(status);
}

/**
 * The tag for a note whose secrets are in hand, or null.
 *
 * Null rather than a throw is the point: the ordinary reason a screen has no
 * secrets is a LOCKED VAULT (`utils/crypto/noteVault.ts`), which is a normal
 * state, not an error. A row with no name still renders; a row that threw would
 * take the list with it.
 */
export function noteTagText(secrets?: NoteSecrets | null): string | null {
  if (!secrets) return null;
  try {
    return noteTag(secrets).text;
  } catch {
    return null;
  }
}

/** The second line of a note row: `lead · TAG`, or `lead` when there is no tag. */
export function noteSubtitle(note: SubtitleNote, parts: SubtitleParts): string {
  // `note` is taken whole and read for NOTHING. It is in the signature so that
  // the date, the id, the leaf and the commitment are all in scope here and
  // still do not reach the screen — the regression this module exists to stop
  // is someone reaching for `note.shieldedAt` to fill a gap. Pinned by "moves
  // with the tag, not with the note's public record" in noteSubtitle.test.ts.
  void note;
  return parts.tag ? `${parts.lead} · ${parts.tag}` : parts.lead;
}

/**
 * The state pill's text: a countdown while the note is immature, the state
 * label otherwise.
 *
 * A clock on a note that CAN already be spent would be a maturity countdown
 * with nothing left to count — it would only date the deposit it started from,
 * which is the fact the deposit date leaked. So the status decides, not the
 * number of milliseconds.
 */
export function maturityCountdown(note: SubtitleNote, parts: CountdownParts): string {
  if (!isImmature(note.status)) return parts.label;
  if (parts.remainingMs > 0) return parts.fmt(parts.remainingMs);
  if (parts.remainingMs === 0) return parts.ready;
  // Negative: the slot height is not known yet, so no honest clock exists.
  return parts.label;
}
