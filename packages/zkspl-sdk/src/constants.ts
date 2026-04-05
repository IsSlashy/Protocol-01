/**
 * Constants for the zkSPL confidential token system
 */

// ---------------------------------------------------------------------------
// Field arithmetic
// ---------------------------------------------------------------------------

/** BN254 scalar field modulus (same as circom's prime) */
export const FIELD_MODULUS = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);

// ---------------------------------------------------------------------------
// Program IDs
// ---------------------------------------------------------------------------

/** Deployed p01_zkspl program ID */
export const ZKSPL_PROGRAM_ID = 'EqppogLBFqoVfYR2t6WVswaGo7cHxvWmgsgLDnaUPpah';

/** Deployed zk_shielded program ID (denominated pools + shielded pool) */
export const ZK_SHIELDED_PROGRAM_ID = 'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c';

/** SPL Token program ID */
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** Devnet USDC mint */
export const USDC_DEVNET_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

// ---------------------------------------------------------------------------
// Network-based program ID registry
// ---------------------------------------------------------------------------

export type NetworkId = 'devnet' | 'mainnet-beta' | 'localnet';
export type ProgramName = 'zkspl' | 'zkShielded';

/**
 * Deployed program IDs per network.
 *
 * - `devnet`: live on Solana devnet.
 * - `mainnet-beta`: not yet deployed (empty strings — `getProgramId` will throw).
 * - `localnet`: empty by default — override via `ZkSplClientConfig.programId`
 *   or `ZkSplClientConfig.zkShieldedProgramId`.
 */
export const PROGRAM_IDS: Record<NetworkId, Record<ProgramName, string>> = {
  devnet: {
    zkspl: 'EqppogLBFqoVfYR2t6WVswaGo7cHxvWmgsgLDnaUPpah',
    zkShielded: 'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c',
  },
  'mainnet-beta': {
    zkspl: '',
    zkShielded: '',
  },
  localnet: {
    zkspl: '',
    zkShielded: '',
  },
};

/**
 * Look up a program ID by network and program name.
 *
 * @param network  - `'devnet'`, `'mainnet-beta'`, or `'localnet'`
 * @param program  - `'zkspl'` or `'zkShielded'`
 * @returns The base-58 program ID string.
 * @throws If the program is not deployed on the requested network.
 *
 * @example
 * ```ts
 * const id = getProgramId('devnet', 'zkspl');
 * // 'EqppogLBFqoVfYR2t6WVswaGo7cHxvWmgsgLDnaUPpah'
 * ```
 */
export function getProgramId(network: string, program: ProgramName): string {
  const net = PROGRAM_IDS[network as NetworkId];
  if (!net) {
    throw new Error(
      `Unknown network "${network}". Supported networks: ${Object.keys(PROGRAM_IDS).join(', ')}`
    );
  }
  const id = net[program];
  if (!id) {
    throw new Error(
      `Program "${program}" is not deployed on ${network}. ` +
        (network === 'mainnet-beta'
          ? 'Mainnet deployment is not yet available.'
          : network === 'localnet'
            ? 'For localnet, pass programId / zkShieldedProgramId in ZkSplClientConfig.'
            : `Check PROGRAM_IDS for available deployments.`)
    );
  }
  return id;
}

// ---------------------------------------------------------------------------
// Token decimals registry
// ---------------------------------------------------------------------------

/** Decimal places for each supported token */
export const TOKEN_DECIMALS: Record<string, number> = {
  // Native SOL (SystemProgram.programId = "1111...1111")
  '11111111111111111111111111111111': 9,
  // Devnet USDC
  [USDC_DEVNET_MINT]: 6,
};

