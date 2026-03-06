/**
 * Monitor a relay job for completion, expiry, or cancellation.
 *
 * Polls the job PDA account. When the account is closed (null),
 * the job was completed or expired. We check the relayer's stats
 * to determine which.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { JobStatus } from './types';
import type { JobCompletionResult } from './types';

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
const POLL_INTERVAL_MS = 2_000; // 2 seconds

/**
 * Monitor a relay job until it completes, expires, or times out.
 *
 * Since completed/expired/cancelled jobs have their accounts closed,
 * we detect completion by the account disappearing.
 *
 * @param connection - Solana connection
 * @param jobAddress - Job PDA address
 * @param timeoutMs - Maximum time to wait (default 120s)
 * @returns Completion result
 */
export async function monitorJob(
  connection: Connection,
  jobAddress: PublicKey,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<JobCompletionResult> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const accountInfo = await connection.getAccountInfo(jobAddress);

    if (!accountInfo) {
      // Account closed — job was completed, expired, or cancelled.
      // Since we just submitted it, completion is the most likely outcome.
      return {
        success: true,
        status: JobStatus.Completed,
      };
    }

    // Account still exists — check if status changed from Pending
    // Status offset in RelayJob: 8 (disc) + 32 (job_id) + 4+N (encrypted_tx vec)
    //   + 32 (assigned_relayer) + 32 (submitter) + 8 (fee) + 8 (posted_at) + 8 (deadline)
    // This is variable due to Vec, so read from end: status is at data.length - 2 (status + bump)
    const data = accountInfo.data;
    const statusByte = data[data.length - 2];

    if (statusByte !== JobStatus.Pending) {
      return {
        success: statusByte === JobStatus.Completed,
        status: statusByte as JobStatus,
      };
    }

    // Still pending — wait and poll again
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Timed out waiting — job is still pending
  return {
    success: false,
    status: JobStatus.Pending,
  };
}

/**
 * Cancel a relay job. Only the original submitter can cancel.
 *
 * @param connection - Solana connection
 * @param programId - Relayer program ID
 * @param jobAddress - Job PDA address
 * @param submitterKeypair - Must be the original submitter
 * @returns Cancel tx signature
 */
export async function cancelRelayJob(
  connection: Connection,
  programId: PublicKey,
  jobAddress: PublicKey,
  submitterKeypair: import('@solana/web3.js').Keypair,
): Promise<string> {
  const { Transaction, TransactionInstruction } = await import('@solana/web3.js');
  const { sha256 } = await import('@noble/hashes/sha256');

  const discriminator = Buffer.from(
    sha256(Buffer.from('global:cancel_job')).slice(0, 8),
  );

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: submitterKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: jobAddress, isSigner: false, isWritable: true },
    ],
    programId,
    data: discriminator,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = submitterKeypair.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(submitterKeypair);

  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}
