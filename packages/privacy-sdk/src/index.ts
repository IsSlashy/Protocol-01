// ─── Main Client ──────────────────────────────────────────────────────────────
export { PrivacySDK } from './client';

// ─── Identity (spending-key helpers) ──────────────────────────────────────────
export {
  asSpendingKey,
  deriveSpendingKeyFromSignature,
  SPENDING_KEY_DOMAIN,
  type SpendingKey,
} from './identity/spendingKey';

// ─── Modules ──────────────────────────────────────────────────────────────────
export { ShieldModule } from './modules/shield';
export { StealthModule } from './modules/stealth';
export { ConfidentialModule } from './modules/confidential';
export { StreamsModule } from './modules/streams';
export { SubscriptionsModule } from './modules/subscriptions';
export { VaultModule } from './modules/vault';
export { RegistryModule } from './modules/registry';
export { RelayModule } from './modules/relay';
export { MPCModule } from './modules/mpc';
export { ComplianceModule } from './modules/compliance';
export type {
  ComplianceRangeParams,
  ComplianceInnocenceParams,
  ComplianceAttestation,
  ComplianceRangeResult,
  ComplianceInnocenceResult,
  ComplianceCircuitPaths,
} from './modules/compliance';
export { AirdropModule } from './modules/airdrop';
export type {
  AirdropRecipient,
  AirdropCampaignConfig,
  AirdropCampaign,
  AirdropLeaf,
  AirdropMerkleTree,
  AirdropClaimParams,
  AirdropCreateResult,
  AirdropClaimResult,
} from './modules/airdrop';
export { OTCModule } from './modules/otc';
export type {
  OTCOrderParams,
  OTCOrder,
  OTCFillParams,
  OTCCreateResult,
  OTCFillResult,
} from './modules/otc';
export { PayrollModule } from './modules/payroll';
export type {
  PayrollEmployee,
  PayrollBatchConfig,
  PayrollBatch,
  PayrollPayment,
  PayrollResult,
} from './modules/payroll';
export { TreasuryModule } from './modules/treasury';
export type {
  TreasuryConfig,
  TreasuryInfo,
  TreasurySpendProposal,
  TreasurySpendResult,
  TreasurySolvencyProof,
} from './modules/treasury';
export { MugenExchangeModule } from './modules/exchange';
export { LiquidityModule, P01_LIQUIDITY_PROGRAM_ID } from './modules/liquidity';
export type {
  LiquidityPoolState,
  PrefundRecordState,
  PrefundIxArgs,
  SettleIxArgs,
  PrefundFeeBreakdown,
} from './modules/liquidity';
export {
  splitAmount,
  CANONICAL_DENOMINATIONS,
  CANONICAL_DENOMINATIONS_SOL,
  POOL_SUPPORTED_DENOMINATIONS_SOL,
} from './modules/denomination';
export type {
  DenominationSplit,
  SplitResult,
  SplitInput,
} from './modules/denomination';
export type {
  MugenOrderParams,
  MugenOrder,
  MugenEscrowInfo,
  MugenReputation,
  MugenCreateOrderResult,
  MugenTakeOrderResult,
  MugenListOrdersFilter,
  MugenOrderType,
  MugenOrderStatus,
  MugenEscrowStatus,
  PaymentMethod,
} from './modules/exchange';

// ─── Errors ───────────────────────────────────────────────────────────────────
export { PrivacyError, PrivacyErrorCode } from './errors';

// ─── Constants ────────────────────────────────────────────────────────────────
export {
  PROGRAM_IDS,
  TOKENS,
  SEEDS,
  DENOMINATIONS,
  MERKLE_TREE_DEPTH,
  MAX_LEAVES,
  SHIELD_FEE_BPS,
  UNSHIELD_FEE_BPS,
  FEE_WALLET,
  STARK_CIRCUITS,
  COMPUTE_UNITS,
  getDeployedProgramIds,
} from './constants';

// ─── Types ────────────────────────────────────────────────────────────────────
export type {
  // Config
  PrivacySDKConfig,
  Network,
  ProgramIds,
  Signer,
  WalletAdapter,

  // Tokens
  TokenSymbol,
  TokenInfo,

  // Transaction
  TxResult,

  // Shield
  ShieldParams,
  UnshieldParams,
  PrivateTransferParams,
  ShieldReceipt,
  UnshieldReceipt,
  TransferReceipt,
  EncryptedNote,
  PoolInfo,

  // Stealth
  StealthMetaAddress,
  StealthAddress,
  StealthPayment,
  StealthSendParams,
  StealthSendReceipt,
  StealthScanOptions,
  StealthClaimReceipt,

  // Confidential
  ConfidentialDepositParams,
  ConfidentialTransferParams,
  ConfidentialWithdrawParams,
  ConfidentialBalanceResult,
  ConfidentialProveBalanceParams,

  // Streams
  CreateStreamParams,
  StreamInfo,
  StreamReceipt,

  // Subscriptions
  CreateSubscriptionParams,
  SubscriptionInfo,
  SubscriptionReceipt,

  // Vault
  VaultType,
  CreateVaultParams,
  VaultDepositParams,
  VaultWithdrawParams,
  VaultInfo,
  VaultReceipt,

  // Registry
  RegisterParams,
  RegistryEntry,

  // Relay
  RelayJobParams,
  RelayerInfo,
  RelayJobReceipt,
  RelayJobStatus,

  // MPC
  MPCVoteParams,
  MPCCreateProposalParams,
  MPCAuditParams,
  MPCSealedBidParams,
  MPCProposalInfo,
  MPCAuctionInfo,

  // Events
  PrivacyEventType,
  PrivacyEventCallback,
  PrivacyEvent,

  // Proofs
  Groth16Proof,
  ProofResult,
  ProverConfig,
} from './types';
