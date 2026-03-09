import { PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { ArciumClient, CIRCUITS, type EncryptedPayload } from '../client';

/**
 * UC4: Confidential Balance Audit
 *
 * Users submit encrypted balances → MPC sums them → returns total
 * without revealing individual amounts. Useful for:
 * - Compliance/solvency proofs
 * - Pool TVL calculation without leaking depositor amounts
 * - Aggregate analytics with individual privacy
 */

export interface AuditSubmission {
  /** Encrypted balance (lamports as u64) */
  encryptedBalance: number[];
  /** Submitter's public key (for attribution) */
  submitter: PublicKey;
  /** Encryption public key + nonce */
  payload: EncryptedPayload;
}

export interface AuditResult {
  /** Total balance across all submissions (plaintext — auditor can see) */
  totalBalance: bigint;
  /** Number of accounts included */
  accountCount: number;
  /** Computation signature for on-chain verification */
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
 * Flow:
 * 1. User encrypts their balance with Arcium shared secret
 * 2. Submits to P01 Arcium program
 * 3. Program CPIs to Arcium → queues MPC computation
 * 4. MPC adds encrypted balance to running total (never decrypts individual)
 * 5. When audit finalizes, total is revealed via threshold decryption
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
 * Finalize the audit — triggers threshold reveal of total.
 * Only the audit authority can call this.
 */
export async function finalizeAudit(
  client: ArciumClient,
  program: anchor.Program,
  auditId: Uint8Array
): Promise<AuditResult> {
  const computationOffset = client.newComputationOffset();
  const accounts = client.getComputationAccounts(CIRCUITS.BALANCE_AUDIT, computationOffset);
  const [accumulatorAddress] = getAuditAccumulatorAddress(client.programId, auditId);

  await program.methods
    .finalizeAudit(computationOffset, Array.from(auditId))
    .accountsPartial({
      ...accounts,
      auditAccumulator: accumulatorAddress,
      authority: client.wallet.publicKey,
    })
    .rpc({ commitment: 'confirmed' });

  // Wait for MPC to return the result
  const sig = await client.awaitFinalization(computationOffset);

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
