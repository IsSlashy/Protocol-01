/**
 * The store that stops a buyer paying twice, and the way it used to fail.
 *
 * ## How to run this file
 *
 * `vitest.config.ts` only includes `__tests__/**`, so this file is picked up by
 * the pool config, whose glob is `lib/**\/*.test.ts`:
 *
 *   npx vitest run --config vitest.pool.config.mts
 *
 * It runs in a `node` environment, which has no `localStorage`, so one is
 * installed below. That is not a workaround: the module already treats a
 * missing `localStorage` as "no records", and a stub keeps the tests honest
 * about which writes actually reach storage.
 *
 * ## What is guarded
 *
 * 🚨 THE DEFECT. `pendingFor` returned the OLDEST record for a wallet, of any
 * shape, and nothing ever pruned one that could not be collected. A buyer who
 * reserved a leaf and then dismissed the wallet prompt left a record with no
 * `paymentSignature`. From then on `resumeContribution` picked that dead record
 * every single time, the collect step threw on the missing signature,
 * `PoolPanel` swallowed the throw by design, and the buyer paid a second full
 * denomination. One abandoned reservation shadowed every later paid
 * contribution for the life of the browser profile.
 *
 * ⛔ AND THE RULE THE FIX MUST NOT BREAK. A record carrying a payment signature
 * (or a claim minted from one) is the only proof a buyer is owed a note. It is
 * never dropped, at any age, for any reason.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  attachClaim,
  attachPayment,
  clearContribution,
  pendingFor,
  rememberContribution,
  type PendingContribution,
} from './pendingContribution';

const KEY = 'p01:pending-contribution:v1';

/** The reclaim window the server itself uses, restated here rather than imported. */
const RECLAIM_MS = 20 * 60 * 1000;

const ALICE = 'AAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa111';
const BOB = 'BBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb222';

