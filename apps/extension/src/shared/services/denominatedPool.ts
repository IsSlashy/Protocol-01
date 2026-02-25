/**
 * Denominated Pool Service for Chrome Extension
 *
 * Client-side ZK proving for Tornado Cash-style fixed-denomination pools.
 * Uses the same Web Worker infrastructure as the existing shielded pool.
 *
 * Circuit: denominated_pool.circom (4,273 constraints, depth 15)
 * Program: zk_shielded (GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c)
 *
 * Flow:
 *   Shield:   deposit exact denomination → insert commitment into Merkle tree (no proof)
 *   Unshield: prove knowledge of note secret → withdraw denomination (client-side proof)
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  Keypair,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { poseidon2, poseidon4 } from 'poseidon-lite';
import type { Groth16Proof, CircuitName } from './zk';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ZK_SHIELDED_PROGRAM_ID = new PublicKey('GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c');

const SEEDS = {
  DENOMINATED_POOL: new TextEncoder().encode('denominated_pool'),
  MERKLE_TREE: new TextEncoder().encode('merkle_tree'),
  NULLIFIER: new TextEncoder().encode('nullifier'),
  VK_DATA: new TextEncoder().encode('vk_data'),
  SHIELDED_POOL: new TextEncoder().encode('shielded_pool'),
};

const MERKLE_DEPTH = 15;
const SLOTS_PER_EPOCH = 7200;

const FIELD_ORDER = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);

/** BN254 zero leaf: keccak256("specter") mod p */
const ZERO_VALUE = BigInt(
  '21663839004416932945382355908790599225266501822907911457504978515578255421292'
);

/** Standard pool denominations (human-readable USDC amounts) */
export const DENOMINATIONS = [1, 10, 100, 1000] as const;

/** Native SOL uses SystemProgram ID as token_mint */
const NATIVE_SOL_MINT = SystemProgram.programId;

const CIRCUIT_NAME: CircuitName = 'denominated_pool';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShieldReceipt {
  /** Random spending secret — MUST be kept private */
  secret: bigint;
  /** Random value for nullifier derivation */
  nullifierPreimage: bigint;
  /** Epoch at time of deposit */
  depositEpoch: bigint;
  /** Token mint (field element) */
  tokenMint: bigint;
  /** Poseidon commitment (on-chain) */
  commitment: bigint;
  /** Leaf index in the Merkle tree */
  leafIndex: number;
  /** Pool denomination in lamports/atomic units */
  denomination: bigint;
  /** Pool PDA address */
  pool: string;
  /** Merkle path saved at shield time for instant unshield */
  merklePathElements?: bigint[];
  merklePathIndices?: number[];
  merkleRoot?: bigint;
}

export interface PoolInfo {
  address: PublicKey;
  tokenMint: PublicKey;
  denomination: bigint;
  epochDelay: bigint;
  isActive: boolean;
  noteCount: number;
  nextLeafIndex: number;
  totalShielded: bigint;
  merkleRoot: Uint8Array;
}

export interface DenominatedPoolProofInputs {
  merkle_root: string;
  nullifier: string;
  min_epoch: string;
  token_mint: string;
  secret: string;
  nullifier_preimage: string;
  deposit_epoch: string;
  path_elements: string[];
  path_indices: string[];
}

// ---------------------------------------------------------------------------
// Precomputed Merkle zeros (Poseidon-based, depth 15)
// ---------------------------------------------------------------------------

function computeZeroHashes(): bigint[] {
  const zeros = [ZERO_VALUE];
  for (let i = 1; i <= MERKLE_DEPTH; i++) {
    zeros.push(poseidon2([zeros[i - 1], zeros[i - 1]]));
  }
  return zeros;
}

let _zeroHashes: bigint[] | null = null;
function getZeroHashes(): bigint[] {
  if (!_zeroHashes) _zeroHashes = computeZeroHashes();
  return _zeroHashes;
}

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

