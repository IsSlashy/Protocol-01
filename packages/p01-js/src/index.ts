/**
 * Protocol 01 SDK — merchant entry-point.
 *
 * Drop-in vanilla-JS + React widgets for accepting privacy-first crypto
 * payments and Stream Secure subscriptions on your site.
 *
 * `p01-js` is the merchant surface — pay buttons, subscription widgets,
 * webhook helpers. It does not build shielded-pool transactions.
 *
 * Privacy backend: post-quantum STARK proofs (Goldilocks field, Blake3
 * Merkle, DEEP-ALI) generated and verified via `@protocol-01/stark-prover`
 * + the on-chain `p01_stark_verifier` program. The legacy Groth16 /
 * snarkjs path was removed in 0.3.0 — see `proof-generator.ts` for the
 * replacement adapter.
 *
 * @example Basic Setup
 * ```typescript
 * import { Protocol01 } from '@protocol-01/p01-js';
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
 * import { P01Provider, SubscriptionWidget, WalletButton } from '@protocol-01/p01-js/react';
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
export { Protocol01, type Protocol01UrlConfig } from './protocol01';

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
  URLS,
} from './constants';

// Registry (for service detection)
export {
  ServiceRegistry,
  type RegisteredService,
  type ServiceEntry,
  type ServiceLookupResult,
} from './registry';

// Security (privacy features)
export * from './security';

// Shielded notes: the receipt type PrivateStream / PrivateSubscription and the
// receipt manager carry. (The `shielded-pool` module — shield, unshield,
// getPoolInfo, getPools and their helpers — left in 0.4.0: its program id was
// the zkSPL one, its shield() returned a placeholder receipt and the rest threw.)
export type { ShieldReceipt } from './types';

// Relayer Client
export {
  RelayerClient,
  type RelayerConfig,
  type RelayerStatus,
  type UnshieldRequest,
  type UnshieldResponse,
} from './relayer-client';

// STARK Proof Generator Adapter (0.3.0+: replaces Groth16/snarkjs path)
export {
  generateDenominatedPoolStarkProof,
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
  computeOutstandingToRetailer,
  computeAlreadyPaidToRetailer,
  nextClaimableSlot,
  parseVaultAccount,

  // Constants
  VAULT_SEED_PREFIX,
  SUBSCRIBER_VK_DATA_SEED,
  ZK_SHIELDED_PROGRAM_ID as VAULT_PROGRAM_ID,

  // Types
  type VaultInfo,
  type SubscribePrivateParams,
  type ProofData,
} from './subscription-vault';
