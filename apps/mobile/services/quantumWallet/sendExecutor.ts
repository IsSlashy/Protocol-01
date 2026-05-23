/**
 * FIFO send executor for the quantum wallet.
 *
 * Optimistic flow:
 *   1. UI calls `quantumWalletStore.enqueueSend(recipient, amount)` →
 *      synchronous: pendingTransactions[] += entry, balance -= amount,
 *      drainQueue() fires.
 *   2. drainQueue() works one entry at a time. For each:
 *        a. Ensure auth proof is fresh (call buildAndSubmitAuthProof if not).
 *        b. Build + sign withdraw ix. expected_nonce = walletStore on-chain
 *           nonce + count of already-confirmed sends since fetch.
 *        c. Send tx, confirm.
 *        d. On success: pending entry → 'confirmed', remove after 5s.
 *        e. On failure: balance += amount (rollback), pending entry → 'failed',
 *           surface error.
 *   3. Next entry processes.
 *
 * Concurrency safety:
 *   - Single-threaded loop guarded by `isProcessing` ref in the store.
 *   - The on-chain nonce is the source of truth — we track our optimistic
 *     `pendingNonceDelta` only to build ix data correctly; reconciliation
 *     happens on every confirm via `getAccountInfo`.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { buildWithdrawIx } from './index';
import { AuthProofRecord } from './authProof';
import type { WalletSigner } from './signer';

export interface SendIntent {
  /** Stable client-generated id (uuid). */
  id: string;
  recipient: PublicKey;
  amountLamports: number;
}

export interface SendResult {
  txSignature: string;
}

/** Execute a single send against the quantum wallet. Mutates nothing in the
 *  store; the caller is responsible for state transitions. */
export async function executeSend(args: {
  connection: Connection;
  intent: SendIntent;
  signer: WalletSigner;
  authProof: AuthProofRecord;
  expectedNonce: bigint;
}): Promise<SendResult> {
  const ix = buildWithdrawIx({
    payer: args.signer.publicKey,
    ownerId: args.signer.publicKey,
    recipient: args.intent.recipient,
    proofBuffer: args.authProof.proofBuffer,
    amount: args.intent.amountLamports,
    expectedNonce: args.expectedNonce,
  });

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }))
    .add(ix);
  const { blockhash } = await args.connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = args.signer.publicKey;
  const signed = await args.signer.signTransaction(tx);

  const sig = await args.connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  await args.connection.confirmTransaction(sig, 'confirmed');
  return { txSignature: sig };
}
