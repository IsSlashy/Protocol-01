/**
 * MPC Hidden Nullifier Commitment — prevents on-chain nullifier linkage.
 *
 * Standard flow: nullifier PDA derived from Poseidon hash → visible on-chain
 *   → observer can track which notes are spent and correlate withdrawals
 *
 * MPC flow: encrypt(nullifier) → MPC computes SHA3 commitment → only
 *   the commitment goes on-chain (not the nullifier itself). MPC maintains
 *   an encrypted spent-set to prevent double-spend.
 *
 * Falls back to standard (public) nullifier PDA when MPC is unavailable.
 */

import { PublicKey } from '@solana/web3.js';
import { getMpcClient, getArciumProgram, isMpcClientReady } from './mpcClient';
import { useArciumStore } from '../../stores/arciumStore';

export interface NullifierResult {
  /** For standard: nullifier PDA. For MPC: commitment PDA */
  nullifierAddress: PublicKey;
  /** The nullifier bytes (for standard) or commitment bytes (for MPC) */
  identifier: Uint8Array;
  /** Whether MPC was used */
  wasMpcProtected: boolean;
  /** MPC computation signature (only if MPC was used) */
  mpcSignature?: string;
}

/**
 * Commit a nullifier — either via MPC (hidden) or standard (public PDA).
 *
 * @param poolPDA - The denomination pool's PDA
 * @param nullifierBytes - The computed nullifier (32 bytes, LE)
 * @param programId - The zk_shielded program ID
 */
export async function commitNullifier(
  poolPDA: PublicKey,
  nullifierBytes: Uint8Array,
  programId: PublicKey
): Promise<NullifierResult> {
  const { mpcEnabled } = useArciumStore.getState();

  if (mpcEnabled && isMpcClientReady()) {
    try {
      return await mpcCommitNullifier(poolPDA, nullifierBytes, programId);
    } catch (e: any) {
      console.warn('[MPC] Nullifier commit failed, using standard PDA:', e.message);
    }
  }

  return standardNullifierPDA(poolPDA, nullifierBytes, programId);
}

/**
 * Check if a nullifier has been spent — MPC or standard.
 */
export async function checkNullifierSpent(
  poolPDA: PublicKey,
  nullifierBytes: Uint8Array,
  programId: PublicKey,
  connection: any
): Promise<{ isSpent: boolean; wasMpcProtected: boolean }> {
  const { mpcEnabled } = useArciumStore.getState();

  if (mpcEnabled && isMpcClientReady()) {
    try {
      return await mpcCheckNullifier(poolPDA, nullifierBytes);
    } catch (e: any) {
      console.warn('[MPC] Nullifier check failed, using standard:', e.message);
    }
  }

  // Standard: check if PDA account exists on-chain
  const [nullifierPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('nullifier'), poolPDA.toBuffer(), Buffer.from(nullifierBytes)],
    programId
  );
  const info = await connection.getAccountInfo(nullifierPDA);
  return { isSpent: info !== null, wasMpcProtected: false };
}

/**
 * MPC hidden nullifier commitment.
 * Encrypts nullifier → MPC computes SHA3 commitment → commitment on-chain.
 */
async function mpcCommitNullifier(
  poolPDA: PublicKey,
  nullifierBytes: Uint8Array,
  programId: PublicKey
): Promise<NullifierResult> {
  const client = await getMpcClient();
  const program = await getArciumProgram();
  if (!client || !program) throw new Error('MPC client not ready');

  const { commitNullifier: sdkCommit, getNullifierCommitmentAddress } = await import(
    '@protocol-01/arcium-sdk'
  );

  const poolId = poolPDA.toBuffer();
  const result = await sdkCommit(client, program, poolId, nullifierBytes);

  const [commitmentPDA] = getNullifierCommitmentAddress(
    client.programId,
    result.commitment
  );

  return {
    nullifierAddress: commitmentPDA,
    identifier: result.commitment,
    wasMpcProtected: true,
    mpcSignature: result.signature,
  };
}

/**
 * MPC nullifier spent check — without revealing which nullifier.
 */
async function mpcCheckNullifier(
  poolPDA: PublicKey,
  nullifierBytes: Uint8Array
): Promise<{ isSpent: boolean; wasMpcProtected: boolean }> {
  const client = await getMpcClient();
  const program = await getArciumProgram();
  if (!client || !program) throw new Error('MPC client not ready');

  const { checkNullifierSpent: sdkCheck } = await import('@protocol-01/arcium-sdk');
  const poolId = poolPDA.toBuffer();
  const result = await sdkCheck(client, program, poolId, nullifierBytes);

  return { isSpent: result.isSpent, wasMpcProtected: true };
}

/**
 * Standard nullifier PDA (public, linkable).
 * Derives PDA from pool + nullifier bytes → exists on-chain if note is spent.
 */
function standardNullifierPDA(
  poolPDA: PublicKey,
  nullifierBytes: Uint8Array,
  programId: PublicKey
): NullifierResult {
  const [nullifierPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('nullifier'), poolPDA.toBuffer(), Buffer.from(nullifierBytes)],
    programId
  );

  return {
    nullifierAddress: nullifierPDA,
    identifier: nullifierBytes,
    wasMpcProtected: false,
  };
}
