/**
 * Security Types for Protocol 01
 */

// ============ Security Levels ============

/**
 * Security level for transactions
 * - 'standard': Regular Solana transaction (public)
 * - 'private': Stealth address + encrypted memo
 * - 'confidential': ZK proof + hidden amount
 * - 'maximum': All features combined
 */
export type SecurityLevel = 'standard' | 'private' | 'confidential' | 'maximum';

// ============ Stealth Addresses (DKSAP) ============

/**
 * Stealth key pair for receiving private payments
 * Based on Dual-Key Stealth Address Protocol
 */
export interface StealthKeyPair {
  /** Scan private key (used to detect incoming payments) */
  scanPrivateKey: Uint8Array;
  /** Scan public key (shared with senders) */
  scanPublicKey: Uint8Array;
  /** Spend private key (used to spend received funds) */
  spendPrivateKey: Uint8Array;
  /** Spend public key (part of stealth meta-address) */
  spendPublicKey: Uint8Array;
}

/**
 * Stealth meta-address (public, can be shared)
 */
export interface StealthMetaAddress {
  /** Scan public key */
  scanPublicKey: Uint8Array;
  /** Spend public key */
  spendPublicKey: Uint8Array;
  /** Encoded string representation */
  encoded: string;
}

/**
 * One-time stealth address for a specific payment
 */
export interface StealthAddress {
  /** The one-time address to send funds to */
  address: string;
  /** Ephemeral public key (included in transaction) */
  ephemeralPublicKey: Uint8Array;
  /** View tag for efficient scanning (1 byte) */
  viewTag: number;
}

/**
 * Scanned stealth payment
 */
export interface StealthPayment {
  /** Transaction signature */
  signature: string;
  /** Amount received */
  amount: number;
  /** Token mint */
  tokenMint: string;
  /** One-time private key to spend */
  privateKey: Uint8Array;
  /** Timestamp */
  timestamp: number;
}

// ============ Encryption ============

/**
 * Encrypted payload with metadata
 */
export interface EncryptedPayload {
  /** Encrypted data (base64) */
  ciphertext: string;
  /** Nonce used for encryption */
  nonce: string;
  /** Ephemeral public key for ECDH */
  ephemeralPublicKey: string;
  /** Encryption algorithm used */
  algorithm: 'x25519-xsalsa20-poly1305' | 'aes-256-gcm';
  /** Version for future compatibility */
  version: number;
}

/**
 * Encrypted memo for transactions
 */
export interface EncryptedMemo {
  /** Encrypted content */
  payload: EncryptedPayload;
  /** Recipient public key (for decryption) */
  recipientPublicKey: string;
  /** Optional: sender public key for verification */
  senderPublicKey?: string;
}

// ============ Confidential Transactions ============

/**
 * Confidential amount using Pedersen Commitment
 */
export interface ConfidentialAmount {
  /** Commitment to the amount (can be verified without revealing) */
  commitment: Uint8Array;
  /** Blinding factor (secret) */
  blindingFactor: Uint8Array;
  /** Range proof (proves amount is positive without revealing) */
  rangeProof?: Uint8Array;
}

/**
 * Confidential transfer data
 */
export interface ConfidentialTransfer {
  /** Sender's balance commitment */
  senderCommitment: Uint8Array;
  /** Recipient's balance commitment */
  recipientCommitment: Uint8Array;
  /** Transfer amount commitment */
  transferCommitment: Uint8Array;
  /** Zero-knowledge proof of validity */
  proof: ZKProof;
}

// ============ Zero-Knowledge Proofs ============

/**
 * Zero-knowledge proof
 */
export interface ZKProof {
  /** Proof type */
  type: 'groth16' | 'plonk' | 'bulletproof';
  /** Serialized proof data */
  proof: Uint8Array;
  /** Public inputs to the proof */
  publicInputs: Uint8Array[];
  /** Verification key hash (for on-chain verification) */
  verificationKeyHash: string;
}

/**
 * Private transaction with ZK proof
 */
export interface PrivateTransaction {
  /** Transaction type */
  type: 'transfer' | 'subscription' | 'payment';
  /** ZK proof of validity */
  proof: ZKProof;
  /** Encrypted details (only recipient can read) */
  encryptedDetails: EncryptedPayload;
  /** Nullifier to prevent double-spending */
  nullifier: Uint8Array;
  /** Merkle root of commitment tree */
  merkleRoot: Uint8Array;
}

// ============ Security Configuration ============

/**
 * Security feature flags
 */
export interface SecurityFeatures {
  /** Enable stealth addresses */
  stealthAddresses: boolean;
  /** Enable encrypted memos */
  encryptedMemos: boolean;
  /** Enable confidential amounts */
  confidentialAmounts: boolean;
  /** Enable ZK proofs */
  zkProofs: boolean;
}

/**
 * Security configuration
 */
export interface SecurityConfig {
  /** Default security level */
  defaultLevel: SecurityLevel;
  /** Enabled features */
  features: SecurityFeatures;
  /** Light Protocol program ID (for ZK) */
  lightProgramId?: string;
  /** Custom encryption key (optional) */
  encryptionKey?: Uint8Array;
}

// ============ Security Events ============

/**
 * Security event types
 */
export type SecurityEventType =
  | 'stealth:generated'
  | 'stealth:scanned'
  | 'encryption:success'
  | 'encryption:failed'
  | 'proof:generated'
  | 'proof:verified'
  | 'proof:failed';

/**
 * Security event
 */
export interface SecurityEvent {
  type: SecurityEventType;
  timestamp: number;
  data: unknown;
}
