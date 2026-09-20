/**
 * Note tag v1, on mobile — the same vector, this client's deserializer.
 *
 * Mobile shows no leaf number by design, but it prints every note's DEPOSIT
 * DATE (map-B §1, denominated-notes.tsx 393-395), which dates the deposit as
 * precisely as the leaf number names it. The tag replaces that name with one
 * computed from the note's secrets.
 *
 * WHAT THIS FILE ADDS over the web copy of the test: the vector goes through
 * MOBILE's own `decodeShareableNote` and `importNote`, in the mobile package,
 * against mobile's own copy of the module.
 *
 * ⚠️ WHY `importNote` IS EXERCISED ON A SECOND POOL STRING. `importNote` looks
 * its pool up by `poolPDA.toBase58()`, and under `test/__mocks__/@solana/web3.js`
 * `toBase58()` returns a base64 slice of a sha256, not base58 — so no real pool
 * address matches in this environment. Rather than skip the import path, the
 * case below asks the mock what it calls the 1 SOL V3 pool, imports a note in
 * THAT pool, and asserts the tag of the receipt is the tag of the fields that
 * went in — and that it differs from the vector, because the pool is part of
 * what a tag names. The pinned vector itself goes through `decodeShareableNote`,
 * which reads the note's own `pool` string and looks nothing up.
 *
 * The copies being byte-identical is asserted in
 * `apps/web/lib/privacy/pool/noteTag.test.ts`; the positive control for the
 * leaf/commitment/time independence is in that same web file.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { NOTE_TAG_DOMAIN, TAG_COLORS, noteTag, noteTagDigest } from './noteTag';
import { ALL_POOLS_V3, decodeShareableNote, importNote } from '../denominatedPool';

const VECTOR = JSON.parse(
  readFileSync(
    join(__dirname, '../../../web/lib/privacy/pool/fixtures/noteTagVector.json'),
    'utf8',
  ),
) as {
  domain: string;
  pool: string;
  secret: string;
  nullifierPreimage: string;
  tag: string;
  color: string;
  digest: string;
  sameTag: Array<{ label: string; blob: string }>;
  otherTag: Array<{
    label: string;
    input: { pool: string; secret: string; nullifierPreimage: string };
    tag: string;
    color: string;
    blob: string;
  }>;
};

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

describe('noteTag v1 (mobile)', () => {
  it('matches the pinned vector, digest and colour included', () => {
    const input = {
      pool: VECTOR.pool,
      secret: VECTOR.secret,
      nullifierPreimage: VECTOR.nullifierPreimage,
    };
    const t = noteTag(input);
    expect(t.text).toBe(VECTOR.tag);
    expect(t.color).toBe(VECTOR.color);
    expect(TAG_COLORS).toContain(t.color);
    expect(NOTE_TAG_DOMAIN).toBe(VECTOR.domain);
    expect(hex(noteTagDigest(input))).toBe(VECTOR.digest);
  });

  it('gives the web-exported blob the same tag, through this client', () => {
    const leaves = new Set<unknown>();
    const commitments = new Set<string>();
    const times = new Set<unknown>();

    for (const c of VECTOR.sameTag) {
      const note = decodeShareableNote(c.blob);
      leaves.add(note.leafIndex);
      commitments.add(note.commitment);
      times.add(note.shieldedAt);
      // The WHOLE decoded note goes in, so leaf, commitment and shield time
      // reach the function (the positive control is in the web copy).
      const whole = { ...note, nullifierPreimage: note.nullifier_preimage };
      const t = noteTag(whole);
      expect(`${c.label}: ${t.text}`).toBe(`${c.label}: ${VECTOR.tag}`);
      expect(t.color).toBe(VECTOR.color);
    }

    expect(leaves.size).toBeGreaterThan(1);
    expect(commitments.size).toBeGreaterThan(1);
    expect(times.size).toBeGreaterThan(1);
  });

  it('survives importNote, and the pool it names is part of the tag', () => {
    const pool = ALL_POOLS_V3.find((p) => p.token === 'SOL' && p.denomination === 1)!;
    const asThisEnvironmentNamesIt = pool.poolPDA.toBase58();

    const note = { ...decodeShareableNote(VECTOR.sameTag[0].blob), pool: asThisEnvironmentNamesIt };
    const receipt = importNote(note);

    const fromReceipt = noteTag(receipt);
    expect(fromReceipt.text).toBe(
      noteTag({
        pool: asThisEnvironmentNamesIt,
        secret: note.secret,
        nullifierPreimage: note.nullifier_preimage,
      }).text,
    );
    expect(receipt.secret.toString()).toBe(VECTOR.secret);
    expect(receipt.nullifierPreimage.toString()).toBe(VECTOR.nullifierPreimage);
    expect(fromReceipt.text).not.toBe(VECTOR.tag);

    // An absolute value, computed outside the module: node:crypto over the same
    // construction as `TAG-0-make-fixture.mjs`, on the pool string this
    // environment names. A constant or empty tag cannot meet it.
    const NUL = Buffer.from([0]);
    const expectedDigest = createHash('sha256')
      .update(Buffer.from(VECTOR.domain, 'utf8'))
      .update(NUL)
      .update(Buffer.from(asThisEnvironmentNamesIt, 'utf8'))
      .update(NUL)
      .update(Buffer.from(VECTOR.secret, 'utf8'))
      .update(NUL)
      .update(Buffer.from(VECTOR.nullifierPreimage, 'utf8'))
      .digest('hex');
    expect(hex(noteTagDigest(receipt))).toBe(expectedDigest);
    expect(fromReceipt.text).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it('moves when the pool or the secret moves', () => {
    for (const c of VECTOR.otherTag) {
      const note = decodeShareableNote(c.blob);
      const t = noteTag({
        pool: note.pool,
        secret: note.secret,
        nullifierPreimage: note.nullifier_preimage,
      });
      expect(`${c.label}: ${t.text}`).toBe(`${c.label}: ${c.tag}`);
      expect(t.color).toBe(c.color);
      expect(t.text).not.toBe(VECTOR.tag);
    }
  });
});
