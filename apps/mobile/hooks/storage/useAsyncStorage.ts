/**
 * useAsyncStorage - AsyncStorage wrapper for non-sensitive data
 * @module hooks/storage/useAsyncStorage
 */

import { useCallback, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Storage keys prefix
const STORAGE_PREFIX = '@p01:';

// Common storage keys
export const ASYNC_KEYS = {
  CONTACTS: `${STORAGE_PREFIX}contacts`,
  RECENT_TRANSACTIONS: `${STORAGE_PREFIX}recent_txs`,
  PRICE_CACHE: `${STORAGE_PREFIX}price_cache`,
  SETTINGS: `${STORAGE_PREFIX}settings`,
  ONBOARDING_COMPLETE: `${STORAGE_PREFIX}onboarding`,
  LAST_SYNC: `${STORAGE_PREFIX}last_sync`,
  NETWORK_CONFIG: `${STORAGE_PREFIX}network`,
  AGENT_HISTORY: `${STORAGE_PREFIX}agent_history`,
  STREAM_CACHE: `${STORAGE_PREFIX}streams`,
  FAVORITES: `${STORAGE_PREFIX}favorites`,
} as const;

export type AsyncKey = (typeof ASYNC_KEYS)[keyof typeof ASYNC_KEYS] | string;

interface UseAsyncStorageOptions<T> {
  key: AsyncKey;
  defaultValue?: T;
}

interface UseAsyncStorageReturn<T> {
  value: T | null;
  setValue: (newValue: T) => Promise<boolean>;
  removeValue: () => Promise<boolean>;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

export function useAsyncStorage<T = unknown>({
  key,
  defaultValue,
}: UseAsyncStorageOptions<T>): UseAsyncStorageReturn<T> {
  const [value, setValueState] = useState<T | null>(defaultValue ?? null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const loadValue = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const stored = await AsyncStorage.getItem(key);

      if (stored === null) {
        setValueState(defaultValue ?? null);
      } else {
        try {
          setValueState(JSON.parse(stored) as T);
        } catch {
          setValueState(stored as unknown as T);
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to load from storage');
      setError(error);
      setValueState(defaultValue ?? null);
    } finally {
      setIsLoading(false);
    }
  }, [key, defaultValue]);

  useEffect(() => {
    loadValue();
  }, [loadValue]);

  const setValue = useCallback(async (newValue: T): Promise<boolean> => {
    setError(null);

    try {
      const stringValue = typeof newValue === 'string'
        ? newValue
        : JSON.stringify(newValue);

      await AsyncStorage.setItem(key, stringValue);
      setValueState(newValue);
      return true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to save to storage');
      setError(error);
      return false;
    }
  }, [key]);

  const removeValue = useCallback(async (): Promise<boolean> => {
    setError(null);

    try {
      await AsyncStorage.removeItem(key);
      setValueState(defaultValue ?? null);
      return true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to remove from storage');
      setError(error);
      return false;
    }
  }, [key, defaultValue]);

  const refresh = useCallback(async (): Promise<void> => {
    await loadValue();
  }, [loadValue]);

  return {
    value,
    setValue,
    removeValue,
    isLoading,
    error,
    refresh,
  };
}

// Utility functions for direct storage access
export const asyncStorageUtils = {
  async getItem<T>(key: AsyncKey): Promise<T | null> {
    try {
      const value = await AsyncStorage.getItem(key);
      if (value === null) return null;
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  },

  async setItem<T>(key: AsyncKey, value: T): Promise<boolean> {
    try {
      await AsyncStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },

  async removeItem(key: AsyncKey): Promise<boolean> {
    try {
      await AsyncStorage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  },

  async multiGet<T>(keys: AsyncKey[]): Promise<Map<AsyncKey, T | null>> {
    const result = new Map<AsyncKey, T | null>();
    try {
      const pairs = await AsyncStorage.multiGet(keys);
      for (const [key, value] of pairs) {
        result.set(key, value ? (JSON.parse(value) as T) : null);
      }
    } catch {
      // Return empty map on error
    }
    return result;
  },

  async multiSet<T>(items: Array<[AsyncKey, T]>): Promise<boolean> {
    try {
      const pairs: Array<[string, string]> = items.map(([key, value]) => [
        key,
        JSON.stringify(value),
      ]);
      await AsyncStorage.multiSet(pairs);
      return true;
    } catch {
      return false;
    }
  },

  async getAllKeys(): Promise<string[]> {
    try {
      const keys = await AsyncStorage.getAllKeys();
      return keys.filter(key => key.startsWith(STORAGE_PREFIX));
    } catch {
      return [];
    }
  },

  async clear(): Promise<boolean> {
    try {
      const keys = await this.getAllKeys();
      await AsyncStorage.multiRemove(keys);
      return true;
    } catch {
      return false;
    }
  },
};
