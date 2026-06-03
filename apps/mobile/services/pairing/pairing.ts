/**
 * Device pairing for the MOBILE app (bidirectional extension ⇄ mobile).
 *
 * Moves the BIP39 mnemonic from a device that HAS the wallet (SENDER) to an empty
 * device (RECEIVER) over a 2-QR, no-network handshake. The camera is the
 * authenticated out-of-band channel. The mnemonic is the ONLY payload and NEVER
 * appears in cleartext in any QR / clipboard / log / relay — it travels encrypted
 * under a hardened hybrid box (X25519 + ML-KEM-768 → HKDF-SHA256 →
 * XSalsa20-Poly1305). See docs/pairing-ledger-spec.md §1A and §3 (Stage S3).
 *
 * ── SINGLE SOURCE OF TRUTH ────────────────────────────────────────────────────
 * The wire format / SAS / box below is BYTE-IDENTICAL to the extension adapter
 * `apps/extension/src/shared/services/pairing.ts` (Stage S2) and the SDK pairing
 * module `packages/privacy-sdk/src/pairing/{box,protocol}.ts` (Stage S1) — same
 * prefixes, domain strings, transcript ordering and field layout. It is PORTED
 * here (rather than imported) because the mobile app does NOT depend on
 * `@protocol-01/privacy-sdk`; importing it would couple the Metro/typecheck graph
 * to an SDK build step. A phone running this code and the extension interoperate.
 * If you change EITHER side, change all three to keep them identical.
 *
 * Wire frames:
 *   QR#1  RECEIVER shows, SENDER scans — receiver's fresh ephemeral receive bundle:
 *     p01pair1:<base64(version(1) ‖ x25519Pub(32) ‖ kemPub(1184) ‖
 *                      pairingNonce(16) ‖ expiryUnixSecs(8 BE))>
 *   QR#2  SENDER shows, RECEIVER scans — encrypted mnemonic:
 *     p01pairenc1:<base64(ephX25519Pub(32) ‖ kemCiphertext(1088) ‖ nonce(24) ‖ ct)>
 *
 * MITM defense (Finding #1): the 6-digit SAS hashes BOTH frames — the receiver
 * bundle AND QR#2's ephemeral material (ephX25519Pub + kemCiphertext) — so a MITM
 * cannot swap EITHER frame without changing the displayed digits. The UI FORCES a
 * cross-entry of the 6 digits, not a one-tap confirm.
 * Replay defense (Finding #4): wall-clock TTL is UX-grade only; the real guarantee
 * is the consumed-nonce set plus the nonce echo binding QR#2 to QR#1.
 *
 * SECRECY: the decrypted mnemonic is NEVER logged. The ephemeral receiver keys are
 * single-use, held in non-persisted in-memory refs, and `fill(0)`-zeroized on
 * success / cancel / expiry (the derived mnemonic STRING cannot be scrubbed — JS
 * strings are immutable; the UI forbids clipboard for the raw phrase and sets
 * FLAG_SECURE on the pairing screen).
 */

import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { utf8ToBytes, concatBytes } from '@noble/hashes/utils.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { Buffer } from 'buffer';

import { getMnemonic, importWallet, validateMnemonic } from '../solana/wallet';

// ─── sizes (bytes) ────────────────────────────────────────────────────────────
const X25519_LEN = 32; // X25519 public/secret key
const KEM_PUBLIC_LEN = 1184; // ML-KEM-768 public key
const KEM_CIPHERTEXT_LEN = 1088; // ML-KEM-768 ciphertext
const KEM_SEED_LEN = 64; // ML-KEM-768 keygen seed (d ‖ z)
const NONCE_LEN = 24; // XSalsa20-Poly1305 nonce
const SYM_KEY_LEN = 32; // derived symmetric key length
const PAIRING_NONCE_LEN = 16; // QR#1 pairing nonce
const EXPIRY_LEN = 8; // QR#1 expiry (uint64 BE)

// ─── prefixes / versions / domains (must match the SDK + extension) ─────────────
export const PAIR_QR1_PREFIX = 'p01pair1:';
export const PAIR_ENC_PREFIX = 'p01pairenc1:';
const PAIRING_QR1_VERSION = 0x01;
const PAIRING_PAYLOAD_VERSION = 0x01;
/** Wallet-kind tag carried in the QR#2 payload (pairing only ships seed wallets). */
const PAIRING_WALLET_KIND_SEED = 0x01;

