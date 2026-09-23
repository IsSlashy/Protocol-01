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

/**
 * [shield-speed C 2026-09-23] The poll schedule. MEASURED 2026-09-22 on devnet
 * (shield-speed MEASURE.md): all 8 single-transaction confirmations took
 * 1845-1941 ms from send to seen. The first read (~+230 ms) was ALWAYS null and
 * the second, a flat 1.5 s later, always confirmed, while the same transaction
 * type confirmed over a WebSocket in 537-632 ms. So: the first read at +400 ms
 * (the immediate one never saw anything), then every 400 ms while the
 * transaction is young, then the old 1.5 s. Only the timing of the reads
 * changes: the ceiling, the history search after 20 s, the 'confirmed' rule
 * and the throw on an on-chain error are exactly as before, and every read
 * still goes through the worker's paced transport.
 */
const FIRST_POLL_MS = 400;
const FAST_POLL_MS = 400;
/** How long the fast cadence lasts, from the call. */
const FAST_POLL_WINDOW_MS = 5_000;
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

    await sleep(FIRST_POLL_MS);
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
          //
          // No signature in either refusal: this message reaches the panels'
          // error line, and the transaction is a deposit (its leaf) or a spend
          // (its nullifier). The caller holds the signature it asked about
          // (pollingConfirm.test.ts, "pollingConfirm refusals name no transaction").
          throw new Error(
            `A transaction failed on-chain: ${JSON.stringify(status.err)}`,
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
      await sleep(Date.now() - start < FAST_POLL_WINDOW_MS ? FAST_POLL_MS : POLL_INTERVAL_MS);
    }

    throw new Error(
      `A transaction was not confirmed within ${MAX_WAIT_MS / 1000}s`,
    );
  }) as Connection['confirmTransaction'];

  return connection;
}
