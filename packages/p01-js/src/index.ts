/**
 * Protocol 01 SDK
 *
 * Privacy-first crypto payments for the modern web.
 *
 * @example Basic Setup
 * ```typescript
 * import { Protocol01 } from 'p-01';
 *
 * const p01 = new Protocol01({
 *   merchantId: 'your-merchant-id',
 *   merchantName: 'Your Business',
 * });
 *
 * // Connect wallet
 * await p01.connect();
 *
 * // One-time payment
 * const payment = await p01.requestPayment({
 *   amount: 9.99,
 *   description: 'Premium Feature',
 * });
 *
 * // Subscription with Stream Secure
 * const sub = await p01.createSubscription({
 *   amount: 15.99,
 *   interval: 'monthly',
 *   description: 'Pro Plan',
 * });
 * ```
 *
 * @example React Integration
 * ```tsx
 * import { P01Provider, SubscriptionWidget, WalletButton } from 'p-01/react';
 *
 * function App() {
 *   return (
 *     <P01Provider config={{ merchantId: 'your-id', merchantName: 'Your Business' }}>
 *       <WalletButton />
 *       <SubscriptionWidget
 *         tiers={[
 *           { id: 'basic', name: 'Basic', price: 9.99, interval: 'monthly' },
 *           { id: 'pro', name: 'Pro', price: 19.99, interval: 'monthly', popular: true },
 *         ]}
 *       />
 *     </P01Provider>
 *   );
 * }
 * ```
 *
 * @packageDocumentation
 */

// Main SDK
export { Protocol01 } from './protocol01';

// Types
export {
  // Merchant
  type MerchantConfig,
  type MerchantCategory,

  // Tokens
  type SupportedToken,

  // Payments
  type PaymentInterval,
  type PaymentRequestOptions,
  type PaymentResult,

  // Subscriptions
  type SubscriptionOptions,
  type SubscriptionResult,
  type Subscription,
  type SubscriptionStatus,
  type PrivacyOptions,

  // Connection
  type ConnectResult,
  type WalletInfo,
  type WalletFeature,

  // Events
  type Protocol01EventType,
  type Protocol01Event,
  type EventCallback,

  // Errors
  Protocol01Error,
  Protocol01ErrorCode,

  // Webhooks
  type WebhookEventType,
  type WebhookPayload,

  // Provider
  type Protocol01Provider,
} from './types';

// Utilities
export {
  // Token utils
  resolveTokenMint,
  getTokenSymbol,
  getTokenDecimals,
  toRawAmount,
  fromRawAmount,
  formatAmount,

  // Interval utils
  resolveInterval,
  getIntervalName,

  // Time utils
  calculateNextPayment,
  formatDate,
  getTimeUntilPayment,

  // Validation
  validateAmount,
  validateInterval,
  normalizePrivacyOptions,
  validateMerchantConfig,

  // Helpers
  generateId,
  ensureOrderId,
  isBrowser,
  isNode,
  sleep,
  withTimeout,
} from './utils';

// Constants
export {
  TOKENS,
  TOKENS_DEVNET,
  TOKEN_DECIMALS,
  INTERVALS,
  SUBSCRIPTION_LIMITS,
  PRIVACY_LIMITS,
  DEFAULT_CONFIG,
} from './constants';

// Registry (for service detection)
export {
  ServiceRegistry,
  type RegisteredService,
  type ServiceLookupResult,
} from './registry';

// Security (privacy features)
export * from './security';

// Shielded Pool (Privacy Layer)
export {
  // Core functions
  shield,
  unshield,
  getPoolInfo,
  getPools,

  // Helpers
  validateShieldParams,
  validateUnshieldParams,
  resolveTokenMintForPool,
  computeCommitmentPlaceholder,
  estimateDelayTier,
  isValidDenomination,

  // Constants
  ZK_SHIELDED_PROGRAM_ID,
  STANDARD_DENOMINATIONS,
  MERKLE_TREE_DEPTH,
  MAX_LEAVES,
  DELAY_TIERS,

  // Types
  type ShieldReceipt,
  type ShieldParams,
  type UnshieldParams,
  type PoolInfo,
} from './shielded-pool';

// Relayer Client
export {
  RelayerClient,
  type RelayerConfig,
  type RelayerStatus,
  type UnshieldRequest,
  type UnshieldResponse,
} from './relayer-client';

// ZK Proof Generator
export {
  generateDenominatedPoolProof,
  verifyProof,
  type ProofResult,
  type ProofGeneratorConfig,
  type DenominatedPoolInputs,
} from './proof-generator';

// Receipt Manager
export {
  serializeReceipt,
  deserializeReceipt,
  receiptToJSON,
  receiptFromJSON,
} from './receipt-manager';

// Private Subscription (ZK-private recurring payments)
export {
  PrivateSubscription,
  type PrivateSubscriptionConfig,
  type SubscriptionStatus as PrivateSubscriptionStatus,
  type PrivateSubscriptionState,
  type PrivatePaymentResult,
} from './private-subscription';

// Private Stream (privacy-preserving denominated payment streams)
export {
  PrivateStream,
  type PrivateStreamConfig,
  type PrivateStreamState,
  type StreamStatus as PrivateStreamStatus,
} from './private-stream';

// Subscription Vault (normal + private ZK subscriptions)
export {
  // PDA derivation
  deriveVaultPDA,
  deriveSubscriberVkPDA,

  // Computation helpers
  computeClaimable,
  computeClaimableAmount,
  computeRefundable,
  nextClaimableSlot,
  computeReshieldNotes,
  parseVaultAccount,

  // Constants
  VAULT_SEED_PREFIX,
  SUBSCRIBER_VK_DATA_SEED,
  ZK_SHIELDED_PROGRAM_ID as VAULT_PROGRAM_ID,

  // Types
  type VaultInfo,
  type SubscribeNormalParams,
  type SubscribePrivateParams,
  type ProofData,
} from './subscription-vault';
