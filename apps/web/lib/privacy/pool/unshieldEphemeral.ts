/**
 * unshieldEphemeral — withdraw a note from the denominated pool without asking
 * the user's wallet to sign the proof uploads.
 *
 * Same shape as `shieldEphemeral.ts`, and for the same reason: an unshield
 * uploads TWO STARK proofs (C1 pool_commitment + C3 merkle_path), each in
 * 1000-byte chunks, and every one of those transactions is signed by the proof
 * buffer's authority. A deterministic ephemeral signs them; the user's wallet
 * signs only the pre-fund.
 *
 * A DIFFERENT ephemeral from the shield's
 * ─────────────────────────────────────────
 * The shield ephemeral is the on-chain depositor. If the same key also
 * performed the withdrawal, deposit and withdrawal would carry an identical
 * signer and the pool would hide nothing at all — the one property this step
 * exists to provide. The derivation is domain-separated so the two can never
 * coincide.
 *
 * WHAT THIS DOES NOT HIDE — read before writing any copy about it
 * ────────────────────────────────────────────────────────────────
 * The V3 withdrawal instruction takes the note commitment as a PUBLIC argument
 * (`buildUnshieldDenominatedStarkV3Ix` writes `starkCommitment` at instruction
 * byte offset 80), and the deposit emitted that identical value in its
 * `LeafInserted` event. So an observer with only public data matches a
 * withdrawal to its exact deposit. Verified on devnet 2026-07-25: unshield
 * `2FhzBLHc…` carries 1126946528953530644, the commitment the shield logged for
 * leaf 28.
 *
 * The effective anonymity set is therefore ONE, regardless of how many notes
 * the pool holds. The domain separation below removes the signer correlation,
 * which is necessary but nowhere near sufficient; it does nothing about the
 * commitment argument. Fixing this needs a program change so membership is
 * proven without revealing which leaf — the C3 proof already proves membership,
 * so publishing the leaf defeats the point of proving it.
 *
 * What the withdrawal no longer publishes is `min_epoch` at byte offset 72: it
 * is pinned to 0 on every path (`UNSHIELD_MIN_EPOCH`). It used to carry the
 * note's third commitment input, which is now a 63-bit secret blinding, so
 * publishing it handed an observer the value that makes the commitment
 * recomputable from the nullifier.
 *
 * Until that lands, this path buys amount quantisation and a post-quantum note,
 * NOT unlinkability. Do not describe it as unlinkable anywhere.
 *
 * THE RECIPIENT IS NOT ALLOWED TO BE THE PRE-FUNDER
 * ─────────────────────────────────────────────────
 * `executeUnshield` refuses `recipient === ownerPubkey`. The reasoning is at the
 * check itself; the short version is that the wallet already appears on-chain
 * funding this ephemeral, and paying the note back to it puts the wallet in the
 * withdrawal too. That refusal removes the payee leak and NOTHING else — the
 * `owner -> E` pre-fund transfer is untouched and still ties the wallet to this
 * withdrawal. Do not read a fresh payout address as unlinkability.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { sendWithFreshBlockhash } from './sendTx';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { prepareUnshieldFromPath, type StoredMerklePath } from './unshieldFromPath';
import { jitterPrefund } from './prefundAmount';
import {
  fetchSpentNullifierSet,
  isNullifierSpentInSet,
  prepareUnshield,
  prepareUnshieldV4,
  unshieldDenominatedStarkV3,
  unshieldDenominatedStarkV4,
  buildRelayedUnshieldV4Batch,
  relayUnshieldV4,
  type PoolConfig,
  type PrepareUnshieldResult,
  type PrepareUnshieldV4Result,
  type ShieldReceipt,
  type WalletSigner,
} from './denominatedPool';

/** Domain separator — deliberately NOT the shield's. See file header. */
const UNSHIELD_EPHEMERAL_INFO = utf8ToBytes('p01:web:unshield-ephemeral:v1');