/**
 * Register custom token decimals so the SDK can format amounts correctly.
 *
 * Call this once at startup for every SPL token mint your app uses.
 * Built-in entries (SOL, devnet USDC) cannot be overwritten.
 *
 * @param mint     - The SPL token mint address (base-58).
 * @param decimals - Number of decimal places (e.g. 6 for USDC, 9 for SOL).
 *
 * @example
 * ```ts
 * import { registerTokenDecimals } from '@protocol-01/zkspl-sdk';
 * registerTokenDecimals('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6); // mainnet USDC
 * ```
 */
export function registerTokenDecimals(mint: string, decimals: number): void {
  if (typeof mint !== 'string' || mint.length === 0) {
    throw new Error('registerTokenDecimals: mint must be a non-empty base-58 string.');
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(
      `registerTokenDecimals: decimals must be an integer 0-18, got ${decimals}.`
    );
  }
  TOKEN_DECIMALS[mint] = decimals;
}

// ---------------------------------------------------------------------------
// PDA seed prefixes (must match the Rust program)
// ---------------------------------------------------------------------------

export const PDA_SEEDS = {
  /** MintConfig PDA: ["zkspl_mint", token_mint] */
  MINT_CONFIG: Buffer.from('zkspl_mint'),
  /** ConfidentialAccount PDA: ["zkspl_account", owner, token_mint] */
  CONFIDENTIAL_ACCOUNT: Buffer.from('zkspl_account'),
  /** Vault PDA (SOL/lamport vault): ["zkspl_vault", token_mint] */
  VAULT: Buffer.from('zkspl_vault'),
  /** VK data PDA: ["zkspl_vk", mint_config_key, vk_type_byte] */
  VK_DATA: Buffer.from('zkspl_vk'),
} as const;

/** PDA seeds for the zk_shielded program (denominated pools) */
export const ZK_SHIELDED_PDA_SEEDS = {
  /** DenominatedPool PDA: ["denominated_pool", token_mint, denomination_le_bytes] */
  DENOMINATED_POOL: Buffer.from('denominated_pool'),
  /** MerkleTree PDA: ["merkle_tree", pool_key] */
  MERKLE_TREE: Buffer.from('merkle_tree'),
  /** Nullifier PDA: ["nullifier", pool_key, nullifier_bytes] */
  NULLIFIER: Buffer.from('nullifier'),
  /** ShieldedPool PDA: ["shielded_pool", token_mint] */
  SHIELDED_POOL: Buffer.from('shielded_pool'),
  /** VK data PDA: ["vk_data", shielded_pool_key] */
  VK_DATA: Buffer.from('vk_data'),
} as const;

/** Standard USDC denominated pool sizes (human-readable USDC amounts) */
export const USDC_DENOMINATIONS = [1, 10, 100, 1000] as const;

// ---------------------------------------------------------------------------
// VK type discriminators
// ---------------------------------------------------------------------------

/** VK type 0 = balance circuit VK (confidential_balance) */
export const VK_TYPE_BALANCE = 0;

/** VK type 1 = proof circuit VK (balance_proof / sufficiency) */
export const VK_TYPE_PROOF = 1;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Maximum pending credits per confidential account */
export const MAX_PENDING_CREDITS = 16;

/** Maximum viewer keys per confidential account */
export const MAX_VIEWER_KEYS = 8;

// ---------------------------------------------------------------------------
// Proof generation
// ---------------------------------------------------------------------------

/** Default proof generation timeout in milliseconds */
export const PROOF_GENERATION_TIMEOUT = 120_000;

// ---------------------------------------------------------------------------
// Circuit files (default paths, overridable via ProverConfig)
// ---------------------------------------------------------------------------

export const CIRCUIT_FILES = {
  BALANCE_WASM: 'confidential_balance.wasm',
  BALANCE_ZKEY: 'confidential_balance_final.zkey',
  BALANCE_VK: 'confidential_balance_vk.json',
  PROOF_WASM: 'balance_proof.wasm',
  PROOF_ZKEY: 'balance_proof_final.zkey',
  PROOF_VK: 'balance_proof_vk.json',
} as const;
