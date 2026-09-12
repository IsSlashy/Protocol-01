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
  /** Generate ML-KEM-768 keypair for post-quantum hybrid stealth addresses (v2) */
  enableHybrid?: boolean;
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
 * Contains the spending and viewing public keys, and optionally a post-quantum KEM key
 */
export interface StealthMetaAddress {
  /** Spending public key (K) */
  spendingPubKey: Uint8Array;
  /** Viewing public key (V) */
  viewingPubKey: Uint8Array;
  /** ML-KEM-768 public key for hybrid quantum-resistant key exchange (1184 bytes, v2 only) */
  kemPubKey?: Uint8Array;
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
  /** ML-KEM-768 ciphertext for hybrid key exchange (1088 bytes, v2 only) */
  kemCiphertext?: Uint8Array;
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

// [2026-09-13] The payment, scan, privacy-level, transfer, stream, transaction
// and event types left with the `specter` program (closed on devnet on
// 2026-09-13); nothing in this package produces them any more.

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
  /** Custom registry program ID override */
  registryProgramId?: PublicKey;
  /** Custom relayer program ID override */
  relayerProgramId?: PublicKey;
  /** Feature flag overrides — keys are feature names, values are enabled/disabled */
  features?: Partial<Record<string, boolean>>;
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
  INVALID_AMOUNT = 3005,

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

// Aliases for backward compatibility
export { P01Error as SpecterError };
export { P01ErrorCode as SpecterErrorCode };
export type { P01Wallet as SpecterWallet };
