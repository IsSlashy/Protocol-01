/**
 * pollingConfirm — replace a Connection's WebSocket-based confirmation with
 * plain status polling.
 *
 * web3.js `confirmTransaction` subscribes to the signature over a WebSocket and
 * only falls back to "wait until the blockhash's block height is exceeded" if
 * the subscription never fires. Inside a Web Worker that subscription client
 * throws `window is not defined`, so every confirmation silently took the
 * fallback path: measured 2026-07-24, each buffer resize took a uniform ~58s
 * (one blockhash lifetime) instead of a couple of seconds. A shield does ~14 of
 * them back to back, so this alone cost ~13 minutes per shield.
 *
 * Polling `getSignatureStatuses` is what the confirmation actually needs, works
 * in a Worker, and reuses the paced fetch. The signature-only and
 * blockhash-strategy call shapes are both supported, since the extracted proof
 * code uses both.
 */

import type { Connection } from '@solana/web3.js';

const POLL_INTERVAL_MS = 1_500;

/** Ceiling per confirmation, in case a transaction is simply dropped. */
const MAX_WAIT_MS = 90_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ConfirmArgs = Parameters<Connection['confirmTransaction']>;

/**
 * Patch `confirmTransaction` on this Connection instance. Every caller that
 * shares the instance — including the extracted STARK upload code, which we do
 * not want to edit — gets the polling behaviour.
 */
export function usePollingConfirmation(connection: Connection): Connection {
  const conn = connection as Connection & { __p01Polling?: boolean };
  if (conn.__p01Polling) return connection;
  conn.__p01Polling = true;

  conn.confirmTransaction = (async (...args: ConfirmArgs) => {
    const [strategy, commitment] = args;
    const signature =
      typeof strategy === 'string' ? strategy : (strategy as { signature: string }).signature;
    const wanted = commitment ?? 'confirmed';

    const start = Date.now();
    const deadline = start + MAX_WAIT_MS;

    while (Date.now() < deadline) {
      // The status cache covers recent signatures; only pay for the history
      // search once the transaction is old enough to have fallen out of it.
      const { context, value } = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: Date.now() - start > 20_000,
      });
      const status = value[0];
      if (status) {
        if (status.err) {
          // THROW rather than return the error. web3.js resolves with
          // `{err}` here, and the extracted upload/shield code calls
          // `await connection.confirmTransaction(...)` without inspecting the
          // result — so a transaction that failed on-chain would otherwise be
          // reported to the user as a successful shield.
          throw new Error(
            `Transaction ${signature} failed on-chain: ${JSON.stringify(status.err)}`,
          );
        }
        const level = status.confirmationStatus;
        if (
          level === 'finalized' ||
          (wanted !== 'finalized' && (level === 'confirmed' || level === 'processed'))
        ) {
          // 'processed' only satisfies a 'processed' request.
          if (level !== 'processed' || wanted === 'processed') {
            return { context, value: { err: null } };
          }
        }
      }
      await sleep(POLL_INTERVAL_MS);
    }

    throw new Error(
      `Transaction ${signature} was not confirmed within ${MAX_WAIT_MS / 1000}s`,
    );
  }) as Connection['confirmTransaction'];

  return connection;
}
