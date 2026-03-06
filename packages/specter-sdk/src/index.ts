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
  STEALTH_META_ADDRESS_VERSION,
  STEALTH_META_ADDRESS_VERSION_2,
  VIEW_TAG_SIZE,
  KEM_PUBLIC_KEY_SIZE,
  KEM_CIPHERTEXT_SIZE,

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
  buildClaimProof,
  buildClaimProofV2,
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
// Indexing Module (Client-Side — replaces relayer indexer)
// ============================================================================
export {
  // Commitment indexer (replaces /pool/state & /pool/commitments)
  CommitmentIndexer,
  type CommitmentIndexerOptions,
  type IndexerStatus,

  // Stealth payment indexer (replaces /relay/stealth-payments)
  StealthIndexer,
  type StealthIndexerOptions,

  // Cache backends
  type IndexerCache,
  MemoryCache,
  LocalStorageCache,
} from './indexing';

// ============================================================================
// Subscription Module (ZK Private)
// ============================================================================
export {
  createPrivateSubscription,
  generatePrivatePaymentData,
  type PrivateSubscriptionParams,
  type PrivateSubscriptionResult,
  type PrivatePaymentData,
  type SubscriptionFrequency,
} from './subscription';

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
  deriveStealthSeed,
  kemGenerateKeypair,
  kemEncapsulate,
  kemDecapsulate,
  deriveHybridSharedSecret,
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

// ============================================================================
// Proving Module (Client-Side zkSPL Prover)
// ============================================================================
//
// TRUST THE MATH, NOT THE NODES.
// Generate zkSPL Groth16 proofs entirely on the client device.
// The spending_key, balance, and salt NEVER leave the user's machine.
//
export {
  // Main prover class
  ClientProver,

  // Circuit file loader
  CircuitLoader,

  // Proof format conversion
  snarkjsProofToBytes,
  parsePublicSignals,
  buildBalanceCircuitInputs,
  buildSufficiencyCircuitInputs,

  // Error class
  ProofInputValidationError,

  // Types (re-exported from proving/types.ts)
  type Groth16ProofBytes,
  type FieldElement as ZkFieldElement,
  type ZkSplOperation,
  type ConfidentialBalancePublicInputs,
  type ConfidentialBalancePrivateInputs,
  type BalanceProofPublicInputs,
  type BalanceProofPrivateInputs,
  type DepositProofInputs,
  type WithdrawProofInputs,
  type TransferProofInputs,
  type BalanceSufficiencyProofInputs,
  type ZkSplProofInputs,
  type SnarkjsProof,
  type ProofResult,
  type CircuitFileConfig,
  type ClientProverConfig,
  type ProgressCallback,
  type ProgressEvent as CircuitProgressEvent,
  type CircuitFiles,
} from './proving';

// ============================================================================
// Relay Module (Decentralized Transaction Relay)
// ============================================================================
//
// BREAK THE LINK. Submit transactions through encrypted relay jobs.
// An ephemeral keypair posts the job; the relayer executes it.
// No on-chain connection between your wallet and the transaction.
//
export {
  // Submit
  submitRelayJob,
  generateJobId,

  // Encryption
  encryptForRelayer,
  decryptRelayJob,

  // Selection
  fetchActiveRelayers,
  fetchRelayerConfig,
  selectRelayer,

  // Monitoring
  monitorJob,
  cancelRelayJob,

  // Constants & types
  RELAYER_PROGRAM_ID_DEVNET,
  RELAY_SEEDS,
  JobStatus,
  type RelayerNodeInfo,
  type RelayerConfigInfo,
  type RelayJobInfo,
  type SubmitRelayJobOptions,
  type RelayJobResult,
  type JobCompletionResult,
} from './relay';
