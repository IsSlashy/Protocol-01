/**
 * Tests for post-quantum note encryption (hybrid X25519 + ML-KEM-768).
 * No WASM — ml-kem + tweetnacl are pure JS, so jsdom/node both work.
 */
import { describe, it, expect } from 'vitest';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  deriveNoteEncryptionKeys,
  createNoteEncryptionAddress,
  parseNoteEncryptionAddress,
  isNoteEncryptionAddress,
  isEncryptedNoteBlob,
  encryptNote,
  decryptNote,
} from './noteCrypto';

const seedA = new Uint8Array(32).fill(7);
const seedB = new Uint8Array(32).fill(9);

describe('deriveNoteEncryptionKeys', () => {
  it('is deterministic for the same seed', () => {
    const k1 = deriveNoteEncryptionKeys(seedA);
    const k2 = deriveNoteEncryptionKeys(seedA);
    expect(Buffer.from(k1.x25519Pub)).toEqual(Buffer.from(k2.x25519Pub));
    expect(Buffer.from(k1.kemPub)).toEqual(Buffer.from(k2.kemPub));
    expect(Buffer.from(k1.kemSec)).toEqual(Buffer.from(k2.kemSec));
  });

  it('differs for different seeds', () => {
    const k1 = deriveNoteEncryptionKeys(seedA);
    const k2 = deriveNoteEncryptionKeys(seedB);
    expect(Buffer.from(k1.x25519Pub)).not.toEqual(Buffer.from(k2.x25519Pub));
    expect(Buffer.from(k1.kemPub)).not.toEqual(Buffer.from(k2.kemPub));
  });

  it('has correct key sizes (X25519 32, ML-KEM-768 pub 1184)', () => {
    const k = deriveNoteEncryptionKeys(seedA);
    expect(k.x25519Pub.length).toBe(32);
    expect(k.x25519Sec.length).toBe(32);
    expect(k.kemPub.length).toBe(1184);
  });
});

describe('note address', () => {
  it('round-trips the public keys', () => {
    const addr = createNoteEncryptionAddress(seedA);
    expect(addr.startsWith('p01pq:')).toBe(true);
    expect(isNoteEncryptionAddress(addr)).toBe(true);
    const parsed = parseNoteEncryptionAddress(addr);
    const keys = deriveNoteEncryptionKeys(seedA);
    expect(Buffer.from(parsed.x25519Pub)).toEqual(Buffer.from(keys.x25519Pub));
    expect(Buffer.from(parsed.kemPub)).toEqual(Buffer.from(keys.kemPub));
  });

  it('rejects junk', () => {
    expect(isNoteEncryptionAddress('nope')).toBe(false);
    expect(isNoteEncryptionAddress('p01pq:zzzz')).toBe(false);
  });
});

describe('encrypt / decrypt', () => {
  const addrA = createNoteEncryptionAddress(seedA);
  const msg = utf8ToBytes(JSON.stringify({ hello: 'world', n: 123, big: '12345678901234567890' }));

  it('round-trips for the addressed recipient', () => {
    const blob = encryptNote(addrA, msg);
    expect(isEncryptedNoteBlob(blob)).toBe(true);
    const out = decryptNote(seedA, blob);
    expect(Buffer.from(out)).toEqual(Buffer.from(msg));
  });

  it('is non-deterministic (fresh ephemeral + nonce per call)', () => {
    expect(encryptNote(addrA, msg)).not.toBe(encryptNote(addrA, msg));
  });

  it('cannot be decrypted by a different wallet (PQ + classical both bind)', () => {
    const blob = encryptNote(addrA, msg);
    expect(() => decryptNote(seedB, blob)).toThrow(/decryption failed/i);
  });

  it('rejects a tampered ciphertext', () => {
    const blob = encryptNote(addrA, msg);
    const i = blob.length - 5;
    const tampered = blob.slice(0, i) + (blob[i] === 'A' ? 'B' : 'A') + blob.slice(i + 1);
    expect(() => decryptNote(seedA, tampered)).toThrow();
  });

  it('rejects a malformed blob', () => {
    expect(() => decryptNote(seedA, 'p01enc1:short')).toThrow();
    expect(() => decryptNote(seedA, 'not-a-blob')).toThrow(/prefix/i);
  });
});
