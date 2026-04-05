import { PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { ArciumClient, CIRCUITS, type EncryptedPayload } from '../client';

/**
 * UC4: Confidential Balance Audit -- Solvency Proofs
 *
 * Users submit encrypted balances via MPC, which sums them without
 * revealing individual amounts. The aggregate total is revealed only
 * when the audit authority finalizes.
 *
 * Use cases: compliance/solvency proofs, pool TVL calculation without
 * leaking depositor amounts, aggregate analytics with individual privacy.
 *
 * **Inputs**: Encrypted balance (u64 lamports), audit ID.
 * **Output**: Aggregate total balance across all submissions.
 *
 * @module audit
 */

/** A single encrypted balance submission for an audit round. */
export interface AuditSubmission {
  /** First ciphertext block of the encrypted balance. */
  encryptedBalance: number[];
  /** Wallet that submitted this balance. */
  submitter: PublicKey;
  /** Full encryption payload (ciphertexts, ephemeral key, nonce). */
  payload: EncryptedPayload;
}

/** Finalized audit result with the revealed aggregate total. */
export interface AuditResult {
  /** Aggregate balance across all submissions (plaintext -- auditor can see). */
  totalBalance: bigint;
  /** Number of individual accounts included in the audit. */
  accountCount: number;
  /** Finalization callback transaction signature. */
  signature: string;
}

/** PDA seed for the audit accumulator account */
const AUDIT_SEED = 'p01_audit';

/**
 * Derive the audit accumulator PDA
 * Stores encrypted running total in MXE-encrypted state
 */
export function getAuditAccumulatorAddress(
  programId: PublicKey,
  auditId: Uint8Array
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(AUDIT_SEED), auditId],
    programId
  );
}

/**
 * Submit an encrypted balance for confidential audit.
 *
 * The balance is encrypted with the Arcium shared secret and added to
 * the MPC accumulator. Individual balances are never decrypted; only the
 * aggregate total is revealed when the audit authority calls {@link finalizeAudit}.
 *
 * @param client - Initialized {@link ArciumClient}.
 * @param program - Anchor program instance for `p01_arcium`.
 * @param auditId - Unique identifier for this audit round.
 * @param balanceLamports - The balance to submit (in lamports).
 * @returns Computation offset and submission details for tracking.
 * @throws {Error} "Audit MPC computation failed: ..." if submission fails.
 */
export async function submitBalanceForAudit(
  client: ArciumClient,
  program: anchor.Program,
  auditId: Uint8Array,
  balanceLamports: bigint
): Promise<{ computationOffset: anchor.BN; submission: AuditSubmission }> {
  const payload = client.encrypt([balanceLamports]);
  const computationOffset = client.newComputationOffset();
  const accounts = client.getComputationAccounts(CIRCUITS.BALANCE_AUDIT, computationOffset);

  const [accumulatorAddress] = getAuditAccumulatorAddress(client.programId, auditId);

  try {
    await program.methods
      .submitBalanceAudit(
        computationOffset,
        Array.from(payload.ciphertexts[0]),
        Array.from(payload.publicKey),
        client.nonceToU128(payload.nonce),
        Array.from(auditId)
      )
      .accountsPartial({
        ...accounts,
        auditAccumulator: accumulatorAddress,
        payer: client.wallet.publicKey,
      })
      .rpc({ commitment: 'confirmed' });
  } catch (err) {
    throw new Error(
      `Audit MPC computation failed: ${err instanceof Error ? err.message : String(err)}. ` +
      'This may indicate the Arcium cluster is unavailable or the circuit inputs are invalid.'
    );
  }

  return {
    computationOffset,
    submission: {
      encryptedBalance: payload.ciphertexts[0],
      submitter: client.wallet.publicKey,
      payload,
    },
  };
}

/**
 * Finalize the audit and reveal the aggregate total.
 *
 * Only callable by the audit authority. Triggers threshold decryption
 * of the MPC accumulator, revealing the sum of all submitted balances.
 *
 * @param client - Initialized {@link ArciumClient}.
 * @param program - Anchor program instance for `p01_arcium`.
 * @param auditId - The audit round to finalize.
 * @returns The revealed aggregate total and finalization signature.
 * @throws {Error} "Audit MPC computation failed: ..." if finalization fails.
 */
export async function finalizeAudit(
  client: ArciumClient,
  program: anchor.Program,
  auditId: Uint8Array
): Promise<AuditResult> {
  const computationOffset = client.newComputationOffset();
  const accounts = client.getComputationAccounts(CIRCUITS.BALANCE_AUDIT, computationOffset);
  const [accumulatorAddress] = getAuditAccumulatorAddress(client.programId, auditId);

  let sig: string;
  try {
    await program.methods
      .finalizeAudit(computationOffset, Array.from(auditId))
      .accountsPartial({
        ...accounts,
        auditAccumulator: accumulatorAddress,
        authority: client.wallet.publicKey,
      })
      .rpc({ commitment: 'confirmed' });

    // Wait for MPC to return the result
    sig = await client.awaitFinalization(computationOffset);
  } catch (err) {
    throw new Error(
      `Audit MPC computation failed: ${err instanceof Error ? err.message : String(err)}. ` +
      'This may indicate the Arcium cluster is unavailable or the circuit inputs are invalid.'
    );
  }

  // The callback emits an event with the revealed total
  // Parse from transaction logs
  const tx = await client.connection.getTransaction(sig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  const logs = tx?.meta?.logMessages || [];
  const totalLine = logs.find((l) => l.includes('AuditTotal:'));
  const total = totalLine ? BigInt(totalLine.split('AuditTotal:')[1].trim()) : 0n;

  return {
    totalBalance: total,
    accountCount: 0, // parsed from accumulator account
    signature: sig,
  };
}
