/**
 * Subscription period math — the CANONICAL implementation.
 *
 * ## Why this file has no imports
 *
 * The same arithmetic has to run in four places that cannot share a bundle:
 * the merchant SDK (Node), `@protocol-01/p01-js` (published, must not gain a
 * dependency), the browser extension (MV3 service worker, hand-rolled bundle)
 * and the mobile app (React Native / Hermes). Each of those keeps a local copy
 * for bundling reasons, and each copy is pinned to THIS file by a parity test
 * that imports it directly — see `ENTITLEMENT_PARITY_VECTORS` below.
 *
 * That only works if importing this module costs nothing, so it deliberately
 * imports NOTHING: no `@solana/web3.js`, no `Buffer`, no `bs58`. Keep it that
 * way; a single value import here breaks every downstream parity test.
 *
 * ## What the arithmetic is for
 *
 * `SubscriptionVault.is_active` carries no information. The program writes it
 * `true` at `subscribe_normal.rs:120` and `subscribe_private_stark.rs:395`, and
 * `false` NOWHERE. Cancellation is not the hole — `cancel_normal.rs:42` and
 * `cancel_private_stark.rs:111` both `close` the account, so a cancelled vault
 * stops existing. The hole is running out of money, which nothing on chain
 * marks. MEASURED on devnet 2026-08-01: a vault with all five periods claimed
 * and a zero residual balance still reported `is_active: true`.
 *
 * So "may this subscriber be served?" is a question about time and funding, and
 * is answered by {@link subscriptionIsCurrent}, never by `isActive` alone.
 */

// ---------------------------------------------------------------------------
// Structural vault shapes
// ---------------------------------------------------------------------------

/**
 * The fields of a `SubscriptionVault` this module reads. Structural on purpose:
 * every port (mobile, extension, p01-js) can satisfy it without importing the
 * SDK's decoded account type.
 */
export interface VaultPeriodState {
  isActive: boolean;
  isPaused: boolean;
  startSlot: bigint;
  totalPausedSlots: bigint;
  intervalSlots: bigint;
  claimedPeriods: bigint;
  totalDeposited: bigint;
  rate: bigint;
}

/** Just the funding half: how many periods the deposit bought. */
export type VaultFundingState = Pick<VaultPeriodState, 'totalDeposited' | 'rate'>;

/** Just the clock half: how far the subscription has run. */
export type VaultElapsedState = Pick<
  VaultPeriodState,
  'startSlot' | 'totalPausedSlots' | 'intervalSlots'
>;

/** Everything {@link subscriptionIsCurrent} needs (all but `claimedPeriods`). */
export type VaultEntitlementState = Omit<VaultPeriodState, 'claimedPeriods'>;

// ---------------------------------------------------------------------------
// Period math
// ---------------------------------------------------------------------------

function satSub(a: bigint, b: bigint): bigint {
  return a > b ? a - b : 0n;
}

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
 * a subscription has run out of money.
 *
 * @param currentSlot slot to evaluate against (`connection.getSlot()`).
 */
export function claimablePeriods(
  vault: VaultPeriodState,
  currentSlot: bigint,
): bigint {
  if (!vault.isActive || vault.isPaused) return 0n;

  const effectiveElapsed = currentSlot - vault.startSlot - vault.totalPausedSlots;
  if (effectiveElapsed <= 0n) return 0n;

  // On chain this is a u64 division; `interval_slots == 0` would panic and the
  // transaction would fail. Refuse to build one rather than reproduce the panic.
  // (`subscribe_normal.rs:68` and `subscribe_private_stark.rs:182` both require
  // `interval_slots > 0`, so this is unreachable for vaults the program made.)
  if (vault.intervalSlots === 0n) return 0n;

  const totalPeriods = effectiveElapsed / vault.intervalSlots;
  const unclaimed = satSub(totalPeriods, vault.claimedPeriods);
  const maxFunded = fundedPeriodsRemaining(vault);

  return unclaimed < maxFunded ? unclaimed : maxFunded;
}

/** Atomic units the retailer would receive if it claimed at `currentSlot`. */
export function claimableAmount(vault: VaultPeriodState, currentSlot: bigint): bigint {
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
  vault: VaultFundingState & Pick<VaultPeriodState, 'claimedPeriods'>,
): bigint {
  if (vault.rate === 0n) return 0n;
  return satSub(vault.totalDeposited / vault.rate, vault.claimedPeriods);
}

/** Total periods the subscriber paid for at subscribe time. */
export function periodsPaidFor(vault: VaultFundingState): bigint {
  if (vault.rate === 0n) return 0n;
  return vault.totalDeposited / vault.rate;
}

/** Zero-based index of the period the subscription is in at `currentSlot`. */
export function periodsElapsed(vault: VaultElapsedState, currentSlot: bigint): bigint {
  if (vault.intervalSlots === 0n) return 0n;
  const effective = currentSlot - vault.startSlot - vault.totalPausedSlots;
  if (effective <= 0n) return 0n;
  return effective / vault.intervalSlots;
}

