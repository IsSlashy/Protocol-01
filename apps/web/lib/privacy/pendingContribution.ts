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
 * 🔒 WHAT IS ON DISK (DEV-1, ledger row D7). The record used to sit here in
 * clear: the wallet, the leaf, the payment signature, the claim code and the
 * claim proof. A claim code is a bearer token for one note, so any extension
 * with the `storage` permission could collect it, and the wallet next to a
 * leaf and a payment is the (buyer, deposit, payment) join the swap exists to
 * break. Now each record is two halves:
 *
 *   INDEX, in clear: `{ id, label, at, kind, paid, claimed }`. Exactly what
 *   the pruning below reads, so the rule that fixed the double payment is
 *   unchanged, plus the random id updates name and the identity's opaque store
 *   label (the index every sealed store already uses, `sealedStore.ts`).
 *
 *   BODY, sealed: the owner, leaf, token, denomination, payment signature,
 *   claim proof, claim code and withdrawal, sealed with X25519 + ML-KEM-768 to
 *   the identity's V1 address (`sealedStore.sealRecord`) and padded to one
 *   length. Updates are append-only sealed deltas, merged by the worker
 *   (`poolOpenRecords`), so a record is never rewritten in place.
 *
 * Measured by `pendingContribution.test.ts`: "raw storage holds no wallet,
 * payment signature, claim code, claim proof or leaf" and "the stored state
 * does not move with the record values, and every sealed body has one length".
 *
 * Sealing needs only the PUBLIC address, so `rememberContribution` stays
 * synchronous; the caller fetches the session in parallel with the
 * reservation, before the wallet is asked for anything. Opening needs the pool
 * seed, so reads go through the worker. A record the worker cannot open is
 * KEPT, never pruned for it: its index still says whether money moved.
 */

import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import {
  openSealedRecords,
  sealRecord,
  StaleWorkerError,
  storeSession,
  type StoreSession,
} from './sealedStore';

/** The plaintext store every build before DEV-1 wrote. Still read, then
 *  re-sealed (`pendingContribution.test.ts` "a legacy record is still
 *  collected, then re-sealed"). Never written with a new record. */
const KEY_V1 = 'p01:pending-contribution:v1';
/** Since DEV-1: the plaintext index, each entry carrying its sealed body. */
const KEY = 'p01:pending-contribution:v2';

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
   * [close-v1 F57, verifier round 1] The `lastValidBlockHeight` the payment
   * was signed under, when this device sent it. Past that height a payment the
   * chain does not know can never land, so `contributeToPool` may drop a record
   * naming one instead of refusing every later contribution for it
   * (`pool/ephemeralFunder.ts`, `paymentOutcome`).
   */
  paymentValidUntil?: number;
  /**
   * Exchange only: the ephemeral's signature over `claimChallenge(txSig)`,
   * base64, made by the worker before it dropped the job. Worth exactly one
   * claim on exactly that payment, and irreplaceable: the key that made it
   * is gone. A receipt, protected like the claim code it turns into.
   */
  claimProof?: string;
  at: number;
}

/** A record as the store hands it back: opened, with the id updates name. */
export interface PendingRecord extends PendingContribution {
  id: string;
}

/**
 * What sealing a record needs: the identity's store label and its V1
 * address. The V1 address, like the subscription store's, because this record
 * is irreplaceable and must stay openable across passphrase arm and disarm
 * (`pendingContribution.test.ts`, "a record written with a passphrase armed
 * still opens once it is disarmed, and back").
 */
export type PendingSession = Pick<StoreSession, 'label' | 'legacyAddress'>;

/** One record on disk: the index in clear, the body sealed. */
interface PendingIndexEntry {
  id: string;
  label: string;
  at: number;
  kind: 'contribution' | 'exchange';
  /** A payment signature was recorded: money moved. */
  paid: boolean;
  /** A claim code was recorded. */
  claimed: boolean;
  /** The sealed base, then every sealed delta, in the order written. */
  sealed: string[];
}

/**
 * Every sealed body is padded to a multiple of this many bytes, so a body's
 * length says nothing about the leaf's digits, the code's length or which
 * fields it carries. One multiple holds every body a record writes:
 * `pendingContribution.test.ts` "the stored state does not move with the
 * record values, and every sealed body has one length" seals the longest
 * values a record carries and finds a single length.
 */
