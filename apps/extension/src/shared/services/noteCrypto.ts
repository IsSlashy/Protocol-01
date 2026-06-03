/**
 * Post-quantum note encryption for denominated transfers.
 *
 * A denominated transfer mints a fresh bearer note (secret + nullifier_preimage).
 * Handing that off in PLAINTEXT means an intercepted blob = stolen funds. This
 * module encrypts the note TO a recipient's published address so an intercepted
 * blob is useless without the recipient's wallet seed.
 *
 * QUANTUM-SAFE BY CONSTRUCTION (not "simple encryption"):
 *   - Key agreement: hybrid X25519 ECDH  +  ML-KEM-768 (FIPS 203, lattice KEM),
 *     combined with HKDF-SHA256. Secure if EITHER leg holds → resists
 *     harvest-now-decrypt-later: the ML-KEM leg is not broken by Shor's
 *     algorithm. (Same primitive set as the stealth hybrid in stealth.ts.)
 *   - Symmetric: XSalsa20-Poly1305 (nacl.secretbox) with a 256-bit key →
 *     Grover only halves it to 128-bit, still secure.
 *   - KDF: HKDF-SHA256 → Grover-safe.
 *
 * The recipient's keypairs are DETERMINISTIC from their 32-byte wallet seed
 * (ML-KEM keygen is seeded with a 64-byte HKDF expansion), so they re-derive
 * them on demand to decrypt — nothing extra to persist.
 *
 * Addresses are public-key material → safe to share. Blobs are ciphertext →
 * safe to intercept.
 */

import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { utf8ToBytes, concatBytes } from '@noble/hashes/utils.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

// --- sizes (bytes) ---
const X25519_LEN = 32;
const KEM_PUBLIC_LEN = 1184;   // ML-KEM-768 public key
const KEM_CIPHERTEXT_LEN = 1088; // ML-KEM-768 ciphertext
const NONCE_LEN = 24;          // XSalsa20-Poly1305 nonce

const ADDRESS_PREFIX = 'p01pq:';
const BLOB_PREFIX = 'p01enc1:';

// HKDF info strings (domain separation).
const INFO_X25519 = utf8ToBytes('p01-note-enc-x25519-v1');
const INFO_MLKEM = utf8ToBytes('p01-note-enc-mlkem-v1');
const INFO_HYBRID = utf8ToBytes('p01-note-enc-hybrid-v1');
const ENC_SALT = utf8ToBytes('p01-note-enc-v1');

export interface NoteEncryptionKeys {
  x25519Pub: Uint8Array;  // 32
  x25519Sec: Uint8Array;  // 32
  kemPub: Uint8Array;     // 1184
  kemSec: Uint8Array;     // 2400
}

