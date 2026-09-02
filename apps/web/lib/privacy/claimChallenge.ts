/**
 * The message a payer signs to collect what a payment bought.
 *
 * One string, one module, imported by everything that signs or verifies it:
 * `/api/claim-for-payment` (verifies), `/api/contribute-note` confirm
 * (verifies), the worker's note-in withdrawal (signs as the ephemeral fee
 * payer) and the contribution fallback (signs as the wallet).
 *
 * WHY IT LIVES HERE AND NOT IN THE ROUTE. The worker bundle must never import
 * a route file: a route pulls in `next/server`, the KV store and the treasury
 * derivation, none of which belong in a web worker. The route re-exports this
 * function so its existing importers keep working.
 *
 * WHY THE PAYMENT SIGNATURE IS INSIDE THE TEXT. A signature over a constant
 * string would be a bearer credential: captured once, it would collect every
 * note that key ever pays for. Binding it to one transaction makes a leaked
 * proof worth exactly the claim it already minted.
 *
 * The wire format is pinned verbatim in `claim-for-payment.test.ts`, on
 * purpose: a test that derived it from this file would follow it anywhere it
 * drifted and pin nothing.
 */
export function claimChallenge(signature: string): string {
  return `Protocol 01 - collect the note I paid for.\nPayment: ${signature}`;
}
