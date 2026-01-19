/**
 * Storage keys constants for Protocol 01
 * Centralized key management for AsyncStorage and SecureStore
 */

/**
 * Secure storage keys (expo-secure-store)
 * Used for sensitive data like keys and credentials
 */
export const SecureStorageKeys = {
  // Wallet keys
  MNEMONIC: 'p01_mnemonic',
  PRIVATE_KEY: 'p01_private_key',
  SPENDING_KEY: 'p01_spending_key',
  VIEWING_KEY: 'p01_viewing_key',
  ENCRYPTION_KEY: 'p01_encryption_key',

  // Authentication
  PIN_HASH: 'p01_pin_hash',
  PIN_SALT: 'p01_pin_salt',
  BIOMETRIC_KEY: 'p01_biometric_key',
  AUTH_TOKEN: 'p01_auth_token',

  // Session
  SESSION_KEY: 'p01_session_key',
  LAST_UNLOCK: 'p01_last_unlock',
} as const;

/**
 * Async storage keys (AsyncStorage)
 * Used for general app data
 */
export const AsyncStorageKeys = {
  // Wallet
  WALLET_ADDRESS: 'p01_wallet_address',
  WALLET_NAME: 'p01_wallet_name',
  ACCOUNTS: 'p01_accounts',
  ACTIVE_ACCOUNT: 'p01_active_account',

  // Settings
  SETTINGS: 'p01_settings',
  THEME: 'p01_theme',
  LANGUAGE: 'p01_language',
  CURRENCY: 'p01_currency',
  NOTIFICATIONS: 'p01_notifications',
  BIOMETRICS_ENABLED: 'p01_biometrics_enabled',

  // Network
  NETWORK: 'p01_network',
  CUSTOM_RPC: 'p01_custom_rpc',

  // Tokens
  TOKEN_LIST: 'p01_token_list',
  HIDDEN_TOKENS: 'p01_hidden_tokens',
  CUSTOM_TOKENS: 'p01_custom_tokens',

  // Transactions
  PENDING_TRANSACTIONS: 'p01_pending_transactions',
  TRANSACTION_HISTORY: 'p01_transaction_history',

  // Contacts
  CONTACTS: 'p01_contacts',
  RECENT_ADDRESSES: 'p01_recent_addresses',

  // Stealth
  STEALTH_META_REGISTRY: 'p01_stealth_meta_registry',
  SCANNED_BLOCKS: 'p01_scanned_blocks',

  // App state
  ONBOARDING_COMPLETE: 'p01_onboarding_complete',
  LAST_SYNC: 'p01_last_sync',
  APP_VERSION: 'p01_app_version',

  // Cache
  PRICE_CACHE: 'p01_price_cache',
  BALANCE_CACHE: 'p01_balance_cache',
  NFT_CACHE: 'p01_nft_cache',
} as const;

/**
 * Cache keys with TTL
 */
export const CacheKeys = {
  SOL_PRICE: {
    key: 'cache_sol_price',
    ttl: 60 * 1000, // 1 minute
  },
  TOKEN_PRICES: {
    key: 'cache_token_prices',
    ttl: 60 * 1000, // 1 minute
  },
  BALANCES: {
    key: 'cache_balances',
    ttl: 30 * 1000, // 30 seconds
  },
  TOKEN_ACCOUNTS: {
    key: 'cache_token_accounts',
    ttl: 60 * 1000, // 1 minute
  },
  TRANSACTION_HISTORY: {
    key: 'cache_transaction_history',
    ttl: 5 * 60 * 1000, // 5 minutes
  },
  NFT_METADATA: {
    key: 'cache_nft_metadata',
    ttl: 30 * 60 * 1000, // 30 minutes
  },
  TOKEN_METADATA: {
    key: 'cache_token_metadata',
    ttl: 24 * 60 * 60 * 1000, // 24 hours
  },
} as const;

/**
 * Type helpers
 */
export type SecureStorageKey = typeof SecureStorageKeys[keyof typeof SecureStorageKeys];
export type AsyncStorageKey = typeof AsyncStorageKeys[keyof typeof AsyncStorageKeys];
export type CacheKey = typeof CacheKeys[keyof typeof CacheKeys];

/**
 * Get all storage keys (for debugging/clearing)
 */
export function getAllSecureKeys(): string[] {
  return Object.values(SecureStorageKeys);
}

export function getAllAsyncKeys(): string[] {
  return Object.values(AsyncStorageKeys);
}

export function getAllCacheKeys(): string[] {
  return Object.values(CacheKeys).map(c => c.key);
}

/**
 * Generate namespaced key
 */
export function createNamespacedKey(namespace: string, key: string): string {
  return `p01_${namespace}_${key}`;
}

/**
 * Generate account-specific key
 */
export function createAccountKey(baseKey: string, accountAddress: string): string {
  return `${baseKey}_${accountAddress.slice(0, 8)}`;
}

/**
 * Check if key is a secure storage key
 */
export function isSecureStorageKey(key: string): boolean {
  return getAllSecureKeys().includes(key);
}

/**
 * Check if key is a cache key
 */
export function isCacheKey(key: string): boolean {
  return getAllCacheKeys().includes(key);
}
