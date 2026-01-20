/**
 * Protocol 01 SDK Types
 *
 * Type definitions for the Protocol 01 merchant SDK.
 */

// ============ Merchant Configuration ============

/**
 * Category of service for merchant classification
 */
export type MerchantCategory =
  | 'streaming'
  | 'music'
  | 'ai'
  | 'gaming'
  | 'saas'
  | 'news'
  | 'fitness'
  | 'education'
  | 'cloud'
  | 'vpn'
  | 'storage'
  | 'productivity'
  | 'entertainment'
  | 'finance'
  | 'other';

/**
 * Merchant configuration options
 */
export interface MerchantConfig {
  /** Unique merchant identifier */
  merchantId: string;
  /** Display name for the merchant */
  merchantName: string;
  /** URL to merchant logo (recommended: 128x128 PNG) */
  merchantLogo?: string;
  /** Category for service classification */
  merchantCategory?: MerchantCategory;
  /** Webhook URL for payment notifications */
  webhookUrl?: string;
  /** Default token for payments (defaults to USDC) */
  defaultToken?: SupportedToken;
  /** Network to use */
  network?: 'devnet' | 'mainnet-beta';
  /** Custom RPC endpoint */
  rpcEndpoint?: string;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Auto-connect to wallet on initialization */
  autoConnect?: boolean;
}

// ============ Token Types ============

/**
 * Supported tokens for payments
 */
export type SupportedToken = 'USDC' | 'USDT' | 'SOL' | string;

// ============ Payment Types ============

/**
 * Payment interval for subscriptions
 */
export type PaymentInterval =
  | 'daily'
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'quarterly'
  | 'yearly'
  | number; // Custom interval in seconds

/**
 * Options for requesting a one-time payment
 */
export interface PaymentRequestOptions {
  /** Amount in token units (e.g., 15.99 for $15.99 USDC) */
  amount: number;
  /** Token to use for payment (defaults to config.defaultToken) */
  token?: SupportedToken;
  /** Human-readable description of the payment */
  description?: string;
  /** Your internal order ID for tracking */
  orderId?: string;
  /** Additional metadata (stored off-chain) */
  metadata?: Record<string, unknown>;
  /** Optional memo to include in transaction */
  memo?: string;
  /** Use stealth address for recipient privacy */
  useStealthAddress?: boolean;
}

/**
 * Result of a successful payment
 */
export interface PaymentResult {
  /** Unique payment ID */
  paymentId: string;
  /** Transaction signature on Solana */
  signature: string;
  /** Amount paid (in token units) */
  amount: number;
  /** Token used */
  token: string;
  /** Whether stealth address was used */
  isPrivate: boolean;
  /** Block confirmation status */
  confirmation: 'processed' | 'confirmed' | 'finalized';
  /** Timestamp of payment */
  timestamp: number;
  /** Order ID if provided */
  orderId?: string;
}

// ============ Subscription Types (Stream Secure) ============

/**
 * Privacy options for subscriptions
 * These are suggestions - the wallet user can override them
 */
export interface PrivacyOptions {
  /** Amount noise percentage (+/- X%) */
  amountNoise?: number;
  /** Timing noise in hours (+/- X hours) */
  timingNoise?: number;
  /** Use stealth address for payments */
  useStealthAddress?: boolean;
}

/**
 * Options for creating a subscription
 */
export interface SubscriptionOptions {
  /** Amount per payment period in token units */
  amount: number;
  /** Token to use for payment (defaults to config.defaultToken) */
  token?: SupportedToken;
  /** Payment interval */
  interval: PaymentInterval;
  /** Maximum number of payments (0 = unlimited) */
  maxPayments?: number;
  /** Human-readable description */
  description?: string;
  /** Your internal subscription ID */
  subscriptionRef?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
  /** Suggested privacy options (user can override) */
  suggestedPrivacy?: PrivacyOptions;
  /** Trial period in days (0 = no trial) */
  trialDays?: number;
  /** Start date for subscription (defaults to now) */
  startDate?: Date;
}

/**
 * Subscription status
 */