function installLocalStorage(): void {
  const data = new Map<string, string>();
  const store = {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
  (globalThis as { localStorage?: unknown }).localStorage = store;
}

/** What is actually on disk, which is what a reload would see. */
function stored(): PendingContribution[] {
  const raw = localStorage.getItem(KEY);
  return raw ? (JSON.parse(raw) as PendingContribution[]) : [];
}

function record(over: Partial<PendingContribution> & { at: number }): PendingContribution {
  return {
    leafIndex: 6,
    owner: ALICE,
    token: 'SOL',
    denomination: 1,
    ...over,
  };
}

beforeEach(() => {
  installLocalStorage();
  localStorage.clear();
});

describe('🚨 one abandoned reservation must not shadow a paid one', () => {
  it('skips a paymentless reservation older than the reclaim window and returns the paid record', () => {
    // The measured shape: click one reserved a leaf and the wallet prompt was
    // dismissed, so no payment exists and none ever will. Click two paid, and
    // the worker went quiet after the till was paid.
    const now = Date.now();
    rememberContribution(record({ leafIndex: 6, at: now - 3 * RECLAIM_MS }));
    rememberContribution(
      record({ leafIndex: 7, at: now - 60_000, paymentSignature: 'PAID-SIG' }),
    );

    const found = pendingFor(ALICE);
    expect(found, 'nothing was offered to resume').not.toBeNull();
    expect(found!.leafIndex, 'the dead reservation shadowed the paid one').toBe(7);
    expect(found!.paymentSignature).toBe('PAID-SIG');
  });

  it('drops the dead reservation from storage, so it stops mattering after one read', () => {
    const now = Date.now();
    rememberContribution(record({ leafIndex: 6, at: now - 3 * RECLAIM_MS }));
    rememberContribution(record({ leafIndex: 7, at: now - 60_000, paymentSignature: 'PAID-SIG' }));

    pendingFor(ALICE);
    expect(stored().map((e) => e.leafIndex)).toEqual([7]);
  });

  it('still offers a paymentless reservation while the server would still hold its leaf', () => {
    // Inside the reclaim window the index is still this buyer's, so the record
    // describes an attempt that can genuinely be finished.
    rememberContribution(record({ leafIndex: 6, at: Date.now() - 60_000 }));
    expect(pendingFor(ALICE)?.leafIndex).toBe(6);
    expect(stored(), 'a live reservation was pruned').toHaveLength(1);
  });

  it('returns null, not a corpse, when every record for the wallet has expired', () => {
    rememberContribution(record({ leafIndex: 6, at: Date.now() - 3 * RECLAIM_MS }));
    expect(pendingFor(ALICE)).toBeNull();
    expect(stored()).toHaveLength(0);
  });

  it('picks the OLDEST of two collectable records, so nothing owed is queued behind', () => {
    const now = Date.now();
    rememberContribution(record({ leafIndex: 8, at: now - 30_000, paymentSignature: 'NEWER' }));
    rememberContribution(record({ leafIndex: 6, at: now - 90_000, paymentSignature: 'OLDER' }));
    expect(pendingFor(ALICE)?.paymentSignature).toBe('OLDER');
  });
});

describe('⛔ a record that carries a payment is never dropped', () => {
  it('keeps a paid record of any age, and keeps returning it', () => {
    // Money that moved is owed forever. This record is the only thing proving
    // a note is owed; an expiry on it would delete the receipt.
    const ancient = Date.now() - 400 * 24 * 60 * 60 * 1000;
    rememberContribution(record({ leafIndex: 6, at: ancient, paymentSignature: 'PAID-SIG' }));

    expect(pendingFor(ALICE)?.paymentSignature).toBe('PAID-SIG');
    expect(stored(), 'a paid record was pruned').toHaveLength(1);
    // And again, after the read that prunes.
    expect(pendingFor(ALICE)?.paymentSignature).toBe('PAID-SIG');
  });

  it('keeps an ancient record that holds a claim code but no payment signature', () => {
    // The contribution path attaches the claim after collecting it; that code
    // is a bearer token for one note out of stock.
    const ancient = Date.now() - 3 * RECLAIM_MS;
    rememberContribution(record({ leafIndex: 6, at: ancient }));
    attachClaim(ALICE, 6, 'CLAIM-CODE');
    expect(pendingFor(ALICE)?.claimCode).toBe('CLAIM-CODE');
    expect(stored()).toHaveLength(1);
  });

  it('keeps an exchange record, whose payment IS the withdrawal that was spent', () => {
    const ancient = Date.now() - 10 * RECLAIM_MS;
    rememberContribution(
      record({
        leafIndex: 33,
        at: ancient,
        kind: 'exchange',
        txSig: 'SPEND-SIG',
        paymentSignature: 'SPEND-SIG',
        claimProof: 'base64-proof',
      }),
    );
    const found = pendingFor(ALICE);
    expect(found?.kind).toBe('exchange');
    expect(found?.claimProof).toBe('base64-proof');
  });

  it('a reservation that gains its payment inside the window survives the window', () => {
    // The ordering the flow actually has: remembered before the money moves,
    // then `attachPayment` the moment it has. Age must stop mattering there.
    const now = Date.now();
    rememberContribution(record({ leafIndex: 6, at: now - 3 * RECLAIM_MS }));
    attachPayment(ALICE, 6, 'PAID-LATE');
    expect(pendingFor(ALICE)?.paymentSignature).toBe('PAID-LATE');
    expect(stored()).toHaveLength(1);
  });
});

describe('the store stays scoped per identity', () => {
  it('never prunes or returns the records of another wallet', () => {
    const now = Date.now();
    rememberContribution(record({ owner: BOB, leafIndex: 4, at: now - 3 * RECLAIM_MS }));
    rememberContribution(record({ owner: ALICE, leafIndex: 6, at: now - 3 * RECLAIM_MS }));

    expect(pendingFor(ALICE)).toBeNull();
    // Alice's read pruned Alice's dead record and left Bob's alone.
    expect(stored().map((e) => e.owner)).toEqual([BOB]);
    expect(pendingFor(BOB)).toBeNull();
  });

  it('clears only the record named, once its note is in hand', () => {
    const now = Date.now();
    rememberContribution(record({ leafIndex: 6, at: now - 60_000, paymentSignature: 'A' }));
    rememberContribution(record({ leafIndex: 7, at: now - 30_000, paymentSignature: 'B' }));
    clearContribution(ALICE, 6);
    expect(stored().map((e) => e.leafIndex)).toEqual([7]);
  });
});

describe('a record written before the payment field existed', () => {
  it('is never pruned, however old, because it cannot say whether money moved', () => {
    // `attachPayment` landed on 2026-09-02. A paymentless record from before
    // it is silent about a payment that may well have happened; dropping it
    // sends the buyer back through a fresh contribution and charges them a
    // second denomination. It stays, and `resumeContribution` keeps refusing
    // loudly rather than quietly starting again.
    rememberContribution(record({ leafIndex: 3, at: Date.parse('2026-08-30T10:00:00Z') }));
    expect(pendingFor(ALICE)?.leafIndex, 'a pre-field record was pruned').toBe(3);
    expect(stored()).toHaveLength(1);
  });

  it('still prunes a paymentless record written after the field existed', () => {
    const recent = Date.parse('2026-09-02T08:00:00Z');
    rememberContribution(record({ leafIndex: 4, at: recent }));
    // Far past the reclaim window: the deployment has handed that leaf on.
    expect(pendingFor(ALICE)).toBeNull();
    expect(stored()).toHaveLength(0);
  });
});