/**
 * Whether the subscription entitles its holder to service RIGHT NOW.
 *
 * This is the check a merchant must gate on, and it is deliberately NOT
 * `isActive` — see the module header for why that field is empty of meaning.
 *
 * Nor is `fundedPeriodsRemaining > 0` the right test: that stays positive while
 * a retailer merely neglects to claim. Entitlement is a function of time paid
 * for, not of collection — the subscriber is current while the period they are
 * in is one they paid for.
 */
export function subscriptionIsCurrent(
  vault: VaultEntitlementState,
  currentSlot: bigint,
): boolean {
  if (!vault.isActive || vault.isPaused) return false;
  // `intervalSlots === 0` makes the period length undefined: `periodsElapsed`
  // would report 0 forever and the subscription would never expire. No vault
  // the program created can be in that state (`subscribe_normal.rs:68`,
  // `subscribe_private_stark.rs:182` both require `interval_slots > 0`), so
  // refusing costs nothing real and closes an "entitled forever" shape that
  // would otherwise sit in the gate.
  if (vault.intervalSlots === 0n) return false;
  return periodsElapsed(vault, currentSlot) < periodsPaidFor(vault);
}

/**
 * First slot at which {@link subscriptionIsCurrent} turns false, or `null` when
 * the vault is never current (`rate === 0`, `intervalSlots === 0`, inactive, or
 * paused — a paused vault entitles nobody until it resumes).
 *
 * ## Why this is a safe lower bound
 *
 * `total_paused_slots` only ever GROWS (`resume_normal.rs:39` adds the paused
 * duration), so the real end slot can only move LATER than the value returned
 * here. Anything that clamps a deadline to this number therefore expires early
 * rather than late, which is the direction an access decision must fail in.
 */
export function subscriptionEndSlot(vault: VaultEntitlementState): bigint | null {
  if (!vault.isActive || vault.isPaused) return null;
  if (vault.intervalSlots === 0n) return null;
  const paid = periodsPaidFor(vault);
  if (paid === 0n) return null;
  return vault.startSlot + vault.totalPausedSlots + paid * vault.intervalSlots;
}

/**
 * Slots of entitlement left at `currentSlot`, floored at zero.
 * Zero means the subscription is already over (or never started).
 */
export function slotsUntilSubscriptionEnds(
  vault: VaultEntitlementState,
  currentSlot: bigint,
): bigint {
  const end = subscriptionEndSlot(vault);
  if (end === null) return 0n;
  return satSub(end, currentSlot);
}

/**
 * Nominal Solana slot time in milliseconds.
 *
 * Used only to turn a slot budget into a wall-clock deadline. Real slots run
 * SLOWER than nominal, so `slots × 400ms` under-states the remaining wall time
 * and any deadline derived from it lands early. That is the safe direction for
 * an access decision; do not "correct" it upward without a measurement.
 */
export const NOMINAL_SLOT_MS = 400n;

/**
 * Whole seconds of entitlement left at `currentSlot`, rounded DOWN.
 *
 * @param slotMs override the nominal slot time. Larger values are less
 *   conservative — only raise it against a measured cluster.
 */
export function secondsUntilSubscriptionEnds(
  vault: VaultEntitlementState,
  currentSlot: bigint,
  slotMs: bigint = NOMINAL_SLOT_MS,
): bigint {
  if (slotMs <= 0n) throw new Error('slotMs must be positive');
  return (slotsUntilSubscriptionEnds(vault, currentSlot) * slotMs) / 1000n;
}

// ---------------------------------------------------------------------------
// The rent floor
// ---------------------------------------------------------------------------

/**
 * Rent-exempt minimum for a zero-data system account, in lamports.
 *
 * Hard-coded only as a fallback for callers with no `Connection`; prefer
 * `connection.getMinimumBalanceForRentExemption(0)`, which is authoritative.
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

// ---------------------------------------------------------------------------
// Cross-implementation parity vectors
// ---------------------------------------------------------------------------

/** One row of the shared conformance table. */
export interface EntitlementParityVector {
  /** Why this row exists — printed by every port's parity test on failure. */
  name: string;
  vault: VaultPeriodState;
  currentSlot: bigint;
  /** Expected {@link subscriptionIsCurrent}. */
  isCurrent: boolean;
  /** Expected {@link claimablePeriods}. */
  claimable: bigint;
  /** Expected {@link fundedPeriodsRemaining}. */
  fundedRemaining: bigint;
}

function vaultOf(over: Partial<VaultPeriodState> = {}): VaultPeriodState {
  return {
    isActive: true,
    isPaused: false,
    startSlot: 1_000n,
    totalPausedSlots: 0n,
    intervalSlots: 100n,
    claimedPeriods: 0n,
    totalDeposited: 500_000n,
    rate: 100_000n, // 5 periods funded
    ...over,
  };
}

/**
 * The conformance table every implementation of this arithmetic must satisfy.
 *
 * The expectations are written out by hand, NOT produced by calling the
 * functions above — a table generated from the implementation would agree with
 * any bug the implementation has. `period-math.test.ts` checks this module
 * against the table, and each port checks itself against the same table, so all
 * copies are pinned to one set of literal answers rather than to each other.
 */
