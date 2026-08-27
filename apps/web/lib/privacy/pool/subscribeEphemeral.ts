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
import {
  deriveUnshieldEphemeral,
  prepareUnshieldJob,
  type PreparedUnshield,
} from './unshieldEphemeral';
import { deriveSubscriptionVaultPDA, subscribePrivateStark } from './subscribePrivateStark';
import {
  prepareSubscribeV4,
  subscribePrivateStarkV4,
  type PrepareSubscribeV4Result,
  type SubscribeBinding,
} from './subscribePrivateStarkV4';
import { goldilocksU64To32, isNullifierSpent } from './denominatedPool';
import { jitterPrefund } from './prefundAmount';
import { SUBSCRIPTION_VAULT_LEN, subscribeFloorLamports } from './subscribeFloat';
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
 * proof buffers and the NullifierRecord. Under-pricing it does not fail cheaply:
 * the ephemeral has already uploaded its chunks by the time the subscribe
 * instruction runs out of lamports.
 *
 * Unlike the buffers, this rent does NOT come back — the vault is a real account
 * that stays open until `claim_period` closes it on the final claim.
 *
 * ⛔ DECLARED IN `subscribeFloat.ts`, re-exported here so callers are unchanged.
 * The cost disclosure prices the same vault, and a second literal is how the
 * disclosed float and the transferred float drift apart.
 */
export { SUBSCRIPTION_VAULT_LEN };

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

// ===========================================================================
// CIRCUIT 7 — the same job, on one proof, publishing no commitment
// ===========================================================================

/**
 * The v4 twin of `PreparedSubscribe`.
 *
 * IT CARRIES THE TERMS AND THE v3 ONE DOES NOT. That is not tidiness, it is the
 * whole difference between the two circuits. `subscribe_private_stark_v4` binds
 * `sha256("P01:C7:SUBSCRIBE:v1" || vault || rate || interval_slots ||
 * vk_hash_subscriber || license)` into four of circuit 7's six public inputs, so
 * a v4 proof is bound to ONE set of terms before it is built. The v3 proof names
 * none of them, which is exactly the hole the domain-tagged composite closes:
 * `claim_period` is permissionless, so a buffer holder who could still choose
 * `rate` at send time would hand the retailer the whole prepaid envelope one
 * slot after subscribe, with no cancellation and no refund to undo it.
 */
export interface PreparedSubscribeV4 {
  jobId: string;
  poolConfig: PoolConfig;
  receipt: ShieldReceipt;
  ephemeral: Keypair;
  /** The terms circuit 7 is bound to. Fixed at prove time, not at send time. */
  binding: SubscribeBinding;
  /** The circuit-0 commitment the vault PDA is seeded on. */
  subscriberCommitment: bigint;
  retailer: PublicKey;
  requiredLamports: number;
  rawRequiredLamports: number;
  prepared: PrepareSubscribeV4Result;
}

/**
 * Prove the subscription on ONE circuit-7 trace instead of the C1 + C3 pair.
 *
 * ⛔ THIS IS A SIBLING, NOT A REPLACEMENT, AND THAT IS DELIBERATE.
 * `prepareSubscribeJob` above is UNTOUCHED and stays reachable: a note whose
 * blinding is unknown can be spent nowhere but the pair, and `prepareSubscribeV4`
 * has NO stored-path fast path, so a note whose root has aged out of the pool's
 * 100-root ring still needs the v3 rebuild. Routing is per CALLER, decided in
 * `handlePoolSubscribePrepare`. It is not a migration.
 *
 * Three real differences from the v3 job, all consequences of the circuit rather
 * than choices:
 *
 *   the TERMS are inputs     rate, interval, the vk hash and the license
 *                            commitment are in the transcript, so they must be
 *                            known before proving. The v3 job only needed them
 *                            at send time, on the execute message.
 *   ONE buffer, not two      C1 and C3 are held open together, so the v3 float
 *                            is their sum plus the vault's rent. Circuit 7 has
 *                            nothing to pair with, so the pre-fund is materially
 *                            smaller — priced here against the RPC, not assumed.
 *   no stored-path shortcut  `prepareSubscribeV4` always rebuilds from history
 *                            and needs an RPC that still serves it.
 */
