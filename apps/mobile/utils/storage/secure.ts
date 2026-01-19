/**
 * Secure storage helpers for Protocol 01
 * Wrapper around expo-secure-store with encryption support
 */

import * as SecureStore from 'expo-secure-store';
import { SecureStorageKeys, SecureStorageKey } from './keys';

export interface SecureStoreOptions {
  keychainService?: string;
  keychainAccessible?: SecureStore.KeychainAccessibilityConstant;
}

export interface SecureStorageError {
  code: 'STORAGE_ERROR' | 'ENCRYPTION_ERROR' | 'NOT_FOUND' | 'INVALID_DATA';
  message: string;
}

const DEFAULT_OPTIONS: SecureStoreOptions = {
  keychainService: 'protocol-01',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/**
 * Save value to secure storage
 */
export async function secureSet(
  key: SecureStorageKey | string,
  value: string,
  options?: SecureStoreOptions
): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value, {
      ...DEFAULT_OPTIONS,
      ...options,
    });
  } catch (error) {
    throw createStorageError(
      'STORAGE_ERROR',
      `Failed to save secure data: ${(error as Error).message}`
    );
  }
}

/**
 * Get value from secure storage
 */
export async function secureGet(
  key: SecureStorageKey | string,
  options?: SecureStoreOptions
): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key, {
      ...DEFAULT_OPTIONS,
      ...options,
    });
  } catch (error) {
    throw createStorageError(
      'STORAGE_ERROR',
      `Failed to retrieve secure data: ${(error as Error).message}`
    );
  }
}

/**
 * Delete value from secure storage
 */
export async function secureDelete(
  key: SecureStorageKey | string,
  options?: SecureStoreOptions
): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key, {
      ...DEFAULT_OPTIONS,
      ...options,
    });
  } catch (error) {
    throw createStorageError(
      'STORAGE_ERROR',
      `Failed to delete secure data: ${(error as Error).message}`
    );
  }
}

/**
 * Save JSON object to secure storage
 */
export async function secureSetJSON<T>(
  key: SecureStorageKey | string,
  value: T,
  options?: SecureStoreOptions
): Promise<void> {
  try {
    const jsonString = JSON.stringify(value);
    await secureSet(key, jsonString, options);
  } catch (error) {
    if ((error as SecureStorageError).code) {
      throw error;
    }
    throw createStorageError(
      'STORAGE_ERROR',
      `Failed to save JSON data: ${(error as Error).message}`
    );
  }
}

/**
 * Get JSON object from secure storage
 */
export async function secureGetJSON<T>(
  key: SecureStorageKey | string,
  options?: SecureStoreOptions
): Promise<T | null> {
  try {
    const jsonString = await secureGet(key, options);
    if (jsonString === null) {
      return null;
    }
    return JSON.parse(jsonString) as T;
  } catch (error) {
    if ((error as SecureStorageError).code) {
      throw error;
    }
    throw createStorageError(
      'INVALID_DATA',
      `Failed to parse JSON data: ${(error as Error).message}`
    );
  }
}

/**
 * Check if key exists in secure storage
 */
export async function secureHas(
  key: SecureStorageKey | string,
  options?: SecureStoreOptions
): Promise<boolean> {
  const value = await secureGet(key, options);
  return value !== null;
}

/**
 * Get value or default if not found
 */
export async function secureGetOrDefault<T extends string>(
  key: SecureStorageKey | string,
  defaultValue: T,
  options?: SecureStoreOptions
): Promise<T> {
  const value = await secureGet(key, options);
  return (value as T) ?? defaultValue;
}

/**
 * Clear all P-01 secure storage
 */
export async function secureClearAll(): Promise<void> {
  const keys = Object.values(SecureStorageKeys);
  const errors: Error[] = [];

  for (const key of keys) {
    try {
      await secureDelete(key);
    } catch (error) {
      errors.push(error as Error);
    }
  }

  if (errors.length > 0) {
    console.warn(`Failed to clear ${errors.length} secure storage items`);
  }
}

/**
 * Save mnemonic securely
 */
export async function saveMnemonic(mnemonic: string): Promise<void> {
  await secureSet(SecureStorageKeys.MNEMONIC, mnemonic);
}

/**
 * Get mnemonic from secure storage
 */
export async function getMnemonic(): Promise<string | null> {
  return secureGet(SecureStorageKeys.MNEMONIC);
}

/**
 * Delete mnemonic from secure storage
 */
export async function deleteMnemonic(): Promise<void> {
  await secureDelete(SecureStorageKeys.MNEMONIC);
}

/**
 * Save private key securely
 */
export async function savePrivateKey(privateKey: string): Promise<void> {
  await secureSet(SecureStorageKeys.PRIVATE_KEY, privateKey);
}

/**
 * Get private key from secure storage
 */
export async function getPrivateKey(): Promise<string | null> {
  return secureGet(SecureStorageKeys.PRIVATE_KEY);
}

/**
 * Delete private key from secure storage
 */
export async function deletePrivateKey(): Promise<void> {
  await secureDelete(SecureStorageKeys.PRIVATE_KEY);
}

/**
 * Save PIN hash securely
 */
export async function savePINHash(hash: string, salt: string): Promise<void> {
  await Promise.all([
    secureSet(SecureStorageKeys.PIN_HASH, hash),
    secureSet(SecureStorageKeys.PIN_SALT, salt),
  ]);
}

/**
 * Get PIN hash and salt
 */
export async function getPINCredentials(): Promise<{
  hash: string | null;
  salt: string | null;
}> {
  const [hash, salt] = await Promise.all([
    secureGet(SecureStorageKeys.PIN_HASH),
    secureGet(SecureStorageKeys.PIN_SALT),
  ]);
  return { hash, salt };
}

/**
 * Delete PIN credentials
 */
export async function deletePINCredentials(): Promise<void> {
  await Promise.all([
    secureDelete(SecureStorageKeys.PIN_HASH),
    secureDelete(SecureStorageKeys.PIN_SALT),
  ]);
}

/**
 * Check if wallet is set up (has mnemonic or private key)
 */
export async function hasWalletCredentials(): Promise<boolean> {
  const [hasMnemonic, hasPrivateKey] = await Promise.all([
    secureHas(SecureStorageKeys.MNEMONIC),
    secureHas(SecureStorageKeys.PRIVATE_KEY),
  ]);
  return hasMnemonic || hasPrivateKey;
}

/**
 * Check if PIN is set up
 */
export async function hasPINSetup(): Promise<boolean> {
  return secureHas(SecureStorageKeys.PIN_HASH);
}

/**
 * Update last unlock time
 */
export async function updateLastUnlock(): Promise<void> {
  await secureSet(SecureStorageKeys.LAST_UNLOCK, Date.now().toString());
}

/**
 * Get last unlock time
 */
export async function getLastUnlock(): Promise<number | null> {
  const value = await secureGet(SecureStorageKeys.LAST_UNLOCK);
  return value ? parseInt(value, 10) : null;
}

// Helper function

function createStorageError(
  code: SecureStorageError['code'],
  message: string
): SecureStorageError {
  return { code, message };
}