export const ENTITLEMENT_PARITY_VECTORS: readonly EntitlementParityVector[] = [
  {
    name: 'fresh vault, first period, nothing accrued yet',
    vault: vaultOf(),
    currentSlot: 1_050n,
    isCurrent: true,
    claimable: 0n,
    fundedRemaining: 5n,
  },
  {
    name: 'mid-subscription: period 2 of 5, two periods claimable',
    vault: vaultOf(),
    currentSlot: 1_250n,
    isCurrent: true,
    claimable: 2n,
    fundedRemaining: 5n,
  },
  {
    name: 'last funded period — still current at the very last slot before rollover',
    vault: vaultOf(),
    currentSlot: 1_499n,
    isCurrent: true,
    claimable: 4n,
    fundedRemaining: 5n,
  },
  {
    name: 'THE BUG: exactly 5 periods elapsed, all 5 paid — no longer current',
    vault: vaultOf(),
    currentSlot: 1_500n,
    isCurrent: false,
    claimable: 5n,
    fundedRemaining: 5n,
  },
  {
    name: 'THE MEASURED VAULT: 5 periods claimed, balance spent, isActive still true',
    vault: vaultOf({ claimedPeriods: 5n }),
    currentSlot: 1_500n,
    isCurrent: false,
    claimable: 0n,
    fundedRemaining: 0n,
  },
  {
    name: 'long overrun: 40 periods of wall clock, only 5 ever funded',
    vault: vaultOf(),
    currentSlot: 5_000n,
    isCurrent: false,
    claimable: 5n,
    fundedRemaining: 5n,
  },
  {
    name: 'lazy retailer: funding intact but time exhausted — money left, no entitlement',
    vault: vaultOf({ claimedPeriods: 1n }),
    currentSlot: 5_000n,
    isCurrent: false,
    claimable: 4n,
    fundedRemaining: 4n,
  },
  {
    name: 'paused vault entitles nobody, and nothing is claimable while paused',
    vault: vaultOf({ isPaused: true }),
    currentSlot: 1_250n,
    isCurrent: false,
    claimable: 0n,
    fundedRemaining: 5n,
  },
  {
    name: 'pause credit shifts the window: 200 paused slots keep period 3 alive',
    vault: vaultOf({ totalPausedSlots: 200n }),
    currentSlot: 1_500n,
    isCurrent: true,
    claimable: 3n,
    fundedRemaining: 5n,
  },
  {
    name: 'pause cannot rewind an already-exhausted subscription',
    vault: vaultOf({ totalPausedSlots: 200n }),
    currentSlot: 1_700n,
    isCurrent: false,
    claimable: 5n,
    fundedRemaining: 5n,
  },
  {
    name: 'isActive false (never written by the program, but decode it faithfully)',
    vault: vaultOf({ isActive: false }),
    currentSlot: 1_250n,
    isCurrent: false,
    claimable: 0n,
    fundedRemaining: 5n,
  },
  {
    // Unreachable on chain: `start_slot` is written from `Clock::get()` at
    // subscribe time, so it is never in the future. Pinned so a port cannot
    // quietly disagree about the sign of the elapsed window.
    name: 'clock before start_slot — treated as period 0, i.e. still current',
    vault: vaultOf(),
    currentSlot: 900n,
    isCurrent: true,
    claimable: 0n,
    fundedRemaining: 5n,
  },
  {
    name: 'rate 0 — unreachable on chain, must never be treated as infinite service',
    vault: vaultOf({ rate: 0n }),
    currentSlot: 1_250n,
    isCurrent: false,
    claimable: 0n,
    fundedRemaining: 0n,
  },
  {
    name: 'intervalSlots 0 — unreachable on chain, must fail closed, not entitle forever',
    vault: vaultOf({ intervalSlots: 0n }),
    currentSlot: 1_250n,
    isCurrent: false,
    claimable: 0n,
    fundedRemaining: 5n,
  },
  {
    name: 'partial funding: deposit buys 3.5 periods, only 3 are entitled',
    vault: vaultOf({ totalDeposited: 350_000n }),
    currentSlot: 1_300n,
    isCurrent: false,
    claimable: 3n,
    fundedRemaining: 3n,
  },
  {
    name: 'partial funding, still inside period 2 of the 3 funded',
    vault: vaultOf({ totalDeposited: 350_000n }),
    currentSlot: 1_250n,
    isCurrent: true,
    claimable: 2n,
    fundedRemaining: 3n,
  },
  {
    name: 'over-claimed vault (claimed beyond funding) saturates instead of underflowing',
    vault: vaultOf({ claimedPeriods: 9n }),
    currentSlot: 5_000n,
    isCurrent: false,
    claimable: 0n,
    fundedRemaining: 0n,
  },
  {
    name: 'large values stay exact in bigint (would lose precision as a double)',
    vault: vaultOf({
      totalDeposited: 9_007_199_254_740_995n,
      rate: 3n,
      claimedPeriods: 0n,
    }),
    currentSlot: 1_100n,
    isCurrent: true,
    claimable: 1n,
    fundedRemaining: 3_002_399_751_580_331n,
  },
];
