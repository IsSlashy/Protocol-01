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
  /**
   * True when this claim collected (or had already collected) every funded
   * period, which makes the program CLOSE the vault account in the same
   * transaction — the address stops existing and the rent goes to the retailer.
   */
  closesVault: boolean;
  /**
   * The vault account's lamports, released to the retailer by the close.
   * `0n` unless {@link closesVault}. Always lamports, even for an SPL vault —
   * rent is rent; `amountClaimed` stays in the vault's own unit.
   */
  rentReleasedLamports: bigint;
}

export interface ClaimPeriodSendOptions extends BuildClaimPeriodOptions {
  /**
   * Who signs and pays. Defaults to the retailer, when the retailer was passed
   * as a `Signer`; REQUIRED when the retailer was passed as a bare `PublicKey`.
   *
   * Supply this to use the capability the 2026-08-04 redeploy exists for: since
   * that deploy `claim_period` takes the retailer as an `UncheckedAccount` pinned
   * by `retailer.key() == vault.retailer`, NOT as a signer, so anyone can trigger
   * a merchant's payment and the money still goes only to the merchant. Proven on
   * chain the same day — tx `2CyRn6MAKdXKaW3e…`, sent by a key holding no retailer
   * secret. That is what rescues a merchant whose retailer key is lost, which is
   * ~5.5 SOL of devnet vaults today.
   *
   * When it is set, only `payer` signs (plus the retailer if `retailerSigns`
   * explicitly opts it in for the treasury case).
   */
  payer?: Signer;
  /**
   * Skip the rent-floor preflight. Only reason to pass this is that you have
   * already run it yourself; it does not make the failure go away, it makes it
   * arrive as `Transaction results in an account (1) with insufficient funds for
   * rent`, which names the wrong account.
   */
  skipPreflight?: boolean;
  /** Commitment for send + confirm. Default `'confirmed'`. */
  commitment?: 'processed' | 'confirmed' | 'finalized';
  /**
   * Send the claim even when ZERO periods are claimable, provided the vault is
   * EXHAUSTED (every funded period already collected).
   *
   * Since the 2026-08-04 redeploy such a claim still settles: the program pays
   * the sub-period remainder plus the account's rent (~0.0027-0.0034 SOL,
   * depending on the vault's size — they exist in three) to the retailer and
   * CLOSES the vault. Proven on devnet the same day. Off by default because it
   * deletes the account: a poll loop that calls `claimPeriod` on every vault it
   * sees should not silently close them, and a closed vault's address can be
   * re-subscribed at the same PDA (`issueSubscriptionAccessToken` pins tokens
   * to `start_slot` for exactly that reason).
   *
   * Has no effect on a vault that still has funded periods coming: a zero-
   * claimable claim there really would fail with NoClaimablePeriods (6029),
   * and it still throws.
   */
  closeExhausted?: boolean;
}

/**
 * Claim every accrued period from a vault and settle the transaction.
 *
 * `claim_period` takes no arguments — the program derives the count from the
 * clock — so this sweeps ALL accrued periods in one transaction. It is a pull,
 * not a drip: nothing on chain schedules it. Call it on whatever cadence suits
 * the merchant's books.
 *
 * @param retailer the vault's `retailer` — an ADDRESS, not a key. The program's
 *   only constraint is `retailer.key() == vault.retailer`: it pins where the
 *   money goes, not who sends the transaction. Pass a bare `PublicKey` together
 *   with `opts.payer` to claim on a merchant's behalf without holding any of
 *   their keys — the permissionless shape the 2026-08-04 redeploy exists for.
 *   Passing a `Signer` keeps the classic self-claim: the retailer signs and
 *   pays its own fee. If this parameter ever demands a `Signer` again, the SDK
 *   has re-imposed in software the constraint the program deliberately removed;
 *   `claim-send.test.ts` pins that.
 */
