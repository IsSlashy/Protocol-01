/**
 * Hardened hybrid box for DEVICE PAIRING (extension ⇄ mobile).
 *
 * This is a HARDENED SIBLING of the extension's `noteCrypto.ts` hybrid box
 * (docs/pairing-ledger-spec.md §1A / Finding #2), lifted into the SDK so both
 * apps share ONE byte-identical implementation. It is NOT a verbatim copy — it
 * closes two gaps that exist in the value-note box:
 *
 *   1. HKDF SALT BINDS THE FULL TRANSCRIPT, not just the static recipient
 *      x25519 pubkey: salt = SHA-256(ephX25519Pub ‖ x25519Pub ‖ kemPub ‖
 *      kemCiphertext ‖ nonce). An attacker cannot replay a transcript fragment
 *      under a different binding. Domain string: `p01-pair-enc-hybrid-v1`.
 *   2. LOW-ORDER / ALL-ZERO X25519 REJECTION on BOTH encrypt and decrypt. After
 *      `nacl.scalarMult`, an all-zero shared secret means a small-subgroup /
 *      identity point was supplied (e.g. an attacker-chosen QR#1 forcing a known
 *      classical secret). We throw rather than silently fall back to the KEM leg.
 *
 * Crypto core (same primitive set as `noteCrypto.ts`, quantum-safe by
 * construction): X25519 ECDH + ML-KEM-768 (FIPS 203) → HKDF-SHA256 →
 * XSalsa20-Poly1305 (nacl.secretbox). Secure if EITHER key-agreement leg holds,
 * so it resists harvest-now-decrypt-later (the ML-KEM leg is Shor-resistant).
 *
 * Pairing keys are EPHEMERAL and RANDOM (not seed-derived): the receiver is an
 * empty device and generates a fresh bundle per ceremony for forward secrecy.
 * Hence decrypt takes the explicit ephemeral secret keys (unlike
 * `noteCrypto.decryptNote`, which re-derives from a persisted wallet seed).
 */

import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { utf8ToBytes, concatBytes } from '@noble/hashes/utils.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

// ─── sizes (bytes) ────────────────────────────────────────────────────────────
export const X25519_LEN = 32; // X25519 public/secret key
export const KEM_PUBLIC_LEN = 1184; // ML-KEM-768 public key
export const KEM_SECRET_LEN = 2400; // ML-KEM-768 secret key
export const KEM_CIPHERTEXT_LEN = 1088; // ML-KEM-768 ciphertext
export const KEM_SEED_LEN = 64; // ML-KEM-768 keygen seed (d ‖ z)
export const NONCE_LEN = 24; // XSalsa20-Poly1305 nonce
export const SHARED_SECRET_LEN = 32; // both legs' shared secret length
export const SYM_KEY_LEN = 32; // derived symmetric key length

/** Encrypted-pairing-blob prefix. Distinct from the value-note `p01enc1:`. */
export const PAIR_ENC_PREFIX = 'p01pairenc1:';

/** Domain separation for the hybrid HKDF (hardened pairing variant). */
const INFO_HYBRID = utf8ToBytes('p01-pair-enc-hybrid-v1');

/** The receiver's fresh ephemeral receive bundle for one pairing ceremony. */
export interface PairingEphemeralKeys {
  x25519Pub: Uint8Array; // 32
  x25519Sec: Uint8Array; // 32
  kemPub: Uint8Array; // 1184
  kemSec: Uint8Array; // 2400
}

/** Public portion of a receive bundle (what travels in QR#1). */
export interface PairingReceiveBundle {
  x25519Pub: Uint8Array; // 32
  kemPub: Uint8Array; // 1184
}

// ─── base64 (Buffer is available in node + RN + bundled browser builds) ─────────
export function b64encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
export function b64decode(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, 'base64'));
}

/** True iff every byte is zero (used for the low-order/identity-point reject). */
function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (let i = 0; i < bytes.length; i++) acc |= bytes[i] as number;
  return acc === 0;
}

/**
 * Generate a FRESH ephemeral hybrid receive bundle for one pairing ceremony.
 *
 * NOT seed-derived — the receiver is an empty device and wants forward secrecy
 * (a filmed/recorded ceremony cannot be replayed against a persistent key).
 * The X25519 half uses `nacl.box.keyPair()` (CSPRNG); the ML-KEM-768 half is
 * keyed by a fresh 64-byte CSPRNG seed.
 */
export function generateEphemeralPairingKeys(): PairingEphemeralKeys {
  const xKp = nacl.box.keyPair();
  const kemSeed = crypto.getRandomValues(new Uint8Array(KEM_SEED_LEN));
  const kem = ml_kem768.keygen(kemSeed);
  kemSeed.fill(0);
  return {
    x25519Pub: xKp.publicKey,
    x25519Sec: xKp.secretKey,
    kemPub: kem.publicKey,
    kemSec: kem.secretKey,
  };
}

/**
 * Transcript-binding HKDF salt: SHA-256 over the FULL key-agreement transcript.
 * Both encrypt and decrypt compute this identically; any mismatch (swapped
 * pubkey, KEM ciphertext, or nonce) yields a different key → secretbox.open fails.
 */
function deriveHybridKey(
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
  return hkdf(
    sha256,
    concatBytes(classicSecret, kemSecret),
    salt,
    INFO_HYBRID,
    SYM_KEY_LEN,
  );
}

