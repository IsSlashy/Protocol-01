// @vitest-environment node
/**
 * Note tag v1, in the extension — the same vector, this client's deserializer.
 *
 * The extension names a note by `Index: {note.index}` and by the head of its
 * commitment (map-B §1, ShieldedWallet.tsx 632-640), both of which lead a
 * reader straight to the `LeafInserted` event of that deposit. The tag replaces
 * that name with one computed from the note's secrets.
 *
 * WHAT THIS FILE ADDS over the web copy of the test: the vector goes through
 * the EXTENSION's own `decodeShareableNote` + `shareableNoteToReceipt`, in the
 * extension's own package, against its own copy of the module. So a tag that
 * only agreed because one package's `@noble/hashes` differs, or because the
 * copies drifted, is caught here rather than on a user's screen.
 *
 * The copies being byte-identical is asserted in
 * `apps/web/lib/privacy/pool/noteTag.test.ts`; the positive control for the
 * leaf/commitment/time independence is in the same web file. This one pins the
 * value and the deserializer path.
 *
 * Runs in the node environment (docblock above): `shareableNoteToReceipt`
 * pulls in the pool tables and @solana/web3.js, exactly as
 * `denominatedPool.test.ts` does.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { NOTE_TAG_DOMAIN, TAG_COLORS, noteTag, noteTagDigest } from './noteTag';
import { decodeShareableNote, shareableNoteToReceipt } from './denominatedPool';

const VECTOR = JSON.parse(
  readFileSync(
    join(__dirname, '../../../../web/lib/privacy/pool/fixtures/noteTagVector.json'),
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

describe('noteTag v1 (extension)', () => {
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

      // The receipt path: the commitment is recomputed from the secrets here,
      // so a note that did not really belong to these secrets is refused.
      const receipt = shareableNoteToReceipt(note);
      const t = noteTag(receipt);
      expect(`${c.label}: ${t.text}`).toBe(`${c.label}: ${VECTOR.tag}`);
      expect(t.color).toBe(VECTOR.color);
    }

    expect(leaves.size).toBeGreaterThan(1);
    expect(commitments.size).toBeGreaterThan(1);
    expect(times.size).toBeGreaterThan(1);
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
