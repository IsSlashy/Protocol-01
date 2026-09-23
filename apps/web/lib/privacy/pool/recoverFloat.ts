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
 * (pool seed, pool, leaf index) — so we re-derive them, close any buffer they
 * still own, and sweep them out. Shield keys are re-derived for EVERY leaf from
 * the head down to 0, not only the recent ones (`HEAD_WINDOW`).
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
import { sendWithFreshBlockhash } from './sendTx';

import {
  CIRCUIT_MERKLE_PATH,
  CIRCUIT_MERKLE_UPDATE,
  CIRCUIT_POOL_COMMITMENT,
  CIRCUIT_SPEND,
  type PoolConfig,
  type WalletSigner,
} from './denominatedPool';
import { closeStarkProofBuffer, getProofBufferPDA, proofBufferAddresses } from './stark';
import { deriveShieldEphemeral, readTreeLeafCount } from './shieldEphemeral';
import { deriveUnshieldEphemeral } from './unshieldEphemeral';
import nacl from 'tweetnacl';

/** Leave enough for the sweep transaction's own fee. */
const SWEEP_FEE = 5_000;

/**
 * Progress cadence of the deep scan (`scanBelowWindow`), far inside the page's
 * 180 s silence watchdog (audit v1 F71): a line at least every 10 s of reads,
 * and every 250 keys whatever the clock says.
 */
const HEARTBEAT_MS = 10_000;
const HEARTBEAT_KEYS = 250;

/**
 * A progress line when `HEARTBEAT_MS` has passed since the last one, or every
 * `HEARTBEAT_KEYS` calls. Called once per RPC-paced step of Recover. The line
 * carries no number (see `scanBelowWindow`).
 */
function heartbeat(onProgress: ((step: string) => void) | undefined, line: string): () => void {
  let last = Date.now();
  let steps = 0;
  return () => {
    steps += 1;
    if (Date.now() - last >= HEARTBEAT_MS || steps % HEARTBEAT_KEYS === 0) {
      onProgress?.(line);
      last = Date.now();
    }
  };
}

/**
 * The head window: leaf indices back from the head whose SHIELD ephemeral is
 * probed in full (its proof buffers, then its balance).
 *
 * ⚠️ THIS IS NOT WHERE A STRANDED SHIELD KEY MUST SIT, AND THIS COMMENT USED TO
 * SAY IT WAS. A shield (a deposit or a contribution) derives E(N) for the leaf
 * index N it was prepared for, and a shield that never landed did not advance
 * the tree FOR THIS USER — but every other deposit, and the restock job alone
 * (up to three leaves per four-hour run), still does. Twelve was the whole
 * search, no caller passed a wider one, and from the 13th foreign leaf on the
 * float of a crashed deposit was never read again while the panel said
 * "Nothing stranded in any pool" (audit v1 round 4, P1;
 * `recoverFloatDeepScan.test.ts`). The default scan now goes down to leaf 0:
 * this window in full, everything below it balance-first (`scanBelowWindow`).
 */
