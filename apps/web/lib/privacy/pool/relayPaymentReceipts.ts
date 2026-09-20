/**
 * relayPaymentReceipts — the receipt for a payment that has already left the
 * buyer's wallet, kept until the relay has actually forwarded it.
 *
 * WHY THIS EXISTS
 * ───────────────
 * A relayed deposit is two steps that cannot be one transaction: the buyer pays
 * the till, and then the deployment funds the depositing ephemeral. Between them
 * sits an HTTP call, and that call fails for entirely ordinary reasons — a
 * confirmation timeout, a 429, a 502, or the relay's own 404 "that payment is
 * not on chain yet; confirm it and retry".
 *
 * 🚨 THE BUG THIS CLOSES, AND IT CHARGED THE BUYER TWICE. The payment signature
 * lived in a local `const` and nowhere else. When the relay call threw, the
 * receipt died with the call stack. The ephemeral had received nothing, so the
 * "already holds lamports" guard did not bite, the Deposit button re-enabled,
 * and the retry built and signed a SECOND payment — another full denomination,
 * plus another operator fee. The first payment stayed at the till, which the
 * deployment holds no spending key for, so only an out-of-band refund could
 * return it.
 *
 * The server side was already correct and unreachable: `/api/relay-to-buyer`
 * releases its one-shot claim on every path that hands nothing over, precisely
 * so the same receipt can be presented again. This module is the half that
 * makes that reachable — it keeps the receipt so the retry re-presents it
 * instead of paying again.
 *
 * 🔒 WHAT IS ON DISK (SWEEP4 round 1, confirmed item 5). The receipt used to sit
 * here in clear: the depositing ephemeral, the buyer's till payment signature,
 * both lamport amounts, the till and the exact instant. `signature` names the
 * buyer's wallet on chain; `ephemeralPubkey` is the key that funds the deposit
 * whose commitment the pool republishes. Side by side in one localStorage row
 * they are the (buyer, deposit) join the inventory swap exists to break — one
 * `JSON.parse` for any extension with the `storage` permission, a device thief,
 * or a profile backup. Now each record is two halves, the same shape
 * `pendingContribution.ts` already uses:
 *
 *   INDEX, in clear: `{ id, label }`. A random id and the identity's opaque
 *   store label (`sealedStore.ts`), and nothing else — this store's pruning
 *   rule needs no field of the receipt, so none is kept out.
 *
 *   BODY, sealed: the whole receipt, sealed with X25519 + ML-KEM-768 to the
 *   identity's V1 address (`sealedStore.sealRecord`) and padded to one length,
 *   opened only in the worker (`poolOpenRecords`, kind `relayReceipt`).
 *
 * ⛔ THE ID IS RANDOM, NOT DERIVED FROM THE JOB. A `sha256(label ||
 * ephemeralPubkey)` id would de-duplicate without opening anything — and would
 * also let a dump holder confirm a guess: the label is in the clear index and
 * every deposit's fee payer is public on chain, so the join would come straight
 * back. Duplicates are resolved on the OPEN path instead (`recallRelayPayment`
 * takes the newest body for a job), which costs one round trip and leaks
 * nothing. Measured by `relayPaymentReceipts.test.ts`, "leaves no payment
 * signature, no ephemeral and no till in the dump".
 *
 * ⚠️ THE V1 ROWS ARE READ, NEVER RE-WRITTEN, AND NEVER SILENTLY MOVED. A row
 * written by an earlier build is a payment that already left a wallet. It stays
 * readable by EVERY identity on this device and is removed only by
 * `forgetRelayPayment`, because nothing in it says whose it is: migrating it to
 * whichever identity happens to read first would hand one buyer's proof of
 * payment to another, and the one it was taken from would pay a second
 * denomination. Its clear form is a disclosed residual of the fix, bounded by
 * the life of one outstanding deposit; nothing new is ever written that way.
 *
 * ⛔ SEALING NEEDS ONLY THE PUBLIC ADDRESS, so `rememberRelayPayment` stays
 * synchronous. That is load-bearing: it is called between `sendRawTransaction`
 * returning and `confirmTransaction` being awaited, and a round trip there is a
 * window in which the receipt does not exist. The caller fetches the session
 * before the wallet is asked for anything. OPENING needs the pool seed, so
 * `recallRelayPayment` goes through the worker and is async.
 *
 * ⚠️ MAIN THREAD ONLY, AND THAT IS LOAD-BEARING. `relayEphemeralRecovery`'s
 * store falls back to a module-scope Map inside a Worker, where it dies with the
 * worker — its own header says nothing in apps/web reads it back. Payments are
 * made from `fundEphemeralForJob`, which runs on the main thread because it
 * holds the wallet, so `localStorage` is really there. `storageAvailable()`
 * exists so the caller can REFUSE rather than take money it might not be able to
 * redeem.
 */

