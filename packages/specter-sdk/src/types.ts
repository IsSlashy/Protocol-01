import { PublicKey, Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';

// ============================================================================
// Wallet Types
// ============================================================================

/**
 * Represents a Protocol 01 wallet with stealth capabilities
 */
export interface P01Wallet {
  /** The main public key of the wallet */
  publicKey: PublicKey;
  /** The keypair for signing transactions */
  keypair: Keypair;
  /** The stealth meta-address for receiving private payments */
  stealthMetaAddress: StealthMetaAddress;
  /** The seed phrase (mnemonic) - only available at creation/import */
  seedPhrase?: string;
  /** Derivation path used for the wallet */
  derivationPath: string;
}

/**
 * Wallet creation options
 */
export interface WalletCreateOptions {
  /** Custom derivation path (defaults to Solana standard) */
  derivationPath?: string;
  /** Entropy strength for mnemonic (128, 160, 192, 224, or 256 bits) */
  strength?: 128 | 160 | 192 | 224 | 256;
}

/**
 * Wallet import options
 */
export interface WalletImportOptions {
  /** Custom derivation path */
  derivationPath?: string;
  /** Password for additional encryption (optional) */
  password?: string;
}

// ============================================================================
// Balance Types
// ============================================================================

/**
 * Token balance information
 */
export interface TokenBalance {
  /** Token mint address */
  mint: PublicKey;
  /** Token symbol */
  symbol: string;
  /** Balance in token units */
  amount: bigint;
  /** Decimals for the token */
  decimals: number;
  /** USD value (if available) */
  usdValue?: number;
}

/**
 * Complete balance information for a wallet
 */
export interface Balance {
  /** SOL balance in lamports */
  solBalance: bigint;
  /** SOL balance formatted */
  solFormatted: string;
  /** Token balances */
  tokens: TokenBalance[];
  /** Total USD value (if available) */
  totalUsdValue?: number;
  /** Last updated timestamp */
  lastUpdated: Date;
}

// ============================================================================
// Stealth Address Types
// ============================================================================

/**
 * Stealth meta-address used to derive one-time addresses
 * Contains the spending and viewing public keys
 */
export interface StealthMetaAddress {
  /** Spending public key (K) */
  spendingPubKey: Uint8Array;
  /** Viewing public key (V) */
  viewingPubKey: Uint8Array;
  /** Encoded string representation for sharing */
  encoded: string;
}

/**
 * A one-time stealth address for receiving a payment
 */
export interface StealthAddress {
  /** The one-time public key for receiving */
  address: PublicKey;
  /** Ephemeral public key (R) - shared with sender */
  ephemeralPubKey: Uint8Array;
  /** View tag for efficient scanning */
  viewTag: number;
  /** Timestamp when generated */
  createdAt: Date;
}

/**
 * Stealth address generation options
 */
export interface StealthAddressOptions {
  /** Label for the address (optional) */
  label?: string;
  /** Expiration time for the address (optional) */
  expiresAt?: Date;
}

/**
 * A detected incoming stealth payment
 */
export interface StealthPayment {
  /** The stealth address that received the payment */
  stealthAddress: PublicKey;
  /** The ephemeral public key from the sender */
  ephemeralPubKey: Uint8Array;
  /** Amount received in lamports */
  amount: bigint;
  /** Token mint (null for SOL) */
  tokenMint: PublicKey | null;
  /** Transaction signature */
  signature: string;
  /** Block time of the payment */
  blockTime: number;
  /** Whether the payment has been claimed */
  claimed: boolean;
  /** View tag for verification */
  viewTag: number;
}

/**
 * Options for scanning incoming payments
 */
export interface ScanOptions {
  /** Start slot for scanning */
  fromSlot?: number;
  /** End slot for scanning */
  toSlot?: number;
  /** Only scan for specific token mints */
  tokenMints?: PublicKey[];
  /** Include already claimed payments */
  includeClaimed?: boolean;
  /** Limit number of results */
  limit?: number;
}

// ============================================================================
// Privacy Types
// ============================================================================

/**
 * Privacy level for transactions
 * - standard: Basic stealth address
 * - enhanced: Stealth + delayed withdrawal
 * - maximum: Stealth + split + delayed + multiple hops
 */
export type PrivacyLevel = 'standard' | 'enhanced' | 'maximum';

/**
 * Privacy options for transfers
 */
export interface PrivacyOptions {
  /** Privacy level */
  level?: PrivacyLevel;
  /** Split payment into multiple transactions */
  splitCount?: number;
  /** Delay between split transactions (ms) */
  splitDelay?: number;
  /** Use relayer for additional privacy */
  useRelayer?: boolean;
  /** Custom memo (will be encrypted) */
  memo?: string;
}

// ============================================================================
// Transfer Types
// ============================================================================

/**
 * Transfer request parameters
 */
export interface TransferRequest {
  /** Recipient stealth meta-address or public key */
  recipient: string;
  /** Amount to send */
  amount: number;
  /** Token mint (null for SOL) */
  tokenMint?: PublicKey;
  /** Privacy options */
  privacyOptions?: PrivacyOptions;
}

/**
 * Transfer result
 */
export interface TransferResult {
  /** Transaction signature */
  signature: string;
  /** Stealth address used */
  stealthAddress: PublicKey;
  /** Ephemeral public key (for recipient to derive key) */
  ephemeralPubKey: Uint8Array;
  /** Confirmation status */
  confirmed: boolean;
  /** Block time */
  blockTime?: number;
  /** Fee paid in lamports */
  fee: bigint;
}

/**
 * Claim result for stealth payments
 */
export interface ClaimResult {
  /** Transaction signature */
  signature: string;
  /** Amount claimed */
  amount: bigint;
  /** Destination address */
  destination: PublicKey;
  /** Confirmation status */
  confirmed: boolean;
}

// ============================================================================
// Stream Types
// ============================================================================

/**
 * Stream status enum
 */
export type StreamStatus =
  | 'pending'    // Created but not started
  | 'active'     // Currently streaming
  | 'paused'     // Temporarily paused
  | 'completed'  // Fully streamed
  | 'cancelled'; // Cancelled before completion

/**
 * Payment stream information
 */
export interface Stream {
  /** Unique stream identifier (PDA) */
  id: PublicKey;
  /** Sender address */
  sender: PublicKey;
  /** Recipient stealth address */
  recipient: PublicKey;
  /** Total amount to stream */
  totalAmount: bigint;
  /** Amount already withdrawn */
  withdrawnAmount: bigint;
  /** Start timestamp */
  startTime: Date;
  /** End timestamp */
  endTime: Date;
  /** Token mint (null for SOL) */
  tokenMint: PublicKey | null;
  /** Current status */
  status: StreamStatus;
  /** Amount available to withdraw now */
  withdrawableAmount: bigint;
  /** Privacy level used */
  privacyLevel: PrivacyLevel;
  /** Created at timestamp */
  createdAt: Date;
  /** Last updated timestamp */
  updatedAt: Date;
}

/**
 * Stream creation options
 */
export interface StreamCreateOptions {
  /** Start time (defaults to now) */
  startTime?: Date;
  /** Privacy level */
  privacyLevel?: PrivacyLevel;
  /** Allow cancellation by sender */
  cancellable?: boolean;
  /** Allow pausing */
  pausable?: boolean;
  /** Custom cliff period in seconds */
  cliffPeriod?: number;
}

/**
 * Stream withdrawal options
 */
export interface StreamWithdrawOptions {
  /** Specific amount to withdraw (defaults to all available) */
  amount?: bigint;
  /** Destination address (defaults to connected wallet) */
  destination?: PublicKey;
}

// ============================================================================
// Transaction Types
// ============================================================================

/**
 * Transaction type enum
 */
export type TransactionType =
  | 'stealth_send'
  | 'stealth_claim'
  | 'stream_create'
  | 'stream_withdraw'
  | 'stream_cancel'
  | 'wallet_transfer';

/**
 * Transaction record
 */
export interface TransactionRecord {
  /** Transaction signature */
  signature: string;
  /** Transaction type */
  type: TransactionType;
  /** Amount involved */
  amount: bigint;
  /** Token mint (null for SOL) */
  tokenMint: PublicKey | null;
  /** Counterparty address */
  counterparty?: PublicKey;
  /** Block time */
  blockTime: number;
  /** Status */
  status: 'pending' | 'confirmed' | 'failed';
  /** Fee paid */
  fee: bigint;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Client Types
// ============================================================================

/**
 * Network cluster
 */
export type Cluster = 'mainnet-beta' | 'testnet' | 'devnet' | 'localnet';

/**
 * Client configuration options
 */
export interface P01ClientConfig {
  /** Solana cluster to connect to */
  cluster?: Cluster;
  /** Custom RPC endpoint */
  rpcEndpoint?: string;
  /** Commitment level */
  commitment?: 'processed' | 'confirmed' | 'finalized';
  /** Enable debug logging */
  debug?: boolean;
  /** Custom program ID (for testing) */
  programId?: PublicKey;
  /** Request timeout in milliseconds */
  timeout?: number;
}

/**
 * Wallet adapter interface for external wallets
 */
export interface WalletAdapter {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]>;
  signMessage?(message: Uint8Array): Promise<Uint8Array>;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error codes for SDK errors
 */
export enum P01ErrorCode {
  // Wallet errors (1xxx)
  WALLET_NOT_CONNECTED = 1001,
  WALLET_CREATION_FAILED = 1002,
  INVALID_SEED_PHRASE = 1003,
  DERIVATION_FAILED = 1004,

  // Stealth errors (2xxx)
  STEALTH_KEY_GENERATION_FAILED = 2001,
  INVALID_STEALTH_ADDRESS = 2002,
  SCAN_FAILED = 2003,
  NO_PAYMENTS_FOUND = 2004,

  // Transfer errors (3xxx)
  INSUFFICIENT_BALANCE = 3001,
  TRANSFER_FAILED = 3002,
  CLAIM_FAILED = 3003,
  INVALID_RECIPIENT = 3004,

  // Stream errors (4xxx)
  STREAM_NOT_FOUND = 4001,
  STREAM_CREATION_FAILED = 4002,
  STREAM_ALREADY_CANCELLED = 4003,
  NOTHING_TO_WITHDRAW = 4004,
  UNAUTHORIZED_STREAM_ACTION = 4005,

  // Network errors (5xxx)
  RPC_ERROR = 5001,
  TIMEOUT = 5002,
  CONFIRMATION_FAILED = 5003,

  // General errors (9xxx)
  UNKNOWN_ERROR = 9999,
}

/**
 * Custom error class for Specter SDK
 */
export class P01Error extends Error {
  constructor(
    public readonly code: P01ErrorCode,
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'P01Error';
  }
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * Event types emitted by the SDK
 */
export type P01EventType =
  | 'payment_received'
  | 'payment_claimed'
  | 'stream_created'
  | 'stream_withdrawn'
  | 'stream_cancelled'
  | 'stream_completed';

/**
 * Event payload base
 */
export interface P01EventBase {
  type: P01EventType;
  timestamp: Date;
}

/**
 * Payment received event
 */
export interface PaymentReceivedEvent extends P01EventBase {
  type: 'payment_received';
  payment: StealthPayment;
}

/**
 * Stream event
 */
export interface StreamEvent extends P01EventBase {
  type: 'stream_created' | 'stream_withdrawn' | 'stream_cancelled' | 'stream_completed';
  stream: Stream;
  amount?: bigint;
}

/**
 * Union type for all events
 */
export type P01Event = PaymentReceivedEvent | StreamEvent;

/**
 * Event listener callback
 */
export type P01EventListener = (event: P01Event) => void;