export function deriveDenominatedPoolPDA(
  tokenMint: PublicKey,
  denominationLamports: bigint
): [PublicKey, number] {
  const denomBuf = Buffer.alloc(8);
  denomBuf.writeBigUInt64LE(denominationLamports);
  return PublicKey.findProgramAddressSync(
    [SEEDS.DENOMINATED_POOL, tokenMint.toBuffer(), denomBuf],
    ZK_SHIELDED_PROGRAM_ID
  );
}

export function deriveMerkleTreePDA(poolKey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.MERKLE_TREE, poolKey.toBuffer()],
    ZK_SHIELDED_PROGRAM_ID
  );
}

export function deriveNullifierPDA(
  poolKey: PublicKey,
  nullifier: Uint8Array
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.NULLIFIER, poolKey.toBuffer(), nullifier],
    ZK_SHIELDED_PROGRAM_ID
  );
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

function randomFieldElement(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let n = BigInt(0);
  for (let i = 0; i < 32; i++) {
    n = (n << BigInt(8)) | BigInt(bytes[i]);
  }
  return n % FIELD_ORDER;
}

function pubkeyToField(pubkey: PublicKey): bigint {
  const bytes = pubkey.toBytes();
  let n = BigInt(0);
  for (let i = 0; i < 32; i++) {
    n = (n << BigInt(8)) | BigInt(bytes[i]);
  }
  return n % FIELD_ORDER;
}

function bigintToBeBytes32(n: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let tmp = n;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(tmp & BigInt(0xff));
    tmp >>= BigInt(8);
  }
  return bytes;
}

function bigintToLeBytes32(n: bigint): number[] {
  const bytes: number[] = new Array(32);
  let tmp = n;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(tmp & BigInt(0xff));
    tmp >>= BigInt(8);
  }
  return bytes;
}

/** Compute the current epoch from a slot number */
export function slotToEpoch(slot: number): bigint {
  return BigInt(Math.floor(slot / SLOTS_PER_EPOCH));
}

// ---------------------------------------------------------------------------
// Commitment & nullifier
// ---------------------------------------------------------------------------

export function createCommitment(
  nullifierPreimage: bigint,
  secret: bigint,
  depositEpoch: bigint,
  tokenMint: bigint
): bigint {
  return poseidon4([nullifierPreimage, secret, depositEpoch, tokenMint]);
}

export function createNullifier(
  nullifierPreimage: bigint,
  secret: bigint
): bigint {
  return poseidon2([nullifierPreimage, secret]);
}

// ---------------------------------------------------------------------------
// Merkle tree from filledSubtrees (matches on-chain insert_with_root)
// ---------------------------------------------------------------------------

/**
 * Compute a new Merkle root after inserting a leaf, using the on-chain
 * filledSubtrees array. Returns the new root, updated subtrees, and the
 * Merkle proof for the inserted leaf.
 */
export function computeNewRootFromSubtrees(
  leaf: bigint,
  leafIndex: number,
  filledSubtrees: bigint[]
): {
  newRoot: bigint;
  updatedSubtrees: bigint[];
  pathElements: bigint[];
  pathIndices: number[];
} {
  const zeros = getZeroHashes();
  const subtrees = [...filledSubtrees];
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];

  let current = leaf;
  let idx = leafIndex;

  for (let level = 0; level < MERKLE_DEPTH; level++) {
    const isRight = idx & 1;
    pathIndices.push(isRight);

    if (isRight === 0) {
      // Inserting on the left → sibling is the zero hash for this level
      pathElements.push(zeros[level]);
      subtrees[level] = current;
      current = poseidon2([current, zeros[level]]);
    } else {
      // Inserting on the right → sibling is the filled subtree
      pathElements.push(subtrees[level]);
      current = poseidon2([subtrees[level], current]);
    }

    idx >>= 1;
  }

  return {
    newRoot: current,
    updatedSubtrees: subtrees,
    pathElements,
    pathIndices,
  };
}

