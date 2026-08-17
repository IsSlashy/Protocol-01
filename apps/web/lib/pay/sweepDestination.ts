/**
 * The one rule standing between a payout address and the wallet it exists to
 * be separate from.
 *
 * WHY THIS IS A NAMED POLICY AND NOT THREE LINES IN A COMPONENT
 * ────────────────────────────────────────────────────────────
 * A withdrawal pays a fresh address derived per note, so the pool's payee is
 * not the user. That mechanism is undone by exactly one action: moving the
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
 * single destination that undoes the mechanism the easiest one to choose, and
 * it sat next to copy explaining why not to.
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
 * has not already been confirmed. Every other destination — a fresh address, an
 * exchange, a second wallet — proceeds without friction, because the warning is
 * about one specific outcome and a warning shown for everything is read for
 * nothing.
 */
export function requiresSweepHomeConfirmation(input: SweepConfirmationInput): boolean {
  const { destination, ownerKey, payoutAddress, armedFor } = input;
  if (destination === '' || ownerKey === '') return false;
  if (destination !== ownerKey) return false;
  return armedFor !== payoutAddress;
}

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