export async function prepareSubscribeJobV4(
  receipt: ShieldReceipt,
  poolConfig: PoolConfig,
  connection: Connection,
  walletSeed: Uint8Array,
  terms: {
    retailer: PublicKey;
    subscriberCommitment: bigint;
    rate: bigint;
    intervalSlots: bigint;
    vkHashSubscriber: Uint8Array;
    licenseCommitment?: Uint8Array;
  },
  onProgress?: (step: string) => void,
): Promise<PreparedSubscribeV4> {
  // 🚨 A PRE-BLINDING NOTE GAINS NOTHING FROM CIRCUIT 7, AND SAYING OTHERWISE IS
  // THE LIE. The same refusal `prepareUnshieldJobV4` makes, for the same reason,
  // and it matters MORE here: a withdrawal's exposure is one transaction, while
  // a subscription sits beside a permanent public vault that every later
  // `claim_period` re-publishes.
  //
  // The commitment is `poseidon(nullifier, poseidon(blinding, token_mint))`.
  // Circuit 7 keeps it off the wire, but the NULLIFIER is published — it is the
  // double-spend guard and a PDA seed, it cannot be hidden — and `token_mint` is
  // the pool's, public. So `blinding` is the only unknown, and for a note
  // deposited before `noteBlinding` landed it is the deposit EPOCH: five digits
  // today. An observer enumerates a few thousand candidates, rebuilds the
  // commitment, matches the leaf, and reaches the deposit and its payer.
  //
  // MEASURED 2026-08-26: epoch = slot/7200 = 67,838, five digits. A PRF blinding
  // is 63 bits, up to 9.2e18. A threshold at 2**32 sits 63,000x above any real
  // epoch, and a PRF draw landing below it has probability 2**-31.
  //
  // ⛔ IT MUST NOT BLOCK THE NOTE. The message carries the needle
  // `circuit 7 needs at least` so `isV4RebuildFailure` in poolHandlers.ts routes
  // it back to the C1 + C3 pair, which publishes the commitment and is honest
  // about it.
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

  // Refused before proving for the same reason `subscribeBindingPreimage` refuses
  // them: `require!(rate > 0)` and `require!(interval_slots > 0)` are the first
  // two lines of the handler, and reaching them costs ~78 chunk uploads first.
  if (terms.rate <= 0n) {
    throw new Error(
      'The per-period rate must be greater than zero: a zero rate makes `funded_periods()` ' +
        'return 0, which mints a vault nobody can ever claim from.',
    );
  }
  if (terms.intervalSlots <= 0n) {
    throw new Error('The billing interval must be at least one slot.');
  }

  onProgress?.('Checking the note is unspent...');
  const spent = await isNullifierSpent(
    connection,
    poolConfig.poolPDA,
    receipt.nullifierPreimage,
    receipt.secret,
  );
  if (spent) {
    throw new Error('This note has already been spent.');
  }

  const [vaultPDA] = deriveSubscriptionVaultPDA(
    terms.retailer,
    goldilocksU64To32(terms.subscriberCommitment),
    poolConfig.tokenMint,
  );
  const binding: SubscribeBinding = {
    vault: vaultPDA,
    rate: terms.rate,
    intervalSlots: terms.intervalSlots,
    vkHashSubscriber: terms.vkHashSubscriber,
    licenseCommitment: terms.licenseCommitment,
  };

  const prepared = await prepareSubscribeV4(
    receipt,
    poolConfig,
    connection,
    binding,
    terms.subscriberCommitment,
    terms.retailer,
    onProgress,
  );

  onProgress?.('Pricing the subscription...');
  // ONE buffer. The v3 job adds two rent figures because the handler reads both
  // proofs in one transaction and they are open at the same time; circuit 7 has
  // nothing to pair with.
  const r7 = await connection.getMinimumBalanceForRentExemption(
    83 + prepared.c7ProofResult.proofSize,
  );
  // The vault's rent does NOT come back: the vault is a real account that stays
  // open until `claim_period` closes it on the final claim.
  const vaultRent = await connection.getMinimumBalanceForRentExemption(SUBSCRIPTION_VAULT_LEN);
  // ⛔ THE SAME FUNCTION THE COST DISCLOSURE QUOTES. `SUBSCRIBE_FLOAT_SOL` in
  // `subscribeFloat.ts` is this call over the MEASURED C7 wire size, so the
  // number the user reads before signing and the number transferred here cannot
  // be edited apart. ONE `proofBufferRent` term, because there is one buffer.
  const rawRequiredLamports = subscribeFloorLamports({ proofBufferRent: r7, vaultRent });
  // Jitter the COMPLETE sum, from the raw floor, for the same reason the v3 job
  // does — and it matters MORE here: a single-buffer float is an even cleaner
  // fingerprint than the pair's sum, because the C7 proof size is a pure function
  // of the circuit and does not move.
  const requiredLamports = jitterPrefund(rawRequiredLamports);

  // 💰 THE SAME EPHEMERAL AS EVERY OTHER SPEND OF THIS LEAF, DELIBERATELY.
  // `recoverFloat.ts` sweeps exactly two derivations per leaf, 'shield' and
  // 'unshield'. A job that dies between the pre-fund and the buffer close
  // strands proof-buffer rent on its ephemeral, and that rent is only reclaimable
  // by the key that opened the buffer. Giving the v4 subscribe its own domain
  // separator would put that float outside the only recovery path this app has.
  // A note is spent once, so the uses are mutually exclusive.
  const ephemeral = deriveUnshieldEphemeral(walletSeed, poolConfig.poolPDA, receipt.leafIndex);

  return {
    // 💰 THE VAULT IS IN THE KEY, AND THAT IS A FUND-LOSS FIX, NOT DECORATION.
    // `subscribe:<pool>:<leaf>` names no terms while the job is BOUND to them.
    // Two prepares of the same note with different terms would collide on one map
    // key and the second would replace the first — and the ephemeral is
    // deterministic in (seed, pool, leaf), so the first caller's pre-fund sits on
    // exactly the signer the second caller's proof spends from. Executing the
    // first job id would then open the second caller's vault, with no error
    // anywhere. This is the shape that was already paid for once on the v4
    // withdrawal (see `preparedUnshields` in poolHandlers.ts). The vault PDA
    // transitively names retailer + subscriber commitment + mint, so it is the
    // right qualifier; rate and interval are covered by the prepared-vs-executed
    // refusal in `subscribePrivateStarkV4`, which throws rather than pays.
    jobId: `subscribe-v4:${poolConfig.poolPDA.toBase58()}:${receipt.leafIndex}:${vaultPDA.toBase58()}`,
    poolConfig,
    receipt,
    ephemeral,
    binding,
    subscriberCommitment: terms.subscriberCommitment,
    retailer: terms.retailer,
    requiredLamports,
    rawRequiredLamports,
    prepared,
  };
}

