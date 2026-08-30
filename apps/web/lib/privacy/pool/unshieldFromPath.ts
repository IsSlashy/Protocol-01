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
  C3_SUBTREE_DEPTH,
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

  // Heartbeat across BOTH proofs. The main thread re-arms its request timeout
  // on every progress message, so a silent stretch longer than that timeout
  // kills a job that is working fine. Loading the prover and running two
  // proofs is the longest silence on this path, and the coset blob (229,640
  // bytes against 213,254) made it longer. Measured in production 2026-08-05:
  // a shield died this way on the sibling path.
  //
  // Elapsed seconds, not a percentage: nothing here can measure its own
  // progress, and a bar moving on a dead prover would be worse than none.
  const proofStartedAt = Date.now();
  let stage = 'Proving you own the note';
  const proofHeartbeat = setInterval(() => {
    const seconds = Math.round((Date.now() - proofStartedAt) / 1000);
    onProgress?.(`${stage} (${seconds}s)...`);
  }, 10_000);
  let c1Raw, c3Raw;
  try {
    await starkProver.start();

    onProgress?.('Generating C1 (pool_commitment) STARK proof...');
    c1Raw = await starkProver.generatePoolCommitmentProof(
    receipt.nullifierPreimage.toString(),
    receipt.secret.toString(),
    // Commitment's third slot — a PRF blinding for new notes, a real epoch for
    // legacy ones. Private witness either way (C1 publishes only
    // [nullifier, commitment]).
    receipt.noteBlinding.toString(),
      receipt.tokenMint.toString(),
    );

    stage = 'Proving the note is in the pool';
    onProgress?.('Generating C3 (merkle_path) STARK proof from the stored path...');
    // [C3-D11] The circuit proves the bottom ELEVEN levels; the instruction
    // walks the remaining four. Handing the prover the full stored path panics
    // inside the wasm, mid-proof.
    //
    // 🚨 THIS FILE WAS MISSED when C3 was first cut on 2026-08-29 — it is a
    // SECOND construction site for `PrepareUnshieldResult`, and it is the one
    // the silent C1+C3 fallback reaches.
    if (path.pathElements.length < C3_SUBTREE_DEPTH) {
      throw new Error(
        `Stored Merkle path has ${path.pathElements.length} elements, need at least ` +
        `${C3_SUBTREE_DEPTH} for the C3 circuit.`,
      );
    }
    c3Raw = await starkProver.generateMerklePathProof(
      receipt.commitment.toString(),
      path.pathElements.slice(0, C3_SUBTREE_DEPTH),
      path.pathIndices.slice(0, C3_SUBTREE_DEPTH),
    );
  } finally {
    clearInterval(proofHeartbeat);
  }

  const c1PublicInputs = c1Raw.publicInputs.map((s) => BigInt(s));
  const c3PublicInputs = c3Raw.publicInputs.map((s) => BigInt(s));

  // 🚨 THIS COMPARED THE PROOF'S ROOT TO THE STORED POOL ROOT. Since the depth
  // cut `c3PublicInputs[1]` is a SUBTREE root, so the comparison could never
  // hold again and this branch would have refused every note it was built for.
  //
  // The staleness check it performed is still worth having, so it moves to a
  // form that survives: the DEPTH the prover actually proved must be the depth
  // this client sliced for. A stale wasm blob is the failure it now names, and
  // that is the failure most likely to be real.
  const subtreeRoot = c3PublicInputs[1] ?? 0n;
  if (c3PublicInputs[2] !== BigInt(C3_SUBTREE_DEPTH)) {
    throw new Error(
      `C3 proved depth ${c3PublicInputs[2]}, expected ${C3_SUBTREE_DEPTH}. The shipped ` +
      `wasm prover is stale — it predates the depth cut, and the on-chain verifier ` +
      `rejects every proof it makes. Reship the blob.`,
    );
  }

  // The stored path's own root is the POOL root, and `isRootAccepted` above has
  // already checked it against the pool's ring — which is the check the removed
  // comparison was really standing in for.
  const siblings = path.pathElements.slice(C3_SUBTREE_DEPTH).map((e) => BigInt(e));
  const directions = path.pathIndices.slice(C3_SUBTREE_DEPTH);

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
    merkleRoot: storedRoot,
    subtreeRoot,
    siblings,
    directions,
    nullifierGoldilocks: c1PublicInputs[0] ?? 0n,
    starkCommitment: c1PublicInputs[1] ?? 0n,
  };
}
