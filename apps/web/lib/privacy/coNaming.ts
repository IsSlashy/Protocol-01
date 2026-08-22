import { Connection, PublicKey } from '@solana/web3.js';

/**
 * Does any one transaction name both of these addresses?
 *
 * WHY THIS ANSWER IS WORTH ITS OWN MODULE
 * ───────────────────────────────────────
 * It is the whole of probe P11's method and the whole of the walk that succeeded
 * on 2026-08-18: an auditor does not decode instructions or read proofs, they
 * list account keys and look for one address. A transaction naming two addresses
 * is returned by `getSignaturesForAddress` for BOTH, so intersecting two
 * listings answers the question in two calls, EXACTLY — no window, no sampling,
 * no transaction bodies fetched.
 *
 * ⚠️ `null` MEANS "COULD NOT ESTABLISH", AND IT IS NOT `false`. Either listing
 * hitting `limit` means the search ran out of room, not that the pair is absent.
 * Every caller must report that as a reason rather than as an all-clear — an
 * absence is only as wide as the search that produced it. A `true` is safe
 * whatever the truncation: a hit is a hit.
 *
 * Extracted from `app/api/fund-ephemeral/route.ts` on 2026-08-22, where it had
 * been answering exactly this question about the till and the float, so the
 * relay route could ask it about the fee sink without a second copy drifting.
 */
export async function namesBoth(
  connection: Connection,
  a: string,
  b: string,
  limit = 1000,
): Promise<boolean | null> {
  try {
    const [left, right] = await Promise.all([
      connection.getSignaturesForAddress(new PublicKey(a), { limit }),
      connection.getSignaturesForAddress(new PublicKey(b), { limit }),
    ]);
    const seen = new Set(left.map((x) => x.signature));
    for (const x of right) if (seen.has(x.signature)) return true;
    if (left.length >= limit || right.length >= limit) return null;
    return false;
  } catch {
    return null;
  }
}

/**
 * The transaction that names both, when there is one.
 *
 * 🚨 WHY A BOOLEAN WAS NOT ENOUGH, AND IT COST A LIVE FALSE ALARM.
 * `namesBoth` answers "is there an edge". For the till and the float that is the
 * wrong question, because the edge is REQUIRED: settling R into F is the only
 * way the float is ever replenished, and a settlement necessarily names both. So
 * the boolean fires on the compliant behaviour, never clears — the transaction
 * stays in both histories forever — and the reason it printed told the operator
 * to "settle in batches", which is the act that trips it.
 *
 * MEASURED 2026-08-22: one settlement put `/api/fund-ephemeral?readiness=1` into
 * `ready: false` permanently, with advice that causes the condition it reports.
 *
 * What separates a compliant settlement from a per-purchase one is the AMOUNT it
 * carries, and that needs the transaction. So this returns the signature and the
 * caller reads the delta.
 */
export async function sharedTransaction(
  connection: Connection,
  a: string,
  b: string,
  limit = 1000,
): Promise<{ signature: string | null; complete: boolean }> {
  // ⚠️ ONE SHAPE, NOT A UNION. A union discriminated on a nullable string does
  // not narrow — the empty string is falsy too — so the caller's `else` branch
  // could not reach `complete` at all. `complete` is meaningless when a
  // signature was found, and true there rather than absent, because a hit is a
  // hit whatever the truncation.
  try {
    const [left, right] = await Promise.all([
      connection.getSignaturesForAddress(new PublicKey(a), { limit }),
      connection.getSignaturesForAddress(new PublicKey(b), { limit }),
    ]);
    const seen = new Set(left.map((x) => x.signature));
    for (const x of right) if (seen.has(x.signature)) return { signature: x.signature, complete: true };
    return { signature: null, complete: left.length < limit && right.length < limit };
  } catch {
    return { signature: null, complete: false };
  }
}
