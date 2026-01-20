/**
 * Specter JS Types
 */

// ============ Payment Types ============

export interface PaymentOptions {
  /** Recipient wallet address */
  recipient: string;
  /** Amount in token units (e.g., 10 for 10 USDC) */
  amount: number;
  /** Token symbol or mint address */
  token?: string;
  /** Use stealth address for privacy */
  private?: boolean;
  /** Memo/note for the payment */
  memo?: string;
  /** Reference ID for tracking */
  reference?: string;
}

export interface PaymentResult {
  /** Transaction signature */
  signature: string;
  /** Whether stealth address was used */
  isPrivate: boolean;
  /** Block confirmation */
  confirmation: 'confirmed' | 'finalized';
}

// ============ Subscription Types (Stream Secure) ============

export type SubscriptionPeriod =
  | 'daily'
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'quarterly'
  | 'yearly'
  | number; // Custom period in seconds

export interface SubscriptionOptions {
  /** Merchant's receiving address */
  recipient: string;
  /** Merchant name for display in wallet */
  merchantName: string;
  /** Merchant logo URL */
  merchantLogo?: string;
  /** Amount per period in token units */
  amount: number;
  /** Token symbol or mint address (defaults to USDC) */
  token?: string;
  /** Payment period */
  period: SubscriptionPeriod;
  /** Maximum number of payments (0 = unlimited) */
  maxPayments?: number;
  /** Description shown in wallet */
  description?: string;
  /** Custom metadata */
  metadata?: Record<string, string>;
}

export interface Subscription {
  /** Unique subscription ID */
  id: string;
  /** On-chain subscription account address */
  address: string;
  /** Merchant receiving payments */
  recipient: string;
  /** Merchant display name */
  merchantName: string;
  /** Merchant logo */
  merchantLogo?: string;
  /** Token mint */
  tokenMint: string;
  /** Token symbol */
  tokenSymbol: string;
  /** Amount per period (raw units) */
  amountPerPeriod: number;
  /** Period in seconds */
  periodSeconds: number;
  /** Max periods (0 = unlimited) */
  maxPeriods: number;
  /** Periods paid so far */
  periodsPaid: number;
  /** Total paid (raw units) */
  totalPaid: number;
  /** Next payment timestamp */
  nextPaymentAt: number;
  /** Created timestamp */
  createdAt: number;
  /** Is active */
  isActive: boolean;
  /** Can be cancelled */
  canCancel: boolean;
}

export interface SubscriptionResult {
  /** Subscription ID */
  subscriptionId: string;
  /** On-chain address */
  address: string;
  /** Transaction signature */
  signature: string;
}

// ============ Connection Types ============

export interface ConnectResult {
  /** Connected wallet public key */
  publicKey: string;
  /** Stealth meta-address for receiving */
  stealthAddress?: string;
}

export interface WalletInfo {
  /** Wallet public key */
  publicKey: string;
  /** Is Specter wallet */
  isSpecter: boolean;
  /** Wallet version */
  version: string;
}

// ============ Event Types ============

export type SpecterEventType =
  | 'connect'
  | 'disconnect'
  | 'accountChanged'
  | 'paymentSent'
  | 'paymentReceived'
  | 'subscriptionCreated'
  | 'subscriptionCancelled'
  | 'subscriptionPayment';

export interface SpecterEvent {
  type: SpecterEventType;
  data: unknown;
  timestamp: number;
}

// ============ Error Types ============

export class SpecterError extends Error {
  code: SpecterErrorCode;
  details?: unknown;

  constructor(code: SpecterErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'SpecterError';
    this.code = code;
    this.details = details;
  }
}

export enum SpecterErrorCode {
  NOT_INSTALLED = 'NOT_INSTALLED',
  NOT_CONNECTED = 'NOT_CONNECTED',
  USER_REJECTED = 'USER_REJECTED',
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  INVALID_PARAMS = 'INVALID_PARAMS',
  NETWORK_ERROR = 'NETWORK_ERROR',
  TRANSACTION_FAILED = 'TRANSACTION_FAILED',
  TIMEOUT = 'TIMEOUT',
  UNKNOWN = 'UNKNOWN',
}