export async function claimPeriod(
  connection: Connection,
  vaultPda: PublicKey,
  retailer: PublicKey | Signer,
  opts: ClaimPeriodSendOptions = {},
): Promise<ClaimPeriodResult> {
  // Address-only is the first-class shape. A Signer is accepted for the
  // self-claim, and is only USED as one — nothing below reads `secretKey`
  // until the transaction is actually signed.
  const retailerKey = 'publicKey' in retailer ? retailer.publicKey : retailer;
  const retailerSigner: Signer | undefined =
    'publicKey' in retailer && retailer.secretKey ? retailer : undefined;
  const payer = opts.payer ?? retailerSigner;
  if (!payer) {
    throw new Error(
      `claim_period: retailer ${retailerKey.toBase58()} was given as an address, so it cannot ` +
        `sign — pass opts.payer to carry the signature and the fee. The claim stays ` +
        `permissionless: any funded key works, and the payout still goes only to the retailer.`,
    );
  }
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

  // The program pins the DESTINATION, not the sender: `retailer.key() ==
  // vault.retailer`. So the only thing that must match this vault is the retailer
  // ADDRESS. Requiring the caller to hold that key as well would re-impose, in
  // the SDK, exactly the constraint the redeploy removed from the program — and
  // would lock out the case the change exists for, a merchant whose key is gone.
  if (!vault.retailer.equals(retailerKey)) {
    throw new Error(
      `${retailerKey.toBase58()} is not this vault's retailer ` +
        `(${vault.retailer.toBase58()}). claim_period would fail with Unauthorized (6004). ` +
        `The retailer is a PDA seed and can never be rotated, so this is the wrong address, ` +
        `not a stale vault. Note you do NOT need the retailer's key to claim — pass ` +
        `opts.payer and the correct retailer address, and the payout still goes to the ` +
        `merchant.`,
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
  let amountClaimed = claimableAmount(vault, slot);
  const funded = vault.rate === 0n ? 0n : vault.totalDeposited / vault.rate;
  const exhausted = vault.claimedPeriods >= funded;
  // The program closes the vault on the claim that collects (or finds
  // collected) its last funded period, releasing the account's lamports to the
  // retailer. `info.lamports` is that release, read from the very account
  // fetched above rather than re-derived from a size table — vaults exist in
  // three sizes and their rent differs.
  const closesVault = exhausted || vault.claimedPeriods + periodsClaimed >= funded;
  const rentReleasedLamports = closesVault ? BigInt(info.lamports) : 0n;
  if (amountClaimed === 0n) {
    if (exhausted && opts.closeExhausted) {
      // Nothing accrues, but the claim still settles: it pays the sub-period
      // remainder (whatever integer division left behind) plus the rent, and
      // closes the account. This branch is what releases the ~0.003 SOL a
      // fully-collected vault otherwise locks up for ever.
      amountClaimed = vault.totalDeposited - vault.claimedPeriods * vault.rate;
    } else {
      throw new Error(
        `nothing to claim at slot ${slot}: ${vault.claimedPeriods} of ${funded} funded periods ` +
          `already collected. claim_period would fail with NoClaimablePeriods (6029). ` +
          (exhausted
            ? `This vault is exhausted — it will never pay again. Since the 2026-08-04 redeploy a ` +
              `claim on an exhausted vault still settles: it CLOSES the account and pays its rent ` +
              `(~0.0027-0.0034 SOL) to the retailer. Pass closeExhausted: true to send it and ` +
              `release that.`
            : `Wait for the next interval of ${vault.intervalSlots} slots to elapse.`),
      );
    }
  }

  const isNative = vault.tokenMint.equals(SystemProgram.programId);
  const ix = buildClaimPeriodInstruction(vaultPda, retailerKey, opts);
  const tx = new Transaction().add(ix);
  const { blockhash } = await connection.getLatestBlockhash(opts.commitment ?? 'confirmed');
  tx.recentBlockhash = blockhash;
  // Permissionless by default: the payer signs, and the retailer travels as a
  // plain writable account, exactly as the program declares it. The retailer
  // co-signs only when `retailerSigns` opts into the one thing the signature
  // still buys (a treasury `retailerTokenAccount` the retailer key does not own).
  const signers: Signer[] = [payer];
  if (opts.retailerSigns) {
    if (!retailerSigner) {
      throw new Error(
        `claim_period: retailerSigns is set but the retailer was given as an address — there is ` +
          `no key to sign with. Pass the retailer as a Signer, or drop retailerSigns.`,
      );
    }
    if (!retailerSigner.publicKey.equals(payer.publicKey)) signers.push(retailerSigner);
  }
  tx.feePayer = payer.publicKey;

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
    // The fee leaves the PAYER's balance, so it only eats into the payout when
    // the payer and the retailer are the same account. On a closing claim the
    // rent lands in the retailer's system account too, so the native rent-floor
    // check counts it — for SPL it stays out: `amountClaimed` is in mint units
    // there and the SPL checks compare token balances, not lamports.
    await assertRetailerCanReceiveClaim(
      connection,
      retailerKey,
      isNative ? amountClaimed + rentReleasedLamports : amountClaimed,
      spl,
      payer.publicKey.equals(retailerKey) ? feeLamports : 0n,
    );
  }

  const signature = await sendAndConfirmTransaction(connection, tx, signers, {
    commitment: opts.commitment ?? 'confirmed',
  });

  return { signature, periodsClaimed, amountClaimed, slot, feeLamports, closesVault, rentReleasedLamports };
}
