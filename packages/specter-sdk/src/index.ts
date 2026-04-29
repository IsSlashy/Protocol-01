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
  REGISTRY_PROGRAM_IDS,
  RELAYER_PROGRAM_IDS,
  DEFAULT_PROGRAM_ID,
  getCheckedProgramId,

  // RPC endpoints
  RPC_ENDPOINTS,
  setCustomRpcEndpoint,
  getEffectiveRpcEndpoint,
  isPublicRpcEndpoint,

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
  setFeature,
  getFeature,
  type FeatureName,
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
  ed25519PublicKeyToX25519,
  ed25519SecretKeyToX25519,
  ed25519ToX25519PublicKey,
  ed25519ToX25519PrivateKey,
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
// Proving Module (Client-Side zkSPL STARK Prover)
// ============================================================================
//
// TRUST THE MATH, NOT THE NODES.
// Generate zkSPL STARK proofs entirely on the client device via
// `@protocol-01/stark-prover` — post-quantum safe, no trusted setup, Goldilocks
// field. The spending_key, balance, and salt NEVER leave the user's machine.
//
export {
  // Main prover class
  StarkClientProver,

  // Input builders + validation helpers
  buildBalanceCircuitInputs,
  buildSufficiencyCircuitInputs,
  validateInputs,
  circuitIdForOperation,

  // Error class
  ProofInputValidationError,

  // Types (re-exported from proving/types.ts)
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
  type StarkProofOutcome,
  type StarkProverConfig,
  type StarkClientProverInit,
  type StarkPrivateInputMap,
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

// ============================================================================
// Quantum-Safe Vault Module
// ============================================================================
//
// APPLICATION-LAYER DEFENSE AGAINST QUANTUM ATTACKS ON ED25519.
// Three mechanisms that protect funds even if Shor's algorithm breaks Ed25519:
// 1. Winternitz OTS (WOTS+) — hash-based one-time signatures
// 2. Hash-timelock vault — SHA-256 preimage lock for cold storage
// 3. Commit-then-reveal — two-phase quantum-safe transaction authorization
//
export {
  // WOTS+ key management
  generateWotsKeypair,
  wotsSign,
  wotsVerify,
  deriveWotsKeypair,
  computeWithdrawMessage,

  // Hash vault
  computeHashVaultCommitment,
  generateVaultSecret,

  // Commit-reveal
  computeCommitment,
  generateNonce,

  // Long-term (SHA-512) commitments — P4.5
  computeLongTermCommitment,
  generateLongTermSecret,
  verifyLongTermCommitment,
  LONG_TERM_COMMIT_SIZE,
  LONG_TERM_COMMIT_DOMAIN,

  // WOTS+ types
  type WotsKeypair,
  type WotsSignature,

  // Constants
  WOTS_CHAINS,
  WOTS_SIG_SIZE,
  WOTS_PUBKEY_SIZE,
} from './quantum';

// ============================================================================
// Registry Module (On-Chain Stealth Address Book)
// ============================================================================
//
// Publish your stealth meta-address on-chain so anyone can look you up
// by wallet address and send you a private payment. No out-of-band sharing.
//
export {
  // Lookup
  lookupMetaAddress,
  lookupMultiple,
  isRegistered,
  getRegistryPDA,
  entryToMetaAddress,

  // Constants
  REGISTRY_PROGRAM_ID,

  // Types
  type RegistryEntry,
} from './registry';

// ============================================================================
// Service Registry Module (On-Chain Merchant Directory)
// ============================================================================
//
// Merchants publish a `ServiceRegistry` PDA per service (Netflix, Spotify,
// self-hosted SaaS, ...). Every Protocol 01 client picks up the entry so
// the service appears in the subscription UI automatically.
//
export {
  // PDA
  getServicePDA,
  SERVICE_REGISTRY_SEED,
  MAX_SLUG_LEN,

  // Account
  decodeServiceRegistryAccount,
  SERVICE_REGISTRY_DISCRIMINATOR,
  SERVICE_REGISTRY_MAX_SIZE,
  type ServiceRegistryAccount,

  // Instructions
  buildRegisterServiceIx,
  buildUpdateServiceIx,
  buildAttestServiceIx,
  buildBumpSubscriberCountIx,
  buildDeregisterServiceIx,
  PROTOCOL_VERIFIED_AUTHORITY,
  SERVICE_IX_DISCRIMINATORS,
  type RegisterServiceArgs,
  type UpdateServiceArgs,

  // Client
  fetchService,
  fetchServiceByPda,
  fetchAllServices,
  type ServiceEntry,
  type FetchServicesOptions,
} from './service-registry';