// ---------------------------------------------------------------------------
// Build circuit inputs
// ---------------------------------------------------------------------------

export function buildDenominatedPoolInputs(
  receipt: ShieldReceipt,
  merkleRoot: bigint,
  pathElements: bigint[],
  pathIndices: number[],
  currentEpoch: bigint,
  epochDelay: bigint
): DenominatedPoolProofInputs {
  const nullifier = createNullifier(receipt.nullifierPreimage, receipt.secret);
  const minEpoch = currentEpoch - epochDelay;

  return {
    merkle_root: merkleRoot.toString(),
    nullifier: nullifier.toString(),
    min_epoch: minEpoch.toString(),
    token_mint: receipt.tokenMint.toString(),
    secret: receipt.secret.toString(),
    nullifier_preimage: receipt.nullifierPreimage.toString(),
    deposit_epoch: receipt.depositEpoch.toString(),
    path_elements: pathElements.map((e) => e.toString()),
    path_indices: pathIndices.map((i) => i.toString()),
  };
}

// ---------------------------------------------------------------------------
// Shield (deposit) — no ZK proof needed
// ---------------------------------------------------------------------------

/**
 * Create a shield receipt and compute the new Merkle root.
 * The caller must build and send the transaction.
 */
export async function prepareShield(
  connection: Connection,
  tokenMint: PublicKey,
  denominationLamports: bigint,
  poolPDA: PublicKey
): Promise<{
  receipt: ShieldReceipt;
  commitment: bigint;
  newRoot: bigint;
  commitmentBytes: number[];
  newRootBytes: number[];
}> {
  const slot = await connection.getSlot('confirmed');
  const depositEpoch = slotToEpoch(slot);
  const tokenMintField = pubkeyToField(tokenMint);

  const secret = randomFieldElement();
  const nullifierPreimage = randomFieldElement();

  const commitment = createCommitment(
    nullifierPreimage,
    secret,
    depositEpoch,
    tokenMintField
  );

  // Read on-chain Merkle tree state
  const [treePDA] = deriveMerkleTreePDA(poolPDA);
  const treeAccount = await connection.getAccountInfo(treePDA);
  if (!treeAccount) throw new Error('Merkle tree account not found');

  // Parse filledSubtrees from account data
  // Account layout: 8 (disc) + 32 (pool) + 32 (root) + 8 (leaf_count) + 1 (depth) + 4 (vec len) + N*32 (subtrees) + 1 (bump)
  const data = treeAccount.data;
  const leafCount = Number(data.readBigUInt64LE(8 + 32 + 32));
  const depth = data[8 + 32 + 32 + 8];
  const vecLen = data.readUInt32LE(8 + 32 + 32 + 8 + 1);

  const filledSubtrees: bigint[] = [];
  let offset = 8 + 32 + 32 + 8 + 1 + 4;
  for (let i = 0; i < vecLen; i++) {
    let val = BigInt(0);
    // Read 32 bytes LE
    for (let b = 31; b >= 0; b--) {
      val = (val << BigInt(8)) | BigInt(data[offset + b]);
    }
    filledSubtrees.push(val);
    offset += 32;
  }

  const { newRoot, updatedSubtrees, pathElements, pathIndices } =
    computeNewRootFromSubtrees(commitment, leafCount, filledSubtrees);

  const receipt: ShieldReceipt = {
    secret,
    nullifierPreimage,
    depositEpoch,
    tokenMint: tokenMintField,
    commitment,
    leafIndex: leafCount,
    denomination: denominationLamports,
    pool: poolPDA.toBase58(),
    merklePathElements: pathElements,
    merklePathIndices: pathIndices,
    merkleRoot: newRoot,
  };

  return {
    receipt,
    commitment,
    newRoot,
    commitmentBytes: bigintToLeBytes32(commitment),
    newRootBytes: bigintToLeBytes32(newRoot),
  };
}

