// ─── Main Client ──────────────────────────────────────────────────────────────
export { PrivacySDK } from './client';

// ─── Identity (spending-key helpers) ──────────────────────────────────────────
export {
  asSpendingKey,
  asViewingKey,
  deriveSpendingKeyFromSignature,
  SPENDING_KEY_DOMAIN,
  type SpendingKey,
  type ViewingKey,
} from './identity/spendingKey';

// ─── Identity (tiered HKDF derivation — Privy removal 2026-06-03) ──────────────
export {
  deriveP01Identity,
  deriveP01IdentityFromSeed,
  clearP01Identity,
  clearAllP01Identities,
  type P01Identity,
} from './identity/deriveIdentity';
export {
  isKeypair,
  classifySigner,
  toUnifiedSigner,
  type SignerKind,
  type UnifiedSigner,
} from './identity/signer';
export {
  IDENTITY_DOMAIN,
  HKDF_SALT,
  SPEND_INFO,
  VIEW_INFO,
  IDENTITY_KEY_LENGTH,
} from './identity/constants';

// ─── Modules ──────────────────────────────────────────────────────────────────
//
// 2.0.0 removed every module that spoke to a program that is not deployed or
// does not register the instruction it built: shield, confidential, streams,
// subscriptions, compliance, airdrop, otc, payroll, treasury, liquidity and the
// instant-unshield flow (see CHANGELOG.md). What remains talks to the registry
// and relayer programs, or is pure computation (the denomination split).
export { RegistryModule } from './modules/registry';
export { RelayModule } from './modules/relay';
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

  // Registry
  RegisterParams,
  RegistryEntry,

  // Relay
  RelayJobParams,
  RelayerInfo,
  RelayJobReceipt,
  RelayJobStatus,

  // Events
  PrivacyEventType,
  PrivacyEventCallback,
  PrivacyEvent,
} from './types';
