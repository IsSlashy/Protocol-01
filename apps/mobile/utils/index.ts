/**
 * Protocol 01 Mobile Utils
 * Central export for all utility functions
 */

// Format utilities (excluding duplicates)
export {
  formatCurrency,
  formatFiatAmount,
  formatTokenAmount,
  formatCompactNumber,
} from './format/currency';
export {
  truncateAddress,
  formatAddress,
  isValidSolanaAddress,
} from './format/address';
export * from './format/date';
export * from './format/number';

// Crypto utilities (excluding duplicates handled by validation)
export * from './crypto/encryption';
export * from './crypto/keys';
export {
  generateMnemonic,
  mnemonicToSeed,
  getWordlist,
} from './crypto/seedPhrase';
export * from './crypto/stealth';

// Validation utilities
export {
  validateAmount,
  isValidAmount,
  normalizeAmount,
  type AmountValidation,
} from './validation/amount';
export {
  validateSolanaAddress,
} from './validation/address';
export {
  validateSeedPhrase,
  getWordSuggestions,
  type ValidationResult,
} from './validation/seedPhrase';
export * from './validation/pin';

// Storage utilities
export * from './storage';

// Solana utilities (excluding duplicates)
export {
  getConnection,
  type NetworkType,
} from './solana/connection';
export * from './solana/fees';
export {
  getTokenInfo,
  getTokenBalance,
  transferToken,
} from './solana/tokens';
export * from './solana/transaction';

// Constants (NetworkConfig from constants takes precedence)
export {
  type NetworkConfig,
  type NetworkId,
  NETWORKS,
  getNetworkConfig,
  getAvailableNetworks,
  DEFAULT_NETWORK,
} from './constants/networks';
export * from './constants/config';
export * from './constants/tokens';

// Privacy utilities
export * from './privacy';
