/**
 * Note tag v1, on the web client — and the drift guard for the other two.
 *
 * WHAT THIS IS FOR. A note is shown on screen by SOME name. Today that name is
 * its leaf number and its commitment on web, its `Index` in the extension, and
 * its deposit date on mobile (map-B §1: 73 hits on 69 lines). Every one of
 * those is published by the deposit that created the leaf, so whoever sees the
 * screen — a screenshot, a screen share, a support ticket — can walk to the
 * `LeafInserted` event and read who funded that deposit and when. The tag is a
 * function of the note's SECRETS, so it names the note to its holder and to
 * nobody reading the chain.
 *
 * WHAT WOULD MAKE THIS TEST WORTHLESS, AND WHAT STOPS IT.
 *  - A tag that quietly depended on the leaf would still pass an equality test
 *    against a single recorded value. So the vector carries FOUR notes that
 *    differ only in leaf index, in commitment and in shield time, and the same
 *    tag is asserted for all four. Each note is handed to `noteTag` WHOLE, as
 *    a screen holds it (leaf, commitment and shield time included), so a
 *    scheme that read any of them would see them. The positive control in the
 *    same case runs the SAME equality rows against three variants of the
 *    module that each also read one public field when the input carries it,
 *    and asserts every variant fails those rows: if the whole note stopped
 *    reaching the function, or the four notes were secretly identical, the
 *    control fails and the case goes red (mutants d and g in
 *    `wp-logs/TAG-0-fix1-mutants.log`).
 *  - A recorded value is not a vector. `fixtures/noteTagVector.json` is built
 *    by a second implementation (node:crypto, `TAG-0-make-fixture.mjs`), not
 *    captured from the module under test.
 *  - Three copies of one scheme drift apart silently. The last case reads all
 *    three off disk and compares the bytes.
 *
 * WHAT IT DOES NOT COVER. It does not show that any SCREEN stopped printing a
 * leaf number: nothing renders the tag yet (EXT-UI, MOB-UI and UI-1 do that).
 * It does not cover a note held in a v2 pool, and it says nothing about who can
 * recompute a tag: whoever holds the note's secrets can, which for an issued
 * note includes the deployment (LEAK-LEDGER D5).
 *
 * Runs under `vitest.pool.config.mts` (node).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { NOTE_TAG_DOMAIN, TAG_COLORS, noteTag, noteTagDigest } from './noteTag';
import type { NoteTag, NoteTagInput } from './noteTag';
import {
  decodeShareableNote,
  encodeShareableNote,
  shareableNoteToReceipt,
} from './denominatedPool';

const VECTOR = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'noteTagVector.json'), 'utf8'),
) as {
  domain: string;
  pool: string;
  secret: string;
  nullifierPreimage: string;
  tag: string;
  color: string;
  digest: string;
  sameTag: Array<{ label: string; note: Record<string, unknown>; blob: string }>;
  otherTag: Array<{
    label: string;
    input: { pool: string; secret: string; nullifierPreimage: string };
    tag: string;
    color: string;
    note: Record<string, unknown>;
    blob: string;
  }>;
};

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** A decoded note as a screen holds it: every field, public ones included. */
type WholeNote = NoteTagInput & Record<string, unknown>;

/**
 * A WRONG scheme, for the positive control: the real tag, except that it also
 * reads one public field of the note whenever the input carries it — the shape
 * of mutants d (leafIndex) and g (shieldedAt) in the verifier's
 * `wp-logs/verify/TAG-0-r1-mutants.log`.
 */
function tagAlsoReading(field: 'leafIndex' | 'commitment' | 'shieldedAt') {
  return (input: WholeNote): NoteTag =>
    input[field] === undefined
      ? noteTag(input)
      : noteTag({ ...input, pool: `${input.pool}|${field}=${String(input[field])}` });
}

const READ = (rel: string): string => readFileSync(join(__dirname, rel), 'utf8');