/**
 * NullifierRecord rent and the chunk-upload fee budget.
 *
 * ⛔ MOVED, NOT COPIED, on 2026-08-27. Both now live in `subscribeFloat.ts`
 * and are re-exported here unchanged, so every existing caller is untouched.
 * They moved because the SubscribePanel cost disclosure has to price the same
 * float this file transfers, and a panel cannot import this module without
 * dragging the whole pool stack into the page bundle. A second declaration over
 * there is exactly how the disclosed figure and the transferred figure drift
 * apart in silence — which is the defect being repaired.
 */
import { E_TX_FEE_BUDGET, NULLIFIER_RENT } from './subscribeFloat';

export { E_TX_FEE_BUDGET, NULLIFIER_RENT };

/**
 * See shieldEphemeral.ts for the full reasoning: exactly the sweep tx's own fee,
 * so E lands on zero. Any larger residue leaves this 0-data system account
 * rent-paying, which the runtime rejects outright — that made every sweep fail.
 */
const SWEEP_FEE = 5_000;

/**
 * Derive the withdrawal ephemeral from the pool seed and the note's leaf index.
 * Deterministic, so a crashed unshield can be swept by re-deriving it.
 */
export function deriveUnshieldEphemeral(
  walletSeed: Uint8Array,
  poolPDA: PublicKey,
  leafIndex: number,
): Keypair {
  const idx = new Uint8Array(4);
  new DataView(idx.buffer).setUint32(0, leafIndex, true);
  const info = concatBytes(UNSHIELD_EPHEMERAL_INFO, poolPDA.toBytes(), idx);
  return Keypair.fromSeed(hkdf(sha256, walletSeed, undefined, info, 32));
}

export interface PreparedUnshield {
  jobId: string;
  poolConfig: PoolConfig;
  receipt: ShieldReceipt;
  ephemeral: Keypair;
  /** What to actually transfer — jittered, so it is not a searchable constant. */
  requiredLamports: number;
  /**
   * The exact floor, before jitter. Exists so a caller that has MORE to add —
   * subscribe adds the vault's rent — can jitter the complete sum once instead
   * of adding a constant to an already-jittered figure. Doing the latter would
   * both waste float and undo the rounding that makes the amount look ordinary.
   *
   * ⛔ Never transfer this. It is the value that was identical on 4 of 4
   * measured devnet runs.
   */
  rawRequiredLamports: number;
  prepared: PrepareUnshieldResult;
}

/**
 * Rebuild the Merkle proof, prove C1 + C3, and price the pre-fund. Nothing is
 * signed or submitted, so a failure here costs nothing.
 *
 * `prepareUnshield` runs its own pre-flight: it refuses to proceed unless the
 * rebuilt root is in the pool's current-or-historical root ring, which is what
 * stops us burning proof rent on a guaranteed rejection.
 */