const SEALED_BODY_BYTES = 1024;

/**
 * [SWEEP4 round 1, storage lane] How much of a PAID record's time the clear
 * index keeps: NONE. `at` is 0 from the moment money moves.
 *
 * A contribution's `at` falls seconds before the till payment that names the
 * wallet on chain, and an exchange's seconds before its note-in withdrawal to
 * the till, so the exact millisecond beside a `paid: true` flag joined this
 * device to that transaction — through a record whose every other field is
 * sealed (DEV-1). Ledger row D17.
 *
 * [SWEEP round 1 of run logs8, storage lens] Round 1 of the earlier sweep kept
 * the UTC DAY, reasoning that `collectable()` reads `at` without a key. It
 * does, but it answers `true` on `paid || claimed` BEFORE it looks at `at`, and
 * `load` orders by the sealed time, so once money has moved NOTHING reads the
 * clear value (`pendingContribution.test.ts`, "positive control: nothing reads
 * the clear time of a paid record"). The day was not free: at 3-4 till payments
 * a day (the founder's figure, not measured here) the day plus `kind` narrowed
 * a record that lingers — a stuck or abandoned collect, "owed forever" — to a
 * handful of public payments, each naming a wallet. An UNPAID record keeps its
 * exact time, because the 20-minute reclaim window is what it decides and a
 * reservation with no payment has no transaction to be joined to.
 *
 * The exact time is not lost: it travels in the SEALED body, which is where
 * `load` reads the `at` it returns and orders by — the rule that a buyer's
 * oldest owed record is collected first. Measured by
 * `pendingContribution.test.ts`, "[SWEEP4-STORAGE] a paid record does not date
 * its own payment in the clear".
 *
 * `coarseDay` survives for ONE case: a row written before the time was sealed,
 * whose body opened without an `at`, and whose re-seal then threw. The day is
 * the only order that row has left, so it keeps it until a read can seal it.
 */
const DAY_MS = 86_400_000;

function coarseDay(at: number): number {
  return Number.isFinite(at) ? Math.floor(at / DAY_MS) * DAY_MS : at;
}

/** A value already reduced (0, or a day a failed re-seal left) stays as it is; anything finer becomes its day. */
function keepOnlyUnsealedDay(at: number): number {
  return at === 0 ? 0 : coarseDay(at);
}

function isEntry(e: unknown): e is PendingIndexEntry {
  const x = e as Partial<PendingIndexEntry> | null;
  return (
    !!x &&
    typeof x.id === 'string' &&
    typeof x.label === 'string' &&
    Array.isArray(x.sealed) &&
    x.sealed.every((s) => typeof s === 'string')
  );
}

function readIndex(): PendingIndexEntry[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    // A corrupt index must not block a shield. The payment is on chain and
    // the deployment's claim routes are idempotent on it.
    return [];
  }
}

/** False when storage refused the write; the caller decides what that costs. */
function writeIndex(list: PendingIndexEntry[]): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    if (list.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    /* storage refused; the caller still has the value in memory this run */
    return false;
  }
}

function readLegacy(): PendingContribution[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY_V1);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingContribution[]) : [];
  } catch {
    return [];
  }
}

function writeLegacy(list: PendingContribution[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    // Removed outright once empty, so the old format stops advertising itself.
    if (list.length === 0) localStorage.removeItem(KEY_V1);
    else localStorage.setItem(KEY_V1, JSON.stringify(list));
  } catch {
    /* storage refused; the sealed copy is already written */
  }
}

/** Seal one body, padded so every body of this store has one length. */
function sealPadded(session: PendingSession, body: Record<string, unknown>): string {
  const bare = utf8ToBytes(JSON.stringify({ ...body, pad: '' })).length;
  const target = Math.ceil(bare / SEALED_BODY_BYTES) * SEALED_BODY_BYTES;
  return sealRecord(session.legacyAddress, { ...body, pad: ' '.repeat(target - bare) });
}

