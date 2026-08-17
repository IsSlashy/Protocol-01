/**
 * recoverFloat — reclaim SOL stranded on a pool ephemeral.
 *
 * WHY THIS IS NEEDED
 * ──────────────────
 * A shield or withdrawal pre-funds an ephemeral E with ~1 SOL, most of which
 * becomes rent on a STARK proof buffer. If the run dies after the buffer is
 * created — browser closed, tab reloaded, RPC failure mid-upload — that rent
 * stays locked, and `CloseProofBuffer` is declared
 * `#[account(mut, has_one = authority, close = authority)]`, so **only E can
 * ever release it**. No crank, no other wallet, no protocol path.
 *
 * The next shield uses a different leaf index, hence a different E, so without
 * this the old E is never derived again and its float is stranded permanently.
 *
 * What makes recovery possible is that E is deterministic in
 * (pool seed, pool, leaf index) — so we simply re-derive the recent ones, close
 * any buffer they still own, and sweep them out.
 *
 * 🚨 THE SWEEP DESTINATION IS NOT ALWAYS THE OWNER — AND USED TO BE
 * ─────────────────────────────────────────────────────────────────
 * This file swept unconditionally to `owner`. That was correct for exactly as
 * long as the user's wallet was the only thing that ever funded an ephemeral,
 * and it stopped being correct the moment `subscribeFromPool` started asking
 * the deployment's funder to pre-fund instead (`shieldClient.ts`). A subscribe
 * shares the withdrawal's ephemeral derivation ON PURPOSE, so that this file
 * finds it (`subscribeEphemeral.ts` header) — which means a subscription paid
 * for by the treasury and then crashed left ~1.03 SOL of the TREASURY'S money
 * sitting on a key this function re-derives, and one click on Recover sent it
 * to the user's wallet. Two defects in one transfer: the treasury is drained by
 * accident, and the wallet is written into the newest transaction of that
 * ephemeral's life, which is exactly the edge the funder exists to avoid.
 *
 * So the destination is now RESOLVED, from the chain, per ephemeral:
 *
 *   sources ⊆ {owner}                     → sweep to owner (unchanged)
 *   sources ⊆ {funder}                     → sweep to the funder, repaying it
 *   sources ∋ owner AND funder             → REFUSE, report `mixed`
 *   any source that is neither             → REFUSE, report `unidentified`
 *   no source readable, funder configured  → REFUSE, report `unverifiable`
 *
 * ⛔ THE ALLOWLIST IS TWO FIXED ADDRESSES, NEVER A HEURISTIC. It is tempting to
 * pick "whoever sent the largest inbound transfer". Do not: ephemeral addresses
 * are free to enumerate with `getSignaturesForAddress` on the funder, so an
 * attacker sends a stranded E one lamport more than the grant, waits for the
 * user to click Recover, and the whole sweep lands on them — cost, one 5,000
 * lamport fee, with their capital returned in the same transaction. A fixed
 * pubkey cannot be outbid.
 *
 * REFUSING COSTS NOTHING, AND THAT IS THE WHOLE ARGUMENT. The money stays on a
 * key that is re-derivable from the seed forever, and the proof buffer is still
 * closed on the way past — so a refusal defers a recovery, it never loses one.
 * Sweeping to the wrong party is irreversible. When the two outcomes are
 * "later" and "gone", the tie does not need breaking.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';

import {
  CIRCUIT_MERKLE_PATH,
  CIRCUIT_MERKLE_UPDATE,
  CIRCUIT_POOL_COMMITMENT,
  type PoolConfig,
  type WalletSigner,
} from './denominatedPool';
import { closeStarkProofBuffer, getProofBufferPDA } from './stark';
import { deriveShieldEphemeral, readTreeLeafCount } from './shieldEphemeral';
import { deriveUnshieldEphemeral } from './unshieldEphemeral';

/** Leave enough for the sweep transaction's own fee. */
const SWEEP_FEE = 5_000;

/**
 * How many leaf indices back to look for a SHIELD ephemeral.
 *
 * Justified for shields and only for shields: a shield derives its ephemeral
 * for the leaf index it is about to occupy, and a shield that never landed did
 * not advance the tree, so a stranded one sits at or just below the head.
 */
