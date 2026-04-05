import { PublicKey } from '@solana/web3.js';

/**
 * Stream lifecycle status.
 *
 * - `Active`    -- funds are streaming, recipient can withdraw.
 * - `Paused`    -- stream is temporarily paused (by sender).
 * - `Cancelled` -- sender cancelled; remaining funds returned.
 * - `Completed` -- all intervals paid, stream fully settled.
 */
export enum StreamStatus {
  Active = 'active',
  Paused = 'paused',
  Cancelled = 'cancelled',
  Completed = 'completed',
}

/**
 * Subscription tier configuration used by the Protocol 01 SaaS tiers.
 */
export interface SubscriptionTier {
  /** Human-readable tier name (e.g. "Basic", "Pro", "Enterprise"). */
  name: string;
  /** Amount per interval in the token's smallest unit (e.g. lamports, USDC base units). */
  pricePerInterval: number;
  /** Duration of one interval in seconds. */
  intervalSeconds: number;
  /** Total number of intervals in the subscription. */
  totalIntervals: number;
  /** List of features included in this tier. */
  features: string[];
}

/**
 * Parsed on-chain stream account data.
 *
 * Returned by `P01StreamClient.getStream()`, `getIncomingStreams()`, etc.
 */
export interface Stream {
  /** The stream account's on-chain address. */
  publicKey: PublicKey;
  /** Wallet that created (and funds) the stream. */
  sender: PublicKey;
  /** Wallet that receives streamed tokens. */
  recipient: PublicKey;
  /** SPL token mint being streamed. */
  mint: PublicKey;
  /** Token amount released per interval, in the mint's smallest unit. */
  amountPerInterval: bigint;
  /** Duration of one interval in seconds. */
  intervalSeconds: number;
  /** Total number of intervals in the stream. */
  totalIntervals: number;
  /** Number of intervals already withdrawn by the recipient. */
  intervalsPaid: number;
  /** Unix timestamp (seconds) when the stream was created. */
  createdAt: number;
  /** Unix timestamp (seconds) of the most recent withdrawal. */
  lastWithdrawalAt: number;
  /** Current lifecycle status of the stream. */
  status: StreamStatus;
  /** Human-readable stream name (max ~32 chars). */
  streamName: string;
}

/**
 * Parameters for creating a new payment stream.
 */
export interface CreateStreamParams {
  /** Recipient wallet address. Must be a valid Solana public key. */
  recipient: PublicKey;
  /** SPL token mint to stream. Use `NATIVE_SOL_MINT` for wrapped SOL. */
  mint: PublicKey;
  /** Token amount per interval in the mint's smallest unit. Must be positive. */
  amountPerInterval: number | bigint;
  /** Duration of one interval in seconds. Must be positive. */
  intervalSeconds: number;
  /** Total number of intervals. Must be positive. */
  totalIntervals: number;
  /** Human-readable stream name (max ~32 chars). */
  streamName: string;
}

/**
 * Discriminated union of stream lifecycle events.
 *
 * Useful for event-driven UIs or webhook integrations.
 */
export type StreamEvent =
  | { type: 'created'; stream: Stream }
  | { type: 'withdrawal'; stream: Stream; amount: bigint }
  | { type: 'cancelled'; stream: Stream; refundAmount: bigint }
  | { type: 'completed'; stream: Stream };

/**
 * Wallet provider interface compatible with `@solana/wallet-adapter-base`.
 *
 * Any wallet adapter that exposes `publicKey`, `connected`, `signTransaction`,
 * `signAllTransactions`, and `signMessage` will satisfy this interface.
 */
export interface P01WalletProvider {
  /** The wallet's public key, or `null` if not connected. */
  publicKey: PublicKey | null;
  /** Whether the wallet is currently connected. */
  connected: boolean;
  /** Sign a single transaction and return the signed copy. */
  signTransaction: <T extends import('@solana/web3.js').Transaction>(transaction: T) => Promise<T>;
  /** Sign multiple transactions and return them all signed. */
  signAllTransactions: <T extends import('@solana/web3.js').Transaction>(transactions: T[]) => Promise<T[]>;
  /** Sign an arbitrary message (for off-chain authentication, etc.). */
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
}

/**
 * Full SDK configuration for `P01StreamClient`.
 */
export interface P01Config {
  /** Solana JSON-RPC endpoint URL. Falls back to the public endpoint for `network`. */
  rpcUrl: string;
  /** Target Solana cluster. */
  network: 'devnet' | 'mainnet-beta' | 'testnet';
  /** Override the stream program ID (defaults per network). */
  programId?: PublicKey;
  /** Transaction confirmation commitment level (default: `"confirmed"`). */
  commitment?: 'processed' | 'confirmed' | 'finalized';
}

/**
 * Optional overrides accepted by `createDevnetClient()` and `createMainnetClient()`.
 */
export interface ClientOverrides {
  /** Override the default stream program ID for the target network. */
  programId?: PublicKey;
  /** Override the default RPC endpoint URL for the target network. */
  rpcUrl?: string;
}
