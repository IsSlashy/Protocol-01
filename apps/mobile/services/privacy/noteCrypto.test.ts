/**
 * The note sealing round-trips, and its wire layout is the web's.
 *
 * The other side of every blob this module opens is apps/web's noteCrypto
 * (the issuer seals with it). The sizes pinned here — 32-byte X25519 pub,
 * 1,184-byte ML-KEM-768 pub, 1,088-byte KEM ciphertext, 24-byte nonce — are
 * the web's constants; a drift on either side fails here before it fails on a
 * phone holding a note it cannot open.
 */
import { describe, expect, it } from 'vitest';
import {
  createNoteEncryptionAddress,
  decryptNote,
  encryptNote,
  isEncryptedNoteBlob,
  parseNoteEncryptionAddress,
} from './noteCrypto';

const seed = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
const other = new Uint8Array(32).map((_, i) => (i * 11 + 5) & 0xff);

describe('note sealing (web-compatible)', () => {
  it('derives a p01pq: address of 32 + 1184 bytes from the seed, deterministically', () => {
    const a = createNoteEncryptionAddress(seed);
    expect(a.startsWith('p01pq:')).toBe(true);
    expect(createNoteEncryptionAddress(seed)).toBe(a);
    const parsed = parseNoteEncryptionAddress(a);
    expect(parsed.x25519Pub.length).toBe(32);
    expect(parsed.kemPub.length).toBe(1184);
    expect(createNoteEncryptionAddress(other)).not.toBe(a);
  });

  it('opens what was sealed to it, and refuses another seed', () => {
    const note = JSON.stringify({ version: 1, pool: 'x', leafIndex: 92, commitment: '1' });
    const blob = encryptNote(createNoteEncryptionAddress(seed), new TextEncoder().encode(note));
    expect(isEncryptedNoteBlob(blob)).toBe(true);
    expect(new TextDecoder().decode(decryptNote(seed, blob))).toBe(note);
    expect(() => decryptNote(other, blob)).toThrow(/not addressed to your wallet/);
  });

  it('carries eph(32) + kemCt(1088) + nonce(24) + box before the body', () => {
    const blob = encryptNote(createNoteEncryptionAddress(seed), new Uint8Array(10));
    const raw = Buffer.from(blob.slice('p01enc1:'.length), 'base64');
    // secretbox adds a 16-byte tag
    expect(raw.length).toBe(32 + 1088 + 24 + 16 + 10);
  });
});
