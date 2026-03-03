/**
 * Type definitions for Subscription Vault service
 */

/** Subscription vault information (parsed on-chain account) */
export interface VaultInfo {
  /** Vault PDA address (base58) */
  address: string;
  /** Subscriber wallet pubkey (normal mode) */
  subscriberPubkey: string | null;
  /** Subscriber commitment (private mode, hex) */
  subscriberCommitment: string | null;
  /** Retailer pubkey (base58) */
  retailer: string;
  /** Token mint (base58) */
  tokenMint: string;
  /** Total amount deposited */
  totalDeposited: number;
  /** Rate per period (lamports/atomic units) */
  rate: number;
  /** Interval between periods (slots) */
  intervalSlots: number;
  /** Start slot */
  startSlot: number;
  /** Number of periods claimed by retailer */
  claimedPeriods: number;
  /** Whether the vault is active */
  isActive: boolean;
  /** Whether the vault is paused */
  isPaused: boolean;
  /** Slot at which the vault was paused */
  pauseSlot: number | null;
  /** Total slots spent paused */
  totalPausedSlots: number;
  /** Source pool for private mode (base58) */
  sourcePool: string | null;
  /** Whether this is a normal (wallet) vault */
  isNormalMode: boolean;
  /** Whether this is a private (ZK) vault */
  isPrivateMode: boolean;
}

/** Parameters for creating a normal subscription */
export interface SubscribeNormalParams {
  /** Retailer pubkey (base58) */
  retailer: string;
  /** Token mint (base58, system program for SOL) */
  tokenMint: string;
  /** Amount to deposit (lamports/atomic units) */
  amount: number;
  /** Rate per period */
  rate: number;
  /** Interval between periods (slots) */
  intervalSlots: number;
  /** VK hash for subscriber ownership circuit */
  vkHashSubscriber: Uint8Array;
}

/** Parameters for creating a private subscription */
export interface SubscribePrivateParams {
  /** Retailer pubkey (base58) */
  retailer: string;
  /** Pool address (base58) */
  poolAddress: string;
  /** Denominated pool proof */
  proof: ProofData;
  /** Nullifier bytes (hex) */
  nullifier: string;
  /** Merkle root (hex) */
  merkleRoot: string;
  /** Min epoch */
  minEpoch: number;
  /** Subscriber secret (bigint string) — used to derive commitment */
  subscriberSecret: string;
  /** Rate per period */
  rate: number;
  /** Interval between periods (slots) */
  intervalSlots: number;
  /** VK hash for subscriber ownership circuit */
  vkHashSubscriber: Uint8Array;
}

/** Groth16 proof data */
export interface ProofData {
  pi_a: Uint8Array;
  pi_b: Uint8Array;
  pi_c: Uint8Array;
}
