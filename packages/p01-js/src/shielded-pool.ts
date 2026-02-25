/**
 * Shielded Pool Module for Protocol 01
 *
 * Provides primitives for interacting with Protocol 01's denominated shielded pools.
 * Shielded pools allow users to deposit tokens into fixed-denomination pools and
 * later withdraw them privately, breaking the on-chain link between sender and recipient.
 *
 * On-chain program: zk_shielded (denominated pool variant)
 * PDA seeds:
 *   - DenominatedPool: [b"denominated_pool", token_mint, denomination_le_bytes]
 *   - MerkleTree:      [b"merkle_tree", pool_key]
 *   - NullifierRecord: [b"nullifier", pool_key, nullifier_bytes]
 *
 * Commitment scheme: Poseidon(nullifier_preimage, secret, deposit_epoch, token_mint)
 * Proof system: Groth16 over BN254 (denominated_pool.circom, depth 15, 4273 constraints)
 *
 * @module shielded-pool
 */

import { bytesToHex, hexToBytes, generateRandomBytes, hashSHA256 } from './security/crypto';

// ============ Constants ============

/** Program ID for zk_shielded (devnet deployment) */
export const ZK_SHIELDED_PROGRAM_ID = 'EqppogLBFqoVfYR2t6WVswaGo7cHxvWmgsgLDnaUPpah';

/** Known USDC devnet mint */
const USDC_DEVNET_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

/** SOL native mint (wrapped SOL) */
const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** Standard denominations supported by the protocol */
export const STANDARD_DENOMINATIONS = [1, 10, 100, 1000] as const;

/** Merkle tree depth used in the denominated pool circuit */
export const MERKLE_TREE_DEPTH = 15;

/** Maximum number of leaves in the Merkle tree (2^15) */
export const MAX_LEAVES = 2 ** MERKLE_TREE_DEPTH;

/** Delay tiers based on pool activity */
export const DELAY_TIERS = {
  instant: 0,
  '10min': 10 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
} as const;

// ============ Types ============

/**
 * Receipt returned after a successful shield (deposit) operation.
 * This receipt contains all information needed to later unshield (withdraw).
 *
 * IMPORTANT: Store this securely. Loss of the receipt means loss of funds.
 */
export interface ShieldReceipt {
  /** Hex-encoded random bigint used as the secret input to the commitment */
  secret: string;
  /** Hex-encoded random bigint used to derive the nullifier */
  nullifierPreimage: string;
  /** Solana slot at the time of deposit, used in the commitment */
  depositEpoch: number;
  /** Base58-encoded token mint public key */
  tokenMint: string;
  /** Hex-encoded 32-byte Poseidon commitment hash */
  commitment: string;
  /** Index of this note's leaf in the Merkle tree */
  leafIndex: number;
  /** Human-readable denomination (e.g. 1, 10, 100, 1000) */
  denomination: number;
  /** Base58-encoded pool PDA address */
  pool: string;
}

/**
 * Parameters for shielding (depositing) tokens into a denominated pool.
 */
export interface ShieldParams {
  /** Token to deposit */
  token: 'SOL' | 'USDC';
  /** Fixed denomination: 1, 10, 100, or 1000 token units */
  denomination: number;
  /** Wallet (Keypair or WalletAdapter) for signing the transaction */
  wallet: any;
  /** Optional RPC endpoint (defaults to devnet) */
  rpcEndpoint?: string;
}

/**
 * Parameters for unshielding (withdrawing) tokens from a denominated pool.
 */
export interface UnshieldParams {
  /** The ShieldReceipt from the original deposit */
  receipt: ShieldReceipt;
  /** Base58-encoded destination address for the withdrawn tokens */
  recipientAddress: string;
  /** Whether to use the relayer for meta-transaction (hides sender) */
  useRelayer: boolean;
  /** Relayer service URL (required if useRelayer is true) */
  relayerUrl?: string;
}

/**
 * Information about a specific denominated pool.
 */