/** Domain separation for the hybrid HKDF (hardened pairing variant). */
const INFO_HYBRID = utf8ToBytes('p01-pair-enc-hybrid-v1');
/** SAS transcript domain string. */
const SAS_DOMAIN = 'p01-pair-v1';

/** Time-to-live for a pairing ceremony (UX-grade; the nonce set is the real guard). */
export const PAIRING_TTL_SECS = 90;
/** Hard cap on accepted QR-string length before any base64 decode (DoS guard). */
export const MAX_PAIRING_INPUT_CHARS = 8192;
/** Max mnemonic UTF-8 bytes we will encode (24 words ≈ 215 bytes; fits 1-byte len). */
const MAX_MNEMONIC_BYTES = 255;

const SAS_DIGITS = 6;
const SAS_MOD = 1_000_000;

const QR1_BYTES_LEN =
  1 + X25519_LEN + KEM_PUBLIC_LEN + PAIRING_NONCE_LEN + EXPIRY_LEN; // 1241

// ─── base64 helpers ─────────────────────────────────────────────────────────────
// React Native has no global btoa/atob; the `buffer` polyfill is the portable
// path. The byte layout is identical to the extension's btoa/atob round-trip.
function b64encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
function b64decode(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, 'base64'));
}

/** True iff every byte is zero (low-order / identity-point reject). */
function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (let i = 0; i < bytes.length; i++) acc |= bytes[i];
  return acc === 0;
}

