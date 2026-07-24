/**
 * unshieldFromPath — withdraw using the Merkle path captured at shield time,
 * instead of rebuilding the tree from transaction history.
 *
 * WHY
 * ───
 * `prepareUnshield` reconstructs every leaf by walking the pool's transaction
 * history (`fetchPoolLeavesByIndex`). That makes withdrawal depend on an RPC
 * that still serves that history — public devnet RPC serves one signature for a
 * pool with 30 leaves, so a note there simply cannot be withdrawn.
 *
 * But a shield already computes the exact witness a withdrawal needs: the
 * siblings folding its own leaf up to the root, and that root is the pool's
 * current root at that moment, which then enters the historical ring
 * (`DenominatedPoolV3::MAX_HISTORICAL_ROOTS = 100`, `pool_v3.rs:185`). The
 * on-chain handler accepts any root in that ring. So storing the path at shield
 * time lets a withdrawal prove membership with no history at all — until 100
 * further deposits push that root out of the ring, at which point we fall back.
 *
 * This only replaces where the C3 witness comes from. The proofs, public
 * inputs, and the instruction are byte-identical to the history-based path.
 */

import type { Connection } from '@solana/web3.js';

import {
  CIRCUIT_MERKLE_PATH,
  goldilocksToLeBytes32,
  type PoolConfig,
  type PrepareUnshieldResult,
  type ShieldReceipt,
} from './denominatedPool';
import { starkProver } from './starkProver';

/** The witness a shield captured for its own leaf. */
export interface StoredMerklePath {
  pathElements: string[];
  pathIndices: number[];
  /** Root this path folds to — must still be in the pool's historical ring. */
  root: string;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Is `root` still one the pool will accept? Reads the pool account's current
 * root plus its historical ring.
 *
 * Layout mirrors `parsePoolV3Account` in denominatedPool.ts: 88..120 current
 * root, 178..182 u32 ring length, 182.. the ring entries.
 */
export async function isRootAccepted(
  connection: Connection,
  poolConfig: PoolConfig,
  root: bigint,
): Promise<boolean> {
  const info = await connection.getAccountInfo(poolConfig.poolPDA, 'confirmed');
  if (!info) return false;
  const data = new Uint8Array(info.data);
  if (data.length < 182) return false;

  const target = new Uint8Array(goldilocksToLeBytes32(root));
  if (bytesEqual(target, data.slice(88, 120))) return true;

  const ringLen = data[178] | (data[179] << 8) | (data[180] << 16) | (data[181] << 24);
  if (ringLen > 100 || data.length < 182 + ringLen * 32) return false;
  for (let i = 0; i < ringLen; i++) {
    if (bytesEqual(target, data.slice(182 + i * 32, 182 + i * 32 + 32))) return true;
  }
  return false;
}

/**
 * Build the C1 + C3 proofs from a stored path. Returns null when the stored
 * root has aged out of the ring, so the caller can fall back to the
 * history-based `prepareUnshield` rather than burning proof rent on a root the
 * program will reject.
 */
export async function prepareUnshieldFromPath(
  receipt: ShieldReceipt,
  poolConfig: PoolConfig,
  connection: Connection,
  path: StoredMerklePath,
  onProgress?: (step: string) => void,
): Promise<PrepareUnshieldResult | null> {
  const storedRoot = BigInt(path.root);

  onProgress?.('Checking the stored Merkle root is still accepted...');
  if (!(await isRootAccepted(connection, poolConfig, storedRoot))) {
    return null;
  }

  await starkProver.start();

  onProgress?.('Generating C1 (pool_commitment) STARK proof...');
  const c1Raw = await starkProver.generatePoolCommitmentProof(
    receipt.nullifierPreimage.toString(),
    receipt.secret.toString(),
    receipt.depositEpoch.toString(),
    receipt.tokenMint.toString(),
  );

  onProgress?.('Generating C3 (merkle_path) STARK proof from the stored path...');
  const c3Raw = await starkProver.generateMerklePathProof(
    receipt.commitment.toString(),
    path.pathElements,
    path.pathIndices,
  );

  const c1PublicInputs = c1Raw.publicInputs.map((s) => BigInt(s));
  const c3PublicInputs = c3Raw.publicInputs.map((s) => BigInt(s));

  // The proof's own root must equal the stored one; if the path were stale or
  // corrupted the on-chain root check would fail after we had already paid for
  // the upload.
  const provenRoot = c3PublicInputs[1] ?? 0n;
  if (provenRoot !== storedRoot) {
    throw new Error(
      `Stored Merkle path does not reproduce its root (${provenRoot} vs ${storedRoot}). ` +
        'Falling back to a full history rebuild is required for this note.',
    );
  }

  void CIRCUIT_MERKLE_PATH;
  return {
    c1ProofResult: {
      proofBytes: hexToBytes(c1Raw.proofHex),
      publicInputs: c1PublicInputs,
      proofSize: c1Raw.proofSize,
    },
    c3ProofResult: {
      proofBytes: hexToBytes(c3Raw.proofHex),
      publicInputs: c3PublicInputs,
      proofSize: c3Raw.proofSize,
    },
    merkleRoot: provenRoot,
    nullifierGoldilocks: c1PublicInputs[0] ?? 0n,
    starkCommitment: c1PublicInputs[1] ?? 0n,
  };
}
