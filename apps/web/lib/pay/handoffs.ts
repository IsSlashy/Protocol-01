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
 *
 * STORAGE (leak L5c). The v1 store put `(pool, leafIndex, sealedAt)` per WALLET
 * PUBKEY in cleartext — a smaller table than the payout store's but the same
 * index defect, so it gets the same v2 treatment (`lib/privacy/sealedStore.ts`,
 * design header in `shieldClient.ts`): records sealed to this identity's own
 * address, indexed by the opaque worker label, opened only in the worker.
 * Reads UNION the v1 leftovers until they are migrated, and with no session at
 * all the v1 view is served untouched, so no record written before this change
 * disappears. A record whose sealed write fails falls back to the v1 store:
 * a handoff record is the double-promise guard, and a worse index beats a
 * silently dropped guard. What loss ultimately costs here — unlike the
 * subscription store — is one click: a handoff can always be re-declared with
 * "Mark as handed over", which exists precisely because handoffs made
 * elsewhere can only be declared.
 */

import {
  isSessionLostError,
  openSealedRecords,
  readMap,
  sealRecord,
  storeSession,
  writeMap,
  type StoreSession,
} from '../privacy/sealedStore';

export interface HandoffRecord {
  /** Pool PDA, base58. */
  pool: string;
  leafIndex: number;
  /** Epoch ms the note was sealed. */
  sealedAt: number;
}

const HANDOFF_STORE_KEY = 'p01_pay_handoffs_v2';
/** The pre-L5c store, keyed by wallet pubkey. Read as fallback forever;
 *  written only when the sealed write fails. */
const HANDOFF_STORE_KEY_V1 = 'p01_pay_handoffs_v1';

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

/**
 * Seal one wallet's v1 records into the v2 store and delete the v1 bucket.
 * Same fund-safety order as every other migration: v2 write lands BEFORE the
 * v1 delete, in the same synchronous turn, so a throw leaves v1 intact and the
 * union reads below still serve it.
 */
function migrateHandoffStore(session: StoreSession, walletPubkey: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const old = readMap<HandoffRecord>(HANDOFF_STORE_KEY_V1);
    const mine = old[walletPubkey];
    if (!mine || mine.length === 0) return;
    const all = readMap<string>(HANDOFF_STORE_KEY);
    const list = all[session.label] ?? [];
    for (const rec of mine) {
      list.push(
        sealRecord(session.address, {
          p01store: 1,
          kind: 'handoff',
          pool: rec.pool,
          leafIndex: rec.leafIndex,
          sealedAt: rec.sealedAt,
        }),
      );
    }
    all[session.label] = list;
    writeMap(HANDOFF_STORE_KEY, all);
    delete old[walletPubkey];
    writeMap(HANDOFF_STORE_KEY_V1, old);
  } catch {
    // Quota or private-mode failure: the fallback read below still serves v1.
  }
}

/**
 * Decrypt this label's sealed records in the worker. Duplicated keys are the
 * append-only write path's doing; newest `sealedAt` wins here.
 *
 * Returns `opened`, the number of blobs the snapshot held. A caller that
 * REWRITES the bucket afterwards must preserve everything past that index —
 * see `forgetHandoff`. Reading it is a round trip to the worker, and this store
 * is written by fire-and-forget UI handlers, so a write landing mid-flight is
 * ordinary, not exotic.
 */
async function openHandoffs(
  meta: string,
  session: StoreSession,
): Promise<{ records: HandoffRecord[]; opened: number; staleWorker: boolean }> {
  const blobs = readMap<string>(HANDOFF_STORE_KEY)[session.label] ?? [];
  if (blobs.length === 0) return { records: [], opened: 0, staleWorker: false };
  const res = await openSealedRecords(meta, blobs);
  // A version-skewed worker (tab open across a deploy) answers WITHOUT the
  // `handoffs` array — it predates the kind, so it filed our blobs under
  // `skipped`. That is not "no records": the sealed blobs are intact, this
  // worker just cannot open them. `staleWorker` says so, and since the blob
  // list here is non-empty by the early return above, the flag can never be
  // raised for a genuinely empty store. See sealedStore.SealedRecordsAnswer.
  const staleWorker = res.handoffs === undefined;
  const byKey = new Map<string, HandoffRecord>();
  for (const rec of res.handoffs ?? []) {
    const key = handoffKey(rec.pool, rec.leafIndex);
    const prev = byKey.get(key);
    if (!prev || rec.sealedAt >= prev.sealedAt) byKey.set(key, rec);
  }
  return { records: [...byKey.values()], opened: blobs.length, staleWorker };
}

