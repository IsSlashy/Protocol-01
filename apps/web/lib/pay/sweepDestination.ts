/**
 * The one rule standing between a payout address and the wallet it exists to
 * be separate from.
 *
 * WHY THIS IS A NAMED POLICY AND NOT THREE LINES IN A COMPONENT
 * ────────────────────────────────────────────────────────────
 * A withdrawal pays a fresh address derived per note, so the pool's payee is
 * not the user. The most direct way to undo that mechanism is moving the
 * payout to the connected wallet. And it is undone completely, because the
 * withdrawal's recipient is a plain 32-byte instruction argument published in
 * cleartext — so the walk is
 *
 *   getTransaction(spend) → the payout address, straight out of the bytes
 *   → getSignaturesForAddress(payout) → getTransaction(its next tx) → the wallet
 *
 * Three RPC calls, the same price as the payer walk, on the same transaction,
 * against the same user. MEASURED on devnet 2026-08-04 in the mobile client: a
 * stealth recipient forwarded 0.994995 SOL to the user's wallet 8 seconds after
 * the withdrawal, slot 481027703.
 *
 * The /pay UI used to offer this as a one-click button that prefilled the
 * wallet address. That is not a default, it is a recommendation: it made the
 * destination that undoes the mechanism most cheaply the easiest one to choose,
 * and it sat next to copy explaining why not to.
 *
 * ⚠️ THE WALLET IS THE MOST DIRECT LINK, NOT THE ONLY ONE. This header used to
 * say "exactly one action", and the screen copy still says "the one
 * destination". Two more are just as public:
 *
 *  - ONE ADDRESS FOR TWO PAYOUTS. A payout address is derived per note so two
 *    withdrawals of one person do not name each other. Sweeping payout A and
 *    payout B to the same D publishes spendA -> A -> D and spendB -> B -> D, so
 *    any chain reader groups the withdrawals, and ties the group to whoever is
 *    behind D. `sweepStop` below asks once before that happens. Measured with
 *    no stop: scratchpad/web-run/logs8/r1-chain/
 *    probe4-sweep-destination-reuse.log.
 *  - ANY ADDRESS ALREADY TIED TO THE WALLET: the exchange deposit address the
 *    wallet pays into, a second wallet funded from the first. No code here can
 *    see that history, so only the copy can carry it.
 *
 * What `sweepStop` cannot see: reuse across a reload, another tab or another
 * device. Its memory is this page's and nothing else's, on purpose (see
 * `createSweepDestinationMemory`).
 *
 * So: sweeping home stays available — it is frequently what someone actually
 * wants, and a tool that forbids it just gets worked around — but it costs one
 * explicit, per-address confirmation. The rule lives here, with its reasoning,
 * rather than inline, because it is the kind of guard a later refactor deletes
 * for looking like an extra click.
 */

export interface SweepConfirmationInput {
  /** What the user typed, already trimmed. */
  destination: string;
  /** The connected wallet, base58. */
  ownerKey: string;
  /** The payout address about to be swept. */
  payoutAddress: string;
  /**
   * The payout address the user has already confirmed sending home, if any.
   *
   * Held per ADDRESS rather than as a boolean on purpose: confirming one payout
   * must not arm the next one. A user with four payouts who accepts the warning
   * on the first would otherwise send the other three home without ever seeing
   * it again.
   */
  armedFor: string | null;
}

/**
 * Whether this sweep must stop and ask first.
 *
 * True only when the destination IS the connected wallet and this exact payout
 * has not already been confirmed. This rule says nothing about any other
 * destination: it is about one specific outcome, and a warning shown for
 * everything is read for nothing. An address an earlier payout already went to
 * is the other outcome with its own stop, in `sweepStop`.
 */
export function requiresSweepHomeConfirmation(input: SweepConfirmationInput): boolean {
  const { destination, ownerKey, payoutAddress, armedFor } = input;
  if (destination === '' || ownerKey === '') return false;
  if (destination !== ownerKey) return false;
  return armedFor !== payoutAddress;
}

