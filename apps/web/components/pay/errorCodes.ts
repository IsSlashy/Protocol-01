/**
 * The refusal codes of the pool builders, the worker and the issuer, turned
 * into a sentence of the visitor's language (close-v1, contract C2).
 *
 * A refusal that fires BEFORE anything is paid carries a stable code at the
 * start of its message (`C1C3_SPEND_DISABLED: ...`); the rest of the message
 * is English detail for a debugger. Every panel that shows a pool error puts
 * it through `localizePoolError`, which returns the dictionary sentence for a
 * known code and the message unchanged otherwise.
 *
 *   C1C3_SPEND_DISABLED    a C1 + C3 spend binds no payee, so a copier of its
 *                          public proof takes the note (audit v1, F05); the
 *                          web builders refuse it (lane L3).
 *   POOL_TREE_DIVERGED     the rebuilt tree disagrees with the on-chain root
 *                          (F01/F06 pre-flight, lane L3).
 *   POOL_DEPOSITS_BRICKED  a non-canonical stored value stops deposits (F28
 *                          pre-flight, lane L3).
 *   IMPORT_NOT_ON_TREE     an imported note's commitment is not at its leaf
 *                          (F35, lane L2).
 *   EXCHANGE_DISABLED      the note-in exchange is off while its claim can be
 *                          taken by a proof copier (F70, lane L2).
 *
 * [close-v1 F57, gate r1 item 7] The codes of the payment itself and of the
 * relayed fallback. These fire AFTER or AROUND a payment, so each sentence says
 * what happened to the money, and every RELAYED_ one tells the buyer not to
 * shield again (that would pay a second time):
 *
 *   PAYMENT_EXPIRED             the payment expired before it landed: nothing
 *                               was paid (`ephemeralFunder.ts`).
 *   PAYMENT_FAILED_ON_CHAIN     the payment landed and failed: it paid nothing
 *                               (`/api/claim-for-payment`).
 *   PAYMENT_OUTSTANDING         an earlier payment is still owed a note, so no
 *                               new one is taken (`shieldClient.ts`).
 *   RELAYED_EPHEMERAL_REQUIRED  the relayed fallback needs the deposit key's
 *   RELAYED_EPHEMERAL_UNBOUND   proof, the relay's record of that key, the
 *   RELAYED_FUNDING_UNSEEN      funding visible on chain, and the float's
 *   RELAYED_FLOAT_NOT_RETURNED  lamports back (`/api/claim-for-payment`, F11).
 *   FUNDER_IP_BUDGET            `/api/fund-ephemeral` refusals (F37). The
 *   FUNDER_GLOBAL_BUDGET        client does not yet put these codes at the
 *   FUNDER_UNSWEPT_GRANT        start of its message (`ephemeralFunder.ts`,
 *                               handed off), so they are mapped ahead of it.
 *
 * Pinned by `__tests__/components/closeV1PayI18n.test.ts`, and by
 * `__tests__/components/closeV1PayErrorCodesAll.test.ts`, which reads every
 * code the routes return and the client throws from the sources and requires
 * each one here with an en and an fr sentence.
 */
export const POOL_ERROR_CODES = [
  "C1C3_SPEND_DISABLED",
  "POOL_TREE_DIVERGED",
  "POOL_DEPOSITS_BRICKED",
  "IMPORT_NOT_ON_TREE",
  "EXCHANGE_DISABLED",
  "PAYMENT_EXPIRED",
  "PAYMENT_FAILED_ON_CHAIN",
  "PAYMENT_OUTSTANDING",
  "RELAYED_EPHEMERAL_REQUIRED",
  "RELAYED_EPHEMERAL_UNBOUND",
  "RELAYED_FUNDING_UNSEEN",
  "RELAYED_FLOAT_NOT_RETURNED",
  "FUNDER_IP_BUDGET",
  "FUNDER_GLOBAL_BUDGET",
  "FUNDER_UNSWEPT_GRANT",
] as const;

export type PoolErrorCode = (typeof POOL_ERROR_CODES)[number];

const KEY: Record<PoolErrorCode, string> = {
  C1C3_SPEND_DISABLED: "pay.errors.c1c3SpendDisabled",
  POOL_TREE_DIVERGED: "pay.errors.poolTreeDiverged",
  POOL_DEPOSITS_BRICKED: "pay.errors.poolDepositsBricked",
  IMPORT_NOT_ON_TREE: "pay.errors.importNotOnTree",
  EXCHANGE_DISABLED: "pay.errors.exchangeDisabled",
  PAYMENT_EXPIRED: "pay.errors.paymentExpired",
  PAYMENT_FAILED_ON_CHAIN: "pay.errors.paymentFailedOnChain",
  PAYMENT_OUTSTANDING: "pay.errors.paymentOutstanding",
  RELAYED_EPHEMERAL_REQUIRED: "pay.errors.relayedEphemeralRequired",
  RELAYED_EPHEMERAL_UNBOUND: "pay.errors.relayedEphemeralUnbound",
  RELAYED_FUNDING_UNSEEN: "pay.errors.relayedFundingUnseen",
  RELAYED_FLOAT_NOT_RETURNED: "pay.errors.relayedFloatNotReturned",
  FUNDER_IP_BUDGET: "pay.errors.funderIpBudget",
  FUNDER_GLOBAL_BUDGET: "pay.errors.funderGlobalBudget",
  FUNDER_UNSWEPT_GRANT: "pay.errors.funderUnsweptGrant",
};

/** A code at the start of the message, or after a prefix such as "Error: ". */
const FIND = new RegExp(`(?:^|[\\s:])(${POOL_ERROR_CODES.join("|")}):`);

export function poolErrorCode(message: string | null | undefined): PoolErrorCode | null {
  const m = (message ?? "").match(FIND);
  return m ? (m[1] as PoolErrorCode) : null;
}

export function localizePoolError(message: string, t: (key: string) => string): string {
  const code = poolErrorCode(message);
  return code ? t(KEY[code]) : message;
}