function baseBody(id: string, entry: PendingContribution): Record<string, unknown> {
  return {
    p01store: 1,
    kind: 'pending',
    id,
    // Sealed, so the clear index can coarsen its copy the moment money moves
    // (`coarseDay`). This is the value `load` returns and orders by.
    at: entry.at,
    owner: entry.owner,
    leafIndex: entry.leafIndex,
    token: entry.token,
    denomination: entry.denomination,
    pendingKind: entry.kind ?? 'contribution',
    ...(entry.txSig ? { txSig: entry.txSig } : {}),
    ...(entry.paymentSignature ? { paymentSignature: entry.paymentSignature } : {}),
    ...(validHeight(entry.paymentValidUntil) ? { paymentValidUntil: entry.paymentValidUntil } : {}),
    ...(entry.claimProof ? { claimProof: entry.claimProof } : {}),
    ...(entry.claimCode ? { claimCode: entry.claimCode } : {}),
  };
}

function validHeight(h: unknown): h is number {
  return typeof h === 'number' && Number.isSafeInteger(h) && h >= 0;
}

function indexEntry(
  session: PendingSession,
  id: string,
  entry: PendingContribution,
): PendingIndexEntry {
  const paid = !!entry.paymentSignature;
  const claimed = !!entry.claimCode;
  return {
    id,
    label: session.label,
    // Exact only while nothing on chain can be joined to it; then nothing at
    // all. `baseBody` seals the exact time in the same call.
    at: paid || claimed ? 0 : entry.at,
    kind: entry.kind ?? 'contribution',
    paid,
    claimed,
    sealed: [sealPadded(session, baseBody(id, entry))],
  };
}

/**
 * Record a contribution the moment its leaf is RESERVED — before any money
 * moves. An entry with no `claimCode` means "we may have paid for this".
 * Returns the record's id, which every later update and the clear name.
 *
 * ⚠️ Written before the payment ON PURPOSE. Writing it after would leave the
 * exact window this file exists to close. Synchronous for the same reason:
 * the session is fetched before this call, never inside it. A body that
 * cannot be sealed throws here, before any money has moved.
 */
export function rememberContribution(session: PendingSession, entry: PendingContribution): string {
  const id = bytesToHex(randomBytes(16));
  const fresh = indexEntry(session, id, entry);
  const list = readIndex();
  list.push(fresh);
  writeIndex(list);
  return id;
}

/**
 * Append one sealed delta. The flag is set even if the delta could not be
 * sealed: a record whose index says money moved is never pruned, and the
 * resume then refuses loudly ("recorded without its payment signature")
 * instead of letting the buyer pay again.
 */
function appendDelta(
  session: PendingSession,
  id: string,
  delta: { paymentSignature: string; paymentValidUntil?: number } | { claimCode: string },
): void {
  const list = readIndex();
  const entry = list.find((e) => e.id === id);
  if (!entry) return;
  // The FIRST time money moves, the index still holds the exact time, and this
  // function cannot open the base body to see whether it holds one too (a row
  // written before the storage sweep does not). So the delta carries it: the
  // worker applies `delta.at` over the base, and for a row that already sealed
  // its time the two values are the same number
  // (`pendingContribution.test.ts`, "a reservation written before round 1 and
  // PAID IN FLIGHT keeps its exact time, sealed").
  const stillExact = !(entry.paid || entry.claimed) && Number.isFinite(entry.at) && entry.at > 0;
  let sealedIt = false;
  try {
    entry.sealed.push(
      sealPadded(session, {
        p01store: 1,
        kind: 'pendingDelta',
        id,
        ...delta,
        ...(stillExact ? { at: entry.at } : {}),
      }),
    );
    sealedIt = true;
  } catch {
    // See above: the flag below still keeps the record.
  }
  if ('paymentSignature' in delta) entry.paid = true;
  else entry.claimed = true;
  // Money has moved, so the clear index stops dating it. If the delta could
  // not be sealed the day stays, as the only order a pre-sweep row would have
  // left (`coarseDay`); the next read that can seal takes it out.
  entry.at = stillExact && sealedIt ? 0 : keepOnlyUnsealedDay(entry.at);
  writeIndex(list);
}

/** Attach the claim once it is minted, so a resume can go straight to collecting. */
export function attachClaim(session: PendingSession, id: string, claimCode: string): void {
  appendDelta(session, id, { claimCode });
}

/**
 * Attach the payment the moment it has gone through, before the deposit is
 * attempted. A record with a payment and no claim is exactly what the
 * fallback needs: the money moved, and this is the receipt for it.
 */
