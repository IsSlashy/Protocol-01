import {
  type Connection,
  type Signer,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  type BuildClaimPeriodOptions,
  type SplClaimAccounts,
  assertRetailerCanReceiveClaim,
  buildClaimPeriodInstruction,
  CLAIM_TX_BASE_FEE_LAMPORTS,
} from './claim';
import { type MerchantSdkConfig, resolveProgramIds, ZK_SHIELDED_PROGRAM_ID_DEVNET } from './config';
import { decodeSubscriptionVault } from './vaults';
import { claimableAmount, claimablePeriods } from './period-math';

/**
 * The revenue leg's send path.
 *
 * This module exists because `vaults.ts` already imports `claim.ts`, so the
 * helper cannot live in `claim.ts` without making that a cycle. It sits above
 * both and the graph stays acyclic.
 *
 * WHY IT EXISTS AT ALL: `assertRetailerCanReceiveClaim` was written, tested and
 * documented, and then had **no caller** — not from `buildClaimPeriodInstruction`,
 * not from the apps, not from the example. A preflight nothing calls prevents
 * nothing. Building the instruction is pure and stays pure; this is the one
 * place that knows a transaction is about to be sent, so this is where the
 * preflight belongs.
 */

export interface ClaimPeriodResult {
  signature: string;
  /** Periods the program will have advanced `claimed_periods` by. */
  periodsClaimed: bigint;
  /** Lamports for a native vault, mint atomic units for an SPL one. */
  amountClaimed: bigint;
  /** Slot the payout was computed against. */
  slot: bigint;
  /** Fee actually quoted for the transaction, in lamports. */
  feeLamports: bigint;
}

export interface ClaimPeriodSendOptions extends BuildClaimPeriodOptions {
  /**
   * Skip the rent-floor preflight. Only reason to pass this is that you have
   * already run it yourself; it does not make the failure go away, it makes it
   * arrive as `Transaction results in an account (1) with insufficient funds for
   * rent`, which names the wrong account.
   */
  skipPreflight?: boolean;
  /** Commitment for send + confirm. Default `'confirmed'`. */
  commitment?: 'processed' | 'confirmed' | 'finalized';
}

/**
 * Claim every accrued period from a vault and settle the transaction.
 *
 * `claim_period` takes no arguments — the program derives the count from the
 * clock — so this sweeps ALL accrued periods in one transaction. It is a pull,
 * not a drip: nothing on chain schedules it. Call it on whatever cadence suits
 * the merchant's books.
 *
 * @param retailerSigner must be the vault's `retailer`; the program's only
 *   constraint is `retailer.key() == vault.retailer`, and the same key pays the
 *   transaction fee.
 */