export async function prepareUnshieldJob(
  receipt: ShieldReceipt,
  poolConfig: PoolConfig,
  connection: Connection,
  walletSeed: Uint8Array,
  onProgress?: (step: string) => void,
  storedPath?: StoredMerklePath,
): Promise<PreparedUnshield> {
  // Fail fast and free if this note is already spent — otherwise the on-chain
  // NullifierRecord init would reject after the whole upload.
  /**
   * \U0001f6a8 ASK ABOUT THE POOL, NOT ABOUT THIS NOTE.
   *
   * This was `isNullifierSpent`, a bare `getAccountInfo` on the nullifier PDA
   * derived from THIS note. On the relayed path that single request undoes the
   * whole detour: the browser asks the RPC provider about an account that DOES
   * NOT EXIST YET, and minutes later the relayer's transaction creates exactly
   * it, from a different IP. Joining its own two log lines gives the provider
   * "this IP caused this spend, of this note, out of this pool" -- the edge the
   * relayed withdrawal exists to delete, handed over for free, and paid even
   * when the job then aborts.
   *
   * \u26a0 The comment that used to sanction it said the nullifier "is about to
   * be published on chain anyway". That is true on the DIRECT path, where the
   * browser submits the transaction itself and is already named as fee payer.
   * It is false on the relayed one, where the relayer publishes it -- and the
   * pointed query was written before that path existed.
   *
   * `fetchSpentNullifierSet` answers the identical question with a
   * `getProgramAccounts` over the POOL: it names no note, is byte-identical
   * whoever asks it, and is a request every client already makes in order to
   * scan. The decision is then local, with no further network.
   */
  onProgress?.('Checking the note is unspent...');
  const spentSet = await fetchSpentNullifierSet(connection, poolConfig.poolPDA);
  if (isNullifierSpentInSet(spentSet, poolConfig.poolPDA, receipt.nullifierPreimage, receipt.secret)) {
    throw new Error('This note has already been withdrawn.');
  }

  // Prefer the path captured when this note was shielded: it needs no
  // transaction history, which an RPC may no longer serve. Returns null if its
  // root has aged out of the pool's 100-root ring, in which case we rebuild
  // from history as before.
  let prepared = storedPath
    ? await prepareUnshieldFromPath(receipt, poolConfig, connection, storedPath, onProgress)
    : null;
  if (storedPath && !prepared) {
    onProgress?.('Stored Merkle root has aged out — rebuilding from history...');
  }
  if (!prepared) {
    prepared = await prepareUnshield(receipt, poolConfig, connection, onProgress);
  }

  onProgress?.('Pricing the withdrawal...');
  const [r1, r3] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(83 + prepared.c1ProofResult.proofSize),
    connection.getMinimumBalanceForRentExemption(83 + prepared.c3ProofResult.proofSize),
  ]);
  // C1 and C3 buffers are held open at the same time — the handler reads both
  // in one transaction — so the peak float is their sum.
  //
  // Jittered before it leaves this function so no caller can accidentally use
  // the bare figure: the exact sum is a pure function of the circuit geometry
  // and was identical on 4 of 4 measured devnet runs, which makes one `memcmp`
  // over transfer amounts an enumeration of every operation this protocol has
  // ever done. The surplus comes back on the sweep; see `prefundAmount.ts`.
  const rawRequiredLamports = r1 + r3 + NULLIFIER_RENT + E_TX_FEE_BUDGET;
  const requiredLamports = jitterPrefund(rawRequiredLamports);

  const ephemeral = deriveUnshieldEphemeral(walletSeed, poolConfig.poolPDA, receipt.leafIndex);

  return {
    jobId: `unshield:${poolConfig.poolPDA.toBase58()}:${receipt.leafIndex}`,
    poolConfig,
    receipt,
    ephemeral,
    requiredLamports,
    rawRequiredLamports,
    prepared,
  };
}

/**
 * Upload both proofs and withdraw to `recipient`. The caller must already have
 * funded the ephemeral with `requiredLamports`.
 *
 * ⚠️ `ownerPubkey` IS IDENTITY, `sweepTo` IS MONEY — they used to be one thing
 * and separating them is load-bearing.
 *
 * `ownerPubkey` means THE USER'S WALLET, always, whoever paid. The refusal below
 * (`recipient.equals(ownerPubkey)`) is justified by that meaning and by nothing
 * else: it is the line that stops the note's whole value landing in the wallet,
 * it regressed once already, and repurposing `ownerPubkey` to carry the funder
 * would disable it silently while every test still passed.
 *
 * `sweepTo` is where the residual rent goes. Omitted means "sweep home", which
 * is correct for a wallet-funded job and WRONG for any other kind: sweeping home
 * after a third party paid spends someone else's SOL and still writes the wallet
 * into the newest transaction of the ephemeral's life.
 */
