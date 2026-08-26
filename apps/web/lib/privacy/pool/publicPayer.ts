/**
 * Refuses to let a live harness pay with an address this repository has already
 * published about itself.
 *
 * WHY THIS EXISTS
 * ───────────────
 * A circuit-7 spend removes the commitment linkage between a withdrawal and its
 * deposit leaf. It does not remove the fee payer. That address is
 * `accountKeys[0]` of the transaction, signed in permanently, returned by every
 * `getTransaction`, and no proof can take it back out.
 *
 * MEASURED: the first real v4 withdrawal (`22psv1tF…`, devnet, 2026-08-25)
 * publishes no field of its deposit — that half held — and was paid by
 * `7gWpzSZA…`, which `getAccountInfo` on the programData accounts confirms is
 * the upgrade authority of BOTH the pool and the verifier, which is
 * `TREASURY_AUTHORITY` in `programs/zk_shielded/src/fee.rs`, and which is
 * printed in `README.md`. So the withdrawal is attributable to the operator in
 * one RPC call. `p01-verify.mjs --wallet 7gWpzSZA…` reports it as a surviving
 * linkage, pinned at `verify/fixtures/v4-live` (P11 FAIL).
 *
 * The trap is that this address is also the Solana CLI default key, so it is
 * what every harness reaches for when `P01_LIVE_KEYPAIR` is unset. Convenience
 * and attribution are the same keystroke. This module makes them different
 * ones.
 */

/**
 * Addresses this repository names in public, and where. Base58 keys, because
 * that is what a reader will have in hand from a block explorer.
 *
 * Add to this map, never remove from it: an address that has been published
 * stays published, and deleting the entry only removes the warning.
 */
export const PUBLICLY_NAMED_IN_THIS_REPO: Readonly<Record<string, string>> = Object.freeze({
  '7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU':
    'the upgrade authority of the pool AND the verifier, TREASURY_AUTHORITY in ' +
    'programs/zk_shielded/src/fee.rs, a live p01_relayer node, and printed in README.md',
  BRop3akxwuQaAHeMUC33ZyRjzLh78ENquVMgHum9TjNN:
    'PROTOCOL_FEE_WALLET in programs/zk_shielded/src/fee.rs',
});

/** The env var that says an attributable payer is what you actually want. */
export const ACK_ENV = 'P01_LIVE_ACK_PUBLIC_PAYER';

/**
 * The refusal message for `pubkey`, or `null` when the address is not one this
 * repository has published.
 *
 * Pure and exported so the guard can be tested without a secret key — the
 * addresses in the map are public, and nobody holds their private halves in a
 * test. A guard that can only be exercised by running the live harness is a
 * guard nobody exercises.
 */
export function publicPayerRefusal(pubkey: string, role = 'a live transaction'): string | null {
  const why = PUBLICLY_NAMED_IN_THIS_REPO[pubkey];
  if (!why) return null;
  return (
    `refusing to pay for ${role} with ${pubkey}: it is ${why}.\n` +
    `  The fee payer is accountKeys[0] and is public forever, so this run would produce a\n` +
    `  transaction attributable to the operator in one getTransaction — measured on\n` +
    `  22psv1tF…, pinned at verify/fixtures/v4-live (P11 FAIL).\n` +
    `  Pass P01_LIVE_KEYPAIR=<a key this repo has never named>, or set ${ACK_ENV}=1 if an\n` +
    `  attributable payer is what you actually want.`
  );
}

/**
 * Throws unless `pubkey` is safe to pay with, or the acknowledgement is set.
 *
 * `env` is injected so a test can drive both branches without mutating
 * `process.env` and leaking that mutation into whatever runs next.
 */
export function assertPayerNotPubliclyNamed(
  pubkey: string,
  role = 'a live transaction',
  env: Record<string, string | undefined> = process.env,
): void {
  if (env[ACK_ENV] === '1') return;
  const refusal = publicPayerRefusal(pubkey, role);
  if (refusal) throw new Error(refusal);
}
