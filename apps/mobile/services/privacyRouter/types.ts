/**
 * Privacy Router — Type Definitions
 *
 * Defines all types for the multi-hop privacy routing system.
 * Users can opt-in to send funds through randomized intermediate wallets
 * with time-delayed execution, making transaction graph analysis infeasible.
 */

/** Privacy level determines hops, splits, and total cost */
export type PrivacyLevel = 1 | 2 | 3 | 4 | 5;

/** Status of a route or individual hop */
export type RouteStatus =
  | 'pending'
  | 'shielding'
  | 'maturing'
  | 'unshielding'
  | 'reshielding'
  | 'completed'
  | 'failed';

/** Denomination tiers available in the protocol */
export type Denomination = 0.1 | 0.5 | 1 | 5 | 10;

/** Individual hop in the privacy route */
export interface RouteHop {
  /** Unique hop ID (deterministic from route + index) */
  id: string;
  /** Position in the route */
  hopIndex: number;
  /** Type of operation for this hop */
  type: 'shield' | 'unshield' | 'reshield';
  /** Pool denomination for this hop */
  poolDenomination: Denomination;
  /** Amount in SOL (always = poolDenomination) */
  amount: number;
  /** Base58 stealth address for this hop */
  stealthAddress: string;
  /** Encrypted spending secret for stealth address */
  stealthSecret: string;
  /** Unix timestamp when this hop should execute */
  scheduledAt: number;
  /** When it actually executed */
  executedAt?: number;
  /** Solana TX signature */
  txSignature?: string;
  /** Current status of this hop */
  status: RouteStatus;
  /** Number of retries attempted */
  retryCount: number;
  /** Hex nullifier, for unshield hops */
  nullifier?: string;
  /** Hex commitment, for shield hops */
  commitment?: string;
  /** Hex merkle root, for unshield hops */
  merkleRoot?: string;
}

/** Complete privacy route plan */
export interface PrivacyRoute {
  /** Route ID = HMAC(spending_key, "privacy_route" + nonce) */
  id: string;
  /** Monotonic counter */
  nonce: number;
  /** Selected privacy level */
  privacyLevel: PrivacyLevel;
  /** Total SOL being sent */
  totalAmount: number;
  /** Pool to split from (or direct deposit denom) */
  sourceDenomination: Denomination;
  /** Pool for individual notes */
  targetDenomination: Denomination;
  /** Number of splits (up to 20) */
  numOutputs: number;
  /** Number of re-shield cycles */
  numHops: number;
  /** Final recipient (stealth address) */
  destination: string;
  /** Ordered list of all hops */
  hops: RouteHop[];
  /** Overall route status */
  status: RouteStatus;
  /** Route creation timestamp */
  createdAt: number;
  /** Estimated completion timestamp */
  estimatedCompletionAt: number;
  /** Estimated protocol fees in SOL */
  totalFeeEstimate: number;
  /** PDA pubkey if tracking on-chain */
  onChainRouteKey?: string;
}

/** Configuration for the Privacy Router */
export interface PrivacyRouterConfig {
  /** Minimum delay between hops (ms) */
  minHopDelay: number;
  /** Maximum delay between hops (ms) */
  maxHopDelay: number;
  /** Minimum anonymity set size before proceeding */
  minAnonymitySet: number;
  /** Whether to check pool depth before operations */
  enforcePoolDepth: boolean;
  /** Maximum retries per hop */
  maxRetries: number;
  /** Retry delay (ms) */
  retryDelay: number;
}

/** Fee breakdown for a route */
export interface RouteFeeEstimate {
  /** Shield fees (0.3% per shield) */
  shieldFees: number;
  /** Unshield fees (0.5% per unshield) */
  unshieldFees: number;
  /** Solana TX fees */
  networkFees: number;
  /** Total fees in SOL */
  totalFees: number;
  /** Total cost as percentage of amount */
  totalCostPercent: number;
  /** Number of on-chain transactions */
  numTransactions: number;
  /** Human readable estimated duration */
  estimatedDuration: string;
}

/** Route progress for UI display */
export interface RouteProgress {
  /** Route ID */
  routeId: string;
  /** Total number of hops */
  totalHops: number;
  /** Number of completed hops */
  completedHops: number;
  /** Current overall status */
  currentStatus: RouteStatus;
  /** Completion percentage (0-100) */
  percentComplete: number;
  /** Human readable estimated time remaining */
  estimatedTimeRemaining: string;
  /** The hop currently being executed */
  currentHop?: RouteHop;
}

/** Callbacks for shield/unshield operations (decoupled from other services) */
export interface HopExecutionCallbacks {
  /** Shield funds into a denominated pool */
  shield: (params: {
    amount: number;
    denomination: Denomination;
    fromKeypair: Uint8Array;
  }) => Promise<{ txSignature: string; commitment: string }>;

  /** Unshield funds from a denominated pool */
  unshield: (params: {
    nullifier: string;
    denomination: Denomination;
    toAddress: string;
    fromKeypair: Uint8Array;
  }) => Promise<{ txSignature: string }>;

  /** Split a note from high-denomination pool into multiple lower-denomination notes */
  split?: (params: {
    sourceDenomination: Denomination;
    targetDenomination: Denomination;
    numOutputs: number;
    fromKeypair: Uint8Array;
  }) => Promise<{ txSignature: string; outputCommitments: string[] }>;
}

/**
 * Default configs per privacy level.
 *
 * Higher levels use more hops, more splits, and longer delays.
 * This exponentially increases the cost of transaction graph analysis.
 */
export const PRIVACY_LEVEL_CONFIGS: Record<
  PrivacyLevel,
  {
    hops: number;
    splits: number;
    minDelayMs: number;
    maxDelayMs: number;
    description: string;
  }
> = {
  1: {
    hops: 1,
    splits: 5,
    minDelayMs: 15 * 60_000,
    maxDelayMs: 60 * 60_000,
    description: 'Basic -- 1 hop, 5 splits, ~30min-1h',
  },
  2: {
    hops: 2,
    splits: 10,
    minDelayMs: 30 * 60_000,
    maxDelayMs: 120 * 60_000,
    description: 'Standard -- 2 hops, 10 splits, ~1-4h',
  },
  3: {
    hops: 3,
    splits: 15,
    minDelayMs: 60 * 60_000,
    maxDelayMs: 240 * 60_000,
    description: 'Enhanced -- 3 hops, 15 splits, ~4-8h',
  },
  4: {
    hops: 4,
    splits: 20,
    minDelayMs: 120 * 60_000,
    maxDelayMs: 480 * 60_000,
    description: 'Maximum -- 4 hops, 20 splits, ~8-16h',
  },
  5: {
    hops: 5,
    splits: 20,
    minDelayMs: 240 * 60_000,
    maxDelayMs: 1440 * 60_000,
    description: 'Paranoid -- 5 hops, 20 splits, ~24-48h',
  },
};
