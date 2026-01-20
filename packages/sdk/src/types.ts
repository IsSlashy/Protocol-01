import { PublicKey } from '@solana/web3.js';

/**
 * Stream status enum
 */
export enum StreamStatus {
  Active = 'active',
  Paused = 'paused',
  Cancelled = 'cancelled',
  Completed = 'completed',
}

/**
 * Subscription tier configuration
 */
export interface SubscriptionTier {
  name: string;
  pricePerInterval: number; // In lamports or token base units
  intervalSeconds: number;
  totalIntervals: number;
  features: string[];
}

/**
 * Stream account data
 */
export interface Stream {
  publicKey: PublicKey;
  sender: PublicKey;
  recipient: PublicKey;
  mint: PublicKey;
  amountPerInterval: bigint;
  intervalSeconds: number;
  totalIntervals: number;
  intervalsPaid: number;
  createdAt: number;
  lastWithdrawalAt: number;
  status: StreamStatus;
  streamName: string;
}

/**
 * Create stream parameters
 */
export interface CreateStreamParams {
  recipient: PublicKey;
  mint: PublicKey;
  amountPerInterval: number | bigint;
  intervalSeconds: number;
  totalIntervals: number;
  streamName: string;
}

/**
 * Stream event types
 */
export type StreamEvent =
  | { type: 'created'; stream: Stream }
  | { type: 'withdrawal'; stream: Stream; amount: bigint }
  | { type: 'cancelled'; stream: Stream; refundAmount: bigint }
  | { type: 'completed'; stream: Stream };

/**
 * P-01 Wallet provider interface
 */
export interface P01WalletProvider {
  publicKey: PublicKey | null;
  connected: boolean;
  signTransaction: <T extends import('@solana/web3.js').Transaction>(transaction: T) => Promise<T>;
  signAllTransactions: <T extends import('@solana/web3.js').Transaction>(transactions: T[]) => Promise<T[]>;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
}

/**
 * SDK configuration
 */
export interface P01Config {
  /** Solana cluster URL */
  rpcUrl: string;
  /** Network: 'devnet' | 'mainnet-beta' | 'testnet' */
  network: 'devnet' | 'mainnet-beta' | 'testnet';
  /** Stream program ID */
  programId?: PublicKey;
  /** Commitment level */
  commitment?: 'processed' | 'confirmed' | 'finalized';
}
