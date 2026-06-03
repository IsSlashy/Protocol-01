/**
 * pairCrypto — device-pairing QR crypto for "scan to import a wallet from the
 * extension onto the phone".
 *
 * DUPLICATED BYTE-IDENTICALLY in:
 *   apps/extension/src/shared/services/pairCrypto.ts
 *   apps/mobile/utils/crypto/pairCrypto.ts            (this file)
 * The two MUST stay identical — the known-vector test in each app is the contract.
 * Only platform import paths may differ; the crypto/offsets/encodings may not.
 *
 * Scheme (v1):
 *   The EXTENSION holds the seed and generates a fresh high-entropy pairing CODE
 *   (80-bit). It encrypts the BIP39 mnemonic to that code and renders a QR; the
 *   phone scans the QR, the user types the CODE, the phone decrypts and imports.
 *
 * Security rationale (from the adversarial crypto review):
 *   - The decryption secret (the CODE) is NOT in the QR, so a filmed/screenshotted
 *     QR is useless on its own. An 80-bit code makes offline brute force infeasible
 *     even with a GPU farm — this is what actually protects the seed, NOT the KDF.
 *   - A 4-byte expiry (TTL) is baked into the payload; the phone rejects an expired
 *     QR, so a captured photo cannot be replayed minutes/days later.
 *   - pbkdf2-50k(SHA-256) + XSalsa20-Poly1305 (tweetnacl secretbox). The Poly1305
 *     tag authenticates the blob (tamper-evident) and surfaces a wrong code as a
 *     clean failure (no padding oracle).
 *   - The plaintext mnemonic is a JS string and cannot be reliably zeroized; the
 *     real controls are the high-entropy code + short TTL + screenshot prevention.
 */
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import nacl from 'tweetnacl';

export const PAIR_PREFIX = 'p01pair1:';
const VERSION = 0x01;
// Modest ON PURPOSE: the 80-bit pairing code already makes brute force infeasible
// (2^80 regardless of KDF), and pure-JS PBKDF2 on the phone's Hermes engine must
// stay fast enough to not freeze the "Linking…" UI. 600k on Hermes blocked ~20s.
const PBKDF2_ITERS = 50_000;
const SALT_LEN = 16;
const NONCE_LEN = 24; // nacl.secretbox.nonceLength
const KEY_LEN = 32;
const CODE_BYTES = 10; // 80-bit pairing code
export const DEFAULT_TTL_SEC = 180;
const HEADER_LEN = 1 + 4 + SALT_LEN + NONCE_LEN; // version|expiry|salt|nonce = 45

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648 base32 (code alphabet)
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'; // base64url

// --- pure-JS base64url (no btoa/Buffer) so this file is byte-identical x-platform ---
function b64urlEncode(bytes: Uint8Array): string {
  let out = '';
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    buf = (buf << 8) | bytes[i];
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += B64[(buf >> bits) & 63];
    }
  }
  if (bits > 0) out += B64[(buf << (6 - bits)) & 63];
  return out;
}

function b64urlDecode(str: string): Uint8Array {
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) lookup[B64.charCodeAt(i)] = i;
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < str.length; i++) {
    const v = str.charCodeAt(i) < 128 ? lookup[str.charCodeAt(i)] : -1;
    if (v < 0) continue; // skip padding / stray chars
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** Generate a fresh 80-bit pairing code as 16 base32 chars (extension side only). */
export function generatePairingCode(): string {
  const raw = nacl.randomBytes(CODE_BYTES);
  let out = '';
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < raw.length; i++) {
    buf = (buf << 8) | raw[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(buf >> bits) & 31];
    }
  }
  if (bits > 0) out += B32[(buf << (5 - bits)) & 31];
  return out;
}

/** Strip grouping/spacing and upper-case so display formatting never changes the key. */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-7]/g, '');
}

/** "ABCD-EFGH-JKLM-NPQR" for display. Does not affect the KDF (see normalizeCode). */
export function formatCodeForDisplay(code: string): string {
  const c = normalizeCode(code);
  return c.replace(/(.{4})(?=.)/g, '$1-');
}

