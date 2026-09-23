import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

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

/**
 * [close-v1 F11] The message the deposit ephemeral of a RELAYED payment signs
 * when that payment falls back to `/api/claim-for-payment`.
 *
 * A distinct text from `claimChallenge`, on purpose: the two keys prove two
 * different things. The wallet proves it made the payment; the ephemeral proves
 * the caller holds the key the relay funded, so the route can read that key's
 * history and see the float's lamports back where they came from. Bound to the
 * payment, so a proof made for one fallback is worth nothing on another.
 * Pinned verbatim by `__tests__/api/closeV1L2ClaimRoute.test.ts`.
 */
export function relayEphemeralChallenge(signature: string): string {
  return `Protocol 01 - the deposit key this payment funded gave the float back.\nPayment: ${signature}`;
}

/**
 * [close-v1 F11] Where `/api/relay-to-buyer` records WHICH ephemeral it funded
 * with a payment, and the value it records there.
 *
 * ⛔ NEVER THE EPHEMERAL IN CLEAR. `p01:relay:payment:<sig>:buyer` was deleted
 * because it joined the buyer's payment (whose fee payer is their wallet) to the
 * key that deposits. So the row holds a keyed tag: HMAC-SHA256 under a key
 * derived from the float's secret, over `<signature>\n<ephemeral>`. A copy of
 * the store cannot test a guess without that secret (every float-funded
 * ephemeral is public, so an unkeyed hash would be matched in one pass), while
 * the claim route, which runs with the same secret, can check the ephemeral a
 * caller names against it.
 *
 * Pure JS (`@noble/hashes`) so this module stays importable by the worker and
 * the client, which only ever call `relayEphemeralChallenge`.
 */
export function relayEphemeralTagKey(signature: string): string {
  return `p01:relay:payment:${signature}:ephemeral-tag`;
}

export function relayEphemeralTag(
  funderSecretKey: Uint8Array,
  signature: string,
  ephemeral: string,
): string {
  const key = sha256(concatBytes(utf8ToBytes('p01:relay:ephemeral-tag:v1\0'), funderSecretKey));
  try {
    return bytesToHex(hmac(sha256, key, utf8ToBytes(`${signature}\n${ephemeral}`)));
  } finally {
    key.fill(0);
  }
}

/**
 * [close-v1 F11, verifier round 1] ONE RETURN TO THE FLOAT BACKS ONE PAYMENT.
 *
 * `/api/claim-for-payment` credits a relayed payment with the transactions
 * that moved lamports from its ephemeral back to the float. Each such return
 * is recorded once, against the payment it backed, so a single sweep can never
 * repay two payments. The row is keyed and valued by HMAC-SHA256 under a key
 * derived from the float's secret, for the reason `relayEphemeralTag` gives:
 * a return transaction names the ephemeral on chain, so a row holding its
 * signature (or the payment's) in clear would join the payment to the deposit
 * key for anyone holding a copy of the store.
 *
 *   p01:relay:return:<hmac(return signature)>         incr: first writer wins
 *   p01:relay:return:<hmac(return signature)>:owner   hmac(payment signature)
 */
function relayReturnHmac(funderSecretKey: Uint8Array, text: string): string {
  const key = sha256(concatBytes(utf8ToBytes('p01:relay:return:v1\0'), funderSecretKey));
  try {
    return bytesToHex(hmac(sha256, key, utf8ToBytes(text)));
  } finally {
    key.fill(0);
  }
}

export function relayReturnKey(funderSecretKey: Uint8Array, returnSignature: string): string {
  return `p01:relay:return:${relayReturnHmac(funderSecretKey, `return\n${returnSignature}`)}`;
}

export function relayReturnOwner(funderSecretKey: Uint8Array, paymentSignature: string): string {
  return relayReturnHmac(funderSecretKey, `owner\n${paymentSignature}`);
}