const DEFAULT_LOOKBACK = 12;

/**
 * Signatures sampled from each end of an ephemeral's life when classifying who
 * funded it.
 *
 * A crashed subscribe can leave ~150 chunk uploads behind, and fetching every
 * one to find two transfers would make Recover unusable. Funding is the FIRST
 * transaction of an ephemeral's life and a later top-up is among the LAST, with
 * nothing in between but E paying its own fees — the same both-ends shape probe
 * P6 walks. This is a bounded read, not a proof, and it is documented as such
 * where it is used.
 */
const SOURCE_SAMPLE_PER_END = 10;

/** Cap on the signature page fetched per ephemeral. */
const SOURCE_SIGNATURE_LIMIT = 1000;

/** Why a sweep was refused. Each one leaves the money on a re-derivable key. */
export type SweepRefusal = 'mixed' | 'unidentified' | 'unverifiable';

export interface RecoveredFloat {
  ephemeral: string;
  kind: 'shield' | 'unshield';
  leafIndex: number;
  lamports: number;
  closedBuffers: number;
  /**
   * Where the lamports went, base58 — `null` when nothing was swept, either
   * because there was nothing to sweep or because `refused` says why not.
   */
  destination: string | null;
  /** Set when a balance was found and deliberately NOT swept. */
  refused?: SweepRefusal;
  /**
   * What is sitting on the key, when `refused` is set. Distinct from `lamports`
   * on purpose: `lamports` is what MOVED, and reporting a refusal as if it had
   * moved is the failure this whole change exists to prevent.
   */
  strandedLamports?: number;
  /** Addresses seen funding this ephemeral, for the refusal message. */
  sources?: string[];
}

export interface RecoverFloatOptions {
  /** Leaf indices back from the head to try for SHIELD ephemerals. */
  lookback?: number;
  /**
   * The deployment's funder, when it has one. Supplying it is what allows a
   * treasury-funded ephemeral to be repaid instead of refused; omitting it is
   * safe and means no third-party money is expected — the pre-funder-era
   * behaviour, unchanged.
   */
  funderPubkey?: PublicKey;
  /**
   * Leaf indices of notes this caller actually holds, for the UNSHIELD
   * derivation.
   *
   * A withdrawal or subscribe derives its ephemeral from the leaf index of the
   * note being SPENT, and spending a note advances nothing — so a note 400
   * leaves below the head strands its float 400 leaves below the head, where
   * the shield's head-relative window cannot see it. These are unioned with
   * that window rather than replacing it, so this can only ever find more.
   */
  unshieldLeafIndices?: number[];
  onProgress?: (step: string) => void;
}

/**
 * Re-derive recent ephemerals for this pool, close any proof buffers they still
 * own, and sweep their balances to whoever funded them.
 *
 * Safe to run at any time: an ephemeral with no buffer and no balance costs one
 * `getBalance` and is skipped. It is NOT safe to run while a shield or
 * withdrawal is in flight for the same pool — it would close the buffer the
 * live run is uploading into, so callers must serialize it against those.
 */
