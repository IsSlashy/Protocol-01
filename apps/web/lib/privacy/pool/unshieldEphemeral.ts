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
  isNullifierSpent,
  prepareUnshield,
  unshieldDenominatedStarkV3,
  type PoolConfig,
  type PrepareUnshieldResult,
  type ShieldReceipt,
  type WalletSigner,
} from './denominatedPool';

/** Domain separator — deliberately NOT the shield's. See file header. */
const UNSHIELD_EPHEMERAL_INFO = utf8ToBytes('p01:web:unshield-ephemeral:v1');

/** NullifierRecord init (~0.0009 SOL) plus margin. */
const NULLIFIER_RENT = 2_000_000;

/** Fee headroom for ~2 proofs' worth of chunk uploads plus the inner tx. */
const E_TX_FEE_BUDGET = 4_000_000;

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
  onProgress?.('Checking the note is unspent...');
  const spent = await isNullifierSpent(
    connection,
    poolConfig.poolPDA,
    receipt.nullifierPreimage,
    receipt.secret,
  );
  if (spent) {
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