export interface PoolInfo {
  /** Base58-encoded pool PDA address */
  address: string;
  /** Base58-encoded token mint public key */
  tokenMint: string;
  /** Human-readable token symbol */
  tokenSymbol: string;
  /** Fixed denomination of this pool */
  denomination: number;
  /** Total number of notes (deposits) in the pool */
  noteCount: number;
  /** Number of notes that have passed the minimum delay */
  matureNotes: number;
  /** Current withdrawal delay tier */
  currentDelay: 'instant' | '10min' | '1h' | '6h';
  /** Estimated delay in milliseconds before withdrawal is possible */
  estimatedDelayMs: number;
  /** Total shielded value (denomination * noteCount) */
  totalShielded: number;
  /** Whether the pool is active and accepting deposits */
  isActive: boolean;
}

// ============ Validation ============

/**
 * Validate shield parameters before executing.
 *
 * @param params - Shield parameters to validate
 * @throws Error if params are invalid
 */
export function validateShieldParams(params: ShieldParams): void {
  if (!params.token || !['SOL', 'USDC'].includes(params.token)) {
    throw new Error(`Invalid token: ${params.token}. Must be 'SOL' or 'USDC'.`);
  }

  if (!STANDARD_DENOMINATIONS.includes(params.denomination as any)) {
    throw new Error(
      `Invalid denomination: ${params.denomination}. Must be one of: ${STANDARD_DENOMINATIONS.join(', ')}`
    );
  }

  if (!params.wallet) {
    throw new Error('Wallet is required for shield operations.');
  }
}

/**
 * Validate unshield parameters before executing.
 *
 * @param params - Unshield parameters to validate
 * @throws Error if params are invalid
 */
export function validateUnshieldParams(params: UnshieldParams): void {
  if (!params.receipt) {
    throw new Error('Receipt is required for unshield operations.');
  }

  if (!params.receipt.secret || !params.receipt.nullifierPreimage) {
    throw new Error('Receipt is missing secret or nullifierPreimage.');
  }

  if (!params.recipientAddress || params.recipientAddress.length < 32) {
    throw new Error('Invalid recipient address.');
  }

  if (params.useRelayer && !params.relayerUrl) {
    throw new Error('relayerUrl is required when useRelayer is true.');
  }
}

// ============ Commitment Helpers ============

/**
 * Resolve a token symbol to its mint address.
 *
 * @param token - 'SOL' or 'USDC'
 * @param network - 'devnet' or 'mainnet-beta'
 * @returns Base58-encoded mint address
 */
export function resolveTokenMintForPool(
  token: 'SOL' | 'USDC',
  network: 'devnet' | 'mainnet-beta' = 'devnet'
): string {
  if (token === 'SOL') return SOL_MINT;
  if (token === 'USDC') {
    return network === 'devnet'
      ? USDC_DEVNET_MINT
      : 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  }
  throw new Error(`Unknown token: ${token}`);
}

/**
 * Compute a placeholder commitment hash.
 *
 * TODO: Replace with real Poseidon hash via circomlibjs.
 * The actual on-chain commitment is Poseidon(nullifier_preimage, secret, deposit_epoch, token_mint).
 * This placeholder uses SHA-256 to simulate the structure for development/testing.
 * It MUST be replaced before mainnet deployment.
 *
 * @param nullifierPreimage - Hex-encoded nullifier preimage
 * @param secret - Hex-encoded secret
 * @param depositEpoch - Deposit slot number
 * @param tokenMint - Base58-encoded token mint
 * @returns Hex-encoded 32-byte commitment
 */
export function computeCommitmentPlaceholder(
  nullifierPreimage: string,
  secret: string,
  depositEpoch: number,
  tokenMint: string
): string {
  // TODO: Replace with Poseidon hash from circomlibjs
  // Real implementation: Poseidon([nullifierPreimage, secret, depositEpoch, tokenMintAsField])
  // For now, use SHA-256 of concatenated inputs as a structural placeholder
  const encoder = new TextEncoder();
  const data = new Uint8Array([
    ...hexToBytes(nullifierPreimage),
    ...hexToBytes(secret),
    ...encoder.encode(depositEpoch.toString()),
    ...encoder.encode(tokenMint),
  ]);
  return bytesToHex(hashSHA256(data));
}

// ============ Shield ============

