/**
 * The contribution a buyer has PAID FOR but not yet collected.
 *
 * 🚨 MEASURED 2026-08-31, ON REAL MONEY. A shield pays the till, funds an
 * ephemeral, deposits a leaf the treasury owns, confirms it into a claim, and
 * only then redeems that claim for a note. The worker went quiet partway. The
 * money had gone; nothing recorded that a claim was owed; the next click started
 * a second contribution and took 1.013 SOL again.
 *
 * ⛔ THE RULE THIS FILE ENCODES: the moment a buyer's money can no longer be
 * un-spent, what they are OWED must survive a reload, a timeout and a closed
 * tab. Anything less makes a retry a second payment.
 *
 * It stores no secret. A leaf index is public the instant it is deposited, and
 * a claim code is a bearer token for ONE note out of stock — worth protecting
 * like a receipt, not like a key. It is scoped per wallet so two identities on
 * one browser never collect each other's.
 */

const KEY = 'p01:pending-contribution:v1';

export interface PendingContribution {
  /**
   * The leaf this buyer's money funded. Owned by the treasury, not by them.
   * On an `exchange` it is the leaf of the note the buyer SPENT into the
   * till: an identifier for the record, not a leaf anybody is owed.
   */
  leafIndex: number;
  /** Base58 wallet this contribution belongs to. */
  owner: string;
  token: 'SOL' | 'USDC';
  denomination: number;
  /**
   * Minted once the deposit is confirmed on chain. Absent means the deposit may
   * have landed and no claim exists yet — the resume path confirms first.
   */
  claimCode?: string;
  /** For the operator reading a support request, not used by the code. */
  txSig?: string;
  /**
   * Which flow owes this buyer a note. Absent means `contribution` (records
   * written before the field existed). An `exchange` is a note-in withdrawal
   * to the till: its claim comes from `/api/claim-for-payment` with the
   * `claimProof` below, never from a confirm.
   */
  kind?: 'contribution' | 'exchange';
  /**
   * The transaction that paid the till: the wallet's transfer on a
   * contribution, the withdrawal itself on an exchange. Recorded the moment it
   * is known, because it is what a failed deposit presents to
   * `/api/claim-for-payment` to collect what the payment bought, and what the
   * confirm now has to name and prove.
   */
  paymentSignature?: string;
  /**
   * Exchange only: the ephemeral's signature over `claimChallenge(txSig)`,
   * base64, made by the worker before it dropped the job. Worth exactly one
   * claim on exactly that payment, and irreplaceable: the key that made it
   * is gone. A receipt, protected like the claim code it turns into.
   */
  claimProof?: string;
  at: number;
}

function read(): PendingContribution[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingContribution[]) : [];
  } catch {
    // A corrupt record must not block a shield. Worst case the buyer redeems
    // through support with the leaf index, which is on chain either way.
    return [];
  }
}

function write(list: PendingContribution[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage refused; the caller still has the value in memory this run */
  }
}

/**
 * Record a contribution the moment its leaf is RESERVED — before any money
 * moves. An entry with no `claimCode` means "we may have paid for this".
 *
 * ⚠️ Written before the payment ON PURPOSE. Writing it after would leave the
 * exact window this file exists to close.
 */
export function rememberContribution(entry: PendingContribution): void {
  const list = read().filter(
    (e) => !(e.owner === entry.owner && e.leafIndex === entry.leafIndex),
  );
  list.push(entry);
  write(list);
}

/** Attach the claim once it is minted, so a resume can go straight to collecting. */
export function attachClaim(owner: string, leafIndex: number, claimCode: string): void {
  write(
    read().map((e) =>
      e.owner === owner && e.leafIndex === leafIndex ? { ...e, claimCode } : e,
    ),
  );
}

/**
 * Attach the payment the moment it has gone through, before the deposit is
 * attempted. A record with a payment and no claim is exactly what the
 * fallback needs: the money moved, and this is the receipt for it.
 */
export function attachPayment(owner: string, leafIndex: number, paymentSignature: string): void {
  write(
    read().map((e) =>
      e.owner === owner && e.leafIndex === leafIndex ? { ...e, paymentSignature } : e,
    ),
  );
}

