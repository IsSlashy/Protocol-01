/**
 * What a note row is allowed to say about a note.
 *
 * THE LEAK THIS CLOSES. Mobile shows no leaf number by design
 * (`denominated-notes.tsx:9`), but until this work every row printed the note's
 * DEPOSIT DATE — `denominated-notes.tsx:394`, `denominated-unshield.tsx:519`
 * and `:549` (map-B §1, and the `ui-deposit-date` rule of
 * `scratchpad/ux-arch/leaf-surface-scan.mjs`, 3 hits before this WP). A date
 * names the note as well as a leaf number does: the deposits of one day are a
 * short list on a pool with 126 leaves (`probes/logs/01-sizing.log`), so a
 * screenshot, a screen share or a support ticket narrows the note to that list.
 * The replacement is TAG-0's `noteTag`, a function of the note's SECRETS only.
 *
 * WHAT THIS FILE MEASURES, and what it does not. It measures the helper the
 * rows now go through. That the rows actually go through it — and that no other
 * date or note identifier is rendered or logged — is measured by reading the
 * screens themselves, in `test/consolePolicy.test.ts`.
 *
 * THE SHAPE OF THE INVARIANCE CASE follows PROTOCOL.md ("A test that measures a
 * leak instead of listing its spellings"): rather than enumerate the spellings
 * of a date, it runs the same row in several WORLDS that differ in exactly one
 * thing — the deposit time, the stored id, the leaf, the commitment — and reads
 * the row by what MOVES it. The case carries its own positive control: a mirror
 * of the old line 394 must SEPARATE the same four notes, so a helper that
 * returned a constant could not pass it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  IMMATURE_STATUSES,
  isImmature,
  maturityCountdown,
  noteSubtitle,
  noteTagText,
} from './noteSubtitle';
import { noteTag } from './noteTag';

/** TAG-0's pinned vector, so this file names the same note as the other clients. */
const VECTOR = JSON.parse(
  readFileSync(
    join(__dirname, '../../../web/lib/privacy/pool/fixtures/noteTagVector.json'),
    'utf8',
  ),
) as { pool: string; secret: string; nullifierPreimage: string; tag: string };

const SECRETS = {
  pool: VECTOR.pool,
  secret: VECTOR.secret,
  nullifierPreimage: VECTOR.nullifierPreimage,
};

/** 2026-09-12T10:30:00Z — a real deposit day for the 1 SOL pool. */
const SHIELDED_AT = Date.UTC(2026, 8, 12, 10, 30, 0);

/** Today's `srcLabel(note)` values, as the screens hand them over. */
const DEPOSITED = 'Deposited';

/**
 * A mirror of what `denominated-notes.tsx:394` rendered before this WP. It is
 * the positive control: every rule below that claims "no date" has to be able
 * to fail, and this is the string it has to fail on.
 */
const oldLine394 = (lead: string, shieldedAt: number): string =>
  `${lead} · ${new Date(shieldedAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })}`;

/** And what `denominated-unshield.tsx:519` rendered: the device's own locale. */
const oldLine519 = (lead: string, shieldedAt: number): string =>
  `${lead} · ${new Date(shieldedAt).toLocaleDateString()}`;

