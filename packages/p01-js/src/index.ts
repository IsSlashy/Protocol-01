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
