/**
 * Session Crypto — Encrypt/decrypt NotePayload for P2P sharing
 *
 * BLE:  nacl.box (X25519 ECDH + XSalsa20-Poly1305) with ephemeral keys
 * NFC:  nacl.secretbox (XSalsa20-Poly1305) with PIN-derived symmetric key
 */

import nacl from 'tweetnacl';
import { Buffer } from 'buffer';
import type {
  NotePayload,
  EncryptedNotePayload,
  SymmetricEncryptedPayload,
} from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// ---------------------------------------------------------------------------
// Ephemeral keypair (BLE sessions)
// ---------------------------------------------------------------------------

export interface EphemeralKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** Generate a fresh X25519 keypair for one session — discarded after use. */
export function generateEphemeralKeyPair(): EphemeralKeyPair {
  return nacl.box.keyPair();
}

// ---------------------------------------------------------------------------
// Asymmetric — BLE (nacl.box)
// ---------------------------------------------------------------------------

/**
 * Encrypt a NotePayload for a specific peer (BLE transport).
 *
 * Uses nacl.box: X25519 ECDH (sender secret × recipient public) + XSalsa20-Poly1305.
 */
export function encryptNote(
  payload: NotePayload,
  recipientPublicKey: Uint8Array,
  senderKeyPair: EphemeralKeyPair,
): EncryptedNotePayload {
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const nonce = nacl.randomBytes(nacl.box.nonceLength);

  const ciphertext = nacl.box(
    plaintext,
    nonce,
    recipientPublicKey,
    senderKeyPair.secretKey,
  );

  if (!ciphertext) {
    throw new Error('BLE encryption failed');
  }

  return {
    epk: toBase64(senderKeyPair.publicKey),
    ct: toBase64(ciphertext),
    n: toBase64(nonce),
    v: 1,
  };
}

/**
 * Decrypt an EncryptedNotePayload received from a BLE peer.
 */
export function decryptNote(
  encrypted: EncryptedNotePayload,
  senderPublicKey: Uint8Array,
  recipientSecretKey: Uint8Array,
): NotePayload {
  const ciphertext = fromBase64(encrypted.ct);
  const nonce = fromBase64(encrypted.n);

  const plaintext = nacl.box.open(
    ciphertext,
    nonce,
    senderPublicKey,
    recipientSecretKey,
  );

  if (!plaintext) {
    throw new Error('BLE decryption failed — corrupted or wrong sender');
  }

  const payload: NotePayload = JSON.parse(
    new TextDecoder().decode(plaintext),
  );

  if (payload.version !== 1) {
    throw new Error(`Unsupported payload version: ${payload.version}`);
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Symmetric — NFC (nacl.secretbox, PIN-derived key)
// ---------------------------------------------------------------------------

/**
 * Derive a 32-byte symmetric key from a 6-digit PIN + rounded timestamp.
 *
 * Both sender and receiver call this with the same PIN and agree on
 * the same minute-rounded timestamp.
 */
export function deriveNfcKey(pin: string, timestampMs?: number): Uint8Array {
  const ts = timestampMs ?? Date.now();
  // Round to current minute for a 60-second agreement window
  const roundedMinute = Math.floor(ts / 60_000);
  const domain = `P01_NFC_${pin}_${roundedMinute}`;
  const hash = nacl.hash(new TextEncoder().encode(domain));
  return hash.slice(0, 32);
}

/**
 * Encrypt a NotePayload for NFC tap-to-share.
 */
export function encryptNoteSymmetric(
  payload: NotePayload,
  key: Uint8Array,
): SymmetricEncryptedPayload {
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);

  const ciphertext = nacl.secretbox(plaintext, nonce, key);

  if (!ciphertext) {
    throw new Error('NFC encryption failed');
  }

  return {
    ct: toBase64(ciphertext),
    n: toBase64(nonce),
    mime: 'application/vnd.p01.note',
    v: 1,
  };
}

/**
 * Decrypt a SymmetricEncryptedPayload received via NFC.
 */
export function decryptNoteSymmetric(
  encrypted: SymmetricEncryptedPayload,
  key: Uint8Array,
): NotePayload {
  const ciphertext = fromBase64(encrypted.ct);
  const nonce = fromBase64(encrypted.n);

  const plaintext = nacl.secretbox.open(ciphertext, nonce, key);

  if (!plaintext) {
    throw new Error('NFC decryption failed — wrong PIN or corrupted');
  }

  const payload: NotePayload = JSON.parse(
    new TextDecoder().decode(plaintext),
  );

  if (payload.version !== 1) {
    throw new Error(`Unsupported payload version: ${payload.version}`);
  }

  return payload;
}

/**
 * Try decrypting with multiple time-window keys to handle minute-boundary
 * race conditions. If the sender encrypted at 12:34:59 and receiver decrypts
 * at 12:35:01, they derive different keys. This tries current, previous,
 * and next minute windows.
 */
export function decryptNoteSymmetricWithRetry(
  encrypted: SymmetricEncryptedPayload,
  pin: string,
): NotePayload {
  const now = Date.now();
  const currentMinute = Math.floor(now / 60_000);
  const ciphertext = fromBase64(encrypted.ct);
  const nonce = fromBase64(encrypted.n);

  // Try current minute, then previous, then next (clock skew)
  for (const offset of [0, -1, 1]) {
    const minuteTs = (currentMinute + offset) * 60_000;
    const key = deriveNfcKey(pin, minuteTs);
    const plaintext = nacl.secretbox.open(ciphertext, nonce, key);
    if (plaintext) {
      const payload: NotePayload = JSON.parse(
        new TextDecoder().decode(plaintext),
      );
      if (payload.version !== 1) {
        throw new Error(`Unsupported payload version: ${payload.version}`);
      }
      return payload;
    }
  }

  throw new Error('NFC decryption failed — wrong PIN or expired time window');
}

// ---------------------------------------------------------------------------
// SHA-256 checksum (integrity)
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hex digest using nacl.hash (SHA-512) truncated to 32 bytes.
 *
 * nacl.hash is SHA-512; we take the first 32 bytes to approximate SHA-256
 * since tweetnacl doesn't ship SHA-256. This is fine for data integrity.
 */
export function computeChecksum(data: string): string {
  const hash = nacl.hash(new TextEncoder().encode(data));
  // First 32 bytes → 64 hex chars
  return Array.from(hash.slice(0, 32))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
