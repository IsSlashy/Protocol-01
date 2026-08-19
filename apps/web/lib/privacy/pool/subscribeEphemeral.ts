/**
 * subscribeEphemeral — open a subscription vault from a shielded note without
 * asking the user's wallet to sign the proof uploads.
 *
 * This is the WITHDRAWAL path with a different final instruction. Both upload
 * the same two STARK proofs — C1 (pool_commitment) and C3 (merkle_path) — in
 * 1000-byte chunks, and every one of those transactions is signed by the proof
 * buffer's authority. `subscribe_private_stark` requires both buffers and checks
 * their circuit ids at `programs/zk_shielded/src/instructions/subscribe_private_stark.rs:233`
 * (C1, circuit 1) and `:285` (C3, circuit 3). An older comment in the extension
 * calls this "the C3-free path"; it is wrong against the deployed program.
 *
 * So `prepareSubscribeJob` REUSES `prepareUnshieldJob` verbatim rather than
 * re-deriving anything: same nullifier pre-check, same stored-Merkle-path
 * shortcut, same proof pair, same ephemeral.
 *
 * WHY THE SAME EPHEMERAL AS A WITHDRAWAL, DELIBERATELY
 * ────────────────────────────────────────────────────
 * `deriveUnshieldEphemeral(seed, pool, leafIndex)` is reused as-is. That is not
 * laziness: `recoverFloat.ts:83-87` sweeps exactly two derivations per leaf,
 * 'shield' and 'unshield'. A subscribe that dies between the pre-fund and the
 * buffer close strands ~1 SOL of proof-buffer rent on its ephemeral, and rent is
 * only reclaimable by the key that opened the buffer. Giving subscribe its own
 * domain separator would put that float outside the only recovery path this app
 * has, until someone remembered to extend it. A note is spent once, so the two
 * uses of the key are mutually exclusive anyway.
 *
 * WHAT THIS DOES NOT HIDE — read before writing any copy about it
 * ───────────────────────────────────────────────────────────────
 * Everything the unshield header says still applies here. `stark_commitment` is
 * a PUBLIC instruction argument (byte offset 160, `SUBSCRIBE_ARG_OFFSETS`) and
 * the deposit emitted that identical value in its `LeafInserted` event, so an
 * observer with only public data matches this subscription to the exact deposit
 * that funded it. The effective anonymity set is ONE.
 *
 * What subscribing DOES buy over a public subscription is that the vault is
 * keyed by `subscriber_commitment` rather than by a wallet pubkey, so the vault
 * address does not name the subscriber, and the payer is a one-shot ephemeral
 * rather than the user's wallet. Do not describe it as unlinkable.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { sendWithFreshBlockhash } from './sendTx';

import type { StoredMerklePath } from './unshieldFromPath';
import { prepareUnshieldJob, type PreparedUnshield } from './unshieldEphemeral';
import { subscribePrivateStark } from './subscribePrivateStark';
import { jitterPrefund } from './prefundAmount';
import type {
  PoolConfig,
  PrepareUnshieldResult,
  ShieldReceipt,
  WalletSigner,
} from './denominatedPool';

/**
 * `SubscriptionVault::LEN` — 361 bytes, summed field by field at
 * `programs/zk_shielded/src/state/subscription_vault.rs:135-153`.
 *
 * The vault is `init, payer = payer` (`subscribe_private_stark.rs:85-96`), and
 * `payer` is the ephemeral, so this rent comes out of the pre-fund on top of the
 * two proof buffers and the NullifierRecord. Under-pricing it does not fail
 * cheaply: the ephemeral has already uploaded ~150 chunks by the time the
 * subscribe instruction runs out of lamports.
 *
 * Unlike the buffers, this rent does NOT come back — the vault is a real account
 * that stays open until `claim_period` closes it on the final claim.
 */
export const SUBSCRIPTION_VAULT_LEN = 361;