export async function executeUnshield(
  ctx: PreparedUnshield,
  connection: Connection,
  recipient: PublicKey,
  ownerPubkey: PublicKey,
  onProgress?: (step: string) => void,
  sweepTo?: PublicKey,
): Promise<{ txSig: string }> {
  const { ephemeral, poolConfig, prepared, receipt } = ctx;

  const eSigner: WalletSigner = {
    publicKey: ephemeral.publicKey,
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

  try {
    // THE PRE-FUNDER MAY NOT ALSO BE THE PAYEE.
    //
    // `ownerPubkey` is by construction the wallet that pre-funded this
    // ephemeral: `shieldClient.unshieldFromPool` builds `owner -> E` and has the
    // wallet sign it, then passes the same `owner` here as the sweep target. So
    // that transfer already names the wallet on-chain. Paying the withdrawal
    // back to it puts the wallet in the withdrawal transaction as well, and the
    // note's whole value lands in it — which is what /pay shipped until
    // 2026-08-04 (`PoolPanel.tsx:125` passed `owner` as `recipient`).
    //
    // Refusing is deliberately absolute rather than a warning: this is the exact
    // line that regressed once, it is one word to get wrong, and every caller
    // has a derived payout address available (`shieldClient.derivePoolPayoutKeypair`).
    // A third-party recipient is still allowed — only the pre-funder is refused.
    //
    // It lives INSIDE the try for the same reason the underfunded check below
    // does: the pre-fund has ALREADY landed by the time this function runs, so
    // throwing before the `finally` would strand ~1 SOL of it on the ephemeral.
    if (recipient.equals(ownerPubkey)) {
      throw new Error(
        'Refusing to withdraw to the wallet that funded this withdrawal — that names it ' +
          'on-chain as the pool payee. Pass a derived payout address as the recipient and ' +
          'move the funds on separately.',
      );
    }

    // The underfunded check lives INSIDE the try deliberately — see the same
    // reasoning in shieldEphemeral.ts. Throwing before the try skips the
    // `finally` sweep below, so a merely-lagging RPC read (pre-fund confirmed
    // on chain but not yet visible here) strands the whole withdrawal float on
    // an ephemeral instead of returning it.
    const funded = await connection.getBalance(ephemeral.publicKey, 'confirmed');
    if (funded < ctx.requiredLamports) {
      throw new Error(
        `The withdrawal signer is underfunded (${funded} of ${ctx.requiredLamports} lamports). ` +
          'The pre-fund transaction may not have confirmed yet — retry in a moment.',
      );
    }

    const txSig = await unshieldDenominatedStarkV3(
      receipt,
      poolConfig,
      recipient,
      prepared,
      eSigner,
      connection,
      onProgress,
    );
    return { txSig };
  } finally {
    try {
      const eBal = await connection.getBalance(ephemeral.publicKey, 'confirmed');
      const sweepable = eBal - SWEEP_FEE;
      if (sweepable > 0) {
        // Default home, and say which of the two happened. A user told
        // "returning rent to your wallet" when it went to a treasury has been
        // handed a false receipt, and this is the only line about it they see.
        const target = sweepTo ?? ownerPubkey;
        onProgress?.(
          target.equals(ownerPubkey)
            ? 'Returning recovered rent to your wallet...'
            : 'Returning recovered rent to the funder that paid for this job...',
        );
        const sweepTx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: ephemeral.publicKey,
            toPubkey: target,
            lamports: sweepable,
          }),
        );
        const { signature: sig, blockhash, lastValidBlockHeight } = await sendWithFreshBlockhash(
          connection,
          sweepTx,
          (t) => {
            t.sign(ephemeral);
            return t;
          },
          ephemeral.publicKey,
        );
        await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      }
    } catch (sweepErr: unknown) {
      console.warn(
        '[pool/unshield] ephemeral sweep failed; the key is re-derivable, funds recoverable:',
        sweepErr instanceof Error ? sweepErr.message : String(sweepErr),
      );
    }
  }
}

// ===========================================================================
// CIRCUIT 7 — the same job, on one proof, publishing no commitment
// ===========================================================================

