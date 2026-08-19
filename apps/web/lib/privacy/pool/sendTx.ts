import type { Connection, PublicKey, Transaction } from '@solana/web3.js';

/**
 * Send a transaction with a blockhash every node agrees on, and retry the one
 * failure that looks like a program bug and is not.
 *
 * 🚨 WHY THIS EXISTS AS A SHARED HELPER RATHER THAN A PATTERN.
 *
 * On 2026-08-18 `stark.ts` was fixed for "Transaction simulation failed:
 * Blockhash not found. Logs: []" and the fix stopped at that one file. On
 * 2026-08-19 the identical failure came back from `/api/fund-ephemeral`, which
 * is the FIRST on-chain step of a deposit — so the bug had not been fixed, it
 * had been narrowed to whichever send the user reached next. Eight call sites
 * carried it. A copied fix does not spread; a helper does.
 *
 * THE TWO CAUSES, WHICH PRODUCE THE SAME MESSAGE
 * ──────────────────────────────────────────────
 * 1. A `confirmed` blockhash is known to the node that issued it and not yet to
 *    its neighbours. Every request here goes through a load-balanced provider,
 *    so the node asked to run PREFLIGHT is routinely not the node that issued
 *    the blockhash, and it rejects a perfectly valid transaction. `finalized`
 *    is known to every node, at the cost of ~13s of its ~60s validity — ample
 *    for a send that happens on the next line.
 * 2. Under a paced or rate-limited transport, the gap between fetching the
 *    blockhash and sending can outlive it. Refetching is the only correct
 *    response and costs one round trip.
 *
 * ⚠️ THE SIGNATURE COVERS THE BLOCKHASH, so every attempt re-signs. A retry
 * that reuses the previous signature is rejected for a different reason, and
 * the real one is never seen.
 *
 * ⛔ Only "blockhash not found" is retried. Every other rejection — insufficient
 * funds, a failing instruction, a bad account — is thrown on the first attempt,
 * because retrying those hides a real defect behind a delay.
 */

const DEFAULT_ATTEMPTS = 3;
const RETRY_PAUSE_MS = 1500;

export interface SendResult {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

export async function sendWithFreshBlockhash(
  connection: Connection,
  tx: Transaction,
  /**
   * Signs `tx` and returns the signed transaction. Called once per attempt,
   * AFTER `recentBlockhash` and `feePayer` are set. A keypair caller can do
   * `(t) => { t.sign(kp); return t; }`; a wallet caller passes its
   * `signTransaction`.
   */
  sign: (tx: Transaction) => Promise<Transaction> | Transaction,
  feePayer: PublicKey,
  opts?: { skipPreflight?: boolean; attempts?: number },
): Promise<SendResult> {
  const attempts = opts?.attempts ?? DEFAULT_ATTEMPTS;
  let lastErr: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash('finalized');
    tx.recentBlockhash = blockhash;
    tx.feePayer = feePayer;
    const signed = await sign(tx);
    try {
      const signature = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: opts?.skipPreflight ?? false,
      });
      return { signature, blockhash, lastValidBlockHeight };
    } catch (e) {
      lastErr = e;
      if (!/blockhash not found/i.test((e as Error)?.message ?? '')) throw e;
      // Give the provider a moment to agree with itself before asking again.
      await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error('Transaction could not be sent: blockhash never settled.');
}
