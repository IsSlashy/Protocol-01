/**
 * useSecureStorage - Expo SecureStore wrapper for sensitive data
 * @module hooks/storage/useSecureStorage
 */

import { useCallback, useState } from 'react';
import * as SecureStore from 'expo-secure-store';

// Storage keys for type safety
export const SECURE_KEYS = {
  WALLET_SEED: 'p01_wallet_seed',
  WALLET_PRIVATE_KEY: 'p01_wallet_pk',
  STEALTH_SPENDING_KEY: 'p01_stealth_spending',
  STEALTH_VIEWING_KEY: 'p01_stealth_viewing',
  AUTH_PIN: 'p01_auth_pin',
  BIOMETRIC_ENABLED: 'p01_biometric_enabled',
  ENCRYPTION_KEY: 'p01_encryption_key',
} as const;

export type SecureKey = (typeof SECURE_KEYS)[keyof typeof SECURE_KEYS];

interface SecureStorageOptions {
  keychainAccessible?: SecureStore.KeychainAccessibilityConstant;
  requireAuthentication?: boolean;
}

interface UseSecureStorageReturn {
  getSecure: <T = string>(key: SecureKey) => Promise<T | null>;
  setSecure: <T = string>(key: SecureKey, value: T) => Promise<boolean>;
  removeSecure: (key: SecureKey) => Promise<boolean>;
  hasSecure: (key: SecureKey) => Promise<boolean>;
  clearAll: () => Promise<void>;
  isLoading: boolean;
  error: Error | null;
}

export function useSecureStorage(
  options: SecureStorageOptions = {}
): UseSecureStorageReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const {
    keychainAccessible = SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    requireAuthentication = false,
  } = options;

  const getSecure = useCallback(async <T = string>(
    key: SecureKey
  ): Promise<T | null> => {
    setIsLoading(true);
    setError(null);

    try {
      const value = await SecureStore.getItemAsync(key, {
        keychainAccessible,
        requireAuthentication,
      });

      if (value === null) {
        return null;
      }

      // Try to parse as JSON, fallback to raw string
      try {
        return JSON.parse(value) as T;
      } catch {
        return value as unknown as T;
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to get secure item');
      setError(error);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [keychainAccessible, requireAuthentication]);

  const setSecure = useCallback(async <T = string>(
    key: SecureKey,
    value: T
  ): Promise<boolean> => {
    setIsLoading(true);
    setError(null);

    try {
      const stringValue = typeof value === 'string'
        ? value
        : JSON.stringify(value);

      await SecureStore.setItemAsync(key, stringValue, {
        keychainAccessible,
        requireAuthentication,
      });

      return true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to set secure item');
      setError(error);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [keychainAccessible, requireAuthentication]);

  const removeSecure = useCallback(async (key: SecureKey): Promise<boolean> => {
    setIsLoading(true);
    setError(null);

    try {
      await SecureStore.deleteItemAsync(key, {
        keychainAccessible,
        requireAuthentication,
      });
      return true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to remove secure item');
      setError(error);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [keychainAccessible, requireAuthentication]);

  const hasSecure = useCallback(async (key: SecureKey): Promise<boolean> => {
    try {
      const value = await SecureStore.getItemAsync(key, {
        keychainAccessible,
        requireAuthentication,
      });
      return value !== null;
    } catch {
      return false;
    }
  }, [keychainAccessible, requireAuthentication]);

  const clearAll = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setError(null);

    try {
      const keys = Object.values(SECURE_KEYS);
      await Promise.all(
        keys.map(key =>
          SecureStore.deleteItemAsync(key, {
            keychainAccessible,
            requireAuthentication,
          })
        )
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to clear secure storage');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [keychainAccessible, requireAuthentication]);

  return {
    getSecure,
    setSecure,
    removeSecure,
    hasSecure,
    clearAll,
    isLoading,
    error,
  };
}
