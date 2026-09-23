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
 * Pinned by `__tests__/components/closeV1PayI18n.test.ts`.
 */
export const POOL_ERROR_CODES = [
  "C1C3_SPEND_DISABLED",
  "POOL_TREE_DIVERGED",
  "POOL_DEPOSITS_BRICKED",
  "IMPORT_NOT_ON_TREE",
  "EXCHANGE_DISABLED",
] as const;

export type PoolErrorCode = (typeof POOL_ERROR_CODES)[number];

const KEY: Record<PoolErrorCode, string> = {
  C1C3_SPEND_DISABLED: "pay.errors.c1c3SpendDisabled",
  POOL_TREE_DIVERGED: "pay.errors.poolTreeDiverged",
  POOL_DEPOSITS_BRICKED: "pay.errors.poolDepositsBricked",
  IMPORT_NOT_ON_TREE: "pay.errors.importNotOnTree",
  EXCHANGE_DISABLED: "pay.errors.exchangeDisabled",
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