/**
 * Mark a note as handed over. Idempotent on `pool:leafIndex` — the sealed
 * store is append-only (blobs are randomized ciphertext, so equality only
 * exists on the plaintext) and the read side keeps the newest per key.
 */
export async function recordHandoff(
  meta: string,
  walletPubkey: string,
  rec: HandoffRecord,
): Promise<void> {
  if (typeof localStorage === 'undefined') return;
  try {
    const session = await storeSession(meta);
    migrateHandoffStore(session, walletPubkey);
    const all = readMap<string>(HANDOFF_STORE_KEY);
    const list = all[session.label] ?? [];
    list.push(
      sealRecord(session.address, {
        p01store: 1,
        kind: 'handoff',
        pool: rec.pool,
        leafIndex: rec.leafIndex,
        sealedAt: rec.sealedAt,
      }),
    );
    all[session.label] = list;
    writeMap(HANDOFF_STORE_KEY, all);
  } catch {
    // No session or quota failure. This record is the double-promise guard, so
    // dropping it silently would let the same coin be promised twice; the v1
    // store is the last resort, and every read path still unions it.
    try {
      const all = readMap<HandoffRecord>(HANDOFF_STORE_KEY_V1);
      const key = handoffKey(rec.pool, rec.leafIndex);
      const list = (all[walletPubkey] ?? []).filter(
        (r) => handoffKey(r.pool, r.leafIndex) !== key,
      );
      list.push({ pool: rec.pool, leafIndex: rec.leafIndex, sealedAt: rec.sealedAt });
      all[walletPubkey] = list;
      writeMap(HANDOFF_STORE_KEY_V1, all);
    } catch {
      // Quota failure on both: only the badge is lost, and it can be
      // re-declared with one click.
    }
  }
  announce();
}

/**
 * Stop treating a note as handed over.
 *
 * 🚨 This does NOT take the note back. The recipient keeps their copy. It says
 * "I no longer expect them to claim it", nothing more.
 *
 * Removal from an append-only ciphertext list means opening everything and
 * re-sealing what stays — a handful of records, so the cost is unmeasurable.
 * The v1 bucket is filtered too, unconditionally: a leftover record there must
 * not resurrect the badge the user just dismissed.
 */
export async function forgetHandoff(
  meta: string,
  walletPubkey: string,
  pool: string,
  leafIndex: number,
): Promise<void> {
  if (typeof localStorage === 'undefined') return;
  const key = handoffKey(pool, leafIndex);
  try {
    const old = readMap<HandoffRecord>(HANDOFF_STORE_KEY_V1);
    if (old[walletPubkey]?.length) {
      old[walletPubkey] = old[walletPubkey]!.filter(
        (r) => handoffKey(r.pool, r.leafIndex) !== key,
      );
      if (old[walletPubkey]!.length === 0) delete old[walletPubkey];
      writeMap(HANDOFF_STORE_KEY_V1, old);
    }
  } catch {
    // Same contract as recordHandoff.
  }
  try {
    const session = await storeSession(meta);
    migrateHandoffStore(session, walletPubkey);
    const { records, opened, staleWorker } = await openHandoffs(meta, session);

    // 🚨 NEVER REWRITE FROM A SKEW-BLINDED VIEW. A version-skewed worker opens
    // NONE of the handoff records, so `records` is empty while `opened` covers
    // every blob — running the rewrite below from that view re-seals nothing
    // and deletes the whole label: every handoff record destroyed by one
    // "forget" click in a stale tab. The badge staying is one click to redo;
    // the records going is the double-promise guard gone for every in-transit
    // note at once. Same fail-safe direction as the tail rule below.
    if (staleWorker) {
      announce();
      return;
    }
    const keep = records.filter((r) => handoffKey(r.pool, r.leafIndex) !== key);

    // 🚨 PRESERVE THE TAIL. `openHandoffs` awaits a worker round trip, and both
    // writers here are called from fire-and-forget UI handlers that are not
    // disabled while one is in flight (`PoolPanel.tsx`, the two badge buttons).
    // A `recordHandoff` landing during that await appends past `opened`;
    // rewriting the bucket from the pre-await snapshot silently ate it, and the
    // empty-`keep` case deleted the whole label. That destroyed the record for a
    // note the user had just promised away — and this record is the ONLY trace a
    // handoff leaves anywhere, so losing it puts that note back in the Send and
    // Subscribe pickers and lets the same coin be promised twice.
    //
    // Appends only ever go to the end, so everything from `opened` onward is
    // untouched by what we opened and is carried over verbatim. The residual
    // race is forget-vs-forget, which can at worst drop a REMOVAL — the badge
    // stays and the click is still there. Losing a removal is recoverable;
    // losing a record is not. This shape can only fail in the safe direction.
    const all = readMap<string>(HANDOFF_STORE_KEY);
    const tail = (all[session.label] ?? []).slice(opened);
    const resealed = keep.map((r) =>
      sealRecord(session.address, {
        p01store: 1,
        kind: 'handoff',
        pool: r.pool,
        leafIndex: r.leafIndex,
        sealedAt: r.sealedAt,
      }),
    );
    const next = [...resealed, ...tail];
    if (next.length === 0) delete all[session.label];
    else all[session.label] = next;
    writeMap(HANDOFF_STORE_KEY, all);
  } catch {
    // No session: the sealed record stays and the badge with it. Cosmetic, and
    // the click is still there next session.
  }
  announce();
}