/**
 * Which destinations this page has already swept a payout to.
 *
 * 🚨 MEMORY ONLY, AND NOT READABLE BACK. The destinations of earlier sweeps are
 * exactly the rows that join payouts to each other, which is why round 1 clears
 * the destination field after every sweep. So this holds them in a closure: no
 * property to list, nothing `JSON.stringify` can reach, nothing to put in a
 * store, and no way to ask "where did the earlier ones go" — only "did a
 * DIFFERENT payout already go to this one". A caller keeps it in a ref for the
 * life of the panel. A reload starts clean, which is the cost of never writing
 * it down. Pinned by `__tests__/lib/sweepDestination.test.ts`, "keeps nothing
 * anybody can read back or carry to the disk".
 *
 * Both arguments are canonical base58 (`PublicKey.toBase58()`), the same form
 * the home rule is given.
 */
export interface SweepDestinationMemory {
  /** Call once a sweep of `payoutAddress` to `destination` has gone through. */
  remember(destination: string, payoutAddress: string): void;
  /** Whether a payout OTHER than this one was already swept to `destination`. */
  usedByAnotherPayout(destination: string, payoutAddress: string): boolean;
}

export function createSweepDestinationMemory(): SweepDestinationMemory {
  const payoutsByDestination = new Map<string, Set<string>>();
  return {
    remember(destination, payoutAddress) {
      if (destination === '' || payoutAddress === '') return;
      const seen = payoutsByDestination.get(destination) ?? new Set<string>();
      seen.add(payoutAddress);
      payoutsByDestination.set(destination, seen);
    },
    usedByAnotherPayout(destination, payoutAddress) {
      const seen = payoutsByDestination.get(destination);
      if (!seen) return false;
      for (const earlier of seen) if (earlier !== payoutAddress) return true;
      return false;
    },
  };
}

/** A sweep that must stop and ask first, and what to say. */
export interface SweepStop {
  reason: 'home' | 'reused';
  /** The sentence to show. It names no address. */
  warning: string;
  /**
   * What the caller stores as `armedFor` so the SAME press again goes through.
   *
   * For `'home'` it is the payout address, exactly what
   * `requiresSweepHomeConfirmation` already compares against. For `'reused'` it
   * also carries the destination, so a confirmation is for one payout going to
   * one address: neither a sweep home confirmed a moment ago nor a different
   * reused address rides on it.
   */
  armToken: string;
}

/**
 * The one door a sweep goes through: `null` to proceed, or the stop to show.
 *
 * Both rules ask ONCE and never block. Several 1 SOL payouts to one address is
 * the ordinary way to move several SOL, and a gate that cannot be passed gets
 * worked around by a route with no warning on it.
 */
export function sweepStop(
  input: SweepConfirmationInput & { memory: SweepDestinationMemory },
): SweepStop | null {
  const { destination, payoutAddress, armedFor, memory } = input;
  if (requiresSweepHomeConfirmation(input)) {
    return { reason: 'home', warning: SWEEP_HOME_WARNING, armToken: payoutAddress };
  }
  if (destination === '' || destination === input.ownerKey) return null;
  if (!memory.usedByAnotherPayout(destination, payoutAddress)) return null;
  const armToken = `${payoutAddress}>${destination}`;
  if (armedFor === armToken) return null;
  return { reason: 'reused', warning: SWEEP_REUSE_WARNING, armToken };
}

/**
 * What to tell the user before a second payout follows an earlier one.
 *
 * It names no address: it renders under the payout rows, and the earlier
 * destination beside them is the join itself.
 */
export const SWEEP_REUSE_WARNING =
  'Another payout already went to that address in this session. Sending this one there too lets ' +
  'anyone reading the chain group the two withdrawals, and tie both to whoever owns that ' +
  'address. Press Sweep again to do it anyway, or enter a different address.';

/**
 * What to tell the user when it does.
 *
 * Written here so the sentence travels with the rule. It states the mechanism
 * and the cost, not a scare: the user is about to do something legitimate whose
 * consequence is invisible from the screen they are looking at.
 */
export const SWEEP_HOME_WARNING =
  'That destination is your connected wallet. Sending this payout there publishes a transfer ' +
  'that links the withdrawal to your wallet in one transaction — anyone reading the withdrawal ' +
  'reaches you in three RPC calls. Press Sweep again to do it anyway, or enter a different ' +
  'address.';