export async function recoverStuckFloat(
  connection: Connection,
  poolConfig: PoolConfig,
  walletSeed: Uint8Array,
  owner: PublicKey,
  opts: RecoverFloatOptions = {},
): Promise<RecoveredFloat[]> {
  const lookback = opts.lookback ?? DEFAULT_LOOKBACK;
  const head = await readTreeLeafCount(connection, poolConfig);

  const recovered: RecoveredFloat[] = [];

  // `head` itself is included: a shield that was prepared but never landed was
  // derived for the current head and left its buffer behind without advancing
  // the tree.
  const window: number[] = [];
  for (let leafIndex = head; leafIndex >= Math.max(0, head - lookback); leafIndex--) {
    window.push(leafIndex);
  }

  const plan: Array<{ leafIndex: number; kind: 'shield' | 'unshield' }> = [];
  for (const leafIndex of window) {
    plan.push({ leafIndex, kind: 'shield' });
    plan.push({ leafIndex, kind: 'unshield' });
  }
  // The caller's own notes, for the spend derivation only, minus anything the
  // window already covers. Order matters only for the progress log.
  const inWindow = new Set(window);
  for (const leafIndex of opts.unshieldLeafIndices ?? []) {
    if (Number.isInteger(leafIndex) && leafIndex >= 0 && !inWindow.has(leafIndex)) {
      plan.push({ leafIndex, kind: 'unshield' });
    }
  }

  for (const { leafIndex, kind } of plan) {
    const ephemeral =
      kind === 'shield'
        ? deriveShieldEphemeral(walletSeed, poolConfig.poolPDA, leafIndex)
        : deriveUnshieldEphemeral(walletSeed, poolConfig.poolPDA, leafIndex);

    const circuits =
      kind === 'shield'
        ? [CIRCUIT_MERKLE_UPDATE]
        : [CIRCUIT_POOL_COMMITMENT, CIRCUIT_MERKLE_PATH];

    let closedBuffers = 0;
    const signer = ephemeralSigner(ephemeral, connection);

    for (const circuitId of circuits) {
      const [bufferPDA] = getProofBufferPDA(ephemeral.publicKey, circuitId);
      const info = await connection.getAccountInfo(bufferPDA);
      if (!info) continue;
      opts.onProgress?.(`Closing a stranded proof buffer from leaf #${leafIndex}...`);
      await closeStarkProofBuffer(bufferPDA, signer, connection);
      closedBuffers += 1;
    }

    const balance = await connection.getBalance(ephemeral.publicKey, 'confirmed');
    const sweepable = balance - SWEEP_FEE;
    if (sweepable <= 0) {
      if (closedBuffers > 0) {
        recovered.push({
          ephemeral: ephemeral.publicKey.toBase58(),
          kind,
          leafIndex,
          lamports: 0,
          closedBuffers,
          destination: null,
        });
      }
      continue;
    }

    // Only now — with money actually on the key — is the classification worth
    // its RPC calls. A pool with nothing stranded pays for none of this.
    const verdict = await resolveSweepDestination(connection, ephemeral.publicKey, owner, opts);
    if (verdict.refused) {
      opts.onProgress?.(
        `Leaving ${(sweepable / 1e9).toFixed(4)} SOL on leaf #${leafIndex}: ${refusalSentence(verdict.refused)}`,
      );
      recovered.push({
        ephemeral: ephemeral.publicKey.toBase58(),
        kind,
        leafIndex,
        lamports: 0,
        closedBuffers,
        destination: null,
        refused: verdict.refused,
        strandedLamports: sweepable,
        sources: verdict.sources,
      });
      continue;
    }

    const destination = verdict.destination;
    opts.onProgress?.(
      destination.equals(owner)
        ? `Sweeping ${(sweepable / 1e9).toFixed(4)} SOL back to your wallet...`
        : `Returning ${(sweepable / 1e9).toFixed(4)} SOL to the funder that paid for this job...`,
    );
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: ephemeral.publicKey,
        toPubkey: destination,
        lamports: sweepable,
      }),
    );
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = ephemeral.publicKey;
    tx.sign(ephemeral);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');

    recovered.push({
      ephemeral: ephemeral.publicKey.toBase58(),
      kind,
      leafIndex,
      lamports: sweepable,
      closedBuffers,
      destination: destination.toBase58(),
    });
  }

  return recovered;
}

/** Human-readable half of a refusal. The money is never at risk in any of them. */
export function refusalSentence(refusal: SweepRefusal): string {
  switch (refusal) {
    case 'mixed':
      return 'both your wallet and the funder paid into it, and a sweep can only land on one of them. ' +
        'Nothing is lost — the key is re-derivable from your seed.';
    case 'unidentified':
      return 'it was funded by an address that is neither your wallet nor this deployment’s funder. ' +
        'Nothing is lost — the key is re-derivable from your seed.';
    case 'unverifiable':
      return 'this RPC no longer serves the transactions that would say who paid for it, and this ' +
        'deployment has a funder, so it could be treasury money. Nothing is lost — the key is ' +
        're-derivable from your seed. Retry against an RPC with fuller history.';
  }
}

interface SweepVerdict {
  destination: PublicKey;
  refused?: undefined;
  sources?: string[];
}
interface SweepRefused {
  destination?: undefined;
  refused: SweepRefusal;
  sources: string[];
}

