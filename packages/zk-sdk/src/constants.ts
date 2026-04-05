/**
 * Constants for the ZK shielded system
 */

/**
 * BN254 field modulus
 */
export const FIELD_MODULUS = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);

/**
 * Default Merkle tree depth (2^20 = ~1M notes)
 */
export const MERKLE_TREE_DEPTH = 20;

/**
 * Maximum tree leaves
 */
export const MAX_TREE_LEAVES = 2 ** MERKLE_TREE_DEPTH;

/**
 * Zero value for empty Merkle tree leaves
 * Computed as Poseidon(0)
 */
export const ZERO_VALUE = BigInt(
  '21663839004416932945382355908790599225266501822907911457504978515578255421292'
);

/**
 * Program ID for the ZK shielded pool (deployed on devnet)
 */
export const ZK_SHIELDED_PROGRAM_ID = 'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c';

/**
 * Network type for program configuration
 */
export type NetworkId = 'devnet' | 'mainnet-beta' | 'localnet';

/**
 * Program IDs by network.
 * Devnet and localnet use the current deployment; mainnet-beta is not yet deployed.
 */
export const PROGRAM_IDS: Record<NetworkId, string> = {
  'devnet': 'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c',
  'mainnet-beta': '',
  'localnet': 'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c',
};

/**
 * Get the program ID for the given network.
 * Falls back to devnet if no network is specified.
 *
 * @param network - The Solana network to use (default: 'devnet')
 * @returns The program ID string for the given network
 * @throws If the network is 'mainnet-beta' and no program ID has been configured
 * @throws If the network string is not recognized
 *
 * @example
 * ```ts
 * const id = getProgramId('devnet');
 * // Override for mainnet when deployed:
 * const id = getProgramId('mainnet-beta'); // throws until mainnet deploy
 * ```
 */
export function getProgramId(network?: string): string {
  const net = (network ?? 'devnet') as NetworkId;
  const id = PROGRAM_IDS[net];

  if (id === undefined) {
    throw new Error(
      `getProgramId: unknown network '${net}'. Expected one of: devnet, mainnet-beta, localnet.`
    );
  }

  if (id === '') {
    throw new Error(
      `getProgramId: the ZK shielded program is not yet deployed on '${net}'. ` +
      `Pass a custom programId in your ShieldedClientConfig, or use 'devnet' or 'localnet' for testing.`
    );
  }

  return id;
}

/**
 * Seed prefixes for PDA derivation
 */
export const PDA_SEEDS = {
  SHIELDED_POOL: Buffer.from('shielded_pool'),
  MERKLE_TREE: Buffer.from('merkle_tree'),
  NULLIFIER_SET: Buffer.from('nullifier_set'),
  NULLIFIER_BATCH: Buffer.from('nullifier_batch'),
  NULLIFIER: Buffer.from('nullifier'),
  VK_DATA: Buffer.from('vk_data'),
} as const;

/**
 * Anchor instruction discriminators (sha256("global:<name>")[0..8])
 */
export const IX_DISCRIMINATORS = {
  SHIELD: Buffer.from([220, 198, 253, 246, 231, 84, 147, 98]),
  TRANSFER: Buffer.from([163, 52, 200, 231, 140, 3, 69, 186]),
  UNSHIELD: Buffer.from([21, 228, 55, 24, 194, 10, 21, 22]),
} as const;

/**
 * Encryption constants
 */
export const ENCRYPTION = {
  /** XChaCha20-Poly1305 nonce size */
  NONCE_SIZE: 24,
  /** Encrypted note overhead (nonce + tag) */
  OVERHEAD: 40,
  /** Key size */
  KEY_SIZE: 32,
} as const;

/**
 * Default relayer fee in basis points (0.1%)
 */
export const DEFAULT_RELAYER_FEE_BPS = 10;

/**
 * Maximum relayer fee in basis points (1%)
 */
export const MAX_RELAYER_FEE_BPS = 100;

/**
 * Number of historical roots to keep
 */
export const MAX_HISTORICAL_ROOTS = 100;

/**
 * Proof generation timeout (ms)
 */
export const PROOF_GENERATION_TIMEOUT = 120000; // 2 minutes

/**
 * Circuit files
 */
export const CIRCUIT_FILES = {
  WASM: 'transfer.wasm',
  ZKEY: 'transfer_final.zkey',
  VK: 'verification_key.json',
} as const;
