/**
 * Shared types for the Protocol 01 network explorer (/explorer).
 *
 * Everything here is AGGREGATE and privacy-safe by construction: counts and
 * sums derived from public on-chain pool state. No per-user, per-note, or
 * linkable data ever crosses this boundary — that is the whole point of the
 * explorer (it proves activity without exposing actors).
 */

export type Token = 'SOL' | 'USDC' | 'USDT';

/** One denomination pool's public, aggregate state. */
export interface PoolMetric {
  token: Token;
  /** Human denomination, e.g. 0.1, 1, 10 (in token units, not base units). */
  denomination: number;
  /** Number of shielded notes in this pool. NOT a delivered anonymity set —
   *  a v3 withdrawal publishes the commitment of the deposit it spends, so the
   *  effective set is one until the C7 spend circuit ships. */
  noteCount: number;
  /** Total value locked in this pool, in token units (noteCount × denomination). */
  tvl: number;
  /** Pool account address (clickable to Solana Explorer). */
  address: string;
}

/** The 7 STARK circuits that make up the verifier. Static but real. */
export interface CircuitInfo {
  id: number;
  key: string;
  name: string;
  /** Post-quantum: STARK = hash-based, no trusted setup, no elliptic curves. */
  postQuantum: true;
}

export interface NetworkMetrics {
  /** True when the numbers came from a live chain read; false ⇒ honest fallback. */
  live: boolean;
  network: 'devnet' | 'mainnet';
  /** Unix ms when this snapshot was taken on the server. */
  snapshotAt: number;
  /** Total value shielded across all pools, keyed by token. */
  tvlByToken: Record<Token, number>;
  /** Total shielded notes across all pools. A pool-size total, not an
   *  anonymity set — see PoolMetric.noteCount. */
  totalNotes: number;
  /** Number of pools holding at least one note. */
  activePools: number;
  /** Per-denomination breakdown (only pools with noteCount > 0). */
  pools: PoolMetric[];
  /** The verifier's circuits. */
  circuits: CircuitInfo[];
  /** Optional diagnostics — how the snapshot was produced (no secrets). */
  debug?: {
    rpcHost: string;
    scanned: number;
    denomPools: number;
    withNotes: number;
    error?: string;
  };
}

export const STARK_CIRCUIT_LIST: CircuitInfo[] = [
  { id: 0, key: 'subscriberOwnership', name: 'Subscriber Ownership', postQuantum: true },
  { id: 1, key: 'poolCommitment', name: 'Pool Commitment', postQuantum: true },
  { id: 2, key: 'balanceProof', name: 'Balance Proof', postQuantum: true },
  { id: 3, key: 'merklePath', name: 'Merkle Path', postQuantum: true },
  { id: 4, key: 'confidentialBalance', name: 'Confidential Balance', postQuantum: true },
  { id: 5, key: 'transfer', name: 'Transfer', postQuantum: true },
  { id: 6, key: 'merkleUpdate', name: 'Merkle Update', postQuantum: true },
];