import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import {
  openSealedRecords,
  sealRecord,
  StaleWorkerError,
  type StoreSession,
} from '../sealedStore';

/** The plaintext store every build before this change wrote. Still read by
 *  every identity, never written, removed only when the job it names is done. */
const KEY_V1 = 'p01_relay_payment_receipts_v1';
/** Since the SWEEP4 fix: the opaque index, each entry carrying its sealed body. */
const KEY = 'p01_relay_payment_receipts_v2';

export interface RelayPaymentReceipt {
  /** The job identity: deterministic in (seed, pool, leafIndex). */
  ephemeralPubkey: string;
  /** The buyer's payment transaction — the thing the relay is presented. */
  signature: string;
  /** What the buyer paid the till, in lamports. */
  valueLamports: number;
  /** What the buyer paid the fee wallet, in lamports. */
  feeLamports: number;
  /** What the job asked the relay to forward. Part of the reuse identity. */
  requiredLamports: number;
  /** The address that was paid. A rotated till must not be paid twice. */
  till: string;
  /** ISO 8601. For the operator, when a receipt has to be settled by hand. */
  createdAt: string;
}

/** A receipt as the store hands it back: opened, with the id `forgetRelayPayment` names. */
export interface RelayPaymentRecord extends RelayPaymentReceipt {
  id: string;
}

/**
 * What sealing a receipt needs: the identity's store label and its V1 address.
 * The V1 address, like the subscription and pending-payment stores', because
 * this record is irreplaceable — it is the only proof a payment happened — and
 * must stay openable across passphrase arm and disarm.
 */
export type ReceiptSession = Pick<StoreSession, 'label' | 'legacyAddress'>;

/** One record on disk: an opaque index, the body sealed. */
interface ReceiptIndexEntry {
  id: string;
  label: string;
  sealed: string;
}

/**
 * Is there somewhere durable to put a receipt?
 *
 * Probed by writing, not by feature-detecting: Safari in private mode exposes
 * `localStorage` and throws on `setItem`, which a presence check reads as
 * available and a payment discovers afterwards.
 */