/**
 * The v4 twin of `PreparedUnshield`.
 *
 * ⛔ IT CARRIES THE RECIPIENT AND THE v3 ONE DOES NOT. That is not tidiness,
 * it is the whole difference between the two circuits. `sha256(recipient)` is
 * four of circuit 7's six public inputs, so a v4 proof is bound to ONE payee
 * before it is built. `unshieldDenominatedStarkV4` refuses a prepared-for-A /
 * executed-for-B mismatch, and carrying the payee in the context means
 * `executeUnshieldV4` cannot be handed a different one at all.
 */
export interface PreparedUnshieldV4 {
  jobId: string;
  poolConfig: PoolConfig;
  receipt: ShieldReceipt;
  ephemeral: Keypair;
  /** The payee circuit 7 is bound to. Fixed at prove time, not at send time. */
  recipient: PublicKey;
  requiredLamports: number;
  rawRequiredLamports: number;
  prepared: PrepareUnshieldV4Result;
}

/**
 * Prove the spend on ONE circuit-7 trace instead of the C1 + C3 pair.
 *
 * ⛔ THIS IS A SIBLING, NOT A REPLACEMENT, AND THAT IS DELIBERATE.
 * `prepareUnshieldJob` is reused VERBATIM by `subscribeEphemeral.ts` and by
 * `subscribePrivateStark.ts`, and a note whose blinding is unknown — the unspent
 * leaf 30 among them — can be spent nowhere else. Routing is per CALLER. It is
 * not a migration.
 *
 * 🚨 UPDATED 2026-08-27. The reason originally given here was "there is no
 * `subscribe_private_stark_v4` on chain". THERE NOW IS
 * (`programs/zk_shielded/src/lib.rs:549`), and the subscribe path is wired to it
 * through its OWN sibling pair, `prepareSubscribeJobV4` / `executeSubscribeV4`.
 * That does not make this function shareable, and the real reason is stronger:
 * the two v4 instructions bind DIFFERENT digests — this one `sha256(recipient)`,
 * the subscribe a 132-byte domain-tagged composite over the vault and the
 * billing terms — so a proof built here can never satisfy that handler.
 *
 * Three real differences from the v3 job, all consequences of the circuit
 * rather than choices:
 *
 *   the payee is an INPUT      it is bound into the transcript, so it must be
 *                              known before proving. The v3 job only needed it
 *                              at send time.
 *   ONE buffer, not two        C1 and C3 are held open together, so the v3
 *                              float is their sum. C7 is a single proof, so the
 *                              pre-fund is materially smaller — priced here
 *                              rather than assumed.
 *   no stored-path shortcut    `prepareUnshieldV4` rebuilds from history and
 *                              has no `storedPath` fast path. A note whose root
 *                              aged out of the ring cannot take the shortcut the
 *                              v3 job takes, so this is slower and needs an RPC
 *                              that still serves the history.
 *
 * The payee refusal moved EARLIER on purpose. In v3 it lives inside `execute`,
 * because that is the first moment the recipient is known. Here it is known
 * before we prove, and proving costs about 5.5 seconds and a real upload — so
 * refusing at prove time returns the same answer for free.
 */
