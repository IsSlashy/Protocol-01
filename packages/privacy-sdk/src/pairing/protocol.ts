/**
 * Device-pairing protocol (extension ⇄ mobile, bidirectional).
 *
 * Moves a BIP39 mnemonic from a device that HAS the wallet (SENDER) to an empty
 * device (RECEIVER) over a 2-QR, no-network handshake. The camera (or a manual
 * paste + forced SAS entry) is the authenticated out-of-band channel. The
 * mnemonic is the ONLY payload and never appears in cleartext in any QR /
 * clipboard / log / relay — it travels encrypted under the hardened pairing box
 * (`./box.ts`). See docs/pairing-ledger-spec.md §1A.
 *
 * Wire frames:
 *   QR#1  RECEIVER shows, SENDER scans — receiver's fresh ephemeral receive bundle:
 *     p01pair1:<base64(version(1) ‖ x25519Pub(32) ‖ kemPub(1184) ‖
 *                      pairingNonce(16) ‖ expiryUnixSecs(8 BE))>
 *   QR#2  SENDER shows, RECEIVER scans — encrypted mnemonic:
 *     p01pairenc1:<base64(ephX25519Pub(32) ‖ kemCiphertext(1088) ‖ nonce(24) ‖ ct)>
 *     where the plaintext is encodePairingPayload(...).
 *
 * MITM defense (Finding #1): the 6-digit SAS hashes BOTH frames — the receiver
 * bundle AND QR#2's ephemeral material (`ephX25519Pub` + `kemCiphertext`) — so a
 * man-in-the-middle cannot swap EITHER frame without changing the displayed
 * digits. Replay defense (Finding #4): wall-clock TTL is UX-grade only; the real
 * guarantee is the consumed-nonce set plus the nonce echo binding QR#2 to QR#1.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes, concatBytes } from '@noble/hashes/utils.js';
import { validateMnemonic } from 'bip39';

import {
  X25519_LEN,
  KEM_PUBLIC_LEN,
  KEM_CIPHERTEXT_LEN,
  b64encode,
  b64decode,
  type PairingReceiveBundle,
} from './box';

// ─── constants ──────────────────────────────────────────────────────────────
/** Time-to-live for a pairing ceremony (UX-grade; the nonce set is the real guard). */
export const PAIRING_TTL_SECS = 90;

/** QR#1 (receiver bundle) prefix. */
export const PAIR_QR1_PREFIX = 'p01pair1:';
/** QR#2 (encrypted mnemonic) prefix — re-exported from the box for callers. */
export { PAIR_ENC_PREFIX } from './box';

/** Current QR#1 frame version byte. */
export const PAIRING_QR1_VERSION = 0x01;
/** Current payload (QR#2 plaintext) version byte. */
export const PAIRING_PAYLOAD_VERSION = 0x01;

/** SAS transcript domain string. */
const SAS_DOMAIN = 'p01-pair-v1';
/** Number of decimal digits in the short authentication string. */
const SAS_DIGITS = 6;
const SAS_MOD = 1_000_000; // 10 ** SAS_DIGITS

/** Wallet-kind tag carried in the QR#2 payload (pairing only ships seed wallets). */
export const PAIRING_WALLET_KIND_SEED = 0x01;

/** Fixed lengths for strict parsing. */
const PAIRING_NONCE_LEN = 16;
const EXPIRY_LEN = 8;
const QR1_BYTES_LEN =
  1 + X25519_LEN + KEM_PUBLIC_LEN + PAIRING_NONCE_LEN + EXPIRY_LEN; // 1241

/**
 * Hard cap on accepted QR-string length before any base64 decode (Finding #5,
 * DoS guard). QR#2 is the larger frame (~1730 base64 chars for a 24-word
 * mnemonic); we allow generous headroom but refuse pathological inputs.
 */
export const MAX_PAIRING_INPUT_CHARS = 8192;

/** Maximum mnemonic length we will encode (24 words ≈ 215 UTF-8 bytes). */
const MAX_MNEMONIC_BYTES = 255; // fits the 1-byte length field

// ─── big-endian helpers ───────────────────────────────────────────────────────
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
  for (let i = 0; i < 8; i++) {
    v = (v << 8n) | BigInt(bytes[offset + i] as number);
  }
  return Number(v);
}