/**
 * How long a reservation with NO payment behind it can still be finished.
 *
 * Not a number invented here: it is the server's own clock. The reserve loop
 * in `/api/contribute-note` treats a marker at the tree edge as dead once it is
 * older than `RECLAIM_AFTER_MS` (20 minutes, sized on the 4-to-13-minute
 * end-to-end contribution measured 2026-09-02) and hands that index to the next
 * contributor. Past that point the leaf this record names may belong to
 * somebody else, and a record with no payment signature never bought anything,
 * so there is nothing left for a resume to collect.
 */
const UNPAID_RESERVATION_TTL_MS = 20 * 60 * 1000;

/**
 * Can a resume still turn this record into a note?
 *
 * ⛔ MONEY THAT MOVED IS OWED FOREVER. A payment signature, or a claim code
 * minted against one, makes this record the only proof a buyer is owed
 * something: it is collectable whatever its age and is never dropped.
 *
 * Anything else is a bare reservation, written by `rememberContribution`
 * BEFORE any money moved. If the buyer dismissed the wallet prompt, no payment
 * exists and none ever will.
 */
/**
 * When `attachPayment` started recording the till payment on the record.
 *
 * 🚨 A PAYMENTLESS RECORD MEANS TWO DIFFERENT THINGS, AND ONLY THE DATE SEPARATES THEM.
 *
 * Written after this instant, it means the money never moved: the buyer
 * dismissed the wallet prompt, and the record is a corpse safe to prune once
 * the deployment has reclaimed the leaf. Written BEFORE it, the field did not
 * exist yet, so the record is silent about a payment that may well have
 * happened. Pruning that one turns a buyer's resume into a fresh contribution
 * and charges them a second denomination, which is the loss this whole store
 * was written to prevent. Those records stay, and `resumeContribution` keeps
 * raising its loud "recorded without its payment signature" refusal for them.
 */
const PAYMENT_FIELD_SINCE_MS = Date.parse('2026-09-02T00:00:00Z');

function collectable(e: PendingContribution, now: number): boolean {
  if (e.paymentSignature || e.claimCode) return true;
  if (!Number.isFinite(e.at)) return true;
  if (e.at < PAYMENT_FIELD_SINCE_MS) return true;
  return now - e.at < UNPAID_RESERVATION_TTL_MS;
}

/**
 * The oldest COLLECTABLE contribution for this wallet, if any.
 *
 * 🚨 WHY "COLLECTABLE" AND NOT SIMPLY "OLDEST". Returning the oldest record of
 * any shape let ONE abandoned reservation shadow every later contribution for
 * the life of the browser profile. A buyer who reserved a leaf and then
 * dismissed the wallet prompt left a record with no `paymentSignature`;
 * `resumeContribution` picked that dead record every time, the collect step
 * threw on the missing signature, `PoolPanel` swallowed the throw by design
 * ("a resume that throws would BLOCK an ordinary shield"), and the buyer paid
 * a second full denomination: the exact double payment this store was written
 * to prevent. A later record that DID carry a payment was never even looked at.
 *
 * Expired paymentless reservations are pruned as they are passed over, so the
 * dead record stops mattering instead of accumulating. Records belonging to
 * other wallets are never touched: this store is scoped per identity.
 */
export function pendingFor(owner: string): PendingContribution | null {
  const now = Date.now();
  const all = read();
  const kept = all.filter((e) => e.owner !== owner || collectable(e, now));
  if (kept.length !== all.length) write(kept);
  const mine = kept.filter((e) => e.owner === owner);
  if (mine.length === 0) return null;
  return mine.sort((a, b) => a.at - b.at)[0]!;
}

/**
 * Drop it, once the note is in hand.
 *
 * ⛔ ONLY AFTER THE NOTE IS STORED. Clearing on the claim alone would lose the
 * one thing that proves a buyer is owed something.
 */
export function clearContribution(owner: string, leafIndex: number): void {
  write(read().filter((e) => !(e.owner === owner && e.leafIndex === leafIndex)));
}