/**
 * Shield (deposit) tokens into a denominated pool.
 *
 * This function:
 * 1. Generates random secret and nullifier preimage
 * 2. Computes a commitment (Poseidon hash placeholder)
 * 3. Builds and sends the shield_denominated transaction
 * 4. Returns a ShieldReceipt for later withdrawal
 *
 * TODO: This implementation requires @solana/web3.js for transaction building.
 * Currently it generates the receipt locally but cannot submit the transaction.
 * The consuming application must provide its own Solana connection and transaction
 * submission logic, or use the full ZK service from apps/mobile or apps/extension.
 *
 * @param params - Shield parameters
 * @returns ShieldReceipt containing all data needed for future unshield
 * @throws Error if parameters are invalid or transaction fails
 */
export async function shield(params: ShieldParams): Promise<ShieldReceipt> {
  // Validate inputs
  validateShieldParams(params);

  // Generate cryptographic randomness for the note
  const secretBytes = generateRandomBytes(32);
  const nullifierPreimageBytes = generateRandomBytes(32);
  const secret = bytesToHex(secretBytes);
  const nullifierPreimage = bytesToHex(nullifierPreimageBytes);

  // Resolve token mint
  const tokenMint = resolveTokenMintForPool(params.token);

  // Get current slot as deposit epoch
  // TODO: Requires @solana/web3.js Connection.getSlot()
  // For now, use a timestamp-based epoch (milliseconds since Unix epoch / 400ms slot time)
  const depositEpoch = Math.floor(Date.now() / 400);

  // Compute commitment
  // TODO: Replace with real Poseidon hash via circomlibjs
  const commitment = computeCommitmentPlaceholder(
    nullifierPreimage,
    secret,
    depositEpoch,
    tokenMint
  );

  // Derive pool PDA
  // TODO: Requires @solana/web3.js PublicKey.findProgramAddressSync()
  // Seeds: [b"denominated_pool", token_mint_bytes, denomination_le_bytes]
  // For now, return a placeholder that the caller must resolve
  const pool = `pool:${params.token}:${params.denomination}`;

  // Build and send transaction
  // TODO: Requires @solana/web3.js for:
  // 1. Connection to RPC
  // 2. Building the shield_denominated instruction
  // 3. Account resolution (pool PDA, Merkle tree PDA, user token account)
  // 4. Transaction signing via wallet
  // 5. Transaction confirmation
  //
  // The full implementation is in:
  //   - apps/mobile/services/zk/index.ts (ZkService.shield)
  //   - apps/extension/src/shared/services/zk.ts
  //
  // This SDK provides the receipt structure; the transaction must be
  // submitted by the host application.

  console.warn(
    '[p-01 SDK] shield(): Transaction submission requires @solana/web3.js. ' +
    'The receipt has been generated locally. Use the full ZK service for on-chain submission.'
  );

  // Leaf index is unknown until the transaction is confirmed on-chain
  // The caller should update this after confirmation
  const leafIndex = -1;

  return {
    secret,
    nullifierPreimage,
    depositEpoch,
    tokenMint,
    commitment,
    leafIndex,
    denomination: params.denomination,
    pool,
  };
}

// ============ Unshield ============

/**
 * Unshield (withdraw) tokens from a denominated pool.
 *
 * This function supports two modes:
 * - Relayer mode (useRelayer=true): Sends proof to relayer for meta-transaction.
 *   The relayer submits the transaction so the recipient's address is not linked
 *   to the original depositor.
 * - Direct mode (useRelayer=false): Builds and sends the unshield transaction directly.
 *   This is cheaper but links the recipient to the withdrawal transaction.
 *
 * TODO: Both modes require heavy dependencies:
 * - snarkjs for client-side proof generation
 * - @solana/web3.js for direct transaction submission
 * - circomlibjs for Poseidon hash computation
 *
 * @param params - Unshield parameters
 * @returns Transaction signature (base58-encoded)
 * @throws Error if proof generation fails or transaction is rejected
 */
