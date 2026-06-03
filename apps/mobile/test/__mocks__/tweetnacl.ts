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

const nacl = {
  sign: {
    keyPair: {
      fromSeed: keyPairFromSeed,
    },
  },
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