export function attachPayment(
  session: PendingSession,
  id: string,
  paymentSignature: string,
  paymentValidUntil?: number,
): void {
  appendDelta(
    session,
    id,
    validHeight(paymentValidUntil) ? { paymentSignature, paymentValidUntil } : { paymentSignature },
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

/** The rule reads the index alone (`paid`, `claimed`, `at`), so it needs no key. */
function collectable(e: { paid: boolean; claimed: boolean; at: number }, now: number): boolean {
  if (e.paid || e.claimed) return true;
  if (!Number.isFinite(e.at)) return true;
  if (e.at < PAYMENT_FIELD_SINCE_MS) return true;
  return now - e.at < UNPAID_RESERVATION_TTL_MS;
}

function legacyCollectable(e: PendingContribution, now: number): boolean {
  return collectable({ paid: !!e.paymentSignature, claimed: !!e.claimCode, at: e.at }, now);
}

/**
 * Every record this identity holds for `owner`, opened, oldest first.
 *
 * `prune` drops the dead reservations of THIS identity as it passes them
 * (`pendingFor`); other identities' entries are never touched. Legacy records
 * of this owner are sealed into the index here, once a worker has proven it
 * can read them back: sealing rows the answering worker cannot open would hide
 * them until a reload, so a worker that predates this store gets
 * `StaleWorkerError` ("reload") instead, and nothing is migrated.
 */
async function load(meta: string, owner: string, prune: boolean): Promise<PendingRecord[]> {
  const now = Date.now();
  // Nothing on this device at all: no round trip, no session needed.
  if (readIndex().length === 0 && readLegacy().length === 0) return [];

  const session = await storeSession(meta);
  let index = readIndex();
  if (prune) {
    const kept = index.filter((e) => e.label !== session.label || collectable(e, now));
    if (kept.length !== index.length) {
      writeIndex(kept);
      index = kept;
    }
  }
  const mine = index.filter((e) => e.label === session.label);
  if (mine.length === 0 && !readLegacy().some((e) => e.owner === owner)) return [];

  // One round trip opens every body of this identity. With none to open it is
  // the probe that says whether this worker can read the store at all.
  const opened = await openSealedRecords(
    meta,
    mine.flatMap((e) => e.sealed),
  );
  if (opened.pending === undefined) throw new StaleWorkerError();

  // Legacy records: pruned by the same rule, sealed, v2 written before v1 is
  // touched, all in this one synchronous turn. A throw leaves v1 as it was.
  const migrated: PendingRecord[] = [];
  const legacy = readLegacy();
  const legacyMine = legacy.filter(
    (e) => e.owner === owner && (!prune || legacyCollectable(e, now)),
  );
  const legacyDead = prune
    ? legacy.filter((e) => e.owner === owner && !legacyCollectable(e, now))
    : [];
  if (legacyMine.length > 0 || legacyDead.length > 0) {
    const entries = legacyMine.map((rec) => {
      const id = bytesToHex(randomBytes(16));
      migrated.push({ ...rec, id });
      return indexEntry(session, id, rec);
    });
    if (entries.length === 0 || writeIndex([...readIndex(), ...entries])) {
      writeLegacy(legacy.filter((e) => e.owner !== owner));
    }
  }

  const bodies = new Map(opened.pending.map((p) => [p.id, p]));

  // [SWEEP4 round 1, storage lane] A row written before this change carries the
  // exact time in the CLEAR index and none in its sealed body. It is moved
  // here, once, with the bodies already open: the time is appended as a sealed
  // delta and the index keeps NOTHING (0). Only this identity's paid or claimed
  // rows are touched, and only while they still hold a time, so a second read
  // rewrites nothing (`pendingContribution.test.ts`, "a row written before this
  // change is coarsened on read, keeps its record, and is stable").
  //
  // [SWEEP round 1 of run logs8, storage lens] Three things changed with the
  // move from "the day" to "nothing":
  //   - a row a round-1 build left at its DAY is rewritten to 0 here ("the day
  //     a round-1 build left in the index goes on the next read");
  //   - the time is sealed for EVERY body that opens, whoever its owner is.
  //     It used to be sealed for this `owner` only while every row of the
  //     identity was coarsened, which at 0 would have cost another wallet's
  //     legacy row its order for good ("another wallet's legacy row under the
  //     same identity keeps its order");
  //   - the one row that keeps a day is the one whose body opened WITHOUT a
  //     time and whose re-seal threw: that day is the only order it has left.
  //     A body that does not open at all orders nothing (it is never
  //     returned), so it goes to 0.
  const exactAt = new Map<string, number>();
  let coarsened = false;
  for (const e of mine) {
    if (!(e.paid || e.claimed) || e.at === 0) continue;
    const body = bodies.get(e.id);
    let next = 0;
    if (body && body.at === undefined) {
      try {
        e.sealed.push(sealPadded(session, { p01store: 1, kind: 'pendingDelta', id: e.id, at: e.at }));
        exactAt.set(e.id, e.at);
      } catch {
        // Sealing refused: the day stays until a read can seal it. What is
        // lost meanwhile is the finer ORDER of this one record, never the record.
        next = coarseDay(e.at);
      }
    }
    if (next === e.at) continue;
    e.at = next;
    coarsened = true;
  }
  if (coarsened) writeIndex(index);

  const records: PendingRecord[] = [...migrated];
  for (const e of mine) {
    const body = bodies.get(e.id);
    // Unopenable, or another wallet's under this identity: kept, not returned.
    if (!body || body.owner !== owner) continue;
    records.push({
      id: e.id,
      owner: body.owner,
      leafIndex: body.leafIndex,
      token: body.token,
      denomination: body.denomination,
      kind: body.kind ?? e.kind,
      // The sealed time first: the clear index keeps only the day once money
      // has moved, and the resume order runs on the exact one (`coarseDay`).
      at: body.at ?? exactAt.get(e.id) ?? e.at,
      ...(body.txSig ? { txSig: body.txSig } : {}),
      ...(body.paymentSignature ? { paymentSignature: body.paymentSignature } : {}),
      ...(validHeight(body.paymentValidUntil) ? { paymentValidUntil: body.paymentValidUntil } : {}),
      ...(body.claimProof ? { claimProof: body.claimProof } : {}),
      ...(body.claimCode ? { claimCode: body.claimCode } : {}),
    });
  }
  return records.sort((a, b) => a.at - b.at);
}

/**
 * Every record this identity holds for `owner`, opened, oldest first. A read:
 * nothing is pruned (only a legacy record is re-sealed).
 */
export function pendingRecords(meta: string, owner: string): Promise<PendingRecord[]> {
  return load(meta, owner, false);
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
 * other identities are never touched: this store is scoped per identity.
 */
export async function pendingFor(meta: string, owner: string): Promise<PendingRecord | null> {
  const records = await load(meta, owner, true);
  // [close-v1 F58] MONEY THAT MOVED IS SERVED FIRST. A paymentless reservation
  // younger than the reclaim window is still "collectable", and as the oldest
  // record it used to be the one returned: the resume threw on its missing
  // payment, the panel swallowed the throw, and the paid record behind it was
  // never presented, so the next click paid again (audit v1,
  // `r3-client/probes/resumeShadow.probe.test.ts`). The oldest record that
  // names a payment or holds a claim wins; a bare reservation is returned only
  // when nothing paid is outstanding.
  return (
    records.find((r) => !!r.paymentSignature || !!r.claimCode) ?? records[0] ?? null
  );
}

/**
 * [close-v1 F57] A record whose money moved and whose note is not in hand yet.
 * `contributeToPool` refuses a new payment while one exists: whatever stopped
 * the resume from collecting it (the deployment busy, Recover not run yet),
 * paying again cannot be the answer.
 */
export async function outstandingPayment(
  meta: string,
  owner: string,
): Promise<PendingRecord | null> {
  return (await load(meta, owner, false)).find((r) => !!r.paymentSignature) ?? null;
}

/**
 * Drop it, once the note is in hand.
 *
 * ⛔ ONLY AFTER THE NOTE IS STORED. Clearing on the claim alone would lose the
 * one thing that proves a buyer is owed something.
 */
export function clearContribution(id: string | undefined): void {
  if (!id) return;
  const list = readIndex();
  const kept = list.filter((e) => e.id !== id);
  if (kept.length !== list.length) writeIndex(kept);
}
