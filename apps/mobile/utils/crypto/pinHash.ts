/**
 * Salted PIN hashing utility.
 *
 * Uses a per-device random salt stored in SecureStore so that identical PINs
 * produce different hashes on different devices. The salt is generated once on
 * first PIN creation and reused for all subsequent hashes.
 *
 * Format: SHA-256("p01_pin_v2:<salt>:<pin>")
 */

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const PIN_SALT_KEY = 'p01_pin_salt';

/**
 * Hash a PIN with a per-device random salt.
 * On first call the salt is generated and persisted to SecureStore.
 */
export async function hashPin(pin: string): Promise<string> {
  let salt = await SecureStore.getItemAsync(PIN_SALT_KEY);
  if (!salt) {
    // Generate 16 random bytes as hex
    const bytes = Crypto.getRandomBytes(16);
    salt = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    await SecureStore.setItemAsync(PIN_SALT_KEY, salt);
  }
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `p01_pin_v2:${salt}:${pin}`,
  );
}

/**
 * Constant-time string comparison to prevent timing side-channels on PIN hashes.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