const HEAD_WINDOW = 12;

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
  /**
   * Bound the SHIELD scan to the head and this many leaves below it.
   *
   * Omitted (every production caller): every shield key from the head down to
   * leaf 0 is read — the head window in full, the rest balance-first. Passing
   * a number is a deliberate narrowing, for tests that isolate one key; a
   * stranded deposit below the bound is then NOT found.
   */
  lookback?: number;
  /**
   * The deployment's funder, when it has one. Supplying it is what allows a
   * treasury-funded ephemeral to be repaid instead of refused; omitting it is
   * safe and means no third-party money is expected — the pre-funder-era
   * behaviour, unchanged.
   */
  funderPubkey?: PublicKey;
  /**
   * The caller could not establish whether this deployment has a funder.
   *
   * Omitting `funderPubkey` asserts "there is definitively none", which makes
   * the pre-funder sweep-home behaviour correct because no third-party money
   * can exist. This flag says the opposite: we do not know, so treasury money
   * might be here and no attribution is possible. It maps to the same refusal
   * an unreadable history gets, for the same reason.
   */
  funderUnknown?: boolean;
  /**
   * The leaves whose SPEND key (the withdrawal and subscribe ephemeral) is
   * read, and the only ones.
   *
   * A withdrawal or subscribe derives its ephemeral from the leaf index of the
   * note being SPENT, and spending a note advances nothing — so a note 400
   * leaves below the head strands its float 400 leaves below the head, where
   * the shield's head-relative window cannot see it.
   *
   * 🚨 READING A SPEND KEY NAMES IT. A note never spent has no such account on
   * chain yet, so reading its key, or a buffer address derived from it, tells
   * the RPC which key will pay for that note's spend before the spend exists.
   * The head window used to derive the spend key of every leaf near the head
   * too, which named the future payer of any recent note the user held
   * whatever this list said; it derives shield keys only now
   * (`recoverReads.test.ts`, "default Recover names no untouched note’s spend
   * key"). `shieldClient.recoverStuckFunds` passes the notes with a spend
   * attempt or a spent mark, and every held note only on the user's own
   * labelled click.
   */
  unshieldLeafIndices?: number[];
  onProgress?: (step: string) => void;
}

/**
 * Re-derive this pool's ephemerals, close any proof buffers they still own, and
 * sweep their balances to whoever funded them.
 *
 * Safe to run at any time: an ephemeral with no buffer and no balance costs one
 * `getBalance` (plus two buffer reads inside the head window) and is skipped.
 * Without `lookback` that is one read per leaf of the tree, paced by the
 * worker's transport: slow on a large tree, but a stranded deposit at any depth
 * is found. It is NOT safe to run while a shield or
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
  const bounded = opts.lookback !== undefined;
  const windowSize = bounded ? Math.max(0, Math.floor(opts.lookback!)) : HEAD_WINDOW;
  const head = await readTreeLeafCount(connection, poolConfig);

  const recovered: RecoveredFloat[] = [];

  // `head` itself is included: a shield that was prepared but never landed was
  // derived for the current head and left its buffer behind without advancing
  // the tree.
  const window: number[] = [];
  const windowFloor = Math.max(0, head - windowSize);
  for (let leafIndex = head; leafIndex >= windowFloor; leafIndex--) {
    window.push(leafIndex);
  }

  const plan: Array<{ leafIndex: number; kind: 'shield' | 'unshield' }> = [];
  for (const leafIndex of window) plan.push({ leafIndex, kind: 'shield' });
  // Spend keys for the leaves the caller named and no others: a read names
  // the key (see `unshieldLeafIndices`). Order matters only for the log.
  const named = new Set<number>();
  for (const leafIndex of opts.unshieldLeafIndices ?? []) {
    if (Number.isInteger(leafIndex) && leafIndex >= 0 && !named.has(leafIndex)) {
      named.add(leafIndex);
      plan.push({ leafIndex, kind: 'unshield' });
    }
  }

  // [close-v1, audit v1 F71] Each key of the plan costs up to ten reads per
  // circuit now (the PDA and eight allocator attempts, F04 follow-up), so the
  // plan reports progress too, not only the deep scan below.
  const beat = heartbeat(opts.onProgress, 'Still looking for funds left on earlier attempts...');
  for (const { leafIndex, kind } of plan) {
    const found = await recoverOne(connection, poolConfig, walletSeed, owner, opts, leafIndex, kind, undefined, beat);
    if (found) recovered.push(found);
  }

  // Below the head window, down to leaf 0, unless the caller bounded the scan.
  if (!bounded && windowFloor > 0) {
    recovered.push(
      ...(await scanBelowWindow(connection, poolConfig, walletSeed, owner, opts, windowFloor - 1)),
    );
  }

  return recovered;
}

/**
 * Every SHIELD key from `top` down to leaf 0, balance-first.
 *
 * WHY EVERY LEAF. A crashed deposit's E(N) is keyed to the leaf N it was
 * prepared for, and nothing this browser keeps remembers N (the breadcrumb
 * store dies with the worker, `shieldEphemeral.ts`). Stopping anywhere above
 * leaf 0 leaves a distance past which the float is unreachable from the UI.
 *
 * WHY BALANCE-FIRST. One `getBalance` per key instead of three reads (the key
 * and its two buffer addresses): a deposit that died before its insert still
 * holds the denomination it was about to deposit, so a stranded E(N) always
 * has a balance, and only a key with one is then probed in full — buffers
 * closed, residue swept — through the same path as the head window.
 *
 * 🚨 ONE ADDRESS PER REQUEST, NEVER A BATCH. Each E(N) is derived per leaf so
 * that two deposits of the same person look unrelated; naming them together in
 * one `getMultipleAccountsInfo` hands the provider the grouping in a single
 * record (the same rule as `refreshPayouts` in `PoolPanel.tsx`). Per-key reads
 * from one IP stay correlatable by timing — the accepted RPC residual — and a
 * key that did land was already used on chain by this browser, through the
 * same provider, when its deposit was uploaded. The list of keys asked about is
 * a function of (seed, pool, head) only, never of the notes the user holds.
 */