export async function unshield(params: UnshieldParams): Promise<string> {
  // Validate inputs
  validateUnshieldParams(params);

  if (params.useRelayer) {
    // Relayer mode: POST proof to relayer service
    // TODO: Generate ZK proof first via snarkjs (see proof-generator.ts)
    //
    // The proof must demonstrate:
    // 1. Knowledge of secret and nullifier_preimage that hash to a commitment in the Merkle tree
    // 2. The nullifier is correctly derived from nullifier_preimage
    // 3. The deposit_epoch satisfies the minimum delay requirement
    // 4. The token_mint matches the pool
    //
    // Public inputs: [merkle_root, nullifier, min_epoch, token_mint]

    if (!params.relayerUrl) {
      throw new Error('relayerUrl is required when useRelayer is true.');
    }

    throw new Error(
      'Unshield via relayer requires snarkjs for proof generation. ' +
      'Install snarkjs and provide circuit artifacts (wasm + zkey) to enable client-side proving. ' +
      'Alternatively, use the full ZK service from apps/mobile or apps/extension.'
    );
  } else {
    // Direct mode: build and send transaction
    // TODO: Requires @solana/web3.js + snarkjs
    throw new Error(
      'Direct unshield requires @solana/web3.js and snarkjs. ' +
      'Use shield() to generate a receipt, then submit via the full ZK service.'
    );
  }
}

// ============ Pool Information ============

/**
 * Get information about a specific denominated pool.
 *
 * TODO: Requires @solana/web3.js to deserialize the on-chain DenominatedPool account.
 * The DenominatedPool account contains:
 * - token_mint: Pubkey
 * - denomination: u64
 * - authority: Pubkey
 * - note_count: u64
 * - is_active: bool
 *
 * @param token - Token symbol ('SOL' or 'USDC') or mint address
 * @param denomination - Pool denomination (1, 10, 100, or 1000)
 * @param rpcEndpoint - Optional RPC endpoint (defaults to devnet)
 * @returns Pool information
 */
export async function getPoolInfo(
  token: string,
  denomination: number,
  rpcEndpoint?: string
): Promise<PoolInfo> {
  // TODO: Requires @solana/web3.js for:
  // 1. PublicKey.findProgramAddressSync to derive pool PDA
  // 2. Connection.getAccountInfo to fetch and deserialize pool data
  // 3. Connection.getAccountInfo for Merkle tree data (note count)
  //
  // The on-chain layout is defined in programs/zk_shielded/src/state/pool.rs

  throw new Error(
    'getPoolInfo() requires @solana/web3.js to read on-chain data. ' +
    'Add @solana/web3.js as a peer dependency or use the full ZK service.'
  );
}

/**
 * Get information about all known denominated pools for a given token.
 *
 * TODO: Requires @solana/web3.js. Scans all standard denominations (1, 10, 100, 1000)
 * for the specified token.
 *
 * @param token - Optional token filter ('SOL', 'USDC', or mint address). If omitted, returns all pools.
 * @param rpcEndpoint - Optional RPC endpoint
 * @returns Array of pool information
 */
export async function getPools(
  token?: string,
  rpcEndpoint?: string
): Promise<PoolInfo[]> {
  // TODO: Requires @solana/web3.js for on-chain account reads
  // Would iterate over STANDARD_DENOMINATIONS and call getPoolInfo for each

  throw new Error(
    'getPools() requires @solana/web3.js to read on-chain data. ' +
    'Add @solana/web3.js as a peer dependency or use the full ZK service.'
  );
}

// ============ Utility Exports ============

/**
 * Estimate the delay tier for a pool based on its note count.
 *
 * The delay system prevents timing analysis attacks:
 * - 0-9 notes: 6h delay (small anonymity set)
 * - 10-49 notes: 1h delay
 * - 50-199 notes: 10min delay
 * - 200+ notes: instant (large anonymity set)
 *
 * @param noteCount - Number of notes in the pool
 * @returns Delay tier and estimated milliseconds
 */
export function estimateDelayTier(noteCount: number): {
  tier: 'instant' | '10min' | '1h' | '6h';
  delayMs: number;
} {
  if (noteCount >= 200) return { tier: 'instant', delayMs: 0 };
  if (noteCount >= 50) return { tier: '10min', delayMs: DELAY_TIERS['10min'] };
  if (noteCount >= 10) return { tier: '1h', delayMs: DELAY_TIERS['1h'] };
  return { tier: '6h', delayMs: DELAY_TIERS['6h'] };
}

/**
 * Check if a denomination value is valid.
 *
 * @param denomination - Denomination to check
 * @returns true if the denomination is one of the standard values
 */
export function isValidDenomination(denomination: number): boolean {
  return STANDARD_DENOMINATIONS.includes(denomination as any);
}
