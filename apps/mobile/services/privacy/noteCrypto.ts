/**
 * Note sealing — the phone's copy of apps/web/lib/privacy/pool/noteCrypto.ts.
 *
 * Byte-for-byte the same scheme, because the OTHER side is the web deployment:
 * `/api/issue-note` seals a note to a `p01pq:` address with this construction,
 * and the phone has to open it. Hybrid key agreement (X25519 ECDH + ML-KEM-768,
 * FIPS 203), HKDF-SHA256 to one 256-bit key, XSalsa20-Poly1305 for the body.
 * The recipient keys are DERIVED from the wallet seed, so nothing new has to be
 * stored or backed up: the seed phrase recovers the address.
 *
 * ⛔ Copied, not shared, on purpose: the mobile bundle cannot import from
 * apps/web, and a package would drag the web's import graph into Metro. If the
 * web changes a constant here, the phone opens nothing — the round-trip test in
 * noteCrypto.test.ts pins the wire layout so that drift is loud.
 */
import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { utf8ToBytes, concatBytes } from '@noble/hashes/utils.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import * as Crypto from 'expo-crypto';

const X25519_LEN = 32;
const KEM_PUBLIC_LEN = 1184; // ML-KEM-768 public key
const KEM_CIPHERTEXT_LEN = 1088; // ML-KEM-768 ciphertext
const NONCE_LEN = 24; // XSalsa20-Poly1305 nonce

const ADDRESS_PREFIX = 'p01pq:';
const BLOB_PREFIX = 'p01enc1:';

const INFO_X25519 = utf8ToBytes('p01-note-enc-x25519-v1');
const INFO_MLKEM = utf8ToBytes('p01-note-enc-mlkem-v1');
const INFO_HYBRID = utf8ToBytes('p01-note-enc-hybrid-v1');
const ENC_SALT = utf8ToBytes('p01-note-enc-v1');

export interface NoteEncryptionKeys {
  x25519Pub: Uint8Array;
  x25519Sec: Uint8Array;
  kemPub: Uint8Array;
  kemSec: Uint8Array;
}

/** CSPRNG: the platform's `crypto.getRandomValues` (polyfilled by expo-crypto on the phone, native in Node), else expo-crypto, else tweetnacl's. */
function randomBytes(n: number): Uint8Array {
  const g = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (g?.getRandomValues) return g.getRandomValues(new Uint8Array(n));
  if (typeof (Crypto as { getRandomValues?: unknown }).getRandomValues === 'function') {
    return Crypto.getRandomValues(new Uint8Array(n));
  }
  return nacl.randomBytes(n);
}

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

/** Deterministic X25519 + ML-KEM-768 keypairs from the wallet seed. */
export function deriveNoteEncryptionKeys(walletSeed: Uint8Array): NoteEncryptionKeys {
  const xSeed = hkdf(sha256, walletSeed, ENC_SALT, INFO_X25519, 32);
  // `nacl.box.keyPair.fromSecretKey` on the web; the same X25519 base point
  // multiplication, spelled so the test mock's stub keypair cannot intercept it.
  const x25519Pub = nacl.scalarMult.base(xSeed);
  const kemSeed = hkdf(sha256, walletSeed, ENC_SALT, INFO_MLKEM, 64);
  const kem = ml_kem768.keygen(kemSeed);
  return { x25519Pub, x25519Sec: xSeed, kemPub: kem.publicKey, kemSec: kem.secretKey };
}

/** Public receive address (safe to share): p01pq:<base64(x25519Pub || kemPub)>. */
export function createNoteEncryptionAddress(walletSeed: Uint8Array): string {
  const keys = deriveNoteEncryptionKeys(walletSeed);
  return ADDRESS_PREFIX + b64encode(concatBytes(keys.x25519Pub, keys.kemPub));
}

export function parseNoteEncryptionAddress(address: string): { x25519Pub: Uint8Array; kemPub: Uint8Array } {
  if (!address.startsWith(ADDRESS_PREFIX)) throw new Error('Invalid note address: missing p01pq: prefix');
  const raw = b64decode(address.slice(ADDRESS_PREFIX.length).trim());
  if (raw.length !== X25519_LEN + KEM_PUBLIC_LEN) {
    throw new Error(`Invalid note address: expected ${X25519_LEN + KEM_PUBLIC_LEN} bytes, got ${raw.length}`);
  }
  return { x25519Pub: raw.slice(0, X25519_LEN), kemPub: raw.slice(X25519_LEN) };
}

export function isEncryptedNoteBlob(s: string): boolean {
  return s.trim().startsWith(BLOB_PREFIX);
}

/** Seal bytes to a p01pq: address. Kept for symmetry and for the round-trip test. */
export function encryptNote(address: string, plaintext: Uint8Array): string {
  const { x25519Pub, kemPub } = parseNoteEncryptionAddress(address);
  const ephSecret = randomBytes(X25519_LEN);
  const eph = { publicKey: nacl.scalarMult.base(ephSecret), secretKey: ephSecret };
  const classicSecret = nacl.scalarMult(eph.secretKey, x25519Pub);
  const { cipherText: kemCt, sharedSecret: kemSecret } = ml_kem768.encapsulate(kemPub);
  const key = hkdf(sha256, concatBytes(classicSecret, kemSecret), x25519Pub, INFO_HYBRID, 32);
  const nonce = randomBytes(NONCE_LEN);
  const ct = nacl.secretbox(plaintext, nonce, key);
  return BLOB_PREFIX + b64encode(concatBytes(eph.publicKey, kemCt, nonce, ct));
}

/** Open a p01enc1: blob with the wallet seed. Throws if it is not ours or is corrupted. */
export function decryptNote(walletSeed: Uint8Array, blob: string): Uint8Array {
  const trimmed = blob.trim();
  if (!trimmed.startsWith(BLOB_PREFIX)) throw new Error('Invalid encrypted note: missing p01enc1: prefix');
  const raw = b64decode(trimmed.slice(BLOB_PREFIX.length));
  const min = X25519_LEN + KEM_CIPHERTEXT_LEN + NONCE_LEN;
  if (raw.length <= min) throw new Error('Invalid encrypted note: payload too short');
  let off = 0;
  const ephPub = raw.slice(off, (off += X25519_LEN));
  const kemCt = raw.slice(off, (off += KEM_CIPHERTEXT_LEN));
  const nonce = raw.slice(off, (off += NONCE_LEN));
  const ct = raw.slice(off);

  const keys = deriveNoteEncryptionKeys(walletSeed);
  const classicSecret = nacl.scalarMult(keys.x25519Sec, ephPub);
  const kemSecret = ml_kem768.decapsulate(kemCt, keys.kemSec);
  const key = hkdf(sha256, concatBytes(classicSecret, kemSecret), keys.x25519Pub, INFO_HYBRID, 32);

  const pt = nacl.secretbox.open(ct, nonce, key);
  if (!pt) throw new Error('Decryption failed — this note is not addressed to your wallet (or the blob is corrupted).');
  return pt;
}
