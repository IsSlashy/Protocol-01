/**
 * Protocol 01 SDK Constants
 */

// ============ Time Periods ============

/**
 * Payment intervals in seconds
 */
export const INTERVALS = {
  daily: 86400,           // 24 hours
  weekly: 604800,         // 7 days
  biweekly: 1209600,      // 14 days
  monthly: 2592000,       // 30 days
  quarterly: 7776000,     // 90 days
  yearly: 31536000,       // 365 days
} as const;

/**
 * Interval display names
 */
export const INTERVAL_NAMES: Record<keyof typeof INTERVALS, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  biweekly: 'Bi-weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
};

// ============ Token Configuration ============

/**
 * Common token mint addresses on Solana mainnet
 */
export const TOKENS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  PYUSD: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
} as const;

/**
 * Token mint addresses for devnet
 */
export const TOKENS_DEVNET = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // Devnet USDC
  USDT: 'EJwZgeZrdC8TXTQbQBoL6bfuAnFUUy1PVCMB4DYPzVaS', // Devnet USDT
} as const;

/**
 * Token decimals
 */
export const TOKEN_DECIMALS: Record<string, number> = {
  [TOKENS.SOL]: 9,
  [TOKENS.USDC]: 6,
  [TOKENS.USDT]: 6,
  [TOKENS.PYUSD]: 6,
  [TOKENS_DEVNET.USDC]: 6,
  [TOKENS_DEVNET.USDT]: 6,
};

/**
 * Token symbols by mint address
 */
export const TOKEN_SYMBOLS: Record<string, string> = {
  [TOKENS.SOL]: 'SOL',
  [TOKENS.USDC]: 'USDC',
  [TOKENS.USDT]: 'USDT',
  [TOKENS.PYUSD]: 'PYUSD',
  [TOKENS_DEVNET.USDC]: 'USDC',
  [TOKENS_DEVNET.USDT]: 'USDT',
};

// ============ Provider Constants ============

/**
 * Window property where Protocol 01 provider is injected
 */
export const PROVIDER_KEY = 'protocol01';

/**
 * Fallback to Solana provider if Protocol 01 not available
 */
export const SOLANA_PROVIDER_KEY = 'solana';

/**
 * Event fired when Protocol 01 provider is initialized
 */
export const PROVIDER_INITIALIZED_EVENT = 'protocol01#initialized';

/**
 * Event fired when Solana provider is initialized
 */
export const SOLANA_INITIALIZED_EVENT = 'solana#initialized';

// ============ Default Configuration ============

/**
 * Default SDK configuration
 */
export const DEFAULT_CONFIG = {
  network: 'mainnet-beta' as const,
  timeout: 60000, // 60 seconds
  autoConnect: false,
  defaultToken: 'USDC' as const,
};

// ============ Privacy Defaults ============

/**
 * Default privacy options for subscriptions
 */
export const DEFAULT_PRIVACY = {
  amountNoise: 0,        // No amount noise by default
  timingNoise: 0,        // No timing noise by default
  useStealthAddress: false,
};

/**
 * Maximum allowed values for privacy options
 */
export const PRIVACY_LIMITS = {
  maxAmountNoise: 25,    // Max +/-25% amount noise
  maxTimingNoise: 24,    // Max +/-24 hours timing noise
};

// ============ Subscription Limits ============

/**
 * Subscription constraints
 */
export const SUBSCRIPTION_LIMITS = {
  minAmount: 0.01,           // Minimum amount per period
  maxAmount: 1000000,        // Maximum amount per period
  minPeriodSeconds: 3600,    // Minimum 1 hour period
  maxPeriodSeconds: 31536000, // Maximum 1 year period
  maxPayments: 999999,       // Maximum payment count (0 = unlimited)
};

// ============ URLs ============

/**
 * Protocol 01 URLs
 */
export const URLS = {
  website: 'https://protocol01.com',
  docs: 'https://docs.protocol01.com',
  walletInstall: 'https://protocol01.com/wallet',
  api: 'https://api.protocol01.com',
  apiDevnet: 'https://api-devnet.protocol01.com',
};

// ============ Category Icons ============

/**
 * Default category icons (emoji fallbacks)
 */
export const CATEGORY_ICONS: Record<string, string> = {
  streaming: 'play_circle',
  music: 'music_note',
  ai: 'smart_toy',
  gaming: 'sports_esports',
  saas: 'cloud',
  news: 'newspaper',
  fitness: 'fitness_center',
  education: 'school',
  cloud: 'cloud_queue',
  vpn: 'vpn_key',
  storage: 'storage',
  productivity: 'task_alt',
  entertainment: 'movie',
  finance: 'account_balance',
  other: 'category',
};
