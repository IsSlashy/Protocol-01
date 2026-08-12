/**
 * sealedStore — the shared machinery behind every encrypted localStorage store
 * (leak L5). Extracted from `shieldClient.ts` so `lib/pay/handoffs.ts` can use
 * the same primitives instead of a drifting copy; the design rationale lives
 * on the L5 header in `shieldClient.ts` and the two worker handlers it names.
 *
 * The shape every v2 store shares:
 *
 *   INDEX — the opaque label from `poolStoreLabel`: a 16-byte HKDF leg of the
 *   v1 pool seed, so possession of a storage dump no longer names the wallet.
 *
 *   VALUES — records sealed with hybrid X25519 + ML-KEM-768 (`encryptNote`)
 *   to this identity's own `p01pq:` address, carrying a `p01store: 1`
 *   envelope. Sealing needs only the PUBLIC address, so it happens here on
 *   the main thread; opening needs the pool seed and happens only in the
 *   worker (`poolOpenRecords`), which whitelists what may cross back.
 *
 * What does NOT live here: the store keys, the record kinds, and the v1
 * migrations. Each store owns those, because what its loss costs — and
 * therefore how its fallbacks must behave — differs per store.
 */

import { utf8ToBytes } from '@noble/hashes/utils.js';

import { poolRequest } from './workerClient';
import { encryptNote } from './pool/noteCrypto';
import type { PoolOpenRecordsResponse } from './worker/poolHandlers';

export interface StoreSession {
  /** Opaque store index from the worker. Stable per identity. */
  label: string;
  /** This identity's own `p01pq:` address — the PUBLIC half, all that sealing
   *  a record needs. The seed that opens them stays in the worker. Derived
   *  from the ACTIVE seed: records sealed here become unreadable if a
   *  passphrase is disarmed, which every store using it can absorb (its loss
   *  degrades to a rescan). */
  address: string;
  /** The `p01pq:` address of the V1 seed — the one that exists for every
   *  identity forever, across passphrase arm/disarm. For records whose loss
   *  nothing can rebuild (the subscription store). */
  legacyAddress: string;
}

/**
 * One label+address fetch per session key, shared by every store call. A
 * failed fetch removes itself so the next call retries instead of caching a
 * dead session forever (the worker may simply not have derived seeds yet).
 */
const storeSessions = new Map<string, Promise<StoreSession>>();

export function storeSession(meta: string): Promise<StoreSession> {
  let p = storeSessions.get(meta);
  if (!p) {
    p = Promise.all([
      poolRequest({ kind: 'poolStoreLabel', meta }),
      poolRequest({ kind: 'poolNoteAddress', meta }),
    ]).then(([l, a]) => ({ label: l.label, address: a.address, legacyAddress: l.legacyAddress }));
    p.catch(() => {
      storeSessions.delete(meta);
    });
    storeSessions.set(meta, p);
  }
  return p;
}

export function readMap<T>(key: string): Record<string, T[]> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, T[]>) : {};
  } catch {
    return {};
  }
}

/** Removing the key outright when the map empties is what lets a migration
 *  actually END: an empty `p01_pay_*_v1` left behind would keep advertising
 *  the old format (and the old key name) in every storage dump forever. */
export function writeMap<T>(key: string, all: Record<string, T[]>): void {
  if (typeof localStorage === 'undefined') return;
  if (Object.keys(all).length === 0) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(all));
}

/** Seal one record to this identity's own address. The `p01store: 1` envelope
 *  is load-bearing: `poolOpenRecords` refuses to return anything without it,
 *  which is what keeps that handler from being a decryption oracle over the
 *  note store.
 *  `utf8ToBytes`, not `new TextEncoder()`: under jsdom the DOM encoder returns
 *  a foreign-realm Uint8Array that tweetnacl's `instanceof` check rejects;
 *  noble's helper re-wraps into this realm's constructor. */
export function sealRecord(address: string, record: Record<string, unknown>): string {
  return encryptNote(address, utf8ToBytes(JSON.stringify(record)));
}

/**
 * A `poolOpenRecords` answer as it may actually arrive: from a VERSION-SKEWED
 * worker. A tab left open across a deploy can pair a newer page with an older
 * worker (the worker script reloads on a crash or restart, the page's chunks on
 * a soft navigation — either side can move alone), and an older worker answers
 * without the arrays for record kinds it has never heard of.
 *
 * The detection contract, and why absence is the signal:
 * `handlePoolOpenRecords` initializes every per-kind array unconditionally, so
 * any worker that KNOWS a kind sends it — as `[]` when there are no records.
 * `res.<kind> === undefined` therefore means exactly "this worker predates the
 * kind", never "there are none". That distinction is everything here: if the
 * v1→v2 migration has already run, the cleartext bucket is gone, and collapsing
 * an absent array into `[]` paints the user's money-tracking lists EMPTY — on a
 * product whose records the user can see no other way, indistinguishable from
 * loss. Nothing is actually lost (the sealed blobs are untouched and a reload
 * loads a worker that reads them), so readers surface the state as
 * `staleWorker` and the panels say "reload", instead of rendering emptiness as
 * truth.
 */
export type SealedRecordsAnswer = Pick<PoolOpenRecordsResponse, 'kind'> &
  Partial<Omit<PoolOpenRecordsResponse, 'kind'>>;

/**
 * The one round-trip site for the sealed record stores, so the possibly-older
 * wire type above is applied in exactly one place. The cast is the honest
 * direction: the shared response type states the CURRENT worker's guarantee
 * (all arrays present), and this widens it to what an old worker may send.
 */
export function openSealedRecords(meta: string, blobs: string[]): Promise<SealedRecordsAnswer> {
  return poolRequest({ kind: 'poolOpenRecords', meta, blobs });
}

/**
 * Thrown by ACTION paths (recovery, and anything that cannot proceed honestly)
 * when the answering worker predates what the page asked of it. READ paths
 * surface the same condition as a `staleWorker` flag instead, because they can
 * still serve what remains readable. The message is user-facing and must stay
 * true in every state it can appear in: the sealed records really are intact,
 * and a reload really does heal the skew.
 */
export class StaleWorkerError extends Error {
  constructor() {
    super(
      'This tab is running an older version of the app and cannot read the records ' +
        'saved on this device. Reload the page and try again — nothing is lost.',
    );
    this.name = 'StaleWorkerError';
  }
}