/** Constant-time byte-array equality. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Constant-time compare of two SAS strings (defends against timing oracles). */
export function sasEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─── big-endian helpers ─────────────────────────────────────────────────────────
function writeUint64BE(value: number): Uint8Array {
  const out = new Uint8Array(8);
  let v = BigInt(value);
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
function readUint64BE(bytes: Uint8Array, offset: number): number {
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(bytes[offset + i]);
  return Number(v);
}

// ─── ephemeral receiver keys ────────────────────────────────────────────────────
export interface PairingEphemeralKeys {
  x25519Pub: Uint8Array; // 32
  x25519Sec: Uint8Array; // 32
  kemPub: Uint8Array; // 1184
  kemSec: Uint8Array; // 2400
}

export interface PairingReceiveBundle {
  x25519Pub: Uint8Array; // 32
  kemPub: Uint8Array; // 1184
}

/**
 * Generate a FRESH ephemeral hybrid receive bundle for one pairing ceremony.
 * NOT seed-derived — the receiver is an empty device and wants forward secrecy.
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

/** Zeroize the secret halves of an ephemeral receive bundle. */
function zeroizeEphemeralKeys(keys: PairingEphemeralKeys): void {
  keys.x25519Sec.fill(0);
  keys.kemSec.fill(0);
}

// ─── hardened hybrid box (transcript-bound salt + low-order reject) ──────────────
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

interface EncryptResult {
  blob: string;
  ephX25519Pub: Uint8Array;
  kemCiphertext: Uint8Array;
}

/**
 * Encrypt `plaintext` to a receiver's public receive bundle.
 * Returns the p01pairenc1: blob plus the QR#2 ephemeral material (for the SAS).
 * @throws if the X25519 ECDH produces an all-zero (low-order/identity) shared secret.
 */
function encryptToPairingBundle(
  bundle: PairingReceiveBundle,
  plaintext: Uint8Array,
): EncryptResult {
  if (bundle.x25519Pub.length !== X25519_LEN) {
    throw new Error('pairing box: receiver x25519Pub must be 32 bytes');
  }
  if (bundle.kemPub.length !== KEM_PUBLIC_LEN) {
    throw new Error('pairing box: receiver kemPub must be 1184 bytes');
  }

  const eph = nacl.box.keyPair();
  const classicSecret = nacl.scalarMult(eph.secretKey, bundle.x25519Pub);
  if (isAllZero(classicSecret)) {
    eph.secretKey.fill(0);
    throw new Error('pairing box: rejected low-order/all-zero X25519 shared secret (encrypt)');
  }

  const { cipherText: kemCt, sharedSecret: kemSecret } = ml_kem768.encapsulate(bundle.kemPub);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const key = deriveHybridKey(classicSecret, kemSecret, eph.publicKey, bundle.x25519Pub, bundle.kemPub, kemCt, nonce);
  const ct = nacl.secretbox(plaintext, nonce, key);

  eph.secretKey.fill(0);
  classicSecret.fill(0);
  kemSecret.fill(0);
  key.fill(0);

  const blob = PAIR_ENC_PREFIX + b64encode(concatBytes(eph.publicKey, kemCt, nonce, ct));
  return { blob, ephX25519Pub: eph.publicKey, kemCiphertext: kemCt };
}

interface ParsedPairingBlob {
  ephX25519Pub: Uint8Array; // 32
  kemCiphertext: Uint8Array; // 1088
  nonce: Uint8Array; // 24
  ciphertext: Uint8Array; // remainder
}

/** Parse (but do not decrypt) a p01pairenc1: blob. Strict prefix + min length. */
function parsePairingBlob(blob: string): ParsedPairingBlob {
  const trimmed = blob.trim();
  if (trimmed.length > MAX_PAIRING_INPUT_CHARS) {
    throw new Error('pairing box: QR#2 exceeds maximum input length');
  }
  if (!trimmed.startsWith(PAIR_ENC_PREFIX)) {
    throw new Error('pairing box: missing p01pairenc1: prefix');
  }
  const raw = b64decode(trimmed.slice(PAIR_ENC_PREFIX.length));
  const min = X25519_LEN + KEM_CIPHERTEXT_LEN + NONCE_LEN;
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
 * Decrypt a p01pairenc1: blob with EXPLICIT ephemeral receiver keys.
 * @throws on bad prefix/length, all-zero (low-order) shared secret, or auth failure.
 */
function decryptWithEphemeral(keys: PairingEphemeralKeys, blob: string): Uint8Array {
  const { ephX25519Pub, kemCiphertext, nonce, ciphertext } = parsePairingBlob(blob);

  const classicSecret = nacl.scalarMult(keys.x25519Sec, ephX25519Pub);
  if (isAllZero(classicSecret)) {
    throw new Error('pairing box: rejected low-order/all-zero X25519 shared secret (decrypt)');
  }
  const kemSecret = ml_kem768.decapsulate(kemCiphertext, keys.kemSec);
  const key = deriveHybridKey(classicSecret, kemSecret, ephX25519Pub, keys.x25519Pub, keys.kemPub, kemCiphertext, nonce);
  const pt = nacl.secretbox.open(ciphertext, nonce, key);

  classicSecret.fill(0);
  kemSecret.fill(0);
  key.fill(0);

  if (!pt) {
    throw new Error('pairing box: decryption failed — blob is not addressed to these keys (or was tampered with).');
  }
  return pt;
}

// ─── QR#1 framing ────────────────────────────────────────────────────────────────
export interface PairingQr1 {
  bundle: PairingReceiveBundle;
  pairingNonce: Uint8Array; // 16
  expiryUnixSecs: number; // seconds
}

function buildPairingQr1(
  bundle: PairingReceiveBundle,
  pairingNonce: Uint8Array,
  expiryUnixSecs: number,
): string {
  const body = concatBytes(
    Uint8Array.of(PAIRING_QR1_VERSION),
    bundle.x25519Pub,
    bundle.kemPub,
    pairingNonce,
    writeUint64BE(expiryUnixSecs),
  );
  return PAIR_QR1_PREFIX + b64encode(body);
}

/**
 * Parse + validate QR#1 (the SENDER scans/pastes this). Strict on prefix,
 * version, max-input length, and EXACT decoded byte length (Finding #5).
 */
function parsePairingQr1(qr: string): PairingQr1 {
  const trimmed = qr.trim();
  if (trimmed.length > MAX_PAIRING_INPUT_CHARS) {
    throw new Error('pairing: QR#1 exceeds maximum input length');
  }
  if (!trimmed.startsWith(PAIR_QR1_PREFIX)) {
    throw new Error('pairing: QR#1 missing p01pair1: prefix');
  }
  const raw = b64decode(trimmed.slice(PAIR_QR1_PREFIX.length));
  if (raw.length !== QR1_BYTES_LEN) {
    throw new Error(`pairing: QR#1 wrong length (expected ${QR1_BYTES_LEN} bytes, got ${raw.length})`);
  }
  if (raw[0] !== PAIRING_QR1_VERSION) {
    throw new Error(`pairing: QR#1 unsupported version 0x${raw[0].toString(16)}`);
  }
  let off = 1;
  const x25519Pub = raw.slice(off, (off += X25519_LEN));
  const kemPub = raw.slice(off, (off += KEM_PUBLIC_LEN));
  const pairingNonce = raw.slice(off, (off += PAIRING_NONCE_LEN));
  const expiryUnixSecs = readUint64BE(raw, off);
  return { bundle: { x25519Pub, kemPub }, pairingNonce, expiryUnixSecs };
}

// ─── QR#2 payload (plaintext, before the box) ────────────────────────────────────
interface PairingPayload {
  pairingNonce: Uint8Array; // 16, MUST echo QR#1
  timestamp: number; // seconds
  walletKind: number;
  mnemonic: string;
}

function encodePairingPayload(p: PairingPayload): Uint8Array {
  const mnemonicBytes = utf8ToBytes(p.mnemonic);
  if (mnemonicBytes.length === 0 || mnemonicBytes.length > MAX_MNEMONIC_BYTES) {
    throw new Error('pairing: mnemonic length out of range');
  }
  return concatBytes(
    Uint8Array.of(PAIRING_PAYLOAD_VERSION),
    p.pairingNonce,
    writeUint64BE(p.timestamp),
    Uint8Array.of(p.walletKind & 0xff),
    Uint8Array.of(mnemonicBytes.length),
    mnemonicBytes,
  );
}

/**
 * Decode + validate the QR#2 plaintext. Enforces, in order: version, EXACT
 * declared length, nonce echo against the receiver's QR#1 (Finding #4), expiry on
 * the receiver's clock (UX-grade), and BIP39 CHECKSUM before the mnemonic is ever
 * handed to an importer.
 */
function decodePairingPayload(
  bytes: Uint8Array,
  expectedNonce: Uint8Array,
  expiryUnixSecs: number,
  nowUnixSecs: number,
): PairingPayload {
  const headerLen = 1 + PAIRING_NONCE_LEN + 8 + 1 + 1;
  if (bytes.length < headerLen) {
    throw new Error('pairing: payload too short');
  }
  let off = 0;
  const version = bytes[off++];
  if (version !== PAIRING_PAYLOAD_VERSION) {
    throw new Error(`pairing: payload unsupported version 0x${version.toString(16)}`);
  }
  const pairingNonce = bytes.slice(off, (off += PAIRING_NONCE_LEN));
  const timestamp = readUint64BE(bytes, off);
  off += 8;
  const walletKind = bytes[off++];
  const mnemonicLen = bytes[off++];
  if (off + mnemonicLen !== bytes.length) {
    throw new Error('pairing: payload trailing/short bytes (length mismatch)');
  }
  const mnemonicBytes = bytes.slice(off, off + mnemonicLen);

  if (!bytesEqual(pairingNonce, expectedNonce)) {
    throw new Error('pairing: nonce mismatch (QR#2 not bound to this QR#1)');
  }
  if (nowUnixSecs >= expiryUnixSecs) {
    throw new Error('pairing: ceremony expired');
  }
  if (walletKind !== PAIRING_WALLET_KIND_SEED) {
    throw new Error(`pairing: unsupported wallet kind 0x${walletKind.toString(16)}`);
  }

  const mnemonic = new TextDecoder().decode(mnemonicBytes);
  if (!validateMnemonic(mnemonic)) {
    throw new Error('pairing: BIP39 checksum invalid (corrupted mnemonic)');
  }
  return { pairingNonce, timestamp, walletKind, mnemonic };
}

// ─── SAS over BOTH frames ────────────────────────────────────────────────────────
/**
 * Compute the 6-digit SAS over the FULL transcript: the receiver bundle (QR#1) AND
 * QR#2's ephemeral material (Finding #1). Both devices compute it identically; a
 * MITM that swaps either frame changes the digits.
 */
export function computeSAS(
  bundle: PairingReceiveBundle,
  pairingNonce: Uint8Array,
  expiryUnixSecs: number,
  qr2EphX25519Pub: Uint8Array,
  qr2KemCiphertext: Uint8Array,
): string {
  const transcript = concatBytes(
    utf8ToBytes(SAS_DOMAIN),
    bundle.x25519Pub,
    bundle.kemPub,
    pairingNonce,
    writeUint64BE(expiryUnixSecs),
    qr2EphX25519Pub,
    qr2KemCiphertext,
  );
  const digest = sha256(transcript);
  const n = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  return (n % SAS_MOD).toString().padStart(SAS_DIGITS, '0');
}

// ─── consumed-nonce set (replay / double-decrypt guard) ──────────────────────────
/**
 * Records the pairingNonce of every consumed QR#1 so a second decrypt under the
 * same ephemeral key is refused — the real replay guarantee (wall-clock expiry is
 * only UX-grade). Keyed by the hex of the 16-byte nonce.
 */
export class ConsumedNonceSet {
  private readonly seen = new Set<string>();

  private key(nonce: Uint8Array): string {
    if (nonce.length !== PAIRING_NONCE_LEN) {
      throw new Error('pairing: nonce must be 16 bytes');
    }
    let s = '';
    for (let i = 0; i < nonce.length; i++) s += nonce[i].toString(16).padStart(2, '0');
    return s;
  }

  has(nonce: Uint8Array): boolean {
    return this.seen.has(this.key(nonce));
  }

  consume(nonce: Uint8Array): void {
    const k = this.key(nonce);
    if (this.seen.has(k)) {
      throw new Error('pairing: nonce already consumed (replay rejected)');
    }
    this.seen.add(k);
  }

  clear(): void {
    this.seen.clear();
  }
}

// ════════════════════════════════════════════════════════════════════════════════
//  MOBILE ADAPTER  —  receiver / sender flows on top of the protocol above
// ════════════════════════════════════════════════════════════════════════════════

export type PairingWalletKind = 'seed';

/** Handle returned by `startAsReceiver` — drives the RECEIVER side of a ceremony. */
export interface ReceiverSession {
  /** QR#1 string to render / hand to the sender. */
  qr1: string;
  /** The receiver's own pairing nonce (16 bytes) — used to validate QR#2's echo. */
  pairingNonce: Uint8Array;
  /** Expiry of this ceremony (unix seconds). */
  expiryUnixSecs: number;
  /** The fresh ephemeral receive bundle (public halves). */
  bundle: PairingReceiveBundle;
  /**
   * Compute the 6-digit SAS for a scanned QR#2 blob, WITHOUT decrypting. The
   * receiver must show this and only proceed after the user confirms it matches
   * the sender's screen (the UI FORCES typed cross-entry of the digits).
   * @throws if the blob is malformed.
   */
  computeSasForQr2(qr2: string): string;
  /**
   * Consume QR#2: decrypt, verify nonce echo + expiry + BIP39 checksum, return the
   * mnemonic + wallet kind. Single-shot — refuses a replayed nonce. Zeroizes the
   * ephemeral keys on success. The returned mnemonic is NEVER logged by this code.
   * @throws on any validation/decryption failure.
   */
  consumeQr2(qr2: string): { mnemonic: string; walletKind: PairingWalletKind };
  /** Abort the ceremony and zeroize all ephemeral key material. */
  cancel(): void;
}

/**
 * Begin a pairing ceremony as the RECEIVER (the empty device importing a wallet).
 *
 * Generates fresh, NON-PERSISTED ephemeral keys held only inside the returned
 * session closure. The keys never touch SecureStore — they live for the lifetime
 * of the ceremony and are `fill(0)`-zeroized on `consumeQr2` success or `cancel()`.
 */
export function startAsReceiver(ttlSecs: number = PAIRING_TTL_SECS): ReceiverSession {
  const keys = generateEphemeralPairingKeys();
  const pairingNonce = crypto.getRandomValues(new Uint8Array(PAIRING_NONCE_LEN));
  const expiryUnixSecs = Math.floor(Date.now() / 1000) + ttlSecs;
  const bundle: PairingReceiveBundle = { x25519Pub: keys.x25519Pub, kemPub: keys.kemPub };
  const qr1 = buildPairingQr1(bundle, pairingNonce, expiryUnixSecs);

  const consumed = new ConsumedNonceSet();
  let zeroized = false;

  const computeSasForQr2 = (qr2: string): string => {
    const parsed = parsePairingBlob(qr2);
    return computeSAS(bundle, pairingNonce, expiryUnixSecs, parsed.ephX25519Pub, parsed.kemCiphertext);
  };

  const consumeQr2 = (qr2: string): { mnemonic: string; walletKind: PairingWalletKind } => {
    if (zeroized) {
      throw new Error('pairing: ceremony already completed or cancelled');
    }
    // Replay guard: refuse a second decrypt under this ephemeral key.
    consumed.consume(pairingNonce);

    let plaintext: Uint8Array | null = null;
    try {
      plaintext = decryptWithEphemeral(keys, qr2);
      const payload = decodePairingPayload(
        plaintext,
        pairingNonce,
        expiryUnixSecs,
        Math.floor(Date.now() / 1000),
      );
      // Single-use keys: scrub immediately on success.
      zeroizeEphemeralKeys(keys);
      zeroized = true;
      return { mnemonic: payload.mnemonic, walletKind: 'seed' };
    } finally {
      if (plaintext) plaintext.fill(0);
    }
  };

  const cancel = (): void => {
    if (!zeroized) {
      zeroizeEphemeralKeys(keys);
      zeroized = true;
    }
    consumed.clear();
  };

  return { qr1, pairingNonce, expiryUnixSecs, bundle, computeSasForQr2, consumeQr2, cancel };
}

/**
 * SENDER step 1: parse + validate a scanned QR#1 from the receiver.
 * Returns the parsed receive bundle + nonce + expiry. Throws on malformed input.
 */
export function senderConsumeQr1(qr1: string): PairingQr1 {
  return parsePairingQr1(qr1);
}

export interface SenderQr2 {
  /** The p01pairenc1: blob to render as QR#2 / hand to the receiver. */
  qr2: string;
  /**
   * The 6-digit SAS the sender must display. The receiver computes the same value
   * from the scanned QR#2 and the two are compared out-of-band.
   */
  sas: string;
}

/**
 * SENDER step 2: build QR#2 for a parsed QR#1.
 *
 * Reads the ACTIVE wallet's mnemonic from SecureStore (`getMnemonic`), encrypts it
 * to the receiver's bundle, and returns the QR#2 blob + the SAS the sender must
 * show.
 *
 * GUARDS:
 *  - Refuses if the active wallet is HARDWARE (no mnemonic to send — Finding #3).
 *    Hardware kind is added to the store in a later stage (S5); today this is a
 *    forward-compatible guard keyed on the absence of a stored mnemonic, which is
 *    exactly how a seedless hardware wallet presents.
 *  - Refuses if no seed-backed wallet exists on this device.
 *
 * SECRECY: the mnemonic is held only as a local string for the duration of
 * `encodePairingPayload` and is NEVER logged. The encoded payload byte buffer is
 * `fill(0)`-zeroized after encryption.
 */
export async function senderBuildQr2(parsedQr1: PairingQr1): Promise<SenderQr2> {
  // Read the active mnemonic from SecureStore. A hardware wallet stores no
  // mnemonic → `getMnemonic` returns null → there is nothing to pair out.
  const mnemonic = await getMnemonic();
  if (!mnemonic) {
    throw new Error(
      'No seed phrase on this device — a hardware-only wallet cannot be paired out. Pairing is unavailable.',
    );
  }
  if (!validateMnemonic(mnemonic)) {
    throw new Error('Active wallet seed phrase is invalid; cannot pair.');
  }

  const payloadBytes = encodePairingPayload({
    pairingNonce: parsedQr1.pairingNonce,
    timestamp: Math.floor(Date.now() / 1000),
    walletKind: PAIRING_WALLET_KIND_SEED,
    mnemonic,
  });

  let result: EncryptResult;
  try {
    result = encryptToPairingBundle(parsedQr1.bundle, payloadBytes);
  } finally {
    payloadBytes.fill(0);
  }

  const sas = computeSAS(
    parsedQr1.bundle,
    parsedQr1.pairingNonce,
    parsedQr1.expiryUnixSecs,
    result.ephX25519Pub,
    result.kemCiphertext,
  );

  return { qr2: result.blob, sas };
}

/**
 * RECEIVER step (decrypt only): given the active receiver session and the scanned
 * QR#2, return the `{ mnemonic, walletKind }` WITHOUT persisting anything. Thin
 * alias over `session.consumeQr2` so callers have a symmetric sender/receiver API.
 * The UI must show the SAS and require a match BEFORE calling this.
 */
export function receiverConsumeQr2(
  session: ReceiverSession,
  qr2: string,
): { mnemonic: string; walletKind: PairingWalletKind } {
  return session.consumeQr2(qr2);
}

/**
 * RECEIVER step (decrypt + IMPORT): consume QR#2 and write the wallet to
 * SecureStore via the standard `importWallet` path. Returns the resulting public
 * key. Call only AFTER the SAS has been confirmed and the user accepted.
 */
export async function receiverImportFromQr2(
  session: ReceiverSession,
  qr2: string,
): Promise<{ publicKey: string }> {
  const { mnemonic } = session.consumeQr2(qr2);
  // importWallet normalizes + re-validates + persists. NEVER log `mnemonic`.
  const { publicKey } = await importWallet(mnemonic);
  return { publicKey };
}

/** True iff a string looks like a pairing QR#1 frame (cheap prefix check). */
export function isPairingQr1(s: string): boolean {
  return s.trim().startsWith(PAIR_QR1_PREFIX);
}
/** True iff a string looks like a pairing QR#2 (encrypted) frame. */
export function isPairingQr2(s: string): boolean {
  return s.trim().startsWith(PAIR_ENC_PREFIX);
}