async function scanBelowWindow(
  connection: Connection,
  poolConfig: PoolConfig,
  walletSeed: Uint8Array,
  owner: PublicKey,
  opts: RecoverFloatOptions,
  top: number,
): Promise<RecoveredFloat[]> {
  const out: RecoveredFloat[] = [];
  opts.onProgress?.('Checking the one-time keys of earlier deposits...');
  const beat = heartbeat(opts.onProgress, 'Still checking the one-time keys of earlier deposits...');
  for (let leafIndex = top; leafIndex >= 0; leafIndex--) {
    // [close-v1, audit v1 F71] A HEARTBEAT, OR THE PAGE STOPS WAITING. The
    // worker's pool jobs run under a SILENCE watchdog (`workerClient.ts`,
    // POOL_SILENCE_TIMEOUT_MS = 180 s) that only a progress message re-arms,
    // and this loop is one paced read per leaf: on a large tree it ran for
    // longer than that with nothing said, and the page reported a hang and
    // dropped the result. A line every `HEARTBEAT_MS` (or `HEARTBEAT_KEYS`
    // keys) keeps it armed. It carries no number: a count left is the leaf
    // being read, and the line just before a hit would place the user's
    // crashed deposit (`noteIdentifierTripwire.test.ts`: rendered lines name
    // no leaf).
    beat();
    const ephemeral = deriveShieldEphemeral(walletSeed, poolConfig.poolPDA, leafIndex);
    const balance = await connection.getBalance(ephemeral.publicKey, 'confirmed');
    if (balance <= 0) continue;
    const found = await recoverOne(
      connection,
      poolConfig,
      walletSeed,
      owner,
      opts,
      leafIndex,
      'shield',
      { ephemeral, balance },
      beat,
    );
    if (found) out.push(found);
  }
  return out;
}

/**
 * Close the buffers one ephemeral owns and sweep its residue, or refuse to.
 * `known` carries a key and balance the caller has just read, so the balance is
 * not asked for twice when no buffer was closed in between.
 */