describe('noteSubtitle: a row names a note by its tag', () => {
  it('names the note by its tag, and never by the day it was deposited', () => {
    const note = { status: 'mature', shieldedAt: SHIELDED_AT, id: 'a1b2c3d4e5f60718' };
    const out = noteSubtitle(note, { lead: DEPOSITED, tag: VECTOR.tag });

    expect(out).toBe(`${DEPOSITED} · ${VECTOR.tag}`);

    // Not a list of spellings: the two renderings the screens actually used,
    // asked of this machine's own locale data, must not appear in the output.
    const asShown = oldLine394(DEPOSITED, SHIELDED_AT).split(' · ')[1];
    const asShownLocale = oldLine519(DEPOSITED, SHIELDED_AT).split(' · ')[1];
    expect(out).not.toContain(asShown);
    expect(out).not.toContain(asShownLocale);
    // The control: those renderings are non-empty and DO carry the date, so the
    // two assertions above are not vacuous.
    expect(asShown.length).toBeGreaterThan(2);
    expect(oldLine394(DEPOSITED, SHIELDED_AT)).toContain(asShown);

    // Nor the stored id, which is a commitment prefix
    // (`stores/denominatedPoolStore.ts`, StoredNote.id).
    expect(out).not.toContain('a1b2c3d4');
  });

  it('moves with the tag, not with the note\'s public record', () => {
    // Four worlds. Same secrets — so the same note, as far as its holder is
    // concerned — differing in exactly the fields the chain publishes.
    const worlds: Array<{ label: string; note: Record<string, unknown> }> = [
      { label: 'base', note: { status: 'mature', shieldedAt: SHIELDED_AT, id: 'aaaa1111', leafIndex: 12, commitment: '8901821612542787864' } },
      { label: 'deposited a month earlier', note: { status: 'mature', shieldedAt: Date.UTC(2026, 7, 12, 10, 30, 0), id: 'aaaa1111', leafIndex: 12, commitment: '8901821612542787864' } },
      { label: 'another leaf', note: { status: 'mature', shieldedAt: SHIELDED_AT, id: 'aaaa1111', leafIndex: 99, commitment: '8901821612542787864' } },
      { label: 'another commitment and id', note: { status: 'mature', shieldedAt: SHIELDED_AT, id: 'bbbb2222', leafIndex: 12, commitment: '1111111111111111111' } },
    ];

    const subtitles = new Set(
      worlds.map((w) => noteSubtitle(w.note, { lead: DEPOSITED, tag: VECTOR.tag })),
    );
    expect([...subtitles]).toHaveLength(1);
    // Non-vacuous: the one subtitle really is the tag, not a constant.
    expect([...subtitles][0]).toContain(VECTOR.tag);

    // THE POSITIVE CONTROL. The old line separates the same four notes: if it
    // did not, the fixtures above would not vary and the assertion would prove
    // nothing.
    const asBefore = new Set(
      worlds.map((w) => oldLine394(DEPOSITED, w.note.shieldedAt as number)),
    );
    expect(asBefore.size).toBeGreaterThan(1);
  });

  it('separates two different notes', () => {
    const other = noteTag({ ...SECRETS, secret: '424242424242' }).text;
    const note = { status: 'mature', shieldedAt: SHIELDED_AT };
    expect(other).not.toBe(VECTOR.tag);
    expect(noteSubtitle(note, { lead: DEPOSITED, tag: VECTOR.tag })).not.toBe(
      noteSubtitle(note, { lead: DEPOSITED, tag: other }),
    );
  });

  it('falls back to the lead alone when the secrets cannot be read', () => {
    // A locked vault is the ordinary case here, not an error: the row still has
    // to render, and it must not reach for the date to fill the gap.
    const note = { status: 'pending', shieldedAt: SHIELDED_AT };
    const out = noteSubtitle(note, { lead: DEPOSITED, tag: null });
    expect(out).toBe(DEPOSITED);
    expect(out).not.toContain('·');
    expect(out).not.toContain(oldLine394(DEPOSITED, SHIELDED_AT).split(' · ')[1]);
  });

  it('reads the note\'s secrets, and refuses to invent a tag', () => {
    expect(noteTagText(SECRETS)).toBe(VECTOR.tag);
    // Same note, secrets given as bigints rather than decimal strings.
    expect(
      noteTagText({
        pool: VECTOR.pool,
        secret: BigInt(VECTOR.secret),
        nullifierPreimage: BigInt(VECTOR.nullifierPreimage),
      }),
    ).toBe(VECTOR.tag);
    // And every way of not having a note gives no tag rather than a throw: a
    // row that crashed on a locked vault would be worse than a row with no name.
    expect(noteTagText(null)).toBeNull();
    expect(noteTagText(undefined)).toBeNull();
    expect(noteTagText({ pool: '', secret: '1', nullifierPreimage: '2' })).toBeNull();
    expect(noteTagText({ pool: VECTOR.pool, secret: 'not-a-number', nullifierPreimage: '2' })).toBeNull();
  });
});

describe('maturityCountdown: a clock only while the note cannot be spent', () => {
  const fmt = (ms: number) => `~${Math.ceil(ms / 3_600_000)}h`;
  const parts = { remainingMs: 7_200_000, fmt, ready: 'Ready', label: 'Maturing' };

  it('gives an immature note the wait it is actually in', () => {
    for (const status of IMMATURE_STATUSES) {
      expect(isImmature(status)).toBe(true);
      expect(maturityCountdown({ status }, parts)).toBe('~2h');
    }
    // Counted out, the row says so rather than showing "~0h".
    expect(maturityCountdown({ status: 'pending' }, { ...parts, remainingMs: 0 })).toBe('Ready');
    // Slot height unknown (-1 on this screen): the state label, not a clock.
    expect(maturityCountdown({ status: 'pending' }, { ...parts, remainingMs: -1 })).toBe('Maturing');
  });

  it('never puts a clock on a note that is not immature', () => {
    // A countdown on a spendable note is a maturity clock running backwards to
    // its deposit epoch, which is the same fact the date leaked.
    for (const status of ['mature', 'spent', 'transferred', 'locked']) {
      expect(isImmature(status)).toBe(false);
      expect(maturityCountdown({ status }, parts)).toBe('Maturing');
      expect(maturityCountdown({ status }, parts)).not.toContain('~');
    }
    expect(maturityCountdown({}, parts)).toBe('Maturing');
    expect(maturityCountdown({ status: null }, parts)).toBe('Maturing');
    // The control: the SAME remainingMs does produce a clock for an immature
    // note, so "no clock" above is the status rule and not an empty input.
    expect(maturityCountdown({ status: 'pending' }, parts)).toBe('~2h');
  });
});
