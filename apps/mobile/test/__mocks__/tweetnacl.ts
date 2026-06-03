/**
 * Mock: tweetnacl
 *
 * Provides lightweight stubs for NaCl box/sign operations.
 */
import { createHash, randomBytes } from 'crypto';

function keyPairFromSeed(seed: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const pk = createHash('sha256').update(seed).digest();
  const sk = new Uint8Array(64);
  sk.set(seed.slice(0, 32));
  sk.set(pk, 32);
  return { publicKey: new Uint8Array(pk), secretKey: sk };
}

// ---------------------------------------------------------------------------
// secretbox (XSalsa20-Poly1305 in prod) — test stub backed by AES-256-GCM.
// Not byte-compatible with real NaCl, but a correct authenticated round-trip:
// secretbox(open(box)) === plaintext, wrong key/tampered ct → null. Enough to
// validate the backup encrypt/decrypt + KDF version dispatch in unit tests.
// ---------------------------------------------------------------------------
const SECRETBOX_NONCE_LEN = 24;

function secretbox(message: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array {
  const { createCipheriv } = require('crypto');
  // AES-GCM uses a 12-byte IV; derive it deterministically from the 24-byte nonce.
  const iv = createHash('sha256').update(Buffer.from(nonce)).digest().subarray(0, 12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key.subarray(0, 32)), iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(message)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([tag, ct])); // [16-byte tag || ct]
}

function secretboxOpen(box: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null {
  try {
    const { createDecipheriv } = require('crypto');
    const iv = createHash('sha256').update(Buffer.from(nonce)).digest().subarray(0, 12);
    const buf = Buffer.from(box);
    const tag = buf.subarray(0, 16);
    const ct = buf.subarray(16);
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key.subarray(0, 32)), iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}

const nacl = {
  sign: {
    keyPair: {
      fromSeed: keyPairFromSeed,
    },
  },
  randomBytes: (n: number): Uint8Array => new Uint8Array(randomBytes(n)),
  secretbox: Object.assign(secretbox, {
    open: secretboxOpen,
    nonceLength: SECRETBOX_NONCE_LEN,
    keyLength: 32,
    overheadLength: 16,
  }),
  box: {
    keyPair: Object.assign(
      (): { publicKey: Uint8Array; secretKey: Uint8Array } => {
        const sk = new Uint8Array(randomBytes(32));
        const pk = new Uint8Array(createHash('sha256').update(sk).digest());
        return { publicKey: pk, secretKey: sk };
      },
      {
        fromSecretKey: (secretKey: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array } => {
          const pk = new Uint8Array(createHash('sha256').update(secretKey).digest());
          return { publicKey: pk, secretKey };
        },
      }
    ),
    before: (theirPk: Uint8Array, mySecretKey: Uint8Array): Uint8Array => {
      // Simulated shared secret via hashing
      const combined = new Uint8Array(theirPk.length + mySecretKey.length);
      combined.set(theirPk);
      combined.set(mySecretKey, theirPk.length);
      return new Uint8Array(createHash('sha256').update(combined).digest());
    },
  },
  hash: (msg: Uint8Array): Uint8Array => {
    return new Uint8Array(createHash('sha512').update(msg).digest());
  },
};

export default nacl;