async function recoverOne(
  connection: Connection,
  poolConfig: PoolConfig,
  walletSeed: Uint8Array,
  owner: PublicKey,
  opts: RecoverFloatOptions,
  leafIndex: number,
  kind: 'shield' | 'unshield',
  known?: { ephemeral: Keypair; balance: number },
  beat?: () => void,
): Promise<RecoveredFloat | null> {
  {
    const ephemeral =
      known?.ephemeral ??
      (kind === 'shield'
        ? deriveShieldEphemeral(walletSeed, poolConfig.poolPDA, leafIndex)
        : deriveUnshieldEphemeral(walletSeed, poolConfig.poolPDA, leafIndex));

    // Circuit 7 is the v4 withdrawal's and subscribe's one proof, uploaded
    // into a buffer this same key owns and alone can close
    // (`recoverReads.test.ts`, "the circuit-7 buffer a marked note’s key owns
    // is found and closed").
    const circuits =
      kind === 'shield'
        ? [CIRCUIT_MERKLE_UPDATE]
        : [CIRCUIT_POOL_COMMITMENT, CIRCUIT_MERKLE_PATH, CIRCUIT_SPEND];

    let closedBuffers = 0;
    const signer = ephemeralSigner(ephemeral, connection);

    for (const circuitId of circuits) {
      // [L2-CLIENT 2026-09-12] The pre-L2 PDA, then every address
      // `allocateProofBuffer` may have used: public attempts 0..3 and the
      // private ones derived from E's own signature, reached when a stranger
      // squatted the public ones (audit v1 F04). Probing attempt 0 alone left a
      // buffer at any later attempt unreachable (close-v1 F04 follow-up,
      // `closeV1L3RecoverFloat.test.ts`). A private address is E's alone to
      // compute; reading it names nothing E's own public key does not already.
      const candidates = [
        getProofBufferPDA(ephemeral.publicKey, circuitId)[0],
        ...(await proofBufferAddresses(signer, circuitId)),
      ];
      for (const bufferAddress of candidates) {
        beat?.();
        const info = await connection.getAccountInfo(bufferAddress);
        if (!info) continue;
        // No leaf in the line: it is rendered, and a spend's key is keyed to the
        // user's own note (`noteIdentifierTripwire.test.ts`).
        opts.onProgress?.('Closing a stranded proof buffer...');
        await closeStarkProofBuffer(bufferAddress, signer, connection);
        closedBuffers += 1;
      }
    }

    // A closed buffer returned its rent to E, so the balance read before it is
    // stale; without one, the caller's fresh read stands.
    const balance =
      known && closedBuffers === 0
        ? known.balance
        : await connection.getBalance(ephemeral.publicKey, 'confirmed');
    const sweepable = balance - SWEEP_FEE;
    if (sweepable <= 0) {
      if (closedBuffers > 0) {
        return {
          ephemeral: ephemeral.publicKey.toBase58(),
          kind,
          leafIndex,
          lamports: 0,
          closedBuffers,
          destination: null,
        };
      }
      return null;
    }

    // Only now — with money actually on the key — is the classification worth
    // its RPC calls. A pool with nothing stranded pays for none of this.
    const verdict = await resolveSweepDestination(connection, ephemeral.publicKey, owner, opts);
    if (verdict.refused) {
      opts.onProgress?.(
        `Leaving ${(sweepable / 1e9).toFixed(4)} SOL on a one-time key: ${refusalSentence(verdict.refused)}`,
      );
      return {
        ephemeral: ephemeral.publicKey.toBase58(),
        kind,
        leafIndex,
        lamports: 0,
        closedBuffers,
        destination: null,
        refused: verdict.refused,
        strandedLamports: sweepable,
        sources: verdict.sources,
      };
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
    const { signature: sig, blockhash, lastValidBlockHeight } = await sendWithFreshBlockhash(
      connection,
      tx,
      (t) => {
        t.sign(ephemeral);
        return t;
      },
      ephemeral.publicKey,
    );
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');

    return {
      ephemeral: ephemeral.publicKey.toBase58(),
      kind,
      leafIndex,
      lamports: sweepable,
      closedBuffers,
      destination: destination.toBase58(),
    };
  }
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

  // We could not find out whether a funder exists. That is NOT the same as
  // there being none, and treating it as such is how a single transient fetch
  // error sends the treasury's float — and the buyer's wallet address — onto
  // the ephemeral that signed their subscription.
  if (!funder && opts.funderUnknown) return { refused: 'unverifiable', sources: [] };

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
    // [TX-V1] raw ed25519 for 4,096-byte transaction-v1 proof chunks (`txv1.ts`).
    signBytes: async (message: Uint8Array) => nacl.sign.detached(message, ephemeral.secretKey),
    signTransaction: async (t: Transaction) => {
      if (!t.recentBlockhash) {
        const { blockhash } = await connection.getLatestBlockhash('finalized');
        t.recentBlockhash = blockhash;
      }
      if (!t.feePayer) t.feePayer = ephemeral.publicKey;
      t.sign(ephemeral);
      return t;
    },
  };
}