export async function claimPeriod(
  connection: Connection,
  vaultPda: PublicKey,
  retailerSigner: Signer,
  opts: ClaimPeriodSendOptions = {},
): Promise<ClaimPeriodResult> {
  const programId = opts.sdkConfig
    ? resolveProgramIds(opts.sdkConfig).zkShielded
    : (opts.programId ?? ZK_SHIELDED_PROGRAM_ID_DEVNET);

  const info = await connection.getAccountInfo(vaultPda, opts.commitment ?? 'confirmed');
  // Three distinct "this is not a vault" cases, each with its own remedy. An
  // account can EXIST and still be nothing: `getAccountInfo` on a live system
  // account returns a zero-length buffer, which used to reach the decoder and
  // surface as "vault account data too short: 0" — true, and useless.
  if (!info) {
    throw new Error(`no account at ${vaultPda.toBase58()} — wrong PDA, or the vault was closed`);
  }
  if (!info.owner.equals(programId)) {
    throw new Error(
      `account ${vaultPda.toBase58()} is owned by ${info.owner.toBase58()}, not by the zk_shielded ` +
        `program (${programId.toBase58()}) — wrong PDA, wrong cluster, or wrong programId override.`,
    );
  }
  if (info.data.length === 0) {
    throw new Error(
      `account ${vaultPda.toBase58()} exists but holds no data — wrong PDA, or the vault was closed ` +
        `and its address reused.`,
    );
  }
  const vault = decodeSubscriptionVault(info.data, vaultPda);

  if (!vault.retailer.equals(retailerSigner.publicKey)) {
    throw new Error(
      `signer ${retailerSigner.publicKey.toBase58()} is not this vault's retailer ` +
        `(${vault.retailer.toBase58()}). claim_period would fail with Unauthorized (6004). ` +
        `The retailer is a PDA seed and can never be rotated, so this is the wrong key, ` +
        `not a stale vault.`,
    );
  }
  if (vault.isPaused) {
    throw new Error(
      `vault ${vaultPda.toBase58()} is paused. claim_period carries an account-level ` +
        `\`!is_paused\` constraint, so it is rejected before the handler runs, and periods do ` +
        `not accrue while paused. The subscriber must resume it.`,
    );
  }

  const slot = BigInt(await connection.getSlot(opts.commitment ?? 'confirmed'));
  const periodsClaimed = claimablePeriods(vault, slot);
  const amountClaimed = claimableAmount(vault, slot);
  if (amountClaimed === 0n) {
    const funded = vault.rate === 0n ? 0n : vault.totalDeposited / vault.rate;
    throw new Error(
      `nothing to claim at slot ${slot}: ${vault.claimedPeriods} of ${funded} funded periods ` +
        `already collected. claim_period would fail with NoClaimablePeriods (6029). ` +
        (vault.claimedPeriods >= funded
          ? `This vault is exhausted — it will never pay again, and on the currently deployed ` +
            `program nothing can close it, so its rent stays locked.`
          : `Wait for the next interval of ${vault.intervalSlots} slots to elapse.`),
    );
  }

  const isNative = vault.tokenMint.equals(SystemProgram.programId);
  const ix = buildClaimPeriodInstruction(vaultPda, retailerSigner.publicKey, opts);
  const tx = new Transaction().add(ix);
  const { blockhash } = await connection.getLatestBlockhash(opts.commitment ?? 'confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = retailerSigner.publicKey;

  // Quote the REAL fee rather than assuming the 5,000-lamport base: a caller that
  // attached compute-budget instructions pays more, and the retailer pays it out
  // of the balance the payout lands in.
  let feeLamports = CLAIM_TX_BASE_FEE_LAMPORTS;
  try {
    const quoted = await connection.getFeeForMessage(tx.compileMessage(), opts.commitment ?? 'confirmed');
    if (quoted?.value != null) feeLamports = BigInt(quoted.value);
  } catch {
    // Some RPCs refuse getFeeForMessage; the base fee is the honest floor and
    // erring low here only makes the preflight slightly less strict.
  }

  if (!opts.skipPreflight) {
    const spl: SplClaimAccounts | undefined =
      !isNative && opts.vaultTokenAccount && opts.retailerTokenAccount
        ? {
            vaultPda,
            vaultTokenAccount: opts.vaultTokenAccount,
            retailerTokenAccount: opts.retailerTokenAccount,
            tokenMint: vault.tokenMint,
          }
        : undefined;
    if (!isNative && !spl) {
      throw new Error(
        `vault ${vaultPda.toBase58()} is an SPL vault (mint ${vault.tokenMint.toBase58()}); pass ` +
          `vaultTokenAccount and retailerTokenAccount so the owner and self-transfer checks can run. ` +
          `Without them claim_period fails in the handler with MissingTokenProgram.`,
      );
    }
    await assertRetailerCanReceiveClaim(
      connection,
      retailerSigner.publicKey,
      amountClaimed,
      spl,
      feeLamports,
    );
  }

  const signature = await sendAndConfirmTransaction(connection, tx, [retailerSigner], {
    commitment: opts.commitment ?? 'confirmed',
  });

  return { signature, periodsClaimed, amountClaimed, slot, feeLamports };
}
