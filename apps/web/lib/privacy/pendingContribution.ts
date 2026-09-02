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

/** The oldest unfinished contribution for this wallet, if any. */
export function pendingFor(owner: string): PendingContribution | null {
  const mine = read().filter((e) => e.owner === owner);
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
