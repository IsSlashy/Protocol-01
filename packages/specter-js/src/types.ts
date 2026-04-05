/**
 * Protocol 01 JS Types
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
  /** Is Protocol 01 wallet */
  isP01: boolean;
  /** Wallet version */
  version: string;
}

// ============ Event Types ============

/**
 * All event types emitted by the P01 client.
 *
 * | Event | Payload | Description |
 * |---|---|---|
 * | `connect` | `ConnectResult` | Wallet connected successfully |
 * | `disconnect` | `{}` | Wallet disconnected |
 * | `accountChanged` | `{ publicKey: string }` | Active account changed in wallet |
 * | `paymentSent` | `PaymentOptions & { signature: string }` | Payment sent (private or public) |
 * | `paymentReceived` | `{ signature: string; amount: number; from: string }` | Incoming payment detected |
 * | `subscriptionCreated` | `SubscriptionOptions & SubscriptionResult` | New subscription created |
 * | `subscriptionCancelled` | `{ subscriptionId: string }` | Subscription cancelled |
 * | `subscriptionPayment` | `{ subscriptionId: string; signature: string; periodsPaid: number }` | Recurring payment executed |
 */
export type P01EventType =
  | 'connect'
  | 'disconnect'
  | 'accountChanged'
  | 'paymentSent'
  | 'paymentReceived'
  | 'subscriptionCreated'
  | 'subscriptionCancelled'
  | 'subscriptionPayment';

/**
 * Type-safe event payload map.
 * Use with `on<E extends P01EventType>(event: E, cb: (event: P01TypedEvent<E>) => void)`.
 */
export interface P01EventMap {
  connect: ConnectResult;
  disconnect: Record<string, never>;
  accountChanged: { publicKey: string };
  paymentSent: PaymentOptions & { signature: string };
  paymentReceived: { signature: string; amount: number; from: string };
  subscriptionCreated: SubscriptionOptions & SubscriptionResult;
  subscriptionCancelled: { subscriptionId: string };
  subscriptionPayment: { subscriptionId: string; signature: string; periodsPaid: number };
}

/**
 * Typed event payload for a specific event type.
 */
export interface P01TypedEvent<E extends P01EventType = P01EventType> {
  type: E;
  data: P01EventMap[E];
  timestamp: number;
}

export interface P01Event {
  type: P01EventType;
  data: unknown;
  timestamp: number;
}

// ============ Error Types ============

export class P01Error extends Error {
  code: P01ErrorCode;
  details?: unknown;

  constructor(code: P01ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'P01Error';
    this.code = code;
    this.details = details;
  }

  /**
   * Check if error is of a specific code
   */
  is(code: P01ErrorCode): boolean {
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
    };
  }
}

export enum P01ErrorCode {
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

/**
 * Check whether an error represents a user rejection (the user explicitly
 * declined the transaction in their wallet popup).
 *
 * Works with both `P01Error` instances and generic `Error` objects from
 * wallet providers that include "rejected" or "cancelled" in their message.
 *
 * @param error - Any caught error
 * @returns true if the error indicates user rejection
 *
 * @example
 * ```typescript
 * try {
 *   await p01.pay({ ... });
 * } catch (error) {
 *   if (isUserRejection(error)) {
 *     showMessage('You declined the payment.');
 *   } else {
 *     showMessage('Something went wrong.');
 *   }
 * }
 * ```
 */
export function isUserRejection(error: unknown): boolean {
  if (error instanceof P01Error) {
    return error.code === P01ErrorCode.USER_REJECTED;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes('rejected') || msg.includes('cancelled') || msg.includes('user denied');
  }
  return false;
}

/**
 * Check whether an error represents a network/RPC failure.
 *
 * @param error - Any caught error
 * @returns true if the error indicates a network issue
 */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof P01Error) {
    return error.code === P01ErrorCode.NETWORK_ERROR;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes('network') || msg.includes('fetch') || msg.includes('econnrefused') || msg.includes('503');
  }
  return false;
}

/**
 * Check whether an error represents a timeout.
 *
 * @param error - Any caught error
 * @returns true if the error indicates a timeout
 */
export function isTimeoutError(error: unknown): boolean {
  if (error instanceof P01Error) {
    return error.code === P01ErrorCode.TIMEOUT;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes('timeout') || msg.includes('timed out');
  }
  return false;
}

// Aliases for backward compatibility
export { P01Error as SpecterError };
export { P01ErrorCode as SpecterErrorCode };
