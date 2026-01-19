/**
 * Application configuration constants for Protocol 01
 */

/**
 * App metadata
 */
export const APP_CONFIG = {
  name: 'P-01',
  fullName: 'Protocol 01',
  version: '1.0.0',
  buildNumber: 1,
  bundleId: 'com.protocol01.app',
  description: 'Privacy-focused Solana wallet with stealth addresses',
  website: 'https://protocol01.dev',
  support: 'support@protocol01.dev',
  github: 'https://github.com/protocol01',
  twitter: 'https://twitter.com/protocol01',
  discord: 'https://discord.gg/protocol01',
} as const;

/**
 * Wallet configuration
 */
export const WALLET_CONFIG = {
  // Default derivation path for Solana
  defaultDerivationPath: "m/44'/501'/0'/0'",

  // Supported word counts for mnemonic
  supportedWordCounts: [12, 24] as const,

  // Default word count for new wallets
  defaultWordCount: 12 as const,

  // Maximum accounts per wallet
  maxAccounts: 10,

  // Auto-lock timeout (in milliseconds)
  autoLockTimeout: 5 * 60 * 1000, // 5 minutes

  // Background lock timeout
  backgroundLockTimeout: 60 * 1000, // 1 minute

  // PIN configuration
  pin: {
    minLength: 4,
    maxLength: 8,
    maxAttempts: 5,
    lockoutDuration: 5 * 60 * 1000, // 5 minutes
  },
} as const;

/**
 * Transaction configuration
 */
export const TRANSACTION_CONFIG = {
  // Default priority level
  defaultPriority: 'medium' as const,

  // Transaction timeout (ms)
  timeout: 60 * 1000, // 60 seconds

  // Confirmation timeout (ms)
  confirmationTimeout: 120 * 1000, // 2 minutes

  // Max retries
  maxRetries: 3,

  // Default compute unit limit
  defaultComputeUnits: 200_000,

  // Minimum SOL to keep for fees
  minSolReserve: 0.01, // 0.01 SOL

  // Minimum lamports for rent exemption (account)
  minRentExemptBalance: 890880, // ~0.00089 SOL
} as const;

/**
 * Stealth protocol configuration
 */
export const STEALTH_CONFIG = {
  // View tag length (bytes)
  viewTagLength: 2,

  // Maximum stealth addresses to scan per batch
  scanBatchSize: 100,

  // Announcement expiry (days)
  announcementExpiry: 30,

  // Registry program ID (placeholder)
  registryProgramId: 'P01RegistryXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
} as const;

/**
 * API configuration
 */
export const API_CONFIG = {
  // Price API
  priceApi: 'https://api.coingecko.com/api/v3',

  // Token list API
  tokenListApi: 'https://token.jup.ag',

  // Rate limits
  rateLimits: {
    priceApi: 10, // requests per minute
    rpcApi: 100, // requests per minute
  },

  // Cache TTL
  cacheTtl: {
    prices: 60 * 1000, // 1 minute
    tokenList: 24 * 60 * 60 * 1000, // 24 hours
    balances: 30 * 1000, // 30 seconds
  },
} as const;

/**
 * Feature flags
 */
export const FEATURES = {
  // Enable stealth transactions
  stealthEnabled: true,

  // Enable biometric authentication
  biometricsEnabled: true,

  // Enable NFT support
  nftsEnabled: true,

  // Enable swap functionality
  swapEnabled: false, // Coming soon

  // Enable staking
  stakingEnabled: false, // Coming soon

  // Enable WalletConnect
  walletConnectEnabled: false, // Coming soon

  // Enable push notifications
  pushNotificationsEnabled: true,

  // Enable analytics
  analyticsEnabled: false,

  // Debug mode
  debugMode: __DEV__ ?? false,
} as const;

/**
 * Limits and thresholds
 */
export const LIMITS = {
  // Maximum transaction history to store locally
  maxTransactionHistory: 100,

  // Maximum contacts
  maxContacts: 100,

  // Maximum custom tokens
  maxCustomTokens: 50,

  // Maximum NFTs to load
  maxNftsToLoad: 100,

  // Input limits
  maxMemoLength: 32,
  maxLabelLength: 20,

  // Display limits
  maxDecimalPlaces: 9,
  displayDecimalPlaces: 4,
} as const;

/**
 * Error messages
 */
export const ERROR_MESSAGES = {
  generic: 'Something went wrong. Please try again.',
  networkError: 'Network error. Please check your connection.',
  transactionFailed: 'Transaction failed. Please try again.',
  insufficientBalance: 'Insufficient balance for this transaction.',
  invalidAddress: 'Invalid Solana address.',
  invalidAmount: 'Invalid amount.',
  invalidPin: 'Invalid PIN.',
  walletLocked: 'Wallet is locked. Please unlock to continue.',
  biometricFailed: 'Biometric authentication failed.',
  sessionExpired: 'Session expired. Please unlock your wallet.',
} as const;

/**
 * Success messages
 */
export const SUCCESS_MESSAGES = {
  transactionSent: 'Transaction sent successfully!',
  walletCreated: 'Wallet created successfully!',
  walletImported: 'Wallet imported successfully!',
  addressCopied: 'Address copied to clipboard.',
  settingsSaved: 'Settings saved.',
} as const;

/**
 * Analytics events
 */
export const ANALYTICS_EVENTS = {
  // Wallet events
  walletCreated: 'wallet_created',
  walletImported: 'wallet_imported',
  walletUnlocked: 'wallet_unlocked',

  // Transaction events
  transactionSent: 'transaction_sent',
  transactionReceived: 'transaction_received',
  stealthTransactionSent: 'stealth_transaction_sent',

  // Screen views
  screenView: 'screen_view',

  // Errors
  error: 'error',
} as const;

/**
 * Environment configuration
 */
export const ENV = {
  isDev: __DEV__ ?? false,
  isProd: !(__DEV__ ?? false),
  platform: 'mobile' as const,
} as const;

// TypeScript helper for __DEV__ in non-RN environments
declare const __DEV__: boolean | undefined;
