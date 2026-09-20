/**
 * The keys that tie one payment to one claim, in ONE place.
 *
 * Three routes share these strings: `/api/relay-to-buyer` writes the binding
 * once the float has funded a deposit, `/api/contribute-note` confirm requires
 * it before it pays for a leaf, and `/api/claim-for-payment` reads it to tell a
 * plain sale from the fallback of a relayed deposit that never landed.
 *
 * A key format written in three files and moved in one is the failure
 * `treasurySeeds.ts` documents. So the format is written here and imported.
 *
 * THE RULE THE KEYS ENFORCE: one claim per payment signature, and
 * `p01:note:paid:<sig>` is the only mint gate, used by every route that mints.
 *
 *   p01:relay:payment:<sig>                the relay's one-shot claim (incr)
 *   p01:relay:payment:<sig>:contribution   `<poolKey>:<leaf>` the relay funded
 *   p01:relay:payment:<sig>:buyer          the ephemeral it funded
 *   p01:note:paid:<sig>                    the mint gate (incr; 1 mints)
 *   p01:note:paid:<sig>:code               the code that payment earned
 *   p01:note:contrib-reserved:<pool>:<leaf>
 *   p01:note:contrib-confirmed:<pool>:<leaf>
 *
 * ⛔ ONE ROW PAIRS A LEAF WITH A PAYMENT, AND IT IS THE BINDING ABOVE. A copy
 * of this store is read by whoever takes a backup, and a payment signature
 * resolves publicly to the wallet that made it — so a row holding a leaf and a
 * signature, or a leaf and a claim code, names the buyer of that leaf for as
 * long as the row exists.
 *
 *   - `contrib-claim:<pool>:<leaf>` held the code a confirmed leaf earned and
 *     was read by NOTHING: both routes replay off `paid:<sig>:code`. Dropped
 *     by KV-1.
 *   - `claim-minted:<code>` holds `payment:<sig>` and no leaf.
 *   - the binding is kept because confirm and the fallback need it, carries no
 *     expiry (a TTL would refuse a paying buyer their own leaf), and is
 *     deleted at redemption by `issue-note`'s sweep.
 *
 * Pinned by `__tests__/api/contribute-note.test.ts` "writes no leaf-to-code
 * row", `__tests__/api/relay-to-buyer.test.ts` "the contribution binding
 * carries no expiry", and measured across worlds by
 * `__tests__/lib/kvRowsAtRest.test.ts`.
 */

import { getPoolsForTokenV3, type PoolConfig } from '@/lib/privacy/pool/denominatedPool';

export type ContributionToken = 'SOL' | 'USDC';

export interface ContributionRef {
  token: ContributionToken;
  leafIndex: number;
}

const RELAY_PAYMENT_PREFIX = 'p01:relay:payment:';
const NOTE_PAID_PREFIX = 'p01:note:paid:';

/** The relay's one-shot claim on a payment. Present means "this payment funded a relayed deposit". */
export function relayPaymentClaimKey(signature: string): string {
  return `${RELAY_PAYMENT_PREFIX}${signature}`;
}

/** The `<poolKey>:<leaf>` the relay funded with this payment. Written only after the lamports moved. */
export function relayPaymentContributionKey(signature: string): string {
  return `${RELAY_PAYMENT_PREFIX}${signature}:contribution`;
}

/** The ephemeral the relay funded with this payment. Same timing as the contribution key. */
export function relayPaymentBuyerKey(signature: string): string {
  return `${RELAY_PAYMENT_PREFIX}${signature}:buyer`;
}

/** The mint gate. `incr` returns 1 for exactly one caller per payment. */
export function notePaidKey(signature: string): string {
  return `${NOTE_PAID_PREFIX}${signature}`;
}

/** The claim code a payment earned, so a retry returns the same one. */
export function notePaidCodeKey(signature: string): string {
  return `${NOTE_PAID_PREFIX}${signature}:code`;
}

/** A leaf handed to a contributor, so two of them never get the same index. */
export function contribReservedKey(poolKey: string, leafIndex: number): string {
  return `p01:note:contrib-reserved:${poolKey}:${leafIndex}`;
}

/** One key per confirmed leaf. `incr` on it is the one-claim-per-deposit rule. */
export function contribConfirmedKey(poolKey: string, leafIndex: number): string {
  return `p01:note:contrib-confirmed:${poolKey}:${leafIndex}`;
}

/** The value the relay records and the confirm compares against. */
export function contributionBinding(poolKey: string, leafIndex: number): string {
  return `${poolKey}:${leafIndex}`;
}

/**
 * The denomination this deployment deals in. Mirrors `issue-note`'s reader,
 * which is the authority: a contribution is reserved in the pool issuance can
 * serve from, or the leaf can never be sold.
 */
export function inventoryDenomination(): number {
  const raw = Number(process.env.P01_TREASURY_NOTE_DENOMINATION);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.1;
}

/** The pool a contribution in `token` lands in, or undefined when none is configured. */
export function resolveContributionPool(token: ContributionToken): PoolConfig | undefined {
  const denomination = inventoryDenomination();
  return getPoolsForTokenV3(token).find((p) => p.denomination === denomination);
}

/**
 * Read `{ token, leafIndex }` off an untrusted body. `null` when it is not a
 * contribution reference at all; the caller decides whether that is a 400 or
 * "no contribution was sent".
 */
export function parseContributionRef(raw: unknown): ContributionRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const { token, leafIndex } = raw as { token?: unknown; leafIndex?: unknown };
  const leaf = Number(leafIndex);
  if (!Number.isInteger(leaf) || leaf < 0) return null;
  return { token: token === 'USDC' ? 'USDC' : 'SOL', leafIndex: leaf };
}

/** A counter read back through `get`: Upstash hands back a number, the dev shim whatever was stored. */
export function counterValue(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}
