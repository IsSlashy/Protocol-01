/**
 * Boot-time reconciliation of pending sends.
 *
 * After an app restart, our persisted `pendingTransactions[]` may contain
 * entries whose on-chain settlement happened (or definitely didn't). We
 * compare the recorded `expected_nonce` against the live on-chain
 * `wallet.nonce` and:
 *   - if live nonce > expected: the tx landed → mark 'confirmed'
 *   - if live nonce == expected AND entry is younger than `STALE_AFTER_MS`:
 *     keep as 'pending' (might still confirm)
 *   - if live nonce == expected AND entry is older than `STALE_AFTER_MS`:
 *     mark 'failed' + rollback balance
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { fetchQuantumWallet } from './index';

/** A pending send becomes stale after 10 minutes — beyond that we assume the
 *  tx never made it on-chain. The actual STARK pipeline rarely takes more
 *  than 60-90s; 10min is forgiving for network partitions. */
export const STALE_AFTER_MS = 10 * 60 * 1000;

export interface PendingRecord {
  id: string;
  expectedNonce: bigint;
  amountLamports: number;
  createdAt: number;
  status: string;
}

export interface ReconcileOutcome {
  confirmed: string[];     // pending ids that landed
  stillPending: string[];  // ids to keep
  failed: { id: string; reason: string }[];
}

/** Inspect persisted pending sends + the live on-chain wallet, decide what
 *  to do with each. Pure function — caller applies the state changes. */
export async function reconcilePending(args: {
  connection: Connection;
  ownerId: PublicKey;
  pending: PendingRecord[];
}): Promise<ReconcileOutcome> {
  const wallet = await fetchQuantumWallet(args.connection, args.ownerId);
  if (!wallet) {
    // Wallet doesn't exist on-chain yet. All pending entries are stale
    // (we never initialized); fail them.
    return {
      confirmed: [],
      stillPending: [],
      failed: args.pending.map((p) => ({
        id: p.id,
        reason: 'Wallet has not been initialized on-chain.',
      })),
    };
  }

  const liveNonce = wallet.nonce;
  const out: ReconcileOutcome = { confirmed: [], stillPending: [], failed: [] };
  const now = Date.now();

  for (const p of args.pending) {
    if (liveNonce > p.expectedNonce) {
      // On-chain advanced past us → our tx landed.
      out.confirmed.push(p.id);
    } else {
      // liveNonce <= expectedNonce. Either still pending or never landed.
      if (now - p.createdAt > STALE_AFTER_MS) {
        out.failed.push({ id: p.id, reason: 'Timed out before confirmation' });
      } else {
        out.stillPending.push(p.id);
      }
    }
  }

  return out;
}