/**
 * Exactly the sweep transaction's own fee, so the ephemeral lands on zero. Any
 * larger residue leaves a 0-data system account rent-paying, which the runtime
 * rejects outright — that made every sweep fail. Same constant, same reason, as
 * `unshieldEphemeral.ts`.
 */
const SWEEP_FEE = 5_000;

export interface PreparedSubscribe {
  jobId: string;
  poolConfig: PoolConfig;
  receipt: ShieldReceipt;
  ephemeral: Keypair;
  /** What to transfer — jittered, so it is not a searchable constant. */
  requiredLamports: number;
  /** The exact floor before jitter. ⛔ Never transfer this; see `prefundAmount.ts`. */
  rawRequiredLamports: number;
  prepared: PrepareUnshieldResult;
}

/**
 * Prove C1 + C3 and price the pre-fund. Nothing is signed or submitted, so a
 * failure here costs nothing.
 *
 * Everything expensive is `prepareUnshieldJob`'s: it refuses to proceed if the
 * note is already spent, prefers the Merkle path captured at shield time, and
 * falls back to rebuilding from event history. The only subscribe-specific work
 * is the extra rent and re-keying the job id so a subscribe can never be handed
 * to the withdrawal executor by a colliding key.
 */
export async function prepareSubscribeJob(
  receipt: ShieldReceipt,
  poolConfig: PoolConfig,
  connection: Connection,
  walletSeed: Uint8Array,
  onProgress?: (step: string) => void,
  storedPath?: StoredMerklePath,
): Promise<PreparedSubscribe> {
  const base: PreparedUnshield = await prepareUnshieldJob(
    receipt,
    poolConfig,
    connection,
    walletSeed,
    onProgress,
    storedPath,
  );

  onProgress?.('Pricing the subscription vault...');
  const vaultRent = await connection.getMinimumBalanceForRentExemption(SUBSCRIPTION_VAULT_LEN);

  // Jitter the COMPLETE sum, from the raw floor — not `base.requiredLamports`,
  // which is already jittered. Adding the vault's rent to a jittered figure
  // would spend a second round of float and, worse, land on a number that is
  // neither round nor searchable-resistant: the whole point of rounding up to a
  // whole hundredth of a SOL is that 1.05 is an amount a human sends and
  // 1_038_231_712 is not.
  const rawRequiredLamports = base.rawRequiredLamports + vaultRent;

  return {
    ...base,
    jobId: `subscribe:${poolConfig.poolPDA.toBase58()}:${receipt.leafIndex}`,
    rawRequiredLamports,
    requiredLamports: jitterPrefund(rawRequiredLamports),
  };
}

export interface SubscribeExecuteParams {
  /** The user's wallet. Identity only — it is NOT necessarily what funded the
   *  ephemeral, and since `sweepTo` exists it is not necessarily what gets the
   *  residue back either. */
  ownerPubkey: PublicKey;
  /**
   * Where the residual rent goes when the job ends. Defaults to `ownerPubkey`,
   * which is what a wallet-funded job wants.
   *
   * ⚠️ It must point at WHOEVER PAID. A sweep to the user's wallet after a
   * third party pre-funded does two wrong things at once: it hands them
   * ~1.03 SOL that is not theirs, and it re-creates on chain exactly the edge
   * the third-party funding existed to remove — probe P6 reads the newest
   * transaction of the ephemeral's life, and that transaction is this sweep.
   * Funding through the relayer while sweeping home is strictly worse than not
   * using the relayer at all, because it costs someone else's SOL to achieve
   * nothing.
   */
  sweepTo?: PublicKey;
  /** Merchant who will be able to claim each period. */
  retailer: PublicKey;
  /** Per-period amount, in the pool token's smallest unit. */
  rate: bigint;
  /** Slots between claimable periods. The program rejects 0. */
  intervalSlots: bigint;
  /**
   * Circuit-0 (`subscriber_ownership`) commitment over the note secret. The
   * vault PDA is seeded on it, so it is what lets the subscriber later prove
   * ownership without naming a wallet.
   *
   * Passed in rather than derived here because deriving it needs the STARK wasm,
   * and the caller computes it during PREPARE — before the wallet has moved any
   * money — so a wasm failure costs nothing. See the comment on
   * `handlePoolSubscribePrepare` in `worker/poolHandlers.ts`.
   */
  subscriberCommitment: bigint;
  /**
   * 32 bytes of vault metadata. Stored verbatim at
   * `subscribe_private_stark.rs:397` and read by nothing, on chain or off — the
   * ownership checks on pause/resume/claim go through `subscriber_commitment`.
   * The extension passes 32 zeros for the same reason
   * (`apps/extension/src/popup/pages/CreateSubscription.tsx:459-473`).
   */
  vkHashSubscriber: Uint8Array;
  /**
   * `blake3(licenseSecret)`, the merchant's off-chain check for a presented
   * license key. Optional: omitting it writes a single `0` tag byte and nothing
   * more, and the vault simply carries no license.
   */
  licenseCommitment?: Uint8Array;
}