function codeToBytes(code: string): Uint8Array {
  // NFKC + UTF-8 of the NORMALIZED code. MUST stay NFKC+UTF-8 — do not change.
  return new TextEncoder().encode(normalizeCode(code).normalize('NFKC'));
}

function normalizeMnemonic(m: string): string {
  return m.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function deriveKey(code: string, salt: Uint8Array): Promise<Uint8Array> {
  return pbkdf2Async(sha256, codeToBytes(code), salt, { c: PBKDF2_ITERS, dkLen: KEY_LEN });
}

function pack(expiry: number, salt: Uint8Array, nonce: Uint8Array, ct: Uint8Array): string {
  const payload = new Uint8Array(HEADER_LEN + ct.length);
  payload[0] = VERSION;
  payload[1] = (expiry >>> 24) & 0xff;
  payload[2] = (expiry >>> 16) & 0xff;
  payload[3] = (expiry >>> 8) & 0xff;
  payload[4] = expiry & 0xff;
  payload.set(salt, 5);
  payload.set(nonce, 5 + SALT_LEN);
  payload.set(ct, HEADER_LEN);
  return PAIR_PREFIX + b64urlEncode(payload);
}

/**
 * Test-injectable core: deterministic given (salt, nonce, expiry). Production code
 * uses encryptPairing() which supplies fresh randomness + a real expiry.
 */
export async function encryptPairingWith(
  mnemonic: string,
  code: string,
  salt: Uint8Array,
  nonce: Uint8Array,
  expiry: number,
): Promise<string> {
  const key = await deriveKey(code, salt);
  const pt = new TextEncoder().encode(normalizeMnemonic(mnemonic));
  const ct = nacl.secretbox(pt, nonce, key);
  return pack(expiry >>> 0, salt, nonce, ct);
}

/** Encrypt a mnemonic to a pairing code, producing a `p01pair1:` QR string. */
export async function encryptPairing(
  mnemonic: string,
  code: string,
  ttlSec: number = DEFAULT_TTL_SEC,
): Promise<string> {
  const salt = nacl.randomBytes(SALT_LEN);
  const nonce = nacl.randomBytes(NONCE_LEN);
  const expiry = Math.floor(Date.now() / 1000) + ttlSec;
  return encryptPairingWith(mnemonic, code, salt, nonce, expiry);
}

/** True if the scanned string is a P01 pairing QR. */
export function isPairingQR(s: string): boolean {
  return typeof s === 'string' && s.startsWith(PAIR_PREFIX);
}

/**
 * Decrypt a `p01pair1:` QR with the pairing code. Throws on: not-a-pairing-QR,
 * malformed, unsupported version, EXPIRED, or wrong code / tampered blob.
 */
export async function decryptPairing(qr: string, code: string): Promise<string> {
  if (!isPairingQR(qr)) throw new Error('Not a P01 pairing QR');
  const payload = b64urlDecode(qr.slice(PAIR_PREFIX.length));
  if (payload.length < HEADER_LEN + nacl.secretbox.overheadLength) {
    throw new Error('Malformed pairing QR');
  }
  if (payload[0] !== VERSION) throw new Error('Unsupported pairing QR version');
  const expiry = ((payload[1] << 24) | (payload[2] << 16) | (payload[3] << 8) | payload[4]) >>> 0;
  if (Math.floor(Date.now() / 1000) > expiry) {
    throw new Error('This pairing QR has expired — generate a fresh one');
  }
  const salt = payload.slice(5, 5 + SALT_LEN);
  const nonce = payload.slice(5 + SALT_LEN, HEADER_LEN);
  const ct = payload.slice(HEADER_LEN);
  const key = await deriveKey(code, salt);
  const pt = nacl.secretbox.open(ct, nonce, key);
  if (!pt) throw new Error('Wrong pairing code (or QR corrupted)');
  return normalizeMnemonic(new TextDecoder().decode(pt));
}