export async function prepareUnshieldJobV4(
  receipt: ShieldReceipt,
  recipient: PublicKey,
  ownerPubkey: PublicKey,
  poolConfig: PoolConfig,
  connection: Connection,
  walletSeed: Uint8Array,
  onProgress?: (step: string) => void,
  storedPath?: StoredMerklePath,
): Promise<PreparedUnshieldV4> {
  // Same refusal as `executeUnshield`, same reason, moved to the first moment it
  // can be made. See the long note at that call site: paying the withdrawal back
  // to the wallet that pre-funded it writes that wallet into the withdrawal
  // transaction, which is what /pay shipped until 2026-08-04.
  if (recipient.equals(ownerPubkey)) {
    throw new Error(
      'Refusing to withdraw to the wallet that funded this withdrawal — that names it ' +
        'on-chain as the pool payee. Pass a derived payout address as the recipient and ' +
        'move the funds on separately.',
    );
  }

  // 🚨 A PRE-BLINDING NOTE GAINS NOTHING FROM CIRCUIT 7, AND SAYING OTHERWISE IS
  // THE LIE. Refuse it here so the claim on screen is true by construction
  // rather than by promise.
  //
  // The commitment is `poseidon(nullifier, poseidon(blinding, token_mint))`
  // (`createCommitmentV3`). Circuit 7 keeps the commitment off the wire, but the
  // NULLIFIER is published — it is the double-spend guard and a PDA seed, it
  // cannot be hidden — and `token_mint` is the pool's, public. So `blinding` is
  // the only unknown, and for a note deposited before `noteBlinding` landed it
  // is the deposit EPOCH: `slotToEpoch(slot)`, five digits today. An observer
  // enumerates a few thousand candidates, rebuilds the commitment, matches the
  // leaf, and reaches the deposit and its payer. `noteBlinding.ts` opens with
  // exactly this attack and the words "Anonymity set: one".
  //
  // The circuit cannot close it: `blinding` is a private witness and
  // `stark/src/air/spend.rs:908-913` forbids constraining it — a boundary
  // assertion, a range check, a bit decomposition or promoting it to a public
  // input all "brick that note with no recovery path". So it is a ROUTING
  // decision, and this is where it belongs.
  //
  // MEASURED 2026-08-26: epoch = slot/7200 = 67,838, five digits. A blinding
  // drawn by the PRF is 63 bits, up to 9.2e18. A threshold at 2**32 sits 63,000x
  // above any real epoch, and a PRF value landing below it has probability
  // 2**-31 — about one in 2.1 billion. The two populations do not overlap in
  // practice.
  //
  // ⛔ IT MUST NOT BLOCK THE NOTE. The message carries the needle
  // `circuit 7 needs at least` so `isV4RebuildFailure` in poolHandlers.ts routes
  // it to the C1 + C3 pair, which publishes the commitment and is honest about
  // it. One such note exists and is unspent: leaf 30 of the 0.1 SOL pool
  // (`poolNotes.ts`, the legacy epoch search that must never be removed).
  const LEGACY_BLINDING_CEILING = 2n ** 32n;
  if (receipt.noteBlinding < LEGACY_BLINDING_CEILING) {
    throw new Error(
      'circuit 7 needs at least a randomised blinding, and this note carries its deposit ' +
        `epoch (${receipt.noteBlinding}) instead — it predates commitment blinding. Proving ` +
        'it on circuit 7 would hide the commitment while leaving the leaf recoverable from ' +
        'the published nullifier by trying a few thousand epochs, which is worse than the ' +
        'C1 + C3 pair only in that it looks private. Falling back to the pair.',
    );
  }

  /**
   * \U0001f6a8 ASK ABOUT THE POOL, NOT ABOUT THIS NOTE.
   *
   * This was `isNullifierSpent`, a bare `getAccountInfo` on the nullifier PDA
   * derived from THIS note. On the relayed path that single request undoes the
   * whole detour: the browser asks the RPC provider about an account that DOES
   * NOT EXIST YET, and minutes later the relayer's transaction creates exactly
   * it, from a different IP. Joining its own two log lines gives the provider
   * "this IP caused this spend, of this note, out of this pool" -- the edge the
   * relayed withdrawal exists to delete, handed over for free, and paid even
   * when the job then aborts.
   *
   * \u26a0 The comment that used to sanction it said the nullifier "is about to
   * be published on chain anyway". That is true on the DIRECT path, where the
   * browser submits the transaction itself and is already named as fee payer.
   * It is false on the relayed one, where the relayer publishes it -- and the
   * pointed query was written before that path existed.
   *
   * `fetchSpentNullifierSet` answers the identical question with a
   * `getProgramAccounts` over the POOL: it names no note, is byte-identical
   * whoever asks it, and is a request every client already makes in order to
   * scan. The decision is then local, with no further network.
   */
  onProgress?.('Checking the note is unspent...');
  const spentSet = await fetchSpentNullifierSet(connection, poolConfig.poolPDA);
  if (isNullifierSpentInSet(spentSet, poolConfig.poolPDA, receipt.nullifierPreimage, receipt.secret)) {
    throw new Error('This note has already been withdrawn.');
  }

  const prepared = await prepareUnshieldV4(receipt, recipient, poolConfig, connection, onProgress, storedPath);

  onProgress?.('Pricing the withdrawal...');
  // ONE buffer. The v3 job adds two rent figures here because the handler reads
  // both proofs in one transaction and they are open at the same time; circuit 7
  // has nothing to pair with.
  const r7 = await connection.getMinimumBalanceForRentExemption(
    83 + prepared.c7ProofResult.proofSize,
  );
  const rawRequiredLamports = r7 + NULLIFIER_RENT + E_TX_FEE_BUDGET;
  // Jittered for the same reason as the v3 job, and it matters MORE here: a
  // single-buffer float is an even cleaner fingerprint than the pair's sum,
  // because the proof size is a pure function of the circuit and does not move.
  const requiredLamports = jitterPrefund(rawRequiredLamports);

  const ephemeral = deriveUnshieldEphemeral(walletSeed, poolConfig.poolPDA, receipt.leafIndex);

  return {
    jobId: `unshield-v4:${poolConfig.poolPDA.toBase58()}:${receipt.leafIndex}`,
    poolConfig,
    receipt,
    ephemeral,
    recipient,
    requiredLamports,
    rawRequiredLamports,
    prepared,
  };
}

