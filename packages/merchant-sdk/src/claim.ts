import { type Connection, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { type MerchantSdkConfig, resolveProgramIds, ZK_SHIELDED_PROGRAM_ID_DEVNET } from './config';
// Type-only, so this module has NO value dependency on `vaults` and `vaults`
// can import the period math back without creating a cycle.
import type { SubscriptionVaultAccount } from './vaults';

/** SPL Token program ID. Inlined so the SDK keeps zero `@solana/spl-token` dependency. */
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/**
 * Anchor instruction discriminator for `claim_period`
 * (`sha256("global:claim_period")[..8]`).
 */
export const CLAIM_PERIOD_DISCRIMINATOR = Buffer.from([
  72, 126, 164, 101, 190, 210, 66, 82,
]);

/**
 * Number of periods the retailer may claim right now.
 *
 * Faithful port of `SubscriptionVault::claimable_periods`
 * (`programs/zk_shielded/src/state/subscription_vault.rs:133`). Keep the two in
 * step: a client that over-estimates builds a transaction the program rejects
 * with `NoClaimablePeriods`, and one that under-estimates silently leaves the
 * merchant unpaid.
 *
 * The `max_funded` clamp is the important half — it is what stops the payout
 * exceeding the residual vault balance, and it is also the only thing that says
 * a subscription has run out of money. `is_active` cannot tell you that: it is
 * written `true` at subscribe time and `false` nowhere in the program.
 *
 * @param currentSlot slot to evaluate against (`connection.getSlot()`).
 */
export function claimablePeriods(
  vault: Pick<
    SubscriptionVaultAccount,
    'isActive' | 'isPaused' | 'startSlot' | 'totalPausedSlots' | 'intervalSlots' | 'claimedPeriods' | 'totalDeposited' | 'rate'
  >,
  currentSlot: bigint,
): bigint {
  if (!vault.isActive || vault.isPaused) return 0n;

  const effectiveElapsed = currentSlot - vault.startSlot - vault.totalPausedSlots;
  if (effectiveElapsed <= 0n) return 0n;

  // On chain this is a u64 division; `interval_slots == 0` would panic and the
  // transaction would fail. Refuse to build one rather than reproduce the panic.
  if (vault.intervalSlots === 0n) return 0n;

  const totalPeriods = effectiveElapsed / vault.intervalSlots;
  const unclaimed = satSub(totalPeriods, vault.claimedPeriods);

  const maxFunded =
    vault.rate === 0n ? 0n : satSub(vault.totalDeposited / vault.rate, vault.claimedPeriods);

  return unclaimed < maxFunded ? unclaimed : maxFunded;
}

/** Atomic units the retailer would receive if it claimed at `currentSlot`. */
export function claimableAmount(
  vault: Parameters<typeof claimablePeriods>[0],
  currentSlot: bigint,
): bigint {
  return claimablePeriods(vault, currentSlot) * vault.rate;
}

/**
 * Periods this vault is still funded for, ignoring elapsed time — i.e. how many
 * more periods the retailer can still be PAID for. Zero means the program will
 * refuse every further claim.
 *
 * This is the money question, not the access question: a lazy retailer that has
 * never claimed leaves this high long after the subscription has run out in
 * time. Use {@link subscriptionIsCurrent} to decide whether to serve a request.
 */
export function fundedPeriodsRemaining(
  vault: Pick<SubscriptionVaultAccount, 'totalDeposited' | 'rate' | 'claimedPeriods'>,
): bigint {
  if (vault.rate === 0n) return 0n;
  return satSub(vault.totalDeposited / vault.rate, vault.claimedPeriods);
}

/** Total periods the subscriber paid for at subscribe time. */
export function periodsPaidFor(
  vault: Pick<SubscriptionVaultAccount, 'totalDeposited' | 'rate'>,
): bigint {
  if (vault.rate === 0n) return 0n;
  return vault.totalDeposited / vault.rate;
}

/** Zero-based index of the period the subscription is in at `currentSlot`. */
export function periodsElapsed(
  vault: Pick<SubscriptionVaultAccount, 'startSlot' | 'totalPausedSlots' | 'intervalSlots'>,
  currentSlot: bigint,
): bigint {
  if (vault.intervalSlots === 0n) return 0n;
  const effective = currentSlot - vault.startSlot - vault.totalPausedSlots;
  if (effective <= 0n) return 0n;
  return effective / vault.intervalSlots;
}

/**
 * Whether the subscription entitles its holder to service RIGHT NOW.
 *
 * This is the check a merchant must gate on, and it is deliberately NOT
 * `isActive`. `is_active` is written `true` at `subscribe_normal.rs:120` and
 * `subscribe_private_stark.rs:395` and `false` NOWHERE in the program, so it
 * carries no information at all: an exhausted vault reports `true` forever.
 * MEASURED on devnet 2026-08-01 — a vault with all five periods claimed and a
 * zero balance still returned `isActive: true`, and the pre-fix
 * `hasActiveVaultAccess` granted access to it.
 *
 * Cancellation is not the hole: `cancel_normal` and `cancel_private_stark`
 * both `close` the account, so a cancelled vault simply stops existing. The
 * hole is running out of money, which nothing on chain marks.
 *
 * Nor is `fundedPeriodsRemaining > 0` the right test — that stays positive
 * while a retailer merely neglects to claim. Entitlement is a function of time
 * paid for, not of collection: the subscriber is current while the period they
 * are in is one they paid for.
 */
export function subscriptionIsCurrent(
  vault: Pick<
    SubscriptionVaultAccount,
    'isActive' | 'isPaused' | 'startSlot' | 'totalPausedSlots' | 'intervalSlots' | 'totalDeposited' | 'rate'
  >,
  currentSlot: bigint,
): boolean {
  if (!vault.isActive || vault.isPaused) return false;
  return periodsElapsed(vault, currentSlot) < periodsPaidFor(vault);
}

function satSub(a: bigint, b: bigint): bigint {
  return a > b ? a - b : 0n;
}

// ---------------------------------------------------------------------------
// The rent floor
// ---------------------------------------------------------------------------

/**
 * Rent-exempt minimum for a zero-data system account, in lamports.
 *
 * Hard-coded only as a fallback for callers with no `Connection`; prefer
 * `connection.getMinimumBalanceForRentExemption(0)`, which is authoritative and
 * what {@link assertRetailerCanReceiveClaim} uses.
 */
export const SYSTEM_ACCOUNT_RENT_EXEMPT_LAMPORTS = 890_880n;

/**
 * Would this payout leave the retailer's account non-zero but below the
 * rent-exempt floor? If so the runtime kills the transaction AFTER the program
 * has already succeeded.
 *
 * MEASURED on devnet 2026-08-01: `claim_period` ran to completion — 7,261 CU,
 * `ClaimPeriodEvent` emitted, `Program … success` — and the transaction was
 * then rejected with `Transaction results in an account (1) with insufficient
 * funds for rent`. Account 1 was the RETAILER; the message reads as though the
 * vault were underfunded, which is the opposite of true and sends anyone
 * debugging it to the wrong place.
 *
 * A merchant whose payout account is empty therefore cannot collect its FIRST
 * claim unless that single payout is itself at least the rent-exempt minimum.
 * Once the account clears the floor the problem never recurs.
 */
export function claimWouldStrandRetailer(
  retailerBalanceLamports: bigint,
  payoutLamports: bigint,
  rentExemptMinimum: bigint = SYSTEM_ACCOUNT_RENT_EXEMPT_LAMPORTS,
): boolean {
  if (payoutLamports === 0n) return false;
  const after = retailerBalanceLamports + payoutLamports;
  return after > 0n && after < rentExemptMinimum;
}

/**
 * Preflight the rent floor before sending a claim, so the failure surfaces as a
 * message that names the real cause instead of a runtime error naming the wrong
 * account. Native SOL only — an SPL payout lands in a token account, whose own
 * (larger) rent floor is the caller's problem to have already satisfied.
 *
 * @throws if the claim would strand the retailer below rent exemption.
 */
export async function assertRetailerCanReceiveClaim(
  connection: Connection,
  retailer: PublicKey,
  payoutLamports: bigint,
): Promise<void> {
  const [balance, floor] = await Promise.all([
    connection.getBalance(retailer),
    connection.getMinimumBalanceForRentExemption(0),
  ]);
  if (!claimWouldStrandRetailer(BigInt(balance), payoutLamports, BigInt(floor))) return;
  throw new Error(
    `claim_period would strand the retailer below rent exemption: balance ${balance} + payout ` +
      `${payoutLamports} = ${BigInt(balance) + payoutLamports}, under the ${floor}-lamport floor. ` +
      `The program succeeds and the RUNTIME then rejects the transaction with a message naming ` +
      `insufficient funds for rent, which reads as though the vault were empty. Fund ${retailer.toBase58()} ` +
      `to at least ${floor} lamports once, or wait until enough periods accrue for a single claim to clear it.`,
  );
}

export interface BuildClaimPeriodOptions {
  /** Program ID override. Ignored when `sdkConfig` is supplied. */
  programId?: PublicKey;
  /** SDK-level configuration (cluster + program ID overrides). */
  sdkConfig?: MerchantSdkConfig;
  /**
   * Vault's SPL token account. Required for SPL vaults, omit for native SOL.
   * The program does NOT create it — `subscribe_private_stark` takes it as an
   * existing account too, so it must already exist.
   */
  vaultTokenAccount?: PublicKey;
  /** Retailer's SPL token account. Required for SPL vaults, omit for native SOL. */
  retailerTokenAccount?: PublicKey;
}

/**
 * Build the `claim_period` instruction. The retailer is the only valid signer
 * (`constraint = retailer.key() == vault.retailer`).
 *
 * Account order mirrors `ClaimPeriod<'info>`
 * (`programs/zk_shielded/src/instructions/claim_period.rs:14`). The three
 * trailing accounts are Anchor `Option<..>`; under Anchor 0.32 an absent
 * optional account is expressed by passing the program's own ID in its slot,
 * which is what the native-SOL path does here.
 *
 * The instruction carries no arguments: the program derives the claimable count
 * from the clock, so the amount is not caller-controlled.
 */
export function buildClaimPeriodInstruction(
  vaultPda: PublicKey,
  retailer: PublicKey,
  opts: BuildClaimPeriodOptions = {},
): TransactionInstruction {
  const programId = opts.sdkConfig
    ? resolveProgramIds(opts.sdkConfig).zkShielded
    : (opts.programId ?? ZK_SHIELDED_PROGRAM_ID_DEVNET);

  const spl = opts.vaultTokenAccount !== undefined || opts.retailerTokenAccount !== undefined;
  if (spl && (!opts.vaultTokenAccount || !opts.retailerTokenAccount)) {
    throw new Error(
      'claim_period: an SPL vault needs BOTH vaultTokenAccount and retailerTokenAccount; ' +
        'omit both for a native SOL vault',
    );
  }

  const keys = [
    { pubkey: retailer, isSigner: true, isWritable: true },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // token_program: Option<Program<Token>>
    { pubkey: spl ? TOKEN_PROGRAM_ID : programId, isSigner: false, isWritable: false },
    // vault_token_account: Option<Account<TokenAccount>>, mut
    { pubkey: spl ? opts.vaultTokenAccount! : programId, isSigner: false, isWritable: spl },
    // retailer_token_account: Option<Account<TokenAccount>>, mut
    { pubkey: spl ? opts.retailerTokenAccount! : programId, isSigner: false, isWritable: spl },
  ];

  return new TransactionInstruction({
    programId,
    keys,
    data: Buffer.from(CLAIM_PERIOD_DISCRIMINATOR),
  });
}
