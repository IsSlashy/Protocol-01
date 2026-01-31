/**
 * Mock: expo-secure-store
 */
const secureStore: Record<string, string> = {};

export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 6;
export type KeychainAccessibilityConstant = number;

export async function getItemAsync(key: string, _options?: any): Promise<string | null> {
  return secureStore[key] ?? null;
}

export async function setItemAsync(key: string, value: string, _options?: any): Promise<void> {
  secureStore[key] = value;
}

export async function deleteItemAsync(key: string, _options?: any): Promise<void> {
  delete secureStore[key];
}

/** Test helper */
export function __reset(): void {
  Object.keys(secureStore).forEach(k => delete secureStore[k]);
}

/** Test helper */
export function __getStore(): Record<string, string> {
  return { ...secureStore };
}
