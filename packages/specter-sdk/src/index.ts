// ============================================================================
// Protocol 01 SDK
// Privacy-preserving payments on Solana
// ============================================================================

// Main client
export { P01Client, default } from './client';

// ============================================================================
// Types
// ============================================================================
export type {
  // Wallet types
  P01Wallet,
  WalletCreateOptions,
  WalletImportOptions,

  // Balance types
  Balance,
  TokenBalance,

  // Stealth types
  StealthMetaAddress,
  StealthAddress,
  StealthAddressOptions,
  StealthPayment,
  ScanOptions,

  // Privacy types
  PrivacyLevel,
  PrivacyOptions,

  // Transfer types
  TransferRequest,
  TransferResult,
  ClaimResult,

  // Stream types
  Stream,
  StreamStatus,
  StreamCreateOptions,
  StreamWithdrawOptions,

  // Transaction types
  TransactionType,
  TransactionRecord,

  // Client types
  Cluster,
  P01ClientConfig,
  WalletAdapter,

  // Event types
  P01EventType,
  P01Event,
  P01EventListener,
  PaymentReceivedEvent,
  StreamEvent,
} from './types';

// Error types
export { P01Error, P01ErrorCode } from './types';

// ============================================================================
// Constants
// ============================================================================
export {
  // Program IDs
  PROGRAM_IDS,
  DEFAULT_PROGRAM_ID,

  // RPC endpoints
  RPC_ENDPOINTS,

  // Wallet constants
  DEFAULT_DERIVATION_PATH,
  STEALTH_DERIVATION,
  DEFAULT_MNEMONIC_STRENGTH,

  // Transaction constants
  LAMPORTS_PER_SOL,
  MIN_RENT_EXEMPTION,
  DEFAULT_TX_TIMEOUT,

  // Stealth constants
  STEALTH_ADDRESS_PREFIX,
  VIEW_TAG_SIZE,

  // Stream constants
  MIN_STREAM_DURATION,
  MAX_STREAM_DURATION,
  MIN_STREAM_AMOUNT,

  // Privacy constants
  PRIVACY_CONFIG,
  DEFAULT_SPLIT_COUNT,

  // Feature flags
  FEATURES,
} from './constants';

// ============================================================================
// Wallet Module
// ============================================================================
export {
  // Creation
  createWallet,
  createWalletState,
  generateMnemonic,
  validateMnemonic,
  getWordList,
  deriveKeypair,

  // Import
  importFromSeedPhrase,
  importFromPrivateKey,
  importFromExport,
  importFromSerialized,
  importWalletState,
  recoverAddresses,

  // Types
  type WalletState,
  type SerializableWallet,
  type WalletExportOptions,
  type ExportedWallet,
  type HDDerivationResult,
} from './wallet';

// ============================================================================
// Stealth Module
// ============================================================================
export {
  // Generation
  generateStealthMetaAddress,
  parseStealthMetaAddress,
  generateStealthAddress,
  generateMultipleStealthAddresses,
  createStealthAnnouncement,
  parseStealthAnnouncement,
  generateStealthTransferData,

  // Derivation
  deriveStealthPublicKey,
  deriveStealthPublicKeyFromEncoded,
  deriveStealthPrivateKey,
  verifyStealthOwnership,
  computeStealthAddress,

  // Scanning
  StealthScanner,
  scanForPayments,
  createScanner,
  subscribeToPayments,
} from './stealth';

// ============================================================================
// Transfer Module
// ============================================================================
export {
  // Send
  sendPrivate,
  sendPublic,
  estimateTransferFee,
  type SendOptions,

  // Claim
  claimStealth,
  claimMultiple,
  getStealthBalance,
  canClaim,
  estimateClaimFee,
  closeStealthAccount,
  type ClaimOptions,
} from './transfer';

// ============================================================================
// Streams Module
// ============================================================================
export {
  // Create
  createStream,
  calculateStreamRate,
  calculateWithdrawableAmount,
  getStreamProgress,
  estimateStreamCreationFee,
  type CreateStreamOptions,

  // Withdraw
  withdrawStream,
  withdrawAllStreams,
  getStream,
  getUserStreams,
  type WithdrawOptions,

  // Cancel
  cancelStream,
  pauseStream,
  resumeStream,
  closeExpiredStream,
  type CancelOptions,
} from './streams';

// ============================================================================
// Utilities
// ============================================================================
export {
  // Crypto utilities
  generateEphemeralKeypair,
  generateSigningKeypair,
  deriveSharedSecret,
  deriveKey,
  computeViewTag,
  encrypt,
  decrypt,
  encryptForRecipient,
  decryptFromSender,
  encryptWithPassword,
  decryptWithPassword,
  hash,
  hashString,
  doubleHash,
  toBase58,
  fromBase58,
  toHex,
  fromHex,
  sign,
  verify,
  randomBytes,
  randomSeed,
  constantTimeEqual,
  secureClear,

  // Helper utilities
  isValidPublicKey,
  isValidStealthMetaAddress,
  encodeStealthMetaAddress,
  decodeStealthMetaAddress,
  shortenAddress,
  lamportsToSol,
  solToLamports,
  formatSol,
  formatTokenAmount,
  parseSol,
  nowSeconds,
  daysToSeconds,
  secondsToDays,
  formatDuration,
  formatRelativeTime,
  getRpcEndpoint,
  createConnection,
  sleep,
  retry,
  assert,
  ensureDefined,
  isValidNumber,
  validateTransferAmount,
  chunk,
  unique,
  deepClone,
  pick,
  omit,
  createLogger,
} from './utils';
