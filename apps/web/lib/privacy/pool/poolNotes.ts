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
 *   `poseidon(poseidon(np, secret), poseidon(blinding, tokenMint))`
 * and every input is derivable from the wallet seed (see noteBlinding.ts), so a
 * note is identified by recomputing its commitment and looking for it among the
 * pool's on-chain leaves. One hash per candidate leaf, no stored state.
 *
 * Legacy notes put the real deposit epoch where the blinding now goes, so they
 * fall back to enumerating candidate epochs. That fallback is exactly the attack
 * blinding closes — it only works here because the owner knows the nullifier
 * before it is ever published.
 */

import type { Connection } from '@solana/web3.js';

import { deriveNoteBlinding } from './noteBlinding';
import {
  createCommitmentV3,
  deriveNoteMaterial,
  fetchPoolCommitments,
  fetchSpentNullifierSet,
  isNullifierSpentInSet,
  pubkeyToField,
  slotToEpoch,
  type PoolConfig,
  type ShieldReceipt,
} from './denominatedPool';

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
  epochWindow?: number;
  /** Reuse a commitment map from a previous scan of the same pool. */
  commitments?: Map<string, { commitment: bigint; leafIndex: number }>;
  /** Reuse a spent-nullifier set from a previous read of the same pool. Same
   *  contract as `commitments`, for the same reason: a caller iterating seed
   *  derivations MUST hoist this, or a passphrase wallet re-issues the
   *  identical pool-wide getProgramAccounts once per derivation. */
  spentSet?: ReadonlySet<string>;
  /**
   * Run only the blinded single-hash pass and SKIP the legacy epoch search.
   *
   * One hash per candidate leaf instead of up to `epochWindow` (6000) hashes
   * per leaf the wallet does not own — milliseconds instead of ~41 s per
   * derivation on the measured 59-leaf pools (0.1158 ms per hash, 2026-08-12).
   * The price is stated in the name: the result is INCOMPLETE by construction.
   * A legacy note (real epoch where the blinding now goes) can only be found
   * by the search this flag skips, and there is a known unspent one at leaf 30
   * of the 0.1 SOL pool. A caller may use this ONLY to paint early results and
   * MUST follow with a full pass before claiming the list is complete.
   */
  blindedOnly?: boolean;
  /**
   * Probe exactly ONE leaf index instead of every leaf the pool contains.
   *
   * For a caller that already knows which note it wants — the withdraw,
   * subscribe and hand-over paths all select by leaf index — scanning the
   * other leaves is pure waste, and the waste is the 6000-epoch legacy search
   * per foreign leaf: the measured ~41 s per derivation, spent before a spend
   * could even start. The counter IS the leaf index (shieldEphemeral.ts), so
   * restricting the probe loses nothing the full scan could have found at
   * this leaf: the same blinded hash and, unless `blindedOnly` says otherwise,
   * the same legacy fallback still run for it. A leaf this RPC does not serve
   * yields no candidates, exactly as it yields no match in the full scan.
   */
  onlyLeaf?: number;
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
  const epochWindow = opts.epochWindow ?? DEFAULT_EPOCH_WINDOW;

  opts.onProgress?.('Reading pool history...');
  const commitments =
    opts.commitments ?? (await fetchPoolCommitments(connection, poolConfig.poolPDA));

  // The current slot only bounds the legacy epoch search, so a blinded-only
  // pass skips the RPC round trip along with the search itself — the fast pass
  // must stay free of per-call chain reads beyond what the caller hoisted.
  let currentEpoch = 0n;
  let lowestEpoch = 0n;
  if (!opts.blindedOnly) {
    const slot = await connection.getSlot('confirmed');
    currentEpoch = slotToEpoch(slot);
    lowestEpoch = currentEpoch > BigInt(epochWindow) ? currentEpoch - BigInt(epochWindow) : 0n;
  }
  const tokenMintField = pubkeyToField(poolConfig.tokenMint);

  // ONE pool-wide question, asked before the loop, instead of one question per
  // note inside it. The old shape handed the RPC a list of not-yet-existing
  // nullifier PDAs on every scan; see `fetchSpentNullifierSet` for why that was a
  // full deanonymisation channel. This asks something every user of the pool
  // asks identically, and resolves membership locally below.
  //
  // Deliberately NOT wrapped in try/catch, unlike handlePoolResolveSpent's
  // per-pool catch. That handler's response can say "unresolved"; here
  // `RecoveredNote.spent` is a plain boolean with no unknown state, so a
  // swallowed failure could only default it — `false` offers money that is
  // gone, `true` hides money that is not. A loud failure is the honest option
  // until the type can carry uncertainty.
  let spentSet = opts.spentSet;
  if (!spentSet) {
    opts.onProgress?.('Reading spent markers...');
    spentSet = await fetchSpentNullifierSet(connection, poolConfig.poolPDA);
  }

  opts.onProgress?.('Matching notes...');
  const found: RecoveredNote[] = [];

  // The counter IS the leaf index (see shieldEphemeral.ts), so probe exactly the
  // leaf indices the pool actually contains rather than a blind 0..N range —
  // that both covers pools of any size and skips indices
  // that cannot match anything. `onlyLeaf` narrows the probe to the one leaf a
  // spending caller already selected; the INTERSECTION with the served leaves,
  // not the raw request, so an unserved leaf stays a miss exactly as it is in
  // the full scan.
  let candidates = [...commitments.values()]
    .map((c) => c.leafIndex)
    .sort((a, b) => a - b);
  if (opts.onlyLeaf !== undefined) {
    candidates = candidates.filter((leaf) => leaf === opts.onlyLeaf);
  }

  for (const counter of candidates) {
    const { secret, nullifierPreimage } = deriveNoteMaterial(walletSeed, poolConfig.poolPDA, counter);

    let hit: { noteBlinding: bigint; commitment: bigint; leafIndex: number } | null = null;

    // Current scheme: the commitment's third input is a seed-derived blinding, so
    // the note is identified with ONE hash and no search at all.
    const blinding = deriveNoteBlinding(walletSeed, poolConfig.poolPDA, counter);
    const blinded = createCommitmentV3(nullifierPreimage, secret, blinding, tokenMintField);
    const blindedOnChain = commitments.get(blinded.toString());
    if (blindedOnChain && blindedOnChain.leafIndex === counter) {
      hit = { noteBlinding: blinding, commitment: blinded, leafIndex: blindedOnChain.leafIndex };
    }

    // Legacy notes (shielded before blinding landed) put the real deposit epoch
    // there, so they still need the search. DO NOT REMOVE THIS FALLBACK: there
    // is an unspent legacy note at leaf 30 of the 0.1 SOL pool, and without the
    // search it becomes invisible to scan and unwithdrawable through the UI.
    // `blindedOnly` defers it — the caller runs a full pass afterwards — it
    // never replaces it.
    if (!hit && !opts.blindedOnly) {
      for (let epoch = currentEpoch; epoch >= lowestEpoch; epoch--) {
        const commitment = createCommitmentV3(nullifierPreimage, secret, epoch, tokenMintField);
        const onChain = commitments.get(commitment.toString());
        if (onChain && onChain.leafIndex === counter) {
          hit = { noteBlinding: epoch, commitment, leafIndex: onChain.leafIndex };
          break;
        }
      }
    }
    if (!hit) continue;

    const spent = isNullifierSpentInSet(
      spentSet,
      poolConfig.poolPDA,
      nullifierPreimage,
      secret,
    );

    found.push({
      counter,
      spent,
      receipt: {
        secret,
        nullifierPreimage,
        noteBlinding: hit.noteBlinding,
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
 * Best-effort note discovery for display.
 *
 * NOT a source of truth for counter allocation. This can only see notes whose
 * insert event the RPC still serves, and public devnet RPC prunes aggressively
 * (observed 2026-07-24: the 0.1 SOL pool's tree account reports 27 leaves while
 * the RPC retains one signature for it). A counter chosen from these results
 * would collide with a pruned note and strand it — see `shieldEphemeral.ts`,
 * which derives the counter from the tree's leaf index instead.
 */
export async function scanPoolForSeed(
  connection: Connection,
  poolConfig: PoolConfig,
  walletSeed: Uint8Array,
  opts: RecoverNotesOptions = {},
): Promise<{ notes: RecoveredNote[] }> {
  return { notes: await recoverNotes(connection, poolConfig, walletSeed, opts) };
}
