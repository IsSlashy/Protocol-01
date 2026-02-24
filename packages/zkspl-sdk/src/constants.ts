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

/** SPL Token program ID */
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

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
