/**
 * Mock: ed25519-hd-key
 */
import { createHash, createHmac } from 'crypto';

export function derivePath(path: string, seed: string): { key: Uint8Array } {
  // Include the derivation path in the HMAC so different paths produce different keys
  const hmac = createHmac('sha512', 'ed25519 seed')
    .update(Buffer.from(seed, 'hex'))
    .update(path)
    .digest();
  return { key: new Uint8Array(hmac.slice(0, 32)) };
}

export function getMasterKeyFromSeed(seed: string): { key: Buffer; chainCode: Buffer } {
  const hmac = createHmac('sha512', 'ed25519 seed').update(Buffer.from(seed, 'hex')).digest();
  return { key: hmac.slice(0, 32), chainCode: hmac.slice(32) };
}
