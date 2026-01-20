/**
 * P-01 Extension Types
 */

// ============ Messages ============

export type MessageType =
  // Wallet operations
  | 'CONNECT'
  | 'DISCONNECT'
  | 'GET_ACCOUNTS'
  | 'SIGN_TRANSACTION'
  | 'SIGN_MESSAGE'
  | 'SIGN_ALL_TRANSACTIONS'
  // P-01 specific
  | 'CREATE_SUBSCRIPTION'
  | 'CANCEL_SUBSCRIPTION'
  | 'GET_SUBSCRIPTIONS'
  | 'SEND_PRIVATE'
  | 'GENERATE_STEALTH_ADDRESS';

export interface BaseMessage {
  type: MessageType;
  id: string;
  origin?: string;
}

export interface ConnectMessage extends BaseMessage {
  type: 'CONNECT';
}

export interface SignTransactionMessage extends BaseMessage {
  type: 'SIGN_TRANSACTION';
  payload: {
    transaction: string; // Base64 encoded
  };
}

export interface CreateSubscriptionMessage extends BaseMessage {
  type: 'CREATE_SUBSCRIPTION';
  payload: SubscriptionRequest;
}

export type ExtensionMessage =
  | ConnectMessage
  | SignTransactionMessage
  | CreateSubscriptionMessage;

// ============ Subscriptions (Stream Secure) ============

export interface SubscriptionRequest {
  /** Merchant's receiving address */
  recipient: string;
  /** Merchant name for display */
  merchantName: string;
  /** Merchant logo URL */
  merchantLogo?: string;
  /** Token mint address (native SOL if not specified) */
  tokenMint?: string;
  /** Amount per period (in token smallest units) */
  amountPerPeriod: number;
  /** Period in seconds (e.g., 2592000 for monthly) */
  periodSeconds: number;
  /** Number of periods (0 = unlimited) */
  maxPeriods: number;
  /** Human-readable description */
  description?: string;
}

export interface Subscription {
  id: string;
  /** Subscription PDA on-chain */
  address: string;
  /** Merchant receiving payments */
  recipient: string;
  merchantName: string;
  merchantLogo?: string;
  /** Token being streamed */
  tokenMint: string;
  tokenSymbol: string;
  tokenDecimals: number;
  /** Amount per period */
  amountPerPeriod: number;
  /** Period duration in seconds */
  periodSeconds: number;
  /** Max number of periods (0 = unlimited) */
  maxPeriods: number;
  /** Periods already paid */
  periodsPaid: number;
  /** Total amount paid so far */
  totalPaid: number;
  /** Next payment timestamp */
  nextPaymentAt: number;
  /** Subscription created at */
  createdAt: number;
  /** Is subscription active */
  isActive: boolean;
  /** Can be cancelled by user */
  canCancel: boolean;
}

// ============ Transactions ============

export interface TransactionRecord {
  signature: string;
  type: 'send' | 'receive' | 'swap' | 'subscription' | 'claim';
  amount: number;
  tokenSymbol: string;
  tokenMint: string;
  counterparty?: string;
  timestamp: number;
  status: 'confirmed' | 'pending' | 'failed';
  isPrivate: boolean;
  fee: number;
}

// ============ dApp Connection ============

export interface ConnectedDapp {
  origin: string;
  name: string;
  icon?: string;
  connectedAt: number;
  permissions: DappPermission[];
}

export type DappPermission =
  | 'viewBalance'
  | 'requestTransaction'
  | 'requestSubscription'
  | 'viewStealthAddress';

// ============ Approval Requests ============

export interface ApprovalRequest {
  id: string;
  type: 'transaction' | 'subscription' | 'connect' | 'signMessage';
  origin: string;
  originName?: string;
  originIcon?: string;
  payload: unknown;
  createdAt: number;
}