/**
 * Send the v4 withdrawal from the pre-funded ephemeral, then sweep the residue.
 *
 * Takes no `recipient`: it is already in `ctx`, bound into the proof, and
 * checked again inside `unshieldDenominatedStarkV4` before a lamport moves. The
 * v3 twin takes one because its proof does not name a payee.
 */
export async function executeUnshieldV4(
  ctx: PreparedUnshieldV4,
  connection: Connection,
  ownerPubkey: PublicKey,
  onProgress?: (step: string) => void,
  sweepTo?: PublicKey,
): Promise<{ txSig: string }> {
  const { ephemeral, poolConfig, prepared, recipient } = ctx;

  const eSigner: WalletSigner = {
    publicKey: ephemeral.publicKey,
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

  try {
    // The payee refusal already ran in `prepareUnshieldJobV4`, before the proof
    // was built. Restated here because this function is exported and a future
    // caller may hold a context it did not prepare — and because the check is
    // one comparison standing against a defect that has shipped once.
    if (recipient.equals(ownerPubkey)) {
      throw new Error(
        'Refusing to withdraw to the wallet that funded this withdrawal — that names it ' +
          'on-chain as the pool payee.',
      );
    }

    // INSIDE the try, like the v3 twin: the pre-fund has already landed by now,
    // so throwing before the `finally` would strand it on the ephemeral.
    const funded = await connection.getBalance(ephemeral.publicKey, 'confirmed');
    if (funded < ctx.requiredLamports) {
      throw new Error(
        `The withdrawal signer is underfunded (${funded} of ${ctx.requiredLamports} lamports). ` +
          'The pre-fund transaction may not have confirmed yet — retry in a moment.',
      );
    }

    const txSig = await unshieldDenominatedStarkV4(
      poolConfig,
      recipient,
      prepared,
      eSigner,
      connection,
      onProgress,
    );
    return { txSig };
  } finally {
    try {
      const eBal = await connection.getBalance(ephemeral.publicKey, 'confirmed');
      const sweepable = eBal - SWEEP_FEE;
      if (sweepable > 0) {
        // Say which of the two happened, for the same reason the v3 twin does:
        // a user told "returning rent to your wallet" when it went elsewhere has
        // been handed a false receipt, and this is the only line about it.
        const target = sweepTo ?? ownerPubkey;
        onProgress?.(
          target.equals(ownerPubkey)
            ? 'Returning recovered rent to your wallet...'
            : 'Returning recovered rent to the funder that paid for this job...',
        );
        const sweepTx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: ephemeral.publicKey,
            toPubkey: target,
            lamports: sweepable,
          }),
        );
        const { signature: sig, blockhash, lastValidBlockHeight } = await sendWithFreshBlockhash(
          connection,
          sweepTx,
          (t) => {
            t.sign(ephemeral);
            return t;
          },
          ephemeral.publicKey,
        );
        await connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          'confirmed',
        );
      }
    } catch (sweepErr: unknown) {
      // A failed sweep must never mask the withdrawal's own outcome, and it must
      // never be silent either — the key is derived, so saying so is what makes
      // the residue recoverable rather than lost.
      console.warn(
        '[pool/unshield-v4] ephemeral sweep failed; the key is re-derivable, funds recoverable:',
        sweepErr instanceof Error ? sweepErr.message : String(sweepErr),
      );
    }
  }
}