/**
 * Send the v4 subscription from the pre-funded ephemeral, then sweep the residue.
 *
 * Takes NO terms: they are already in `ctx`, bound into the proof, and checked
 * again inside `subscribePrivateStarkV4` before a lamport moves. The v3 twin
 * takes them because its proof names none of them.
 */
export async function executeSubscribeV4(
  ctx: PreparedSubscribeV4,
  connection: Connection,
  params: { ownerPubkey: PublicKey; sweepTo?: PublicKey },
  onProgress?: (step: string) => void,
): Promise<{ txSig: string; vaultPDA: PublicKey }> {
  const { ephemeral, poolConfig, prepared, receipt, binding } = ctx;

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
    // INSIDE the try, like both twins: the pre-fund has already landed by now, so
    // throwing before the `finally` would strand the whole float on an ephemeral
    // over a merely-lagging RPC read.
    const funded = await connection.getBalance(ephemeral.publicKey, 'confirmed');
    if (funded < ctx.requiredLamports) {
      throw new Error(
        `The subscription signer is underfunded (${funded} of ${ctx.requiredLamports} lamports). ` +
          'The pre-fund transaction may not have confirmed yet — retry in a moment.',
      );
    }

    return await subscribePrivateStarkV4(
      {
        receipt,
        poolConfig,
        prepared,
        retailer: ctx.retailer,
        subscriberCommitment: ctx.subscriberCommitment,
        binding,
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
        // Say which of the two happened, for the same reason the twins do: a user
        // told "returning rent to your wallet" when it went elsewhere has been
        // handed a false receipt, and this is the only line about it.
        onProgress?.(
          home
            ? 'Returning recovered rent to your wallet...'
            : 'Returning recovered rent to the funder that paid for this job...',
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
        '[pool/subscribe-v4] ephemeral sweep failed; the key is re-derivable, funds recoverable:',
        sweepErr instanceof Error ? sweepErr.message : String(sweepErr),
      );
    }
  }
}
