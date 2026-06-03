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
 *
 * ── HARDENING (v2 format, docs/pairing-ledger-spec.md §1A / Finding #2) ────────
 * This box was hardened to close two gaps that the original v1 format had,
 * mirroring the SDK pairing box (packages/privacy-sdk/src/pairing/box.ts):
 *
 *   1. HKDF SALT BINDS THE FULL TRANSCRIPT, not just the static recipient
 *      x25519 pubkey:  salt = SHA-256(ephX25519Pub ‖ x25519Pub ‖ kemPub ‖
 *      kemCiphertext ‖ nonce). v1 keyed HKDF only on the static recipient
 *      x25519Pub, so an attacker could replay a transcript fragment under a
 *      different binding.
 *   2. LOW-ORDER / ALL-ZERO X25519 REJECTION on BOTH encrypt and decrypt. After
 *      nacl.scalarMult, an all-zero shared secret means a small-subgroup /
 *      identity point was supplied (e.g. a malicious recipient address forcing a
 *      known classical secret). We throw rather than silently relying on the KEM
 *      leg alone.
 *
 * BACKWARD COMPATIBILITY (value-bearing notes — must never lose funds):
 *   New blobs are written in the v2 format: a single VERSION byte 0x02 is
 *   prepended inside the base64 payload before the ephemeral pubkey. Decryption
 *   tries v2 first; if the version byte is not 0x02 (or v2 auth fails) it falls
 *   back to the LEGACY v1 layout (no version byte, v1 static-salt HKDF). Because
 *   secretbox is authenticated, a wrong format guess fails cleanly and we move on
 *   — there is no risk of returning wrong plaintext. Old `p01enc1:` notes minted
 *   before this change therefore still decrypt.
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

/** Version byte for the hardened (transcript-bound salt) blob layout. */
const BLOB_VERSION_V2 = 0x02;

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

/** True iff every byte is zero (low-order / identity-point reject). */
function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (let i = 0; i < bytes.length; i++) acc |= bytes[i];
  return acc === 0;
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
 * v2 (HARDENED) hybrid key: HKDF salt binds the FULL transcript
 * (ephX25519Pub ‖ x25519Pub ‖ kemPub ‖ kemCiphertext ‖ nonce). Encrypt and
 * decrypt compute this identically; any swapped pubkey / KEM ciphertext / nonce
 * yields a different key → secretbox.open fails.
 */
function deriveHybridKeyV2(
  classicSecret: Uint8Array,
  kemSecret: Uint8Array,
  ephX25519Pub: Uint8Array,
  x25519Pub: Uint8Array,
  kemPub: Uint8Array,
  kemCiphertext: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  const salt = sha256(
    concatBytes(ephX25519Pub, x25519Pub, kemPub, kemCiphertext, nonce),
  );
  return hkdf(sha256, concatBytes(classicSecret, kemSecret), salt, INFO_HYBRID, 32);
}

/**
 * v1 (LEGACY) hybrid key: HKDF salt = the static recipient x25519Pub only.
 * Retained for decrypt-only backward compatibility with notes minted before the
 * hardening. NOT used to encrypt new notes.
 */
function deriveHybridKeyV1(
  classicSecret: Uint8Array,
  kemSecret: Uint8Array,
  recipientX25519Pub: Uint8Array,
): Uint8Array {
  return hkdf(sha256, concatBytes(classicSecret, kemSecret), recipientX25519Pub, INFO_HYBRID, 32);
}

/**
 * Encrypt `plaintext` to a recipient's p01pq address.
 * Hybrid X25519 + ML-KEM-768 → HKDF (transcript-bound salt) → XSalsa20-Poly1305.
 * Returns the v2 blob:
 *   p01enc1:<base64(0x02 || ephX25519Pub(32) || kemCiphertext(1088) || nonce(24) || ct)>.
 *
 * @throws if the X25519 ECDH produces an all-zero (low-order / identity) shared
 *         secret — i.e. a malicious/garbage recipient public key.
 */
export function encryptNote(address: string, plaintext: Uint8Array): string {
  const { x25519Pub, kemPub } = parseNoteEncryptionAddress(address);

  // X25519 ECDH leg with a fresh ephemeral key.
  const eph = nacl.box.keyPair();
  const classicSecret = nacl.scalarMult(eph.secretKey, x25519Pub);
  if (isAllZero(classicSecret)) {
    eph.secretKey.fill(0);
    throw new Error('Encryption failed: rejected low-order/all-zero X25519 shared secret.');
  }

  // ML-KEM-768 KEM leg.
  const { cipherText: kemCt, sharedSecret: kemSecret } = ml_kem768.encapsulate(kemPub);

  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));

  // Combine both legs → 256-bit symmetric key (secure if EITHER leg holds).
  const key = deriveHybridKeyV2(classicSecret, kemSecret, eph.publicKey, x25519Pub, kemPub, kemCt, nonce);
  const ct = nacl.secretbox(plaintext, nonce, key);

  const blob = BLOB_PREFIX + b64encode(
    concatBytes(Uint8Array.of(BLOB_VERSION_V2), eph.publicKey, kemCt, nonce, ct),
  );

  // Zeroize derived secret material.
  eph.secretKey.fill(0);
  classicSecret.fill(0);
  kemSecret.fill(0);
  key.fill(0);

  return blob;
}