/**
 * Encrypt `plaintext` to a receiver's public receive bundle.
 * Returns `p01pairenc1:<base64(ephX25519Pub(32) ‖ kemCiphertext(1088) ‖
 * nonce(24) ‖ ct)>`.
 *
 * @throws if the X25519 ECDH produces an all-zero (low-order/identity) shared
 *         secret — i.e. a malicious/garbage receiver public key.
 */
export function encryptToPairingBundle(
  bundle: PairingReceiveBundle,
  plaintext: Uint8Array,
): { blob: string; ephX25519Pub: Uint8Array; kemCiphertext: Uint8Array } {
  if (bundle.x25519Pub.length !== X25519_LEN) {
    throw new Error('pairing box: receiver x25519Pub must be 32 bytes');
  }
  if (bundle.kemPub.length !== KEM_PUBLIC_LEN) {
    throw new Error('pairing box: receiver kemPub must be 1184 bytes');
  }

  // X25519 ECDH leg with a fresh ephemeral key.
  const eph = nacl.box.keyPair();
  const classicSecret = nacl.scalarMult(eph.secretKey, bundle.x25519Pub);
  if (isAllZero(classicSecret)) {
    // Low-order / identity receiver point → known classical secret. Refuse.
    eph.secretKey.fill(0);
    throw new Error(
      'pairing box: rejected low-order/all-zero X25519 shared secret (encrypt)',
    );
  }

  // ML-KEM-768 KEM leg.
  const { cipherText: kemCt, sharedSecret: kemSecret } = ml_kem768.encapsulate(
    bundle.kemPub,
  );

  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const key = deriveHybridKey(
    classicSecret,
    kemSecret,
    eph.publicKey,
    bundle.x25519Pub,
    bundle.kemPub,
    kemCt,
    nonce,
  );
  const ct = nacl.secretbox(plaintext, nonce, key);

  // Zeroize ephemeral/derived secret material.
  eph.secretKey.fill(0);
  classicSecret.fill(0);
  kemSecret.fill(0);
  key.fill(0);

  const blob =
    PAIR_ENC_PREFIX + b64encode(concatBytes(eph.publicKey, kemCt, nonce, ct));
  return { blob, ephX25519Pub: eph.publicKey, kemCiphertext: kemCt };
}

/** Parsed wire fields of a `p01pairenc1:` blob (for SAS cross-binding etc.). */
export interface ParsedPairingBlob {
  ephX25519Pub: Uint8Array; // 32
  kemCiphertext: Uint8Array; // 1088
  nonce: Uint8Array; // 24
  ciphertext: Uint8Array; // remainder
}

/**
 * Parse (but do not decrypt) a `p01pairenc1:` blob. Strict on prefix + minimum
 * length so a forged/truncated blob is rejected before any crypto runs.
 */
export function parsePairingBlob(blob: string): ParsedPairingBlob {
  const trimmed = blob.trim();
  if (!trimmed.startsWith(PAIR_ENC_PREFIX)) {
    throw new Error('pairing box: missing p01pairenc1: prefix');
  }
  const raw = b64decode(trimmed.slice(PAIR_ENC_PREFIX.length));
  const min = X25519_LEN + KEM_CIPHERTEXT_LEN + NONCE_LEN;
  // secretbox over a non-empty plaintext is > 0 bytes (16-byte Poly1305 tag),
  // so a valid blob is strictly longer than the header.
  if (raw.length <= min) {
    throw new Error('pairing box: encrypted payload too short');
  }
  let off = 0;
  const ephX25519Pub = raw.slice(off, (off += X25519_LEN));
  const kemCiphertext = raw.slice(off, (off += KEM_CIPHERTEXT_LEN));
  const nonce = raw.slice(off, (off += NONCE_LEN));
  const ciphertext = raw.slice(off);
  return { ephX25519Pub, kemCiphertext, nonce, ciphertext };
}

/**
 * Decrypt a `p01pairenc1:` blob with EXPLICIT ephemeral receiver keys.
 *
 * Unlike `noteCrypto.decryptNote`, the keys are passed in (random, in-memory,
 * single-use) rather than re-derived from a persisted wallet seed.
 *
 * @throws if the prefix/length is wrong, if the X25519 ECDH produces an
 *         all-zero (low-order) shared secret, or if authentication fails (the
 *         blob is not addressed to these keys / was tampered with).
 */
export function decryptWithEphemeral(
  keys: PairingEphemeralKeys,
  blob: string,
): Uint8Array {
  const { ephX25519Pub, kemCiphertext, nonce, ciphertext } =
    parsePairingBlob(blob);

  const classicSecret = nacl.scalarMult(keys.x25519Sec, ephX25519Pub);
  if (isAllZero(classicSecret)) {
    throw new Error(
      'pairing box: rejected low-order/all-zero X25519 shared secret (decrypt)',
    );
  }
  const kemSecret = ml_kem768.decapsulate(kemCiphertext, keys.kemSec);

  const key = deriveHybridKey(
    classicSecret,
    kemSecret,
    ephX25519Pub,
    keys.x25519Pub,
    keys.kemPub,
    kemCiphertext,
    nonce,
  );

  const pt = nacl.secretbox.open(ciphertext, nonce, key);

  classicSecret.fill(0);
  kemSecret.fill(0);
  key.fill(0);

  if (!pt) {
    throw new Error(
      'pairing box: decryption failed — blob is not addressed to these keys (or was tampered with).',
    );
  }
  return pt;
}