// ---------------------------------------------------------------------------
// Unshield (withdraw) — client-side ZK proof
// ---------------------------------------------------------------------------

/**
 * Build circuit inputs for unshield and generate a client-side proof.
 * The prover must have the denominated_pool circuit loaded.
 *
 * @param prover - ClientProver instance with denominated_pool circuit loaded
 * @param receipt - The shield receipt from deposit time
 * @param connection - Solana connection for slot lookup
 * @param epochDelay - The pool's epoch_delay value
 * @returns Proof + public signals for the unshield transaction
 */
export async function prepareUnshield(
  receipt: ShieldReceipt,
  connection: Connection,
  epochDelay: bigint
): Promise<{
  circuitInputs: DenominatedPoolProofInputs;
  nullifier: bigint;
  nullifierBytes: Uint8Array;
  merkleRootBytes: number[];
  minEpoch: bigint;
}> {
  if (!receipt.merklePathElements || !receipt.merklePathIndices || !receipt.merkleRoot) {
    throw new Error(
      'Receipt missing Merkle proof. Was this note shielded with proof saving?'
    );
  }

  const slot = await connection.getSlot('confirmed');
  const currentEpoch = slotToEpoch(slot);
  const nullifier = createNullifier(receipt.nullifierPreimage, receipt.secret);
  const minEpoch = currentEpoch - epochDelay;

  // Verify the note is old enough
  if (receipt.depositEpoch > minEpoch) {
    const remaining = Number(receipt.depositEpoch - minEpoch + BigInt(1));
    throw new Error(
      `Note not mature yet. Deposited epoch ${receipt.depositEpoch}, ` +
        `need <= ${minEpoch}. Wait ~${remaining} more epoch(s).`
    );
  }

  const circuitInputs = buildDenominatedPoolInputs(
    receipt,
    receipt.merkleRoot,
    receipt.merklePathElements,
    receipt.merklePathIndices,
    currentEpoch,
    epochDelay
  );

  return {
    circuitInputs,
    nullifier,
    nullifierBytes: bigintToBeBytes32(nullifier),
    merkleRootBytes: bigintToLeBytes32(receipt.merkleRoot),
    minEpoch,
  };
}

// ---------------------------------------------------------------------------
// Receipt serialization (for persistence)
// ---------------------------------------------------------------------------

export function receiptToJSON(receipt: ShieldReceipt): string {
  return JSON.stringify({
    secret: receipt.secret.toString(),
    nullifierPreimage: receipt.nullifierPreimage.toString(),
    depositEpoch: receipt.depositEpoch.toString(),
    tokenMint: receipt.tokenMint.toString(),
    commitment: receipt.commitment.toString(),
    leafIndex: receipt.leafIndex,
    denomination: receipt.denomination.toString(),
    pool: receipt.pool,
    merklePathElements: receipt.merklePathElements?.map((e) => e.toString()),
    merklePathIndices: receipt.merklePathIndices,
    merkleRoot: receipt.merkleRoot?.toString(),
  });
}

export function receiptFromJSON(json: string): ShieldReceipt {
  const obj = JSON.parse(json);
  return {
    secret: BigInt(obj.secret),
    nullifierPreimage: BigInt(obj.nullifierPreimage),
    depositEpoch: BigInt(obj.depositEpoch),
    tokenMint: BigInt(obj.tokenMint),
    commitment: BigInt(obj.commitment),
    leafIndex: obj.leafIndex,
    denomination: BigInt(obj.denomination),
    pool: obj.pool,
    merklePathElements: obj.merklePathElements?.map((e: string) => BigInt(e)),
    merklePathIndices: obj.merklePathIndices,
    merkleRoot: obj.merkleRoot ? BigInt(obj.merkleRoot) : undefined,
  };
}