/**
 * This wallet's handoffs, newest first. `meta: null` (no session yet) serves
 * the v1 cleartext view, so pre-L5c records never disappear.
 *
 * `staleWorker: true` means a version-skewed worker could not open the sealed
 * records, so `records` is MISSING everything sealed — the caller must say so
 * (a reload heals it) rather than render the shortfall as the truth. A worker
 * that is merely absent (no session) is NOT skew: nothing migrated, v1 serves
 * in full, the flag stays false.
 *
 * `lostSession: true` is the third state: the worker restarted under the open
 * tab and lost the seeds mid-session, so the sealed records are unreadable
 * until the user SIGNS again — a reload alone changes nothing, and the caller
 * must not claim it would. Classified by position, as documented on
 * `shieldClient.openLinkage`; gated on sealed blobs existing, so a genuinely
 * empty store can never raise it.
 */
export async function loadHandoffs(
  meta: string | null,
  walletPubkey: string,
): Promise<{ records: HandoffRecord[]; staleWorker: boolean; lostSession: boolean }> {
  let sealed: HandoffRecord[] = [];
  let staleWorker = false;
  let lostSession = false;
  // Snapshot v1 BEFORE any migration: the union below is built from this
  // copy, so rows sealed by this very call keep serving on this call's
  // answer, whatever the worker turns out to be able to read. The by-key map
  // deduplicates, so nothing is counted twice.
  const left = readMap<HandoffRecord>(HANDOFF_STORE_KEY_V1)[walletPubkey] ?? [];
  if (meta) {
    let session: StoreSession | null = null;
    try {
      session = await storeSession(meta);
    } catch {
      // No worker session ever derived: the v1 snapshot serves in full.
    }
    if (session) {
      const blobs = readMap<string>(HANDOFF_STORE_KEY)[session.label] ?? [];
      if (blobs.length > 0 || left.length > 0) {
        try {
          // A zero-blob call here is the migration probe (see
          // `openSealedRecords`): it proves the worker can read the kind
          // before the v1 rows are taken away from the cleartext store.
          const res = await openSealedRecords(meta, blobs);
          const answered = res.handoffs !== undefined;
          // User-facing skew only when sealed records were actually being
          // read — a skewed answer to the probe hides nothing (the snapshot
          // serves the whole list) and only vetoes the migration.
          staleWorker = !answered && blobs.length > 0;
          sealed = res.handoffs ?? [];
          if (answered) migrateHandoffStore(session, walletPubkey);
        } catch (err) {
          // Restart, not skew: seeds existed (storeSession succeeded) and are
          // gone now. Same gate as the skew flag, same reason.
          if (isSessionLostError(err) && blobs.length > 0) lostSession = true;
          // Anything else degrades exactly as before: v1 serves, flagless.
        }
      }
    }
  }
  const byKey = new Map<string, HandoffRecord>();
  for (const rec of [...sealed, ...left]) {
    const key = handoffKey(rec.pool, rec.leafIndex);
    const prev = byKey.get(key);
    if (!prev || rec.sealedAt >= prev.sealedAt) byKey.set(key, rec);
  }
  return {
    records: [...byKey.values()].sort((a, b) => b.sealedAt - a.sealedAt),
    staleWorker,
    lostSession,
  };
}

/** `pool:leafIndex` of every note this browser is waiting to see claimed.
 *  `staleWorker` and `lostSession` pass through from `loadHandoffs` — either
 *  way the set is missing keys, and a picker filtering on it may re-offer a
 *  note already promised away, so the caller must surface the flag it got,
 *  not just take the keys. */
export async function handoffKeys(
  meta: string | null,
  walletPubkey: string,
): Promise<{ keys: Set<string>; staleWorker: boolean; lostSession: boolean }> {
  const { records, staleWorker, lostSession } = await loadHandoffs(meta, walletPubkey);
  return {
    keys: new Set(records.map((r) => handoffKey(r.pool, r.leafIndex))),
    staleWorker,
    lostSession,
  };
}