export type SubscriptionStatus =
  | 'pending'    // Awaiting first payment
  | 'active'     // Currently active
  | 'paused'     // Temporarily paused
  | 'cancelled'  // Cancelled by user
  | 'expired'    // Reached max payments
  | 'failed';    // Payment failed

/**
 * Active subscription details
 */
export interface Subscription {
  /** Unique subscription ID (on-chain address) */
  id: string;
  /** On-chain subscription account address */
  address: string;
  /** Merchant ID */
  merchantId: string;
  /** Merchant name */
  merchantName: string;
  /** Token mint address */
  tokenMint: string;
  /** Token symbol */
  tokenSymbol: string;
  /** Amount per period (in token units) */
  amountPerPeriod: number;
  /** Period in seconds */
  periodSeconds: number;
  /** Maximum periods (0 = unlimited) */
  maxPeriods: number;
  /** Periods paid so far */
  periodsPaid: number;
  /** Total paid (in token units) */
  totalPaid: number;
  /** Next payment timestamp (Unix ms) */
  nextPaymentAt: number;
  /** Created timestamp (Unix ms) */
  createdAt: number;
  /** Current status */
  status: SubscriptionStatus;
  /** Privacy settings applied */
  privacySettings?: PrivacyOptions;
  /** Your subscription reference if provided */
  subscriptionRef?: string;
  /** Description */
  description?: string;
}

/**
 * Result of subscription creation
 */
export interface SubscriptionResult {
  /** Subscription ID */
  subscriptionId: string;
  /** On-chain subscription account address */
  address: string;
  /** Transaction signature */
  signature: string;
  /** Whether first payment was made */
  firstPaymentMade: boolean;
  /** Privacy settings applied */
  privacySettings?: PrivacyOptions;
  /** Next payment date */
  nextPaymentAt: number;
}

// ============ Connection Types ============

/**
 * Result of wallet connection
 */
export interface ConnectResult {
  /** Connected wallet public key */
  publicKey: string;
  /** Stealth meta-address for private receiving */
  stealthAddress?: string;
  /** Whether the wallet supports Protocol 01 features */
  supportsProtocol01: boolean;
}

/**
 * Wallet information
 */
export interface WalletInfo {
  /** Wallet public key */
  publicKey: string;
  /** Wallet name (e.g., "Specter", "Phantom") */
  name: string;
  /** Whether it's a Protocol 01 compatible wallet */
  isProtocol01Compatible: boolean;
  /** Wallet version */
  version: string;
  /** Supported features */
  features: WalletFeature[];
}

/**
 * Features supported by the wallet
 */
export type WalletFeature =
  | 'payments'
  | 'subscriptions'
  | 'stealth-addresses'
  | 'privacy-options'
  | 'webhooks';

// ============ Event Types ============

/**
 * Event types emitted by the SDK
 */
export type Protocol01EventType =
  | 'connect'
  | 'disconnect'
  | 'accountChanged'
  | 'paymentComplete'
  | 'paymentFailed'
  | 'subscriptionCreated'
  | 'subscriptionPayment'
  | 'subscriptionCancelled'
  | 'subscriptionExpired'
  | 'error';

/**
 * Event payload
 */
export interface Protocol01Event<T = unknown> {
  /** Event type */
  type: Protocol01EventType;
  /** Event data */
  data: T;
  /** Timestamp */
  timestamp: number;
}

/**
 * Event callback function
 */
export type EventCallback<T = unknown> = (event: Protocol01Event<T>) => void;

// ============ Error Types ============

/**
 * Error codes
 */
export enum Protocol01ErrorCode {
  // Connection errors
  WALLET_NOT_INSTALLED = 'WALLET_NOT_INSTALLED',
  WALLET_NOT_CONNECTED = 'WALLET_NOT_CONNECTED',
  CONNECTION_REJECTED = 'CONNECTION_REJECTED',
  CONNECTION_TIMEOUT = 'CONNECTION_TIMEOUT',

  // Payment errors
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  INVALID_AMOUNT = 'INVALID_AMOUNT',
  INVALID_TOKEN = 'INVALID_TOKEN',
  PAYMENT_REJECTED = 'PAYMENT_REJECTED',
  PAYMENT_FAILED = 'PAYMENT_FAILED',

