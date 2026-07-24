/**
 * poolNotes — note discovery, counter allocation, and recovery for the
 * denominated pool.
 *
 * WHY COUNTER ALLOCATION IS FUND-CRITICAL
 * ───────────────────────────────────────
 * A note's secrets derive from `(walletSeed, poolPDA, counter)`
 * (`deriveNoteMaterial`), and its nullifier is
 * `poseidon(nullifierPreimage, secret)` (`createNullifierV3`) — with NO epoch
 * input. Two notes shielded under the SAME counter therefore share one
 * nullifier: spending either one marks it spent and the other becomes
 * permanently unspendable. Counter reuse destroys funds.
 *
 * So the counter must never be guessed from local state alone. Everything here
 * is derived from the chain plus the wallet seed, so a user with a cleared
 * browser (or a different device) reconstructs the exact same picture.
 *
 * HOW RECOVERY WORKS WITHOUT STORED STATE
 * ───────────────────────────────────────
 * The commitment is
 *   `poseidon(poseidon(np, secret), poseidon(depositEpoch, tokenMint))`
 * — everything but `depositEpoch` is derivable from the seed. `depositEpoch` is
 * `slot / 7200` at shield time, so we simply enumerate candidate epochs and test
 * each resulting commitment against the pool's on-chain leaf set. A match
 * recovers both the epoch and the leaf index, which is exactly what an unshield
 * needs. No note storage is required for this to work.
 */

import type { Connection } from '@solana/web3.js';

import {
  createCommitmentV3,
  deriveNoteMaterial,
  fetchPoolCommitments,
  isNullifierSpent,
  pubkeyToField,
  slotToEpoch,
  type PoolConfig,
  type ShieldReceipt,
} from './denominatedPool';

/**
 * How many counters to probe per pool. Each is a handful of hashes per epoch,
 * so this is cheap; it caps how many notes one wallet can hold in one pool.
 */
const DEFAULT_MAX_COUNTER = 32;

/**
 * How far back to search for a note's deposit epoch, in epochs (7200 slots
 * each — roughly an hour of devnet per epoch). The V4 pools were deployed in
 * 2026-05, so this window covers every note that can exist in them while
 * keeping the search a few hundred thousand hashes rather than millions.
 */
const DEFAULT_EPOCH_WINDOW = 6000;

export interface RecoveredNote {
  counter: number;
  receipt: ShieldReceipt;
  /** True when the nullifier PDA already exists on-chain (already spent). */
  spent: boolean;
}

export interface RecoverNotesOptions {
  maxCounter?: number;
  epochWindow?: number;
  /** Reuse a commitment map from a previous scan of the same pool. */
  commitments?: Map<string, { commitment: bigint; leafIndex: number }>;
  onProgress?: (step: string) => void;
}

/**
 * Find every note this seed owns in `poolConfig`, by matching derived
 * commitments against the pool's on-chain leaves.
 *
 * Returns notes in counter order. `spent` is resolved per note so callers can
 * both show a balance and pick a safe next counter.
 */
export async function recoverNotes(
  connection: Connection,
  poolConfig: PoolConfig,
  walletSeed: Uint8Array,
  opts: RecoverNotesOptions = {},
): Promise<RecoveredNote[]> {
  const maxCounter = opts.maxCounter ?? DEFAULT_MAX_COUNTER;
  const epochWindow = opts.epochWindow ?? DEFAULT_EPOCH_WINDOW;

  opts.onProgress?.('Reading pool history...');
  const commitments =
    opts.commitments ?? (await fetchPoolCommitments(connection, poolConfig.poolPDA));

  const slot = await connection.getSlot('confirmed');
  const currentEpoch = slotToEpoch(slot);
  const lowestEpoch = currentEpoch > BigInt(epochWindow) ? currentEpoch - BigInt(epochWindow) : 0n;
  const tokenMintField = pubkeyToField(poolConfig.tokenMint);

  opts.onProgress?.('Matching notes...');
  const found: RecoveredNote[] = [];

  for (let counter = 0; counter < maxCounter; counter++) {
    const { secret, nullifierPreimage } = deriveNoteMaterial(walletSeed, poolConfig.poolPDA, counter);

    // Walk epochs newest-first: a wallet's most recent note is the common case.
    let hit: { epoch: bigint; commitment: bigint; leafIndex: number } | null = null;
    for (let epoch = currentEpoch; epoch >= lowestEpoch; epoch--) {
      const commitment = createCommitmentV3(nullifierPreimage, secret, epoch, tokenMintField);
      const onChain = commitments.get(commitment.toString());
      if (onChain) {
        hit = { epoch, commitment, leafIndex: onChain.leafIndex };
        break;
      }
    }
    if (!hit) continue;

    const spent = await isNullifierSpent(connection, poolConfig.poolPDA, nullifierPreimage, secret);

    found.push({
      counter,
      spent,
      receipt: {
        secret,
        nullifierPreimage,
        depositEpoch: hit.epoch,
        tokenMint: tokenMintField,
        commitment: hit.commitment,
        leafIndex: hit.leafIndex,
        denomination: poolConfig.denominationAtomic,
        pool: poolConfig.poolPDA.toBase58(),
        token: poolConfig.token,
        denominationHuman: poolConfig.denomination,
        shieldedAt: 0,
        source: 'shielded',
      },
    });
  }

  return found;
}

/**
 * Pick a counter that has never been used in this pool by this seed.
 *
 * Takes the highest counter that matched on-chain and returns the next one, so
 * a gap (a note recovered outside the epoch window, say) can never cause reuse
 * of a lower counter. Callers MUST use this rather than counting local notes.
 */
export function nextFreeCounter(notes: RecoveredNote[]): number {
  let highest = -1;
  for (const n of notes) if (n.counter > highest) highest = n.counter;
  return highest + 1;
}

/**
 * Full pre-shield check: scan the pool, then return the safe next counter plus
 * the notes already held. One RPC sweep, reused by the balance display.
 */
export async function scanPoolForSeed(
  connection: Connection,
  poolConfig: PoolConfig,
  walletSeed: Uint8Array,
  opts: RecoverNotesOptions = {},
): Promise<{ notes: RecoveredNote[]; nextCounter: number }> {
  const notes = await recoverNotes(connection, poolConfig, walletSeed, opts);
  return { notes, nextCounter: nextFreeCounter(notes) };
}
