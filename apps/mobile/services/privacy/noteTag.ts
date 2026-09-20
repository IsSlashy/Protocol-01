/**
 * Note tag v1 — the name a note is shown by.
 *
 * ============================================================================
 * ONE SCHEME, THREE COPIES — this file is byte-identical in
 *   apps/web/lib/privacy/pool/noteTag.ts
 *   apps/extension/src/shared/services/noteTag.ts
 *   apps/mobile/services/privacy/noteTag.ts
 * and `apps/web/lib/privacy/pool/noteTag.test.ts` reads all three off disk and
 * asserts that ("the three clients carry the same file, byte for byte"). Edit
 * one, edit all three, or that test goes red.
 * ============================================================================
 *
 *   digest = sha256( utf8("p01:note-tag:v1") || 0x00
 *                  || utf8(pool)             || 0x00
 *                  || utf8(secret)           || 0x00
 *                  || utf8(nullifier_preimage) )
 *   text   = Crockford base32 of the top 40 bits, grouped as XXXX-XXXX
 *   color  = TAG_COLORS[digest[5] mod TAG_COLORS.length]
 *
 * `secret` and `nullifier_preimage` are the DECIMAL strings a note already
 * carries on the wire (`ShareableNote`), so a bigint and its decimal string
 * name the same note; `pool` is the pool PDA in base58.
 *
 * WHY IT EXISTS. A note has to be called something on screen, and today the
 * three clients call it by its leaf number, by its commitment, or by the date
 * it was shielded. Each of those is published by the deposit that created the
 * leaf, so a screenshot, a screen share or a support ticket hands the reader
 * the row of the chain that names who deposited it and when. The tag is a
 * function of the note's SECRETS only: it names the note to the person holding
 * it and to nobody else reading the chain.
 *
 * The scheme is pinned by a vector shared with the other two clients:
 * `apps/web/lib/privacy/pool/fixtures/noteTagVector.json`, re-checked by
 * `noteTag.test.ts` in each of the three packages.
 *
 * WHAT IT IS NOT.
 *  - It is not a secret. Anyone who can derive a note's secrets can compute its
 *    tag, which for a note issued out of the deployment's inventory includes
 *    the deployment, for as long as that seed exists (LEAK-LEDGER D5).
 *  - It is not an identifier the protocol reads. Nothing signs, spends or
 *    selects a note by its tag; a spend still goes through the commitment and
 *    the nullifier. So a collision is a display matter, not a fund-loss one:
 *    40 bits collide at about n^2 / 2^41, which for the tens of notes a client
 *    holds is far below one in a million ("names no public identifier of the
 *    note" pins the format, not the collision rate — that is arithmetic).
 *  - It is not an integrity check. It does not depend on the commitment, so it
 *    is the same before and after a note is imported, and it cannot tell a
 *    valid note from a corrupted one. `importNote` still does that.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/** Domain separation. A v2 scheme gets a new string, never a new field order. */
export const NOTE_TAG_DOMAIN = 'p01:note-tag:v1';

/**
 * Crockford base32: no I, L, O or U, so a tag read aloud or copied off a screen
 * cannot land on a neighbouring character. Same alphabet as the license key
 * (`lib/privacy/license.ts`), so one reading rule covers both.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The separator byte between fields. A pool PDA and a decimal never carry it. */
const SEPARATOR = new Uint8Array([0]);

/** How many bits of the digest the text carries: 40 bits = 8 base32 characters. */
const TAG_BYTES = 5;

/** Which digest byte picks the colour dot. */
const COLOR_BYTE = 5;

/**
 * The dot beside the text. Eight hues, each legible on a light and on a dark
 * background; the dot is a fast visual match, the text is the name.
 */
export const TAG_COLORS: readonly string[] = [
  '#d4553f',
  '#d98324',
  '#b8960f',
  '#4f9d4f',
  '#2f9c94',
  '#3b7fd4',
  '#7a5cd6',
  '#c44f9b',
];

/** The note fields a tag is computed from. Nothing else is read. */
export interface NoteTagInput {
  /** Pool PDA, base58 — the `pool` field a note already carries. */
  pool: string;
  /** The note secret, as a bigint or its decimal string. */
  secret: bigint | string;
  /** The note nullifier preimage, as a bigint or its decimal string. */
  nullifierPreimage: bigint | string;
}

/** What a screen shows for a note. */
export interface NoteTag {
  /** `XXXX-XXXX`, Crockford base32 of the top 40 bits of the digest. */
  text: string;
  /** `#rrggbb`, one of TAG_COLORS. */
  color: string;
}

/**
 * Normalise a field element to the decimal string the digest is taken over, so
 * that a bigint, its decimal string and a zero-padded decimal string all name
 * the same note.
 */
function toDecimal(value: bigint | string, field: string): string {
  let v: bigint;
  if (typeof value === 'bigint') {
    v = value;
  } else {
    const s = String(value).trim();
    if (!/^[0-9]+$/.test(s)) {
      throw new Error('noteTag: ' + field + ' must be a decimal integer');
    }
    v = BigInt(s);
  }
  if (v < 0n) throw new Error('noteTag: ' + field + ' must not be negative');
  return v.toString();
}

/** Crockford base32 of the top 40 bits, grouped as XXXX-XXXX. */
function crockford40(digest: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < TAG_BYTES; i++) {
    value = (value << 8) | digest[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD.charAt((value >>> bits) & 0x1f);
    }
  }
  return out.slice(0, 4) + '-' + out.slice(4);
}

/**
 * The full 32-byte digest. Exposed so a test can assert the exact bytes rather
 * than only the eight characters that survive into the text.
 */
export function noteTagDigest(input: NoteTagInput): Uint8Array {
  const pool = String(input.pool).trim();
  if (pool.length === 0) throw new Error('noteTag: pool is required');
  return sha256(
    concatBytes(
      utf8ToBytes(NOTE_TAG_DOMAIN),
      SEPARATOR,
      utf8ToBytes(pool),
      SEPARATOR,
      utf8ToBytes(toDecimal(input.secret, 'secret')),
      SEPARATOR,
      utf8ToBytes(toDecimal(input.nullifierPreimage, 'nullifierPreimage')),
    ),
  );
}

/** The tag a screen shows for a note. One SHA-256, no RPC, no chain read. */
export function noteTag(input: NoteTagInput): NoteTag {
  const digest = noteTagDigest(input);
  return {
    text: crockford40(digest),
    color: TAG_COLORS[digest[COLOR_BYTE] % TAG_COLORS.length],
  };
}
