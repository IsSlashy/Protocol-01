import { PublicKey } from '@solana/web3.js';
import type { Cluster } from './types';

// ============================================================================
// Program IDs
// ============================================================================

/**
 * Specter Protocol program IDs for different networks
 */
export const PROGRAM_IDS: Record<Cluster, PublicKey> = {
  'mainnet-beta': new PublicKey('SpctRxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'),
  'testnet': new PublicKey('SpctRTestxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'),
  'devnet': new PublicKey('SpctRDevxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'),
  'localnet': new PublicKey('SpctRLocalxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'),
};

/**
 * Default program ID (devnet)
 */
export const DEFAULT_PROGRAM_ID = PROGRAM_IDS['devnet'];

// ============================================================================
// RPC Endpoints
// ============================================================================

/**
 * Default RPC endpoints for different clusters
 */
export const RPC_ENDPOINTS: Record<Cluster, string> = {
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  'testnet': 'https://api.testnet.solana.com',
  'devnet': 'https://api.devnet.solana.com',
  'localnet': 'http://127.0.0.1:8899',
};

// ============================================================================
// Wallet Constants
// ============================================================================

/**
 * Default derivation path for Solana wallets
 */
export const DEFAULT_DERIVATION_PATH = "m/44'/501'/0'/0'";

/**
 * Stealth key derivation paths
 */
export const STEALTH_DERIVATION = {
  SPENDING_KEY_PATH: "m/44'/501'/0'/1'",
  VIEWING_KEY_PATH: "m/44'/501'/0'/2'",
};

/**
 * Default entropy strength for mnemonic generation (24 words)
 */
export const DEFAULT_MNEMONIC_STRENGTH = 256;

// ============================================================================
// Transaction Constants
// ============================================================================

/**
 * Lamports per SOL
 */
export const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Minimum rent exemption (approx)
 */
export const MIN_RENT_EXEMPTION = 890_880n;

/**
 * Default transaction timeout (60 seconds)
 */
export const DEFAULT_TX_TIMEOUT = 60_000;

/**
 * Maximum retries for transaction confirmation
 */
export const MAX_TX_RETRIES = 3;

/**
 * Delay between retries (ms)
 */
export const TX_RETRY_DELAY = 1_000;

// ============================================================================
// Stealth Address Constants
// ============================================================================

/**
 * Stealth address prefix for encoding
 */
export const STEALTH_ADDRESS_PREFIX = 'st';

/**
 * View tag size in bytes
 */
export const VIEW_TAG_SIZE = 1;

/**
 * Ephemeral key size in bytes
 */
export const EPHEMERAL_KEY_SIZE = 32;

/**
 * Stealth meta-address version
 */
export const STEALTH_META_ADDRESS_VERSION = 1;

// ============================================================================
// Stream Constants
// ============================================================================

/**
 * Minimum stream duration (1 hour in seconds)
 */
export const MIN_STREAM_DURATION = 3600;

/**
 * Maximum stream duration (5 years in seconds)
 */
export const MAX_STREAM_DURATION = 5 * 365 * 24 * 3600;

/**
 * Minimum stream amount in lamports
 */
export const MIN_STREAM_AMOUNT = 1_000_000n; // 0.001 SOL

/**
 * Stream PDA seeds
 */
export const STREAM_SEED = 'specter_stream';

// ============================================================================
// Privacy Constants
// ============================================================================

/**
 * Default split count for enhanced privacy
 */
export const DEFAULT_SPLIT_COUNT = 3;

/**
 * Default delay between splits (ms)
 */
export const DEFAULT_SPLIT_DELAY = 5_000;

/**
 * Minimum amount per split transaction (lamports)
 */
export const MIN_SPLIT_AMOUNT = 10_000_000n; // 0.01 SOL

/**
 * Privacy level configurations
 */
export const PRIVACY_CONFIG = {
  standard: {
    useStealth: true,
    splitCount: 1,
    useDelay: false,
    useRelayer: false,
  },
  enhanced: {
    useStealth: true,
    splitCount: 3,
    useDelay: true,
    delayMs: 10_000,
    useRelayer: false,
  },
  maximum: {
    useStealth: true,
    splitCount: 5,
    useDelay: true,
    delayMs: 30_000,
    useRelayer: true,
    multiHop: true,
  },
} as const;

// ============================================================================
// Crypto Constants
// ============================================================================

/**
 * Encryption algorithm
 */
export const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

/**
 * Key derivation function iterations
 */
export const KDF_ITERATIONS = 100_000;

/**
 * Salt size for encryption
 */
export const SALT_SIZE = 16;

/**
 * IV size for AES-GCM
 */
export const IV_SIZE = 12;

/**
 * Auth tag size for AES-GCM
 */
export const AUTH_TAG_SIZE = 16;

// ============================================================================
// Error Messages
// ============================================================================

export const ERROR_MESSAGES = {
  WALLET_NOT_CONNECTED: 'Wallet is not connected. Please connect a wallet first.',
  INVALID_SEED_PHRASE: 'Invalid seed phrase. Please check and try again.',
  INSUFFICIENT_BALANCE: 'Insufficient balance for this transaction.',
  INVALID_RECIPIENT: 'Invalid recipient address format.',
  STEALTH_GENERATION_FAILED: 'Failed to generate stealth address.',
  STREAM_NOT_FOUND: 'Stream not found or has been cancelled.',
  UNAUTHORIZED: 'You are not authorized to perform this action.',
  RPC_ERROR: 'Failed to connect to the Solana network.',
  TIMEOUT: 'Transaction confirmation timed out.',
} as const;

// ============================================================================
// Anchor IDL Account Names
// ============================================================================

export const ACCOUNT_NAMES = {
  STEALTH_ACCOUNT: 'StealthAccount',
  STREAM_ACCOUNT: 'StreamAccount',
  USER_REGISTRY: 'UserRegistry',
} as const;

// ============================================================================
// Feature Flags
// ============================================================================

export const FEATURES = {
  ENABLE_RELAYER: false, // Enable when relayer is deployed
  ENABLE_MULTI_HOP: false, // Enable when multi-hop is implemented
  ENABLE_TOKEN_STREAMS: true, // SPL token streams
  ENABLE_NFT_TRANSFERS: false, // NFT stealth transfers
} as const;