/**
 * Decrypt a p01enc1 blob with the wallet seed (re-derives the recipient keys).
 * Handles BOTH the v2 (hardened, transcript-bound salt) layout and the LEGACY v1
 * layout (static-salt HKDF). secretbox authentication makes the format probe
 * safe — a wrong guess fails cleanly, never returns wrong plaintext.
 * Throws if the blob is not addressed to this wallet or is corrupted.
 */
export function decryptNote(walletSeed: Uint8Array, blob: string): Uint8Array {
  const trimmed = blob.trim();
  if (!trimmed.startsWith(BLOB_PREFIX)) {
    throw new Error('Invalid encrypted note: missing p01enc1: prefix');
  }
  const raw = b64decode(trimmed.slice(BLOB_PREFIX.length));

  const keys = deriveNoteEncryptionKeys(walletSeed);

  // --- v2 attempt: leading version byte 0x02, transcript-bound salt. ---
  const v2Min = 1 + X25519_LEN + KEM_CIPHERTEXT_LEN + NONCE_LEN;
  if (raw.length > v2Min && raw[0] === BLOB_VERSION_V2) {
    try {
      let off = 1;
      const ephPub = raw.slice(off, off += X25519_LEN);
      const kemCt = raw.slice(off, off += KEM_CIPHERTEXT_LEN);
      const nonce = raw.slice(off, off += NONCE_LEN);
      const ct = raw.slice(off);

      const classicSecret = nacl.scalarMult(keys.x25519Sec, ephPub);
      if (!isAllZero(classicSecret)) {
        const kemSecret = ml_kem768.decapsulate(kemCt, keys.kemSec);
        const key = deriveHybridKeyV2(classicSecret, kemSecret, ephPub, keys.x25519Pub, keys.kemPub, kemCt, nonce);
        const pt = nacl.secretbox.open(ct, nonce, key);
        classicSecret.fill(0);
        kemSecret.fill(0);
        key.fill(0);
        if (pt) return pt;
      } else {
        classicSecret.fill(0);
      }
    } catch {
      // fall through to legacy attempt
    }
  }

  // --- v1 (legacy) attempt: no version byte, static-salt HKDF. ---
  const v1Min = X25519_LEN + KEM_CIPHERTEXT_LEN + NONCE_LEN;
  if (raw.length > v1Min) {
    try {
      let off = 0;
      const ephPub = raw.slice(off, off += X25519_LEN);
      const kemCt = raw.slice(off, off += KEM_CIPHERTEXT_LEN);
      const nonce = raw.slice(off, off += NONCE_LEN);
      const ct = raw.slice(off);

      const classicSecret = nacl.scalarMult(keys.x25519Sec, ephPub);
      const kemSecret = ml_kem768.decapsulate(kemCt, keys.kemSec);
      const key = deriveHybridKeyV1(classicSecret, kemSecret, keys.x25519Pub);
      const pt = nacl.secretbox.open(ct, nonce, key);
      classicSecret.fill(0);
      kemSecret.fill(0);
      key.fill(0);
      if (pt) return pt;
    } catch {
      // fall through to the common failure below
    }
  }

  throw new Error('Decryption failed — this note is not addressed to your wallet (or the blob is corrupted).');
}
