/**
 * Protocol 01 JS Constants
 */

// Period durations in seconds
export const PERIODS = {
  daily: 86400,
  weekly: 604800,
  biweekly: 1209600,
  monthly: 2592000, // 30 days
  quarterly: 7776000, // 90 days
  yearly: 31536000, // 365 days
} as const;

// Common token mints
export const TOKENS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
} as const;

// Token decimals
export const TOKEN_DECIMALS: Record<string, number> = {
  [TOKENS.SOL]: 9,
  [TOKENS.USDC]: 6,
  [TOKENS.USDT]: 6,
};

// Default configuration
export const DEFAULT_CONFIG = {
  network: 'devnet' as const,
  timeout: 60000,
  autoConnect: false,
};

// Protocol 01 extension detection
export const P01_PROVIDER_KEY = 'protocol01';
export const P01_INITIALIZED_EVENT = 'protocol01#initialized';