describe('noteTag v1', () => {
  it('matches the pinned vector, digest and colour included', () => {
    const t = noteTag({
      pool: VECTOR.pool,
      secret: VECTOR.secret,
      nullifierPreimage: VECTOR.nullifierPreimage,
    });
    expect(t.text).toBe(VECTOR.tag);
    expect(t.color).toBe(VECTOR.color);
    expect(TAG_COLORS).toContain(t.color);
    expect(NOTE_TAG_DOMAIN).toBe(VECTOR.domain);
    expect(
      hex(
        noteTagDigest({
          pool: VECTOR.pool,
          secret: VECTOR.secret,
          nullifierPreimage: VECTOR.nullifierPreimage,
        }),
      ),
    ).toBe(VECTOR.digest);
  });

  it('is the same tag for notes that differ only in leaf, commitment or shield time', () => {
    const leaves = new Set<unknown>();
    const commitments = new Set<string>();
    const times = new Set<unknown>();

    // The rows every scheme below is held to. The web client's OWN
    // deserializer, on the encoded note, not on the JSON — and the WHOLE note
    // goes in, so leaf, commitment and shield time all reach the function.
    const rows = (tagOf: (input: WholeNote) => NoteTag) =>
      VECTOR.sameTag.map((c) => {
        const note = decodeShareableNote(c.blob);
        leaves.add(note.leafIndex);
        commitments.add(note.commitment);
        times.add(note.shieldedAt);
        const whole: WholeNote = { ...note, nullifierPreimage: note.nullifier_preimage };
        const t = tagOf(whole);
        return {
          got: `${c.label}: ${t.text}`,
          want: `${c.label}: ${VECTOR.tag}`,
          text: t.text,
          color: t.color,
        };
      });

    for (const r of rows(noteTag)) {
      expect(r.got).toBe(r.want);
      expect(r.color).toBe(VECTOR.color);
    }

    // The vector really does vary the three public identifiers…
    expect(leaves.size).toBeGreaterThan(1);
    expect(commitments.size).toBeGreaterThan(1);
    expect(times.size).toBeGreaterThan(1);

    // …and the SAME rows fail for a scheme that reads any one of them, which is
    // what makes the equalities above a measurement and not a tautology.
    for (const field of ['leafIndex', 'commitment', 'shieldedAt'] as const) {
      const wrong = rows(tagAlsoReading(field));
      const failing = wrong.filter((r) => r.got !== r.want).map((r) => r.got);
      expect(`${field}: ${failing.length > 0}`).toBe(`${field}: true`);
      expect(`${field}: ${new Set(wrong.map((r) => r.text)).size > 1}`).toBe(`${field}: true`);
    }
  });

  it('survives the web deserializer and the receipt it builds', () => {
    for (const c of VECTOR.sameTag) {
      // The blob is exactly what this client's encoder produces.
      expect(encodeShareableNote(decodeShareableNote(c.blob))).toBe(c.blob);
      // …and the note is a real one: the receipt builder recomputes the
      // commitment from the secrets and refuses a mismatch.
      const receipt = shareableNoteToReceipt(decodeShareableNote(c.blob));
      expect(noteTag(receipt).text).toBe(VECTOR.tag);
    }
  });

  it('names no public identifier of the note', () => {
    const text = noteTag({
      pool: VECTOR.pool,
      secret: VECTOR.secret,
      nullifierPreimage: VECTOR.nullifierPreimage,
    }).text;
    expect(text).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

    const runs = (s: string): string[] => {
      const out: string[] = [];
      for (let i = 0; i + 4 <= s.length; i++) out.push(s.slice(i, i + 4));
      return out;
    };
    for (const c of VECTOR.sameTag) {
      const note = decodeShareableNote(c.blob);
      expect(text).not.toContain(String(note.leafIndex));
      for (const form of [
        note.commitment,
        BigInt(note.commitment).toString(16).toUpperCase(),
        String(note.shieldedAt),
      ]) {
        for (const r of runs(form)) expect(text).not.toContain(r);
      }
    }
  });

  it('reads a bigint, a decimal string and a padded decimal as one note', () => {
    const asBigint = noteTag({
      pool: VECTOR.pool,
      secret: BigInt(VECTOR.secret),
      nullifierPreimage: BigInt(VECTOR.nullifierPreimage),
    });
    const padded = noteTag({
      pool: ` ${VECTOR.pool} `,
      secret: `000${VECTOR.secret}`,
      nullifierPreimage: `0${VECTOR.nullifierPreimage}`,
    });
    expect(asBigint.text).toBe(VECTOR.tag);
    expect(padded.text).toBe(VECTOR.tag);
  });

  it('moves when the pool or the secret moves', () => {
    for (const c of VECTOR.otherTag) {
      const t = noteTag(c.input);
      expect(`${c.label}: ${t.text}`).toBe(`${c.label}: ${c.tag}`);
      expect(t.color).toBe(c.color);
      expect(t.text).not.toBe(VECTOR.tag);
      // The same note, read back through this client's deserializer.
      const note = decodeShareableNote(c.blob);
      expect(
        noteTag({
          pool: note.pool,
          secret: note.secret,
          nullifierPreimage: note.nullifier_preimage,
        }).text,
      ).toBe(c.tag);
    }
  });

  it('refuses an input that is not a non-negative integer', () => {
    const base = { pool: VECTOR.pool, nullifierPreimage: VECTOR.nullifierPreimage };
    expect(() => noteTag({ ...base, secret: '' })).toThrow(/secret/);
    expect(() => noteTag({ ...base, secret: '12a' })).toThrow(/secret/);
    expect(() => noteTag({ ...base, secret: '1.5' })).toThrow(/secret/);
    expect(() => noteTag({ ...base, secret: -1n })).toThrow(/secret/);
    expect(() =>
      noteTag({ pool: '   ', secret: VECTOR.secret, nullifierPreimage: VECTOR.nullifierPreimage }),
    ).toThrow(/pool/);
    expect(() =>
      noteTag({ pool: VECTOR.pool, secret: VECTOR.secret, nullifierPreimage: 'x' }),
    ).toThrow(/nullifierPreimage/);
  });

  it('reads no leaf, commitment, time or chain — the code, not the comments', () => {
    const code = READ('noteTag.ts')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^[ \t]*\/\/.*$/gm, ' ');
    for (const banned of [
      'leafIndex',
      'commitment',
      'shieldedAt',
      'depositEpoch',
      'deposit_epoch',
      'merkle',
      'Connection',
      'getAccountInfo',
      'fetch(',
      'Date.now',
      'localStorage',
      'AsyncStorage',
      'console.',
    ]) {
      expect(`${banned} in noteTag.ts code: ${code.includes(banned)}`).toBe(
        `${banned} in noteTag.ts code: false`,
      );
    }
    // The only dependency is the hash.
    const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec.startsWith('@noble/hashes/')).toBe(true);
  });

  it('the three clients carry the same file, byte for byte', () => {
    const lf = (s: string): string => s.replace(/\r\n/g, '\n');
    const web = lf(READ('noteTag.ts'));
    const extension = lf(READ('../../../../extension/src/shared/services/noteTag.ts'));
    const mobile = lf(READ('../../../../mobile/services/privacy/noteTag.ts'));
    expect(web.length).toBeGreaterThan(500);
    expect(extension).toBe(web);
    expect(mobile).toBe(web);
  });
});