/**
 * The same withdrawal, submitted and paid for by a stranger.
 *
 * ⛔ SIBLING OF `executeUnshieldV4`, NOT A MODE OF IT. It shares no line with
 * it, and that is the point: this path has NO ephemeral, NO pre-fund and NO
 * sweep. The buyer signs nothing and pays nothing — the relayer is paid out of
 * the protocol fee the pool already charges, so no lamport travels from the
 * buyer to the submitter and there is no edge to walk back.
 *
 * 🧠 The same prepared context feeds both paths. Circuit 7 binds the RECIPIENT,
 * not the payer, so a proof is submitter-agnostic; only the proof BUFFER is
 * keyed to whoever uploads it, and that is created here rather than at prepare
 * time. That is why `prepareUnshieldJobV4` needed no change at all.
 *
 * ⚠️ NO FALLBACK. If the relayer refuses or dies, this throws and the
 * withdrawal did not happen. The v3 wrapper fell back to direct submission on
 * any error, which is why its privacy guarantee held only when the
 * infrastructure felt well and why the buyer was never told which of the two
 * had occurred.
 */
export async function executeUnshieldV4Relayed(
  ctx: PreparedUnshieldV4,
  connection: Connection,
  relayerUrl: string,
  onProgress?: (step: string) => void,
): Promise<{ txSig: string }> {
  const { poolConfig, prepared, recipient } = ctx;

  // 🚨 THE NODE SAYS WHO IT IS, rather than a third environment variable that
  // can drift from the key actually running. Safe by construction: a hostile
  // URL that names some other key cannot steal anything — the payee is bound by
  // the proof and the reward comes out of the protocol fee, not the buyer's
  // share — so the worst it buys is a wasted round trip.
  onProgress?.('Asking the relayer who it is...');
  const base = relayerUrl.replace(/\/$/, '');
  let operator: PublicKey;
  try {
    const health = await fetch(`${base}/health`, { cache: 'no-store' });
    const body = (await health.json()) as { operator?: string };
    if (!body?.operator) throw new Error('no `operator` field');
    operator = new PublicKey(body.operator);
  } catch (e) {
    throw new Error(
      `Could not read the relayer's operator key from ${base}/health: ` +
        `${e instanceof Error ? e.message : String(e)}. Nothing was sent.`,
    );
  }

  onProgress?.('Building the withdrawal in the relayer’s name...');
  const { transactions } = await buildRelayedUnshieldV4Batch(
    poolConfig,
    recipient,
    prepared,
    operator,
    connection,
  );

  const { spendSignature } = await relayUnshieldV4(base, transactions, onProgress);
  return { txSig: spendSignature };
}