/**
 * Upload both proofs and open the vault. The caller must already have funded the
 * ephemeral with `requiredLamports`.
 *
 * Mirrors `executeUnshield` down to the ordering of the `finally` sweep: proof
 * buffer rent is only reclaimable by the ephemeral that opened it, so the
 * ephemeral must be drained back to the owner on every exit path, success or
 * failure.
 */
export async function executeSubscribe(
  ctx: PreparedSubscribe,
  connection: Connection,
  params: SubscribeExecuteParams,
  onProgress?: (step: string) => void,
): Promise<{ txSig: string; vaultPDA: PublicKey }> {
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
    // Both checks live INSIDE the try deliberately — the same reasoning as
    // `executeUnshield`. Throwing before the try skips the `finally` sweep, so a
    // merely-lagging RPC read (pre-fund confirmed on chain but not yet visible
    // here) would strand the whole float on an ephemeral instead of returning it.
    if (params.intervalSlots <= 0n) {
      // `require!(interval_slots > 0)` is the first line of the handler
      // (subscribe_private_stark.rs:180). Catching it here saves ~150 chunk
      // uploads that would be thrown away.
      throw new Error('The billing interval must be at least one slot.');
    }

    const funded = await connection.getBalance(ephemeral.publicKey, 'confirmed');
    if (funded < ctx.requiredLamports) {
      throw new Error(
        `The subscription signer is underfunded (${funded} of ${ctx.requiredLamports} lamports). ` +
          'The pre-fund transaction may not have confirmed yet — retry in a moment.',
      );
    }

    return await subscribePrivateStark(
      {
        receipt,
        poolConfig,
        prepared,
        retailer: params.retailer,
        subscriberCommitment: params.subscriberCommitment,
        rate: params.rate,
        intervalSlots: params.intervalSlots,
        vkHashSubscriber: params.vkHashSubscriber,
        licenseCommitment: params.licenseCommitment,
      },
      eSigner,
      connection,
      onProgress,
    );
  } finally {
    try {
      const eBal = await connection.getBalance(ephemeral.publicKey, 'confirmed');
      const sweepable = eBal - SWEEP_FEE;
      if (sweepable > 0) {
        const sweepTo = params.sweepTo ?? params.ownerPubkey;
        const home = sweepTo.equals(params.ownerPubkey);
        onProgress?.(
          home
            ? 'Returning recovered rent to your wallet...'
            : 'Returning recovered rent to the funder...',
        );
        const sweepTx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: ephemeral.publicKey,
            toPubkey: sweepTo,
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
        '[pool/subscribe] ephemeral sweep failed; the key is re-derivable, funds recoverable:',
        sweepErr instanceof Error ? sweepErr.message : String(sweepErr),
      );
    }
  }
}