  // Subscription errors
  SUBSCRIPTION_EXISTS = 'SUBSCRIPTION_EXISTS',
  SUBSCRIPTION_NOT_FOUND = 'SUBSCRIPTION_NOT_FOUND',
  SUBSCRIPTION_CANCELLED = 'SUBSCRIPTION_CANCELLED',
  INVALID_INTERVAL = 'INVALID_INTERVAL',

  // General errors
  INVALID_CONFIG = 'INVALID_CONFIG',
  NETWORK_ERROR = 'NETWORK_ERROR',
  TRANSACTION_FAILED = 'TRANSACTION_FAILED',
  TIMEOUT = 'TIMEOUT',
  UNKNOWN = 'UNKNOWN',
}

/**
 * Protocol 01 Error class
 */
export class Protocol01Error extends Error {
  /** Error code for programmatic handling */
  code: Protocol01ErrorCode;
  /** Additional error details */
  details?: unknown;
  /** Whether error is recoverable */
  recoverable: boolean;

  constructor(
    code: Protocol01ErrorCode,
    message: string,
    options?: { details?: unknown; recoverable?: boolean }
  ) {
    super(message);
    this.name = 'Protocol01Error';
    this.code = code;
    this.details = options?.details;
    this.recoverable = options?.recoverable ?? false;

    // Maintains proper stack trace for where our error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, Protocol01Error);
    }
  }

  /**
   * Check if error is of a specific code
   */
  is(code: Protocol01ErrorCode): boolean {
    return this.code === code;
  }

  /**
   * Convert to JSON for logging
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      recoverable: this.recoverable,
    };
  }
}

// ============ Webhook Types ============

/**
 * Webhook event types
 */
export type WebhookEventType =
  | 'payment.completed'
  | 'payment.failed'
  | 'subscription.created'
  | 'subscription.payment'
  | 'subscription.cancelled'
  | 'subscription.expired';

/**
 * Webhook payload
 */
export interface WebhookPayload {
  /** Event type */
  event: WebhookEventType;
  /** Merchant ID */
  merchantId: string;
  /** Event timestamp (Unix ms) */
  timestamp: number;
  /** Signature for verification */
  signature: string;
  /** Event-specific data */
  data: PaymentResult | Subscription;
}

// ============ Provider Types (Internal) ============

/**
 * Provider interface for wallet communication
 * @internal
 */
export interface Protocol01Provider {
  isProtocol01: boolean;
  version: string;
  connect(): Promise<ConnectResult>;
  disconnect(): Promise<void>;
  isConnected(): Promise<boolean>;
  getPublicKey(): Promise<string | null>;
  requestPayment(options: InternalPaymentRequest): Promise<PaymentResult>;
  createSubscription(options: InternalSubscriptionRequest): Promise<SubscriptionResult>;
  getSubscriptions(merchantId?: string): Promise<Subscription[]>;
  cancelSubscription(subscriptionId: string): Promise<{ success: boolean }>;
  on(event: string, callback: (...args: unknown[]) => void): void;
  off(event: string, callback: (...args: unknown[]) => void): void;
}

/**
 * Internal payment request format
 * @internal
 */
export interface InternalPaymentRequest {
  merchantId: string;
  merchantName: string;
  merchantLogo?: string;
  merchantCategory?: MerchantCategory;
  amount: number;
  tokenMint: string;
  description?: string;
  orderId?: string;
  metadata?: Record<string, unknown>;
  memo?: string;
  useStealthAddress?: boolean;
  webhookUrl?: string;
}

/**
 * Internal subscription request format
 * @internal
 */
export interface InternalSubscriptionRequest {
  merchantId: string;
  merchantName: string;
  merchantLogo?: string;
  merchantCategory?: MerchantCategory;
  tokenMint: string;
  amountPerPeriod: number;
  periodSeconds: number;
  maxPeriods: number;
  description?: string;
  subscriptionRef?: string;
  metadata?: Record<string, unknown>;
  suggestedPrivacy?: PrivacyOptions;
  trialDays?: number;
  startDate?: number;
  webhookUrl?: string;
}
