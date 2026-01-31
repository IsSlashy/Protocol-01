/**
 * Mock: expo-crypto
 *
 * Provides deterministic crypto operations for testing.
 * Uses Node.js crypto module under the hood.
 */
import { createHash, randomBytes } from 'crypto';

export const CryptoDigestAlgorithm = {
  SHA256: 'SHA-256',
  SHA512: 'SHA-512',
  MD5: 'MD5',
} as const;

export async function digestStringAsync(
  algorithm: string,
  data: string
): Promise<string> {
  const alg = algorithm === 'SHA-256' ? 'sha256'
    : algorithm === 'SHA-512' ? 'sha512'
    : 'md5';
  return createHash(alg).update(data).digest('hex');
}

export async function getRandomBytesAsync(byteCount: number): Promise<Uint8Array> {
  return new Uint8Array(randomBytes(byteCount));
}