// ─── QR#1: receiver bundle frame ───────────────────────────────────────────────
export interface PairingQr1 {
  bundle: PairingReceiveBundle; // x25519Pub + kemPub
  pairingNonce: Uint8Array; // 16
  expiryUnixSecs: number; // seconds
}

/**
 * Build QR#1 (the RECEIVER shows this). Caller supplies the fresh ephemeral
 * receive bundle (`generateEphemeralPairingKeys`), a fresh 16-byte nonce, and an
 * expiry (default now + PAIRING_TTL_SECS).
 */
export function buildPairingQr1(
  bundle: PairingReceiveBundle,
  pairingNonce: Uint8Array,
  expiryUnixSecs: number = Math.floor(Date.now() / 1000) + PAIRING_TTL_SECS,
): string {
  if (bundle.x25519Pub.length !== X25519_LEN) {
    throw new Error('pairing: x25519Pub must be 32 bytes');
  }
  if (bundle.kemPub.length !== KEM_PUBLIC_LEN) {
    throw new Error('pairing: kemPub must be 1184 bytes');
  }
  if (pairingNonce.length !== PAIRING_NONCE_LEN) {
    throw new Error('pairing: pairingNonce must be 16 bytes');
  }
  if (!Number.isFinite(expiryUnixSecs) || expiryUnixSecs < 0) {
    throw new Error('pairing: invalid expiry');
  }
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
 * Parse + validate QR#1 (the SENDER scans this). Strict on prefix, version,
 * max-input length, and EXACT decoded byte length (Finding #5). Does NOT check
 * expiry — that is the receiver's job at decrypt time on its own clock.
 */
export function parsePairingQr1(qr: string): PairingQr1 {
  if (typeof qr !== 'string') {
    throw new Error('pairing: QR#1 must be a string');
  }
  const trimmed = qr.trim();
  if (trimmed.length > MAX_PAIRING_INPUT_CHARS) {
    throw new Error('pairing: QR#1 exceeds maximum input length');
  }
  if (!trimmed.startsWith(PAIR_QR1_PREFIX)) {
    throw new Error('pairing: QR#1 missing p01pair1: prefix');
  }
  const raw = b64decode(trimmed.slice(PAIR_QR1_PREFIX.length));
  if (raw.length !== QR1_BYTES_LEN) {
    throw new Error(
      `pairing: QR#1 wrong length (expected ${QR1_BYTES_LEN} bytes, got ${raw.length})`,
    );
  }
  if (raw[0] !== PAIRING_QR1_VERSION) {
    throw new Error(`pairing: QR#1 unsupported version 0x${(raw[0] as number).toString(16)}`);
  }
  let off = 1;
  const x25519Pub = raw.slice(off, (off += X25519_LEN));
  const kemPub = raw.slice(off, (off += KEM_PUBLIC_LEN));
  const pairingNonce = raw.slice(off, (off += PAIRING_NONCE_LEN));
  const expiryUnixSecs = readUint64BE(raw, off);
  return { bundle: { x25519Pub, kemPub }, pairingNonce, expiryUnixSecs };
}

// ─── QR#2: encrypted-mnemonic payload (plaintext, before the box) ──────────────
export interface PairingPayload {
  pairingNonce: Uint8Array; // 16, MUST echo QR#1
  timestamp: number; // seconds
  walletKind: number; // PAIRING_WALLET_KIND_SEED
  mnemonic: string; // BIP39 phrase
}

/**
 * Encode the QR#2 plaintext:
 *   version(1) ‖ pairingNonce(16) ‖ timestamp(8 BE) ‖ walletKind(1) ‖
 *   mnemonicLen(1) ‖ mnemonicUtf8(N)
 */
export function encodePairingPayload(payload: PairingPayload): Uint8Array {
  if (payload.pairingNonce.length !== PAIRING_NONCE_LEN) {
    throw new Error('pairing: payload pairingNonce must be 16 bytes');
  }
  const mnemonicBytes = utf8ToBytes(payload.mnemonic);
  if (mnemonicBytes.length === 0 || mnemonicBytes.length > MAX_MNEMONIC_BYTES) {
    throw new Error('pairing: mnemonic length out of range');
  }
  return concatBytes(
    Uint8Array.of(PAIRING_PAYLOAD_VERSION),
    payload.pairingNonce,
    writeUint64BE(payload.timestamp),
    Uint8Array.of(payload.walletKind & 0xff),
    Uint8Array.of(mnemonicBytes.length),
    mnemonicBytes,
  );
}

/**
 * Decode + validate the QR#2 plaintext. Enforces, in order: version, EXACT
 * declared length, nonce echo against the expected QR#1 nonce (Finding #4),
 * expiry on the receiver's clock (UX-grade), and BIP39 CHECKSUM (Finding — the
 * mnemonic is verified before it is ever handed to an importer).
 *
 * @param bytes              decrypted QR#2 plaintext
 * @param expectedNonce      the pairingNonce from the receiver's own QR#1
 * @param expiryUnixSecs     the expiry from the receiver's own QR#1
 * @param nowUnixSecs        current time in seconds (default Date.now()/1000)
 */
export function decodePairingPayload(
  bytes: Uint8Array,
  expectedNonce: Uint8Array,
  expiryUnixSecs: number,
  nowUnixSecs: number = Math.floor(Date.now() / 1000),
): PairingPayload {
  const headerLen = 1 + PAIRING_NONCE_LEN + 8 + 1 + 1;
  if (bytes.length < headerLen) {
    throw new Error('pairing: payload too short');
  }
  let off = 0;
  const version = bytes[off++] as number;
  if (version !== PAIRING_PAYLOAD_VERSION) {
    throw new Error(`pairing: payload unsupported version 0x${version.toString(16)}`);
  }
  const pairingNonce = bytes.slice(off, (off += PAIRING_NONCE_LEN));
  const timestamp = readUint64BE(bytes, off);
  off += 8;
  const walletKind = bytes[off++] as number;
  const mnemonicLen = bytes[off++] as number;
  if (off + mnemonicLen !== bytes.length) {
    throw new Error('pairing: payload trailing/short bytes (length mismatch)');
  }
  const mnemonicBytes = bytes.slice(off, off + mnemonicLen);

  // Nonce echo: binds QR#2 to THIS receiver's QR#1 (defeats cross-device replay).
  if (!bytesEqual(pairingNonce, expectedNonce)) {
    throw new Error('pairing: nonce mismatch (QR#2 not bound to this QR#1)');
  }

  // Wall-clock expiry (UX-grade; the consumed-nonce set is the real guard).
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

// ─── SAS (short authentication string) over BOTH frames ────────────────────────
/**
 * Compute the 6-digit SAS over the FULL transcript: the receiver bundle (QR#1)
 * AND QR#2's ephemeral material (Finding #1). Both devices compute it
 * identically; a MITM that swaps either frame changes the digits.
 *
 *   transcript = "p01-pair-v1"
 *      ‖ x25519Pub(32) ‖ kemPub(1184) ‖ pairingNonce(16) ‖ expiryUnixSecs(8 BE)
 *      ‖ ephX25519Pub(32) ‖ kemCiphertext(1088)
 *   sas = (BE_uint(sha256(transcript)[0..4]) mod 1_000_000)  // zero-padded
 */
export function computeSAS(
  bundle: PairingReceiveBundle,
  pairingNonce: Uint8Array,
  expiryUnixSecs: number,
  qr2EphX25519Pub: Uint8Array,
  qr2KemCiphertext: Uint8Array,
): string {
  if (bundle.x25519Pub.length !== X25519_LEN) {
    throw new Error('pairing: SAS x25519Pub must be 32 bytes');
  }
  if (bundle.kemPub.length !== KEM_PUBLIC_LEN) {
    throw new Error('pairing: SAS kemPub must be 1184 bytes');
  }
  if (qr2EphX25519Pub.length !== X25519_LEN) {
    throw new Error('pairing: SAS ephX25519Pub must be 32 bytes');
  }
  if (qr2KemCiphertext.length !== KEM_CIPHERTEXT_LEN) {
    throw new Error('pairing: SAS kemCiphertext must be 1088 bytes');
  }
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
  const n =
    ((digest[0] as number) << 24) |
    ((digest[1] as number) << 16) |
    ((digest[2] as number) << 8) |
    (digest[3] as number);
  // >>> 0 to read the top byte as unsigned, then mod into the digit space.
  const code = (n >>> 0) % SAS_MOD;
  return code.toString().padStart(SAS_DIGITS, '0');
}

/** Constant-time compare of two SAS strings (defends against timing oracles). */
export function sasEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─── chunk framing (ciphertext-only, authenticated) ───────────────────────────
/**
 * Some transports (dense single QR rejected by a mid-range camera) need to split
 * the `p01pairenc1:` ciphertext across multiple frames. We chunk ONLY the
 * ciphertext (NOT the prefix-routed blob) and authenticate the reassembly with a
 * total-length + SHA-256 + sessionId, verified BEFORE any decrypt (Finding #5).
 *
 * Frame wire format (one QR each):
 *   p01pairc1:<base64(
 *     sessionId(8) ‖ index(2 BE) ‖ total(2 BE) ‖ totalLen(4 BE) ‖
 *     fullSha256(32) ‖ chunkBytes(M)
 *   )>
 */
export const PAIR_CHUNK_PREFIX = 'p01pairc1:';
const CHUNK_SESSION_LEN = 8;
const CHUNK_HEADER_LEN = CHUNK_SESSION_LEN + 2 + 2 + 4 + 32; // 48

export interface PairingChunk {
  sessionId: Uint8Array; // 8
  index: number; // 0-based
  total: number; // chunk count
  totalLen: number; // full ciphertext length
  fullSha256: Uint8Array; // 32
  chunkBytes: Uint8Array;
}

function writeUint16BE(v: number): Uint8Array {
  return Uint8Array.of((v >>> 8) & 0xff, v & 0xff);
}
function readUint16BE(b: Uint8Array, o: number): number {
  return ((b[o] as number) << 8) | (b[o + 1] as number);
}
function writeUint32BE(v: number): Uint8Array {
  return Uint8Array.of((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}
function readUint32BE(b: Uint8Array, o: number): number {
  return (
    (((b[o] as number) << 24) |
      ((b[o + 1] as number) << 16) |
      ((b[o + 2] as number) << 8) |
      (b[o + 3] as number)) >>>
    0
  );
}

/**
 * Split a full ciphertext (the bytes AFTER the `p01pairenc1:` prefix's base64
 * decode is NOT what we chunk — we chunk the raw ciphertext bytes the caller
 * gives us) into authenticated chunk frames.
 *
 * @param ciphertext   the bytes to split (e.g. b64decode of the QR#2 body)
 * @param sessionId    8 random bytes, identical across all chunks
 * @param maxChunkLen  max ciphertext bytes per frame (default 700)
 */
export function chunkPairingCiphertext(
  ciphertext: Uint8Array,
  sessionId: Uint8Array,
  maxChunkLen = 700,
): string[] {
  if (sessionId.length !== CHUNK_SESSION_LEN) {
    throw new Error('pairing: chunk sessionId must be 8 bytes');
  }
  if (maxChunkLen <= 0) {
    throw new Error('pairing: chunk size must be positive');
  }
  const fullSha = sha256(ciphertext);
  const total = Math.max(1, Math.ceil(ciphertext.length / maxChunkLen));
  if (total > 0xffff) {
    throw new Error('pairing: too many chunks');
  }
  const frames: string[] = [];
  for (let index = 0; index < total; index++) {
    const start = index * maxChunkLen;
    const chunkBytes = ciphertext.slice(start, start + maxChunkLen);
    const body = concatBytes(
      sessionId,
      writeUint16BE(index),
      writeUint16BE(total),
      writeUint32BE(ciphertext.length),
      fullSha,
      chunkBytes,
    );
    frames.push(PAIR_CHUNK_PREFIX + b64encode(body));
  }
  return frames;
}

/** Parse a single chunk frame (strict prefix + min length). */
export function parsePairingChunk(frame: string): PairingChunk {
  if (typeof frame !== 'string') {
    throw new Error('pairing: chunk frame must be a string');
  }
  const trimmed = frame.trim();
  if (trimmed.length > MAX_PAIRING_INPUT_CHARS) {
    throw new Error('pairing: chunk frame exceeds maximum input length');
  }
  if (!trimmed.startsWith(PAIR_CHUNK_PREFIX)) {
    throw new Error('pairing: chunk missing p01pairc1: prefix');
  }
  const raw = b64decode(trimmed.slice(PAIR_CHUNK_PREFIX.length));
  if (raw.length <= CHUNK_HEADER_LEN) {
    throw new Error('pairing: chunk too short');
  }
  let off = 0;
  const sessionId = raw.slice(off, (off += CHUNK_SESSION_LEN));
  const index = readUint16BE(raw, off);
  off += 2;
  const total = readUint16BE(raw, off);
  off += 2;
  const totalLen = readUint32BE(raw, off);
  off += 4;
  const fullSha256 = raw.slice(off, (off += 32));
  const chunkBytes = raw.slice(off);
  if (total === 0 || index >= total) {
    throw new Error('pairing: chunk index/total invalid');
  }
  return { sessionId, index, total, totalLen, fullSha256, chunkBytes };
}

/**
 * Reassemble + verify chunk frames into the original ciphertext. Verifies, in
 * order: consistent sessionId / total / totalLen / fullSha256 across all frames,
 * all indices present exactly once, total reassembled length, and finally the
 * SHA-256 over the reassembled bytes (verify-BEFORE-decrypt, Finding #5). Any
 * splice / drop / duplicate / tamper throws.
 */
export function reassemblePairingChunks(frames: string[]): Uint8Array {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error('pairing: no chunk frames');
  }
  const parsed = frames.map(parsePairingChunk);
  const first = parsed[0] as PairingChunk;
  const { total, totalLen, fullSha256, sessionId } = first;
  if (parsed.length !== total) {
    throw new Error('pairing: chunk count mismatch (missing or extra frames)');
  }
  const slots = new Array<Uint8Array | undefined>(total);
  for (const c of parsed) {
    if (c.total !== total || c.totalLen !== totalLen) {
      throw new Error('pairing: chunk metadata mismatch across frames');
    }
    if (!bytesEqual(c.sessionId, sessionId)) {
      throw new Error('pairing: chunk sessionId mismatch (spliced frames)');
    }
    if (!bytesEqual(c.fullSha256, fullSha256)) {
      throw new Error('pairing: chunk digest mismatch (spliced frames)');
    }
    if (slots[c.index] !== undefined) {
      throw new Error('pairing: duplicate chunk index');
    }
    slots[c.index] = c.chunkBytes;
  }
  for (let i = 0; i < total; i++) {
    if (slots[i] === undefined) {
      throw new Error(`pairing: missing chunk ${i}`);
    }
  }
  const reassembled = concatBytes(...(slots as Uint8Array[]));
  if (reassembled.length !== totalLen) {
    throw new Error('pairing: reassembled length mismatch');
  }
  // Verify-before-decrypt: the authenticated digest over the WHOLE ciphertext.
  if (!bytesEqual(sha256(reassembled), fullSha256)) {
    throw new Error('pairing: reassembled digest mismatch (tampered chunks)');
  }
  return reassembled;
}

// ─── consumed-nonce set (replay / double-decrypt guard, Finding #4) ────────────
/**
 * A small set that records the pairingNonce of every consumed QR#1 so a second
 * decrypt under the same ephemeral key is refused — the real replay guarantee
 * (wall-clock expiry is only UX-grade). Apps persist this across the ceremony's
 * lifetime; it is keyed by the hex of the 16-byte nonce.
 */
export class ConsumedNonceSet {
  private readonly seen = new Set<string>();

  private key(nonce: Uint8Array): string {
    if (nonce.length !== PAIRING_NONCE_LEN) {
      throw new Error('pairing: nonce must be 16 bytes');
    }
    let s = '';
    for (let i = 0; i < nonce.length; i++) {
      s += (nonce[i] as number).toString(16).padStart(2, '0');
    }
    return s;
  }

  has(nonce: Uint8Array): boolean {
    return this.seen.has(this.key(nonce));
  }

  /** Mark a nonce consumed. Throws if it was already consumed (replay). */
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

// ─── shared byte helpers ───────────────────────────────────────────────────────
/** Constant-time byte-array equality. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