export function storageAvailable(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    const probe = `${KEY}:probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

function isEntry(e: unknown): e is ReceiptIndexEntry {
  const x = e as Partial<ReceiptIndexEntry> | null;
  return (
    !!x && typeof x.id === 'string' && typeof x.label === 'string' && typeof x.sealed === 'string'
  );
}

function readIndex(): ReceiptIndexEntry[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

function writeIndex(list: ReceiptIndexEntry[]): void {
  // Throws on a full or blocked store, deliberately. The caller writes the
  // receipt BEFORE presenting it to the relay, so a silent failure here would
  // reintroduce exactly the defect this module exists for.
  if (list.length === 0) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, JSON.stringify(list));
}

/** The clear rows an earlier build left. Read, never written with a new one. */
function readLegacy(): RelayPaymentReceipt[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(KEY_V1);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RelayPaymentReceipt =>
        !!e &&
        typeof (e as RelayPaymentReceipt).ephemeralPubkey === 'string' &&
        typeof (e as RelayPaymentReceipt).signature === 'string',
    );
  } catch {
    return [];
  }
}

/** The id a legacy row is named by, so `forgetRelayPayment` can reach it. */
const LEGACY_PREFIX = 'v1:';

/**
 * Record a payment that has already landed. Call before presenting it.
 *
 * Returns the record's id, which `forgetRelayPayment` names once the lamports
 * have moved. Synchronous: sealing needs only `session.legacyAddress`, which
 * the caller already holds.
 */
export function rememberRelayPayment(
  session: ReceiptSession,
  receipt: RelayPaymentReceipt,
): string {
  const id = bytesToHex(randomBytes(16));
  const list = readIndex();
  list.push({
    id,
    label: session.label,
    // `sealRecord` pads to one bucket, so every receipt blob on this device has
    // the same length whatever the signature, the amounts or the till.
    sealed: sealRecord(session.legacyAddress, { p01store: 1, kind: 'relayReceipt', id, ...receipt }),
  });
  writeIndex(list);
  return id;
}

/**
 * Every outstanding receipt this identity holds, oldest first, plus the clear
 * rows an earlier build left (which belong to no identity — see the header).
 *
 * Throws `StaleWorkerError` when the answering worker predates the
 * `relayReceipt` kind. Refusing is the safe direction here: the caller is about
 * to decide whether to pay, and an empty answer from a worker that simply
 * cannot read the store would be read as "no payment outstanding".
 */
export async function listRelayPayments(meta: string): Promise<RelayPaymentRecord[]> {
  const legacy = readLegacy().map((r, i) => ({ ...r, id: `${LEGACY_PREFIX}${i}` }));
  const index = readIndex();
  if (index.length === 0) return legacy.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // Imported lazily so this module carries no import-time dependency on the
  // worker client: `storageAvailable` is called before any money moves and must
  // never be the thing that drags the worker in.
  const { storeSession } = await import('../sealedStore');
  const session = await storeSession(meta);
  const mine = index.filter((e) => e.label === session.label);
  // A zero-blob call is still the probe that says whether this worker knows the
  // kind (`sealedStore.openSealedRecords`).
  const opened = await openSealedRecords(
    meta,
    mine.map((e) => e.sealed),
  );
  if (opened.relayReceipts === undefined) throw new StaleWorkerError();

  const records: RelayPaymentRecord[] = [...legacy];
  for (const r of opened.relayReceipts) records.push(r);
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The receipt for this job, if one is outstanding.
 *
 * The NEWEST body for the job, because the index de-duplicates nothing (the id
 * is random, deliberately — see the header). Two bodies for one ephemeral means
 * a first receipt was forgotten and a second payment made, and the newer one is
 * the one the relay will accept.
 */
export async function recallRelayPayment(
  meta: string,
  ephemeralPubkey: string,
): Promise<RelayPaymentRecord | null> {
  const mine = (await listRelayPayments(meta)).filter(
    (e) => e.ephemeralPubkey === ephemeralPubkey,
  );
  return mine[mine.length - 1] ?? null;
}

/**
 * Drop a receipt once the relay has forwarded it, by the id `remember` returned
 * or `recall` handed back.
 *
 * ⛔ ONLY after the relay reports the lamports moved. Dropping it on a refusal
 * would strand the payment again — the refusal is precisely when the receipt is
 * the only way back to the money.
 */
export function forgetRelayPayment(id: string | undefined): void {
  if (!id) return;
  try {
    if (id.startsWith(LEGACY_PREFIX)) {
      const at = Number(id.slice(LEGACY_PREFIX.length));
      const kept = readLegacy().filter((_, i) => i !== at);
      if (kept.length === 0) localStorage.removeItem(KEY_V1);
      else localStorage.setItem(KEY_V1, JSON.stringify(kept));
      return;
    }
    const list = readIndex();
    const kept = list.filter((e) => e.id !== id);
    if (kept.length !== list.length) writeIndex(kept);
  } catch {
    // Best effort on the way OUT. A receipt that outlives its use costs a stale
    // entry; failing loudly here would turn a completed deposit into an error.
  }
}
