/**
 * Notes this browser has handed over, and is waiting to see claimed.
 *
 * WHY THIS IS NOT "SENT". Sealing a note consumes nothing. The secrets came
 * from the sender's own pool seed, so after a handoff BOTH sides hold a
 * spendable copy and the first to spend wins. Dropping the note from the lists
 * would therefore be a lie with teeth: if the recipient never claims it, the
 * sender would believe they lost money that is still entirely theirs.
 *
 * So the note stays, and this store is what lets the UI say what actually
 * changed: somebody else can now spend it at any moment.
 *
 * WHAT IT CHANGES. An in-transit note is withheld from the pickers that would
 * hand it over again or lock it into a subscription, because promising the same
 * coin to two people is the one mistake this state exists to prevent. It is NOT
 * withheld from Withdraw: withdrawing is precisely how a sender takes the note
 * back from a recipient who has not claimed it yet, and that has to stay one
 * click away.
 *
 * 🚨 CANCELLING TRANSIT REVOKES NOTHING. It only stops this browser treating
 * the note as handed over. The recipient still holds their copy and can still
 * spend it. The only way to actually take a note back is to spend it first.
 * Any UI built on this store must say that, or it promises a recall that does
 * not exist.
 *
 * The claim itself needs no bookkeeping here: when either side spends the note,
 * its nullifier appears on chain and `resolveSpentNotes` sees it within seconds.
 */

export interface HandoffRecord {
  /** Pool PDA, base58. */
  pool: string;
  leafIndex: number;
  /** Epoch ms the note was sealed. */
  sealedAt: number;
}

const HANDOFF_STORE_KEY = 'p01_pay_handoffs_v1';

/** Raised on write so an already-rendered list catches up. See subscriptions.ts. */
export const HANDOFFS_CHANGED_EVENT = 'p01:handoffs-changed';

export function handoffKey(pool: string, leafIndex: number): string {
  return `${pool}:${leafIndex}`;
}

function announce(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new Event(HANDOFFS_CHANGED_EVENT));
  } catch {
    // An environment without Event is not worth failing a write over.
  }
}

function readStore(): Record<string, HandoffRecord[]> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(HANDOFF_STORE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, HandoffRecord[]>) : {};
  } catch {
    return {};
  }
}

/** Mark a note as handed over. Idempotent on `pool:leafIndex`. */
export function recordHandoff(walletPubkey: string, rec: HandoffRecord): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const all = readStore();
    const key = handoffKey(rec.pool, rec.leafIndex);
    const list = (all[walletPubkey] ?? []).filter((r) => handoffKey(r.pool, r.leafIndex) !== key);
    list.push({ pool: rec.pool, leafIndex: rec.leafIndex, sealedAt: rec.sealedAt });
    all[walletPubkey] = list;
    localStorage.setItem(HANDOFF_STORE_KEY, JSON.stringify(all));
    announce();
  } catch {
    // Quota or private-mode failure. The note is still spendable by both sides;
    // only the badge is lost, which is cosmetic next to that.
  }
}

/**
 * Stop treating a note as handed over.
 *
 * 🚨 This does NOT take the note back. The recipient keeps their copy. It says
 * "I no longer expect them to claim it", nothing more.
 */
export function forgetHandoff(walletPubkey: string, pool: string, leafIndex: number): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const all = readStore();
    const key = handoffKey(pool, leafIndex);
    all[walletPubkey] = (all[walletPubkey] ?? []).filter(
      (r) => handoffKey(r.pool, r.leafIndex) !== key,
    );
    localStorage.setItem(HANDOFF_STORE_KEY, JSON.stringify(all));
    announce();
  } catch {
    // Same contract as recordHandoff.
  }
}

export function loadHandoffs(walletPubkey: string): HandoffRecord[] {
  const list = readStore()[walletPubkey] ?? [];
  return [...list].sort((a, b) => b.sealedAt - a.sealedAt);
}

/** `pool:leafIndex` of every note this browser is waiting to see claimed. */
export function handoffKeys(walletPubkey: string): Set<string> {
  return new Set(loadHandoffs(walletPubkey).map((r) => handoffKey(r.pool, r.leafIndex)));
}