// --- base64 helpers (popup + node both have btoa/atob) ---
function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64decode(str: string): Uint8Array {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Deterministically derive the X25519 + ML-KEM-768 note-encryption keypairs
 * from a 32-byte wallet seed. Same seed → same keys, always.
 */
export function deriveNoteEncryptionKeys(walletSeed: Uint8Array): NoteEncryptionKeys {
  const xSeed = hkdf(sha256, walletSeed, ENC_SALT, INFO_X25519, 32);
  const xKp = nacl.box.keyPair.fromSecretKey(xSeed);
  // ML-KEM-768 keygen takes a 64-byte seed (d || z) → deterministic.
  const kemSeed = hkdf(sha256, walletSeed, ENC_SALT, INFO_MLKEM, 64);
  const kem = ml_kem768.keygen(kemSeed);
  return {
    x25519Pub: xKp.publicKey,
    x25519Sec: xKp.secretKey,
    kemPub: kem.publicKey,
    kemSec: kem.secretKey,
  };
}

/** Public receive address (safe to share): p01pq:<base64(x25519Pub || kemPub)>. */
export function createNoteEncryptionAddress(walletSeed: Uint8Array): string {
  const keys = deriveNoteEncryptionKeys(walletSeed);
  return ADDRESS_PREFIX + b64encode(concatBytes(keys.x25519Pub, keys.kemPub));
}

export interface ParsedNoteAddress {
  x25519Pub: Uint8Array;
  kemPub: Uint8Array;
}

export function parseNoteEncryptionAddress(address: string): ParsedNoteAddress {
  if (!address.startsWith(ADDRESS_PREFIX)) {
    throw new Error('Invalid note address: missing p01pq: prefix');
  }
  const raw = b64decode(address.slice(ADDRESS_PREFIX.length).trim());
  if (raw.length !== X25519_LEN + KEM_PUBLIC_LEN) {
    throw new Error(`Invalid note address: expected ${X25519_LEN + KEM_PUBLIC_LEN} bytes, got ${raw.length}`);
  }
  return {
    x25519Pub: raw.slice(0, X25519_LEN),
    kemPub: raw.slice(X25519_LEN, X25519_LEN + KEM_PUBLIC_LEN),
  };
}

export function isNoteEncryptionAddress(s: string): boolean {
  try {
    parseNoteEncryptionAddress(s);
    return true;
  } catch {
    return false;
  }
}

export function isEncryptedNoteBlob(s: string): boolean {
  return s.trim().startsWith(BLOB_PREFIX);
}

/**
 * Encrypt `plaintext` to a recipient's p01pq address.
 * Hybrid X25519 + ML-KEM-768 → HKDF → XSalsa20-Poly1305.
 * Returns p01enc1:<base64(ephX25519Pub(32) || kemCiphertext(1088) || nonce(24) || ct)>.
 */
export function encryptNote(address: string, plaintext: Uint8Array): string {
  const { x25519Pub, kemPub } = parseNoteEncryptionAddress(address);

  // X25519 ECDH leg with a fresh ephemeral key.
  const eph = nacl.box.keyPair();
  const classicSecret = nacl.scalarMult(eph.secretKey, x25519Pub);

  // ML-KEM-768 KEM leg.
  const { cipherText: kemCt, sharedSecret: kemSecret } = ml_kem768.encapsulate(kemPub);

  // Combine both legs → 256-bit symmetric key (secure if EITHER leg holds).
  const key = hkdf(sha256, concatBytes(classicSecret, kemSecret), x25519Pub, INFO_HYBRID, 32);

  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const ct = nacl.secretbox(plaintext, nonce, key);

  return BLOB_PREFIX + b64encode(concatBytes(eph.publicKey, kemCt, nonce, ct));
}

/**
 * Decrypt a p01enc1 blob with the wallet seed (re-derives the recipient keys).
 * Throws if the blob is not addressed to this wallet or is corrupted.
 */
export function decryptNote(walletSeed: Uint8Array, blob: string): Uint8Array {
  const trimmed = blob.trim();
  if (!trimmed.startsWith(BLOB_PREFIX)) {
    throw new Error('Invalid encrypted note: missing p01enc1: prefix');
  }
  const raw = b64decode(trimmed.slice(BLOB_PREFIX.length));
  const min = X25519_LEN + KEM_CIPHERTEXT_LEN + NONCE_LEN;
  if (raw.length <= min) {
    throw new Error('Invalid encrypted note: payload too short');
  }
  let off = 0;
  const ephPub = raw.slice(off, off += X25519_LEN);
  const kemCt = raw.slice(off, off += KEM_CIPHERTEXT_LEN);
  const nonce = raw.slice(off, off += NONCE_LEN);
  const ct = raw.slice(off);

  const keys = deriveNoteEncryptionKeys(walletSeed);
  const classicSecret = nacl.scalarMult(keys.x25519Sec, ephPub);
  const kemSecret = ml_kem768.decapsulate(kemCt, keys.kemSec);
  const key = hkdf(sha256, concatBytes(classicSecret, kemSecret), keys.x25519Pub, INFO_HYBRID, 32);

  const pt = nacl.secretbox.open(ct, nonce, key);
  if (!pt) {
    throw new Error('Decryption failed — this note is not addressed to your wallet (or the blob is corrupted).');
  }
  return pt;
}