/**
 * Decide where one ephemeral's residue may go, from who is seen paying into it.
 *
 * WHY BALANCE DELTAS AND NOT DECODED INSTRUCTIONS. An inbound lamport can
 * arrive as `SystemProgram::transfer`, as `createAccount`, as
 * `transferWithSeed`, or through a CPI where no top-level instruction mentions
 * it at all — this repo has already been bitten by a probe that read only the
 * first of those. `preBalances`/`postBalances` are computed by the runtime and
 * see every one of them. Over-collecting sources is the safe direction here:
 * it can only push this function toward refusing, and a refusal costs a retry.
 */
async function resolveSweepDestination(
  connection: Connection,
  ephemeral: PublicKey,
  owner: PublicKey,
  opts: RecoverFloatOptions,
): Promise<SweepVerdict | SweepRefused> {
  const funder = opts.funderPubkey;

  // No funder on this deployment: no third-party money can be here, so the
  // pre-funder behaviour is still exactly right and costs no RPC calls.
  if (!funder) return { destination: owner };

  // A funder that IS the owner would make every classification ambiguous, and
  // the route refuses to fund itself anyway. Treat it as no funder.
  if (funder.equals(owner)) return { destination: owner };

  let sources: string[];
  try {
    sources = await readInboundSources(connection, ephemeral);
  } catch {
    // The read itself failed. Same posture as pruned history: we do not know,
    // and treasury money could be here.
    return { refused: 'unverifiable', sources: [] };
  }

  if (sources.length === 0) return { refused: 'unverifiable', sources: [] };

  const ownerB58 = owner.toBase58();
  const funderB58 = funder.toBase58();
  const sawOwner = sources.includes(ownerB58);
  const sawFunder = sources.includes(funderB58);
  const strangers = sources.filter((s) => s !== ownerB58 && s !== funderB58);

  if (strangers.length > 0) return { refused: 'unidentified', sources };
  if (sawOwner && sawFunder) return { refused: 'mixed', sources };
  if (sawFunder) return { destination: funder, sources };
  if (sawOwner) return { destination: owner, sources };
  return { refused: 'unidentified', sources };
}

/**
 * Every address seen paying lamports INTO `ephemeral`, base58, deduplicated.
 *
 * Bounded on purpose — see `SOURCE_SAMPLE_PER_END`. A funding transaction is
 * the first of an ephemeral's life and a top-up is among the last; the ~150
 * chunk uploads in between are E spending, not receiving.
 */
async function readInboundSources(
  connection: Connection,
  ephemeral: PublicKey,
): Promise<string[]> {
  const sigs = await connection.getSignaturesForAddress(ephemeral, {
    limit: SOURCE_SIGNATURE_LIMIT,
  });
  if (sigs.length === 0) return [];

  // Newest first, as the RPC returns them.
  const sampled =
    sigs.length <= SOURCE_SAMPLE_PER_END * 2
      ? sigs
      : [...sigs.slice(0, SOURCE_SAMPLE_PER_END), ...sigs.slice(-SOURCE_SAMPLE_PER_END)];

  const target = ephemeral.toBase58();
  const found = new Set<string>();

  for (const { signature } of sampled) {
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (!tx?.meta) continue;
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
    const idx = keys.indexOf(target);
    if (idx < 0) continue;
    const gained = (tx.meta.postBalances[idx] ?? 0) - (tx.meta.preBalances[idx] ?? 0);
    if (gained <= 0) continue;
    keys.forEach((key, i) => {
      if (i === idx) return;
      const delta = (tx.meta!.postBalances[i] ?? 0) - (tx.meta!.preBalances[i] ?? 0);
      if (delta < 0) found.add(key);
    });
  }

  return [...found];
}

function ephemeralSigner(ephemeral: Keypair, connection: Connection): WalletSigner {
  return {
    publicKey: ephemeral.publicKey,
    signTransaction: async (t: Transaction) => {
      if (!t.recentBlockhash) {
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        t.recentBlockhash = blockhash;
      }
      if (!t.feePayer) t.feePayer = ephemeral.publicKey;
      t.sign(ephemeral);
      return t;
    },
  };
}
