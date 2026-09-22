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

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attachClaim,
  attachPayment,
  clearContribution,
  pendingFor,
  pendingRecords,
  rememberContribution,
  type PendingContribution,
  type PendingRecord,
} from './pendingContribution';
import { StaleWorkerError, sealRecord, storeSession } from './sealedStore';

/**
 * DEV-1: the worker is NOT stubbed. `poolRequest` is routed into the real
 * `handlePoolRequest`, so the records are sealed by the real hybrid
 * X25519 + ML-KEM-768 and opened by the real envelope filter, the same
 * harness as `pool/storeEncryption.test.ts`.
 */
/**
 * Version-skew dial: `stripPending` answers `poolOpenRecords` the way a worker
 * from before DEV-1 does, without the `pending` array. Everything else is
 * the real handler.
 */
const skew = vi.hoisted(() => ({ stripPending: false }));
vi.mock('./workerClient', async () => {
  const { handlePoolRequest } = await import('./worker/poolHandlers');
  return {
    poolRequest: async (req: never, onProgress?: (step: string) => void) => {
      const res = await handlePoolRequest(req, onProgress);
      if (skew.stripPending && (res as { kind?: string }).kind === 'poolOpenRecords') {
        const aged = { ...(res as Record<string, unknown>) };
        delete aged.pending;
        return aged;
      }
      return res;
    },
  };
});
const { clearPoolState, setPoolSeed } = await import('./worker/poolHandlers');

const KEY = 'p01:pending-contribution:v1';

/** The reclaim window the server itself uses, restated here rather than imported. */
const RECLAIM_MS = 20 * 60 * 1000;

const ALICE = 'AAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa111';
const BOB = 'BBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb222';

/** Each wallet signs once and gets its own pool identity (DEV-1 harness). */
const SIGNATURES: Record<string, Uint8Array> = {
  'meta-alice': Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff),
  'meta-bob': Uint8Array.from({ length: 64 }, (_, i) => (i * 13 + 1) & 0xff),
};
const META_OF: Record<string, string> = { [ALICE]: 'meta-alice', [BOB]: 'meta-bob' };

/** A page reload: nothing in memory survives, the wallet signs again. */
function reload(): void {
  clearPoolState();
  for (const [meta, sig] of Object.entries(SIGNATURES)) setPoolSeed(meta, sig);
}

/**
 * The call shapes, kept in one place because DEV-1 changes them (the red
 * snapshot keeps the shapes the red ran against). A record is named by the id
 * `rememberContribution` returns; sealing takes the identity's store session.
 */
type Ref = { owner: string; id: string };
async function remember(entry: PendingContribution, meta = META_OF[entry.owner]!): Promise<Ref> {
  return { owner: entry.owner, id: rememberContribution(await storeSession(meta), entry) };
}
async function payment(ref: Ref, paymentSignature: string, meta = META_OF[ref.owner]!): Promise<void> {
  attachPayment(await storeSession(meta), ref.id, paymentSignature);
}
async function claim(ref: Ref, claimCode: string, meta = META_OF[ref.owner]!): Promise<void> {
  attachClaim(await storeSession(meta), ref.id, claimCode);
}
async function pending(owner: string, meta = META_OF[owner]!): Promise<PendingRecord | null> {
  return pendingFor(meta, owner);
}

/** Every key and value in storage: what a device thief or an extension reads. */
function rawDump(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    out.push([k, localStorage.getItem(k) ?? '']);
  }
  return out;
}

/**
 * Which of a record's values a dump carries in clear: the strings as
 * substrings of any key or value, a leaf as any JSON number equal to it or as
 * a `leafIndex` field. Its own positive control is the first assertion of the
 * case that uses it.
 */
function leaks(
  dump: Array<[string, string]>,
  values: { strings: Record<string, string>; leaves: number[] },
): string[] {
  const found: string[] = [];
  const text = dump.map(([k, v]) => `${k}\n${v}`).join('\n');
  for (const [name, s] of Object.entries(values.strings)) if (text.includes(s)) found.push(name);
  if (text.includes('leafIndex')) found.push('leafIndex field');
  const numbers: number[] = [];
  const walk = (x: unknown): void => {
    if (typeof x === 'number') numbers.push(x);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  };
  for (const [, v] of dump) {
    try {
      walk(JSON.parse(v));
    } catch {
      // Not JSON: the substring scan above already covered it.
    }
  }
  for (const leaf of values.leaves) if (numbers.includes(leaf)) found.push(`leaf ${leaf}`);
  return found;
}

/** The dump with every sealed blob replaced by its length, keys sorted. */
function normalized(dump: Array<[string, string]>): string {
  const norm = (x: unknown): unknown => {
    if (typeof x === 'string') return x.startsWith('p01enc1:') ? `p01enc1:<${x.length} chars>` : x;
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, norm(v)]));
    }
    return x;
  };
  return JSON.stringify(
    dump
      .map(([k, v]) => {
        let parsed: unknown = v;
        try {
          parsed = JSON.parse(v);
        } catch {
          // kept as the string it is
        }
        return [k, norm(parsed)] as const;
      })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** Every `crypto.getRandomValues` draw from a seeded LCG, so a world replays byte for byte. */
function seedRandom(seed: number): () => void {
  let s = seed >>> 0;
  const spy = vi
    .spyOn(globalThis.crypto, 'getRandomValues')
    .mockImplementation(<T extends ArrayBufferView | null>(arr: T): T => {
      const view = arr as unknown as ArrayBufferView;
      const u8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      for (let i = 0; i < u8.length; i++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        u8[i] = s >>> 24;
      }
      return arr;
    });
  return () => spy.mockRestore();
}

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

/**
 * What is actually on disk, which is what a reload would see: every record of
 * both identities, opened by the worker. A read, so it prunes nothing.
 */
async function stored(): Promise<PendingRecord[]> {
  return [
    ...(await pendingRecords('meta-alice', ALICE)),
    ...(await pendingRecords('meta-bob', BOB)),
  ];
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
  reload();
  skew.stripPending = false;
});

describe('🚨 one abandoned reservation must not shadow a paid one', () => {
  it('skips a paymentless reservation older than the reclaim window and returns the paid record', async () => {
    // The measured shape: click one reserved a leaf and the wallet prompt was
    // dismissed, so no payment exists and none ever will. Click two paid, and
    // the worker went quiet after the till was paid.
    const now = Date.now();
    await remember(record({ leafIndex: 6, at: now - 3 * RECLAIM_MS }));
    await remember(
      record({ leafIndex: 7, at: now - 60_000, paymentSignature: 'PAID-SIG' }),
    );

    const found = await pending(ALICE);
    expect(found, 'nothing was offered to resume').not.toBeNull();
    expect(found!.leafIndex, 'the dead reservation shadowed the paid one').toBe(7);
    expect(found!.paymentSignature).toBe('PAID-SIG');
  });

  it('drops the dead reservation from storage, so it stops mattering after one read', async () => {
    const now = Date.now();
    await remember(record({ leafIndex: 6, at: now - 3 * RECLAIM_MS }));
    await remember(record({ leafIndex: 7, at: now - 60_000, paymentSignature: 'PAID-SIG' }));

    await pending(ALICE);
    expect((await stored()).map((e) => e.leafIndex)).toEqual([7]);
  });

  it('still offers a paymentless reservation while the server would still hold its leaf', async () => {
    // Inside the reclaim window the index is still this buyer's, so the record
    // describes an attempt that can genuinely be finished.
    await remember(record({ leafIndex: 6, at: Date.now() - 60_000 }));
    expect((await pending(ALICE))?.leafIndex).toBe(6);
    expect(await stored(), 'a live reservation was pruned').toHaveLength(1);
  });

  it('returns null, not a corpse, when every record for the wallet has expired', async () => {
    await remember(record({ leafIndex: 6, at: Date.now() - 3 * RECLAIM_MS }));
    expect(await pending(ALICE)).toBeNull();
    expect(await stored()).toHaveLength(0);
  });

  it('picks the OLDEST of two collectable records, so nothing owed is queued behind', async () => {
    const now = Date.now();
    await remember(record({ leafIndex: 8, at: now - 30_000, paymentSignature: 'NEWER' }));
    await remember(record({ leafIndex: 6, at: now - 90_000, paymentSignature: 'OLDER' }));
    expect((await pending(ALICE))?.paymentSignature).toBe('OLDER');
  });
});

describe('⛔ a record that carries a payment is never dropped', () => {
  it('keeps a paid record of any age, and keeps returning it', async () => {
    // Money that moved is owed forever. This record is the only thing proving
    // a note is owed; an expiry on it would delete the receipt.
    const ancient = Date.now() - 400 * 24 * 60 * 60 * 1000;
    await remember(record({ leafIndex: 6, at: ancient, paymentSignature: 'PAID-SIG' }));

    expect((await pending(ALICE))?.paymentSignature).toBe('PAID-SIG');
    expect(await stored(), 'a paid record was pruned').toHaveLength(1);
    // And again, after the read that prunes.
    expect((await pending(ALICE))?.paymentSignature).toBe('PAID-SIG');
  });

  it('keeps an ancient record that holds a claim code but no payment signature', async () => {
    // The contribution path attaches the claim after collecting it; that code
    // is a bearer token for one note out of stock.
    const ancient = Date.now() - 3 * RECLAIM_MS;
    const six = await remember(record({ leafIndex: 6, at: ancient }));
    await claim(six, 'CLAIM-CODE');
    expect((await pending(ALICE))?.claimCode).toBe('CLAIM-CODE');
    expect(await stored()).toHaveLength(1);
  });

  it('keeps an exchange record, whose payment IS the withdrawal that was spent', async () => {
    const ancient = Date.now() - 10 * RECLAIM_MS;
    await remember(
      record({
        leafIndex: 33,
        at: ancient,
        kind: 'exchange',
        txSig: 'SPEND-SIG',
        paymentSignature: 'SPEND-SIG',
        claimProof: 'base64-proof',
      }),
    );
    const found = await pending(ALICE);
    expect(found?.kind).toBe('exchange');
    expect(found?.claimProof).toBe('base64-proof');
  });

  it('a reservation that gains its payment inside the window survives the window', async () => {
    // The ordering the flow actually has: remembered before the money moves,
    // then `attachPayment` the moment it has. Age must stop mattering there.
    const now = Date.now();
    const six = await remember(record({ leafIndex: 6, at: now - 3 * RECLAIM_MS }));
    await payment(six, 'PAID-LATE');
    expect((await pending(ALICE))?.paymentSignature).toBe('PAID-LATE');
    expect(await stored()).toHaveLength(1);
  });
});

describe('the store stays scoped per identity', () => {
  it('never prunes or returns the records of another wallet', async () => {
    const now = Date.now();
    await remember(record({ owner: BOB, leafIndex: 4, at: now - 3 * RECLAIM_MS }));
    await remember(record({ owner: ALICE, leafIndex: 6, at: now - 3 * RECLAIM_MS }));

    expect(await pending(ALICE)).toBeNull();
    // Alice's read pruned Alice's dead record and left Bob's alone.
    expect((await stored()).map((e) => e.owner)).toEqual([BOB]);
    expect(await pending(BOB)).toBeNull();
  });

  it('clears only the record named, once its note is in hand', async () => {
    const now = Date.now();
    const six = await remember(record({ leafIndex: 6, at: now - 60_000, paymentSignature: 'A' }));
    await remember(record({ leafIndex: 7, at: now - 30_000, paymentSignature: 'B' }));
    clearContribution(six.id);
    expect((await stored()).map((e) => e.leafIndex)).toEqual([7]);
  });
});

describe('a record written before the payment field existed', () => {
  it('is never pruned, however old, because it cannot say whether money moved', async () => {
    // `attachPayment` landed on 2026-09-02. A paymentless record from before
    // it is silent about a payment that may well have happened; dropping it
    // sends the buyer back through a fresh contribution and charges them a
    // second denomination. It stays, and `resumeContribution` keeps refusing
    // loudly rather than quietly starting again.
    await remember(record({ leafIndex: 3, at: Date.parse('2026-08-30T10:00:00Z') }));
    expect((await pending(ALICE))?.leafIndex, 'a pre-field record was pruned').toBe(3);
    expect(await stored()).toHaveLength(1);
  });

  it('still prunes a paymentless record written after the field existed', async () => {
    const recent = Date.parse('2026-09-02T08:00:00Z');
    await remember(record({ leafIndex: 4, at: recent }));
    // Far past the reclaim window: the deployment has handed that leaf on.
    expect(await pending(ALICE)).toBeNull();
    expect(await stored()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DEV-1 — the record is sealed, and every money-safety case above still holds
// ---------------------------------------------------------------------------

describe('DEV-1: no wallet, signature, code or leaf in clear; every money-safety case holds', () => {
  /**
   * The adversary is a device thief or an extension with the `storage`
   * permission. A claim code is a bearer token for one note; the wallet next
   * to a leaf and a payment signature is the (buyer, deposit, payment) join
   * the swap exists to break. Values are distinctive and of on-chain length.
   */
  const PAY = '5PAYmentSIGNATUREofTHEtillTRANSFER'.padEnd(88, 'p');
  const CODE = 'claim-CODE-bearer-7f3a9c';
  const PROOF = 'ZXBoZW1lcmFsLXByb29mLW92ZXItdGhlLWNsYWltLWNoYWxsZW5nZQ'.padEnd(88, '=');
  const SPEND = '4SPENDwithdrawalTOtheTILL'.padEnd(87, 's');
  const CODE2 = 'claim-CODE-exchange-44d1';
  const LEAF = 48_271;
  const NEEDLES = {
    strings: { wallet: ALICE, payment: PAY, code: CODE, proof: PROOF, spend: SPEND, code2: CODE2 },
    leaves: [LEAF, LEAF + 1],
  };

  it('raw storage holds no wallet, payment signature, claim code, claim proof or leaf', async () => {
    // Positive control: the detector flags every one of them in the shape the
    // store used to write.
    expect(
      leaks(
        [[KEY, JSON.stringify([{ owner: ALICE, leafIndex: LEAF, paymentSignature: PAY, claimCode: CODE, claimProof: PROOF, txSig: SPEND }])]],
        NEEDLES,
      ),
    ).toEqual(['wallet', 'payment', 'code', 'proof', 'spend', 'leafIndex field', `leaf ${LEAF}`]);

    const c = await remember(record({ leafIndex: LEAF, at: Date.now() - 60_000 }));
    await payment(c, PAY);
    await claim(c, CODE);
    const x = await remember(
      record({
        kind: 'exchange',
        leafIndex: LEAF + 1,
        at: Date.now(),
        txSig: SPEND,
        paymentSignature: SPEND,
        claimProof: PROOF,
      }),
    );
    await claim(x, CODE2);

    expect(rawDump().length, 'nothing was stored, so nothing could leak').toBeGreaterThan(0);
    expect(leaks(rawDump(), NEEDLES)).toEqual([]);
    // Anti-vacuity: the records are all there, behind the seal.
    const back = await pending(ALICE);
    expect(back?.claimCode).toBe(CODE);
    expect(back?.leafIndex).toBe(LEAF);
  });

  it('the stored state does not move with the record values, and every sealed body has one length', async () => {
    /**
     * Measured, not spelled: two worlds that differ ONLY in the record's
     * values (wallet, leaf, payment, code, proof, withdrawal, with different
     * lengths), the same identity, a frozen clock and seeded randomness.
     * Anything the store derives from those values without a key (a hash, a
     * prefix, a length) moves the dump; nothing else can.
     */
    const CAROL = 'CCCCccccCCCCccccCCCCccccCCCCccccCCCCccccC333';
    const W1 = { owner: ALICE, leaf: 6, pay: PAY, code: CODE, proof: PROOF, spend: SPEND, code2: CODE2 };
    const W2 = {
      owner: CAROL,
      leaf: LEAF,
      pay: '3otherPAYMENT'.padEnd(87, 'q'),
      code: 'a-much-longer-claim-code-of-sixty-four-characters-0123456789abcd',
      proof: 'b3RoZXItcHJvb2Y'.padEnd(88, 'A'),
      spend: '2otherSPEND'.padEnd(88, 'r'),
      code2: 'short-c2',
    };
    const FROZEN = Date.parse('2026-09-19T00:00:00Z');

    async function world(w: typeof W1): Promise<string> {
      localStorage.clear();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(FROZEN);
      const restore = seedRandom(0x5eed);
      try {
        const c = await remember(
          { leafIndex: w.leaf, owner: w.owner, token: 'SOL', denomination: 1, at: Date.now() },
          'meta-alice',
        );
        await payment(c, w.pay, 'meta-alice');
        await claim(c, w.code, 'meta-alice');
        const x = await remember(
          {
            kind: 'exchange',
            leafIndex: w.leaf + 1,
            owner: w.owner,
            token: 'SOL',
            denomination: 1,
            txSig: w.spend,
            paymentSignature: w.spend,
            claimProof: w.proof,
            at: Date.now(),
          },
          'meta-alice',
        );
        await claim(x, w.code2, 'meta-alice');
      } finally {
        restore();
        vi.useRealTimers();
      }
      return normalized(rawDump());
    }

    const base = await world(W1);
    const again = await world(W1);
    expect(again, 'the world does not replay: an unseeded draw would hide every join').toBe(base);
    const other = await world(W2);
    expect(other, 'the stored state moved with the record values').toBe(base);
    // Anti-vacuity: the dump holds sealed bodies, and they all have one length.
    const lengths = [...base.matchAll(/p01enc1:<(\d+) chars>/g)].map((m) => Number(m[1]));
    expect(lengths.length).toBeGreaterThanOrEqual(5);
    expect(new Set(lengths).size).toBe(1);
  });

  it('a reload between remember and attachClaim still resumes', async () => {
    const ref = await remember(record({ leafIndex: LEAF, at: Date.now() - 60_000 }));
    await payment(ref, PAY);
    reload();
    const rec = await pending(ALICE);
    expect(rec?.paymentSignature, 'the payment did not survive the reload').toBe(PAY);
    await claim(rec!, CODE);
    reload();
    const again = await pending(ALICE);
    expect(again?.claimCode, 'the claim did not survive the reload').toBe(CODE);
    expect(again?.paymentSignature).toBe(PAY);
    expect(again?.leafIndex).toBe(LEAF);
  });

  it('a legacy record is still collected, then re-sealed', async () => {
    // Written by the build before DEV-1: plaintext, keyed by the wallet.
    localStorage.setItem(
      KEY,
      JSON.stringify([
        record({ leafIndex: LEAF, at: Date.now() - 400 * 24 * 60 * 60 * 1000, paymentSignature: PAY }),
      ]),
    );
    const found = await pending(ALICE);
    expect(found?.paymentSignature, 'a legacy record was lost').toBe(PAY);
    expect(found?.leafIndex).toBe(LEAF);
    expect(leaks(rawDump(), NEEDLES), 'the legacy record stayed in clear').toEqual([]);
    // And it is still collected from the sealed copy.
    const again = await pending(ALICE);
    expect(again?.paymentSignature).toBe(PAY);
    expect(again?.leafIndex).toBe(LEAF);
  });
  it("a worker that cannot read the store says reload, never 'nothing owed'", async () => {
    // A worker from before DEV-1, left open across the deploy, answers
    // `poolOpenRecords` without the `pending` array. "Nothing outstanding"
    // would send the buyer into a fresh contribution and a second payment.
    const ref = await remember(record({ leafIndex: LEAF, at: Date.now() - 60_000 }));
    await payment(ref, PAY);
    skew.stripPending = true;
    await expect(pending(ALICE)).rejects.toBeInstanceOf(StaleWorkerError);
    // Nor is a legacy record moved past such a worker: it stays readable.
    localStorage.setItem(KEY, JSON.stringify([record({ owner: BOB, leafIndex: 9, at: 1, paymentSignature: PAY })]));
    await expect(pending(BOB)).rejects.toBeInstanceOf(StaleWorkerError);
    expect(localStorage.getItem(KEY), 'a legacy record was sealed past a worker that cannot open it').not.toBeNull();
    // With nothing stored for an identity, the old worker is no error at all.
    localStorage.clear();
    expect(await pending(ALICE)).toBeNull();
    // The reload: a current worker reads what was kept, nothing lost.
    skew.stripPending = false;
    await remember(record({ leafIndex: LEAF, at: Date.now() - 60_000, paymentSignature: PAY }));
    expect((await pending(ALICE))?.paymentSignature).toBe(PAY);
  });

  it('a record written with a passphrase armed still opens once it is disarmed, and back', async () => {
    // Sealed to the V1 address, like the subscription store: a passphrase
    // changes the active seed, and a receipt must not become unreadable
    // because the buyer armed or disarmed one between paying and collecting.
    const PASSPHRASE = 'nine tigers argue quietly';
    clearPoolState();
    setPoolSeed('meta-armed', SIGNATURES['meta-alice']!, PASSPHRASE);
    await remember(record({ leafIndex: LEAF, at: Date.now() - 60_000, paymentSignature: PAY }), 'meta-armed');

    clearPoolState();
    setPoolSeed('meta-disarmed', SIGNATURES['meta-alice']!);
    expect((await pending(ALICE, 'meta-disarmed'))?.paymentSignature, 'lost on disarm').toBe(PAY);

    clearPoolState();
    setPoolSeed('meta-rearmed', SIGNATURES['meta-alice']!, PASSPHRASE);
    expect((await pending(ALICE, 'meta-rearmed'))?.paymentSignature, 'lost on re-arm').toBe(PAY);
  });

  it('an unopenable record is kept, and so is its promise that money moved', async () => {
    // A body no seed of this identity opens (corrupted, or truncated by a
    // quota failure). Its index still says a payment was recorded, so the
    // pruning keeps it, whatever its age.
    const { label } = await storeSession('meta-alice');
    // A real moment, not `1`: with `at: 1` the day it is truncated to is also 0,
    // and the case could not tell "no time kept" from "the day kept" (sweep
    // round 1 of run logs8, storage lens).
    const corpse = { id: '0'.repeat(32), label, at: Date.parse('2026-09-15T14:23:45.678Z'), kind: 'contribution', paid: true, claimed: false, sealed: ['p01enc1:AAAA'] };
    localStorage.setItem('p01:pending-contribution:v2', JSON.stringify([corpse]));
    expect(await pending(ALICE)).toBeNull();
    // Kept whole — the id, the label, the flags and the sealed body it was
    // written with. Its `at` is the one field the storage fixes take away from
    // a record that says money moved: the time of an unopenable record orders
    // nothing, since the record cannot be returned at all, and a dump would
    // otherwise still read the day of the payment beside it.
    expect(JSON.parse(localStorage.getItem('p01:pending-contribution:v2') ?? '[]')).toEqual([
      { ...corpse, at: 0 },
    ]);
    // Positive control: the same entry without the flag is pruned as any
    // dead reservation is, so the kept one was kept for its flag.
    localStorage.setItem('p01:pending-contribution:v2', JSON.stringify([{ ...corpse, paid: false, at: Date.now() - 3 * RECLAIM_MS }]));
    expect(await pending(ALICE)).toBeNull();
    expect(localStorage.getItem('p01:pending-contribution:v2')).toBeNull();
  });
});

/**
 * [SWEEP4 round 1, storage lane] The clear index kept each reservation's exact
 * millisecond, for records that HAVE a payment.
 *
 * A contribution's `at` falls seconds before its till payment, and an
 * exchange's falls seconds before its note-in withdrawal to the till — both
 * public transactions that name the wallet. So a dump holding the index and
 * the chain joined this device to that payment to the millisecond, through a
 * record whose every other field is sealed (DEV-1). Ledger row D17.
 *
 * `collectable()` needs `at` only while a record is UNPAID (the 20-minute
 * reclaim window and the 2026-09-02 cut-off), and an unpaid reservation has no
 * payment to be joined to. So the exact time stays in the clear index exactly
 * as long as it decides something, and moves into the sealed body — where the
 * resume order reads it — the moment money moves.
 */
describe('[SWEEP4-STORAGE] a paid record does not date its own payment in the clear', () => {
  const DAY_MS = 86_400_000;
  const AT = Date.parse('2026-09-15T14:23:45.678Z');
  const dayOf = (at: number) => Math.floor(at / DAY_MS) * DAY_MS;
  const V2 = 'p01:pending-contribution:v2';

  interface IndexRow {
    id: string;
    at: number;
    paid: boolean;
    claimed: boolean;
    label: string;
    kind: string;
    sealed: string[];
  }
  const indexRows = (): IndexRow[] => JSON.parse(localStorage.getItem(V2) ?? '[]') as IndexRow[];

  it('the exact millisecond leaves the index the moment a payment is attached', async () => {
    const ref = await remember(record({ at: AT }));
    // While unpaid it is what decides whether the leaf can still be finished,
    // and there is no payment on chain for it to be joined to.
    expect(indexRows()[0]!.at, 'the reservation is not dated at all').toBe(AT);

    await payment(ref, 'PAY-SIG-XYZ');
    const row = indexRows()[0]!;
    expect(row.paid).toBe(true);
    expect(row.at, 'the index still dates the till payment, to the day or finer').toBe(0);

    // ...and nothing is lost: the resume still reads the exact time, from the
    // sealed body, so the oldest owed record is still the oldest.
    const [rec] = await pendingRecords('meta-alice', ALICE);
    expect(rec!.at).toBe(AT);
    expect(rec!.paymentSignature).toBe('PAY-SIG-XYZ');
  });

  it('a claim attached to a record coarsens it too', async () => {
    const ref = await remember(record({ leafIndex: 9, at: AT }));
    await claim(ref, 'CLAIM-CODE');
    expect(indexRows()[0]!.claimed).toBe(true);
    expect(indexRows()[0]!.at).toBe(0);
    expect((await pendingRecords('meta-alice', ALICE))[0]!.at).toBe(AT);
  });

  it('a row written before this change is coarsened on read, keeps its record, and is stable', async () => {
    // A v2 row exactly as the pre-sweep code wrote it: the exact time in the
    // clear index, and a sealed body that carries no time at all.
    const s = await storeSession('meta-alice');
    const older = { id: '1'.repeat(32), at: AT - 90_000 };
    const newer = { id: '2'.repeat(32), at: AT };
    const rows = [newer, older].map((r) => ({
      id: r.id,
      label: s.label,
      at: r.at,
      kind: 'contribution',
      paid: true,
      claimed: false,
      sealed: [
        sealRecord(s.legacyAddress, {
          p01store: 1,
          kind: 'pending',
          id: r.id,
          owner: ALICE,
          leafIndex: r.id === older.id ? 11 : 12,
          token: 'SOL',
          denomination: 1,
          pendingKind: 'contribution',
          paymentSignature: `PAY-${r.id.slice(0, 1)}`,
        }),
      ],
    }));
    localStorage.setItem(V2, JSON.stringify(rows));

    // Read once: both records are served, oldest first — the order the resume
    // depends on, and the reason the exact time may not simply be dropped.
    const first = await pendingRecords('meta-alice', ALICE);
    expect(first.map((r) => r.leafIndex)).toEqual([11, 12]);
    expect(first.map((r) => r.at)).toEqual([older.at, newer.at]);
    expect(indexRows().map((r) => r.at)).toEqual([0, 0]);

    // Read again: the same answer, and nothing keeps being rewritten.
    const before = localStorage.getItem(V2);
    const second = await pendingRecords('meta-alice', ALICE);
    expect(second.map((r) => r.leafIndex)).toEqual([11, 12]);
    expect(second.map((r) => r.at)).toEqual([older.at, newer.at]);
    expect(localStorage.getItem(V2)).toBe(before);

    // And the money-safety rule is untouched: a paid record is collectable
    // whatever its age.
    expect((await pendingFor('meta-alice', ALICE))!.leafIndex).toBe(11);
  });

  /**
   * [SWEEP round 1 of run logs8, storage lens] THE DAY SERVED NOTHING.
   *
   * Round 1 kept the UTC day "because `collectable()` reads `at` without a
   * key". It does, but it answers `true` on `paid || claimed` BEFORE it looks at
   * `at`, and `load` orders by the SEALED time. So once money has moved nothing
   * reads the clear value, and at 3-4 till payments a day the day plus `kind`
   * narrowed a lingering record to a handful of public payments, each naming a
   * wallet (`logs8/r1-storage/probe-E.log`). The cases above now pin 0; these
   * pin what 0 must not cost.
   */
  it('positive control: nothing reads the clear time of a paid record', async () => {
    const ref = await remember(record({ leafIndex: 77, at: AT }));
    await payment(ref, 'PAY-SIG-77');
    for (const forged of [0, Date.parse('2100-01-01T00:00:00Z'), null]) {
      const rows = indexRows().map((r) => ({ ...r, at: forged }));
      localStorage.setItem(V2, JSON.stringify(rows));
      const rec = await pendingFor('meta-alice', ALICE);
      expect(rec?.leafIndex, `clear at := ${forged}: the record was lost`).toBe(77);
      expect(rec?.at, `clear at := ${forged}: the order moved`).toBe(AT);
    }
  });

  it('the day a round-1 build left in the index goes on the next read', async () => {
    const ref = await remember(record({ leafIndex: 21, at: AT }));
    await payment(ref, 'PAY-SIG-21');
    // Exactly what the round-1 code wrote: the sealed time, and the day in clear.
    localStorage.setItem(V2, JSON.stringify(indexRows().map((r) => ({ ...r, at: dayOf(AT) }))));
    expect((await pendingRecords('meta-alice', ALICE))[0]!.at).toBe(AT);
    expect(indexRows()[0]!.at, 'the index still names the day of the payment').toBe(0);
    expect(JSON.stringify(rawDump())).not.toContain(String(dayOf(AT)));
  });

  it('a reservation written before round 1 and PAID IN FLIGHT keeps its exact time, sealed', async () => {
    // Before round 1 the sealed body carried no time: the clear index was the
    // only copy. `attachPayment` cannot open a body, so it has to seal the time
    // it is about to take out of the index, or the resume order is gone for good.
    const s = await storeSession('meta-alice');
    const id = '3'.repeat(32);
    localStorage.setItem(V2, JSON.stringify([{
      id,
      label: s.label,
      at: AT,
      kind: 'contribution',
      paid: false,
      claimed: false,
      sealed: [sealRecord(s.legacyAddress, {
        p01store: 1, kind: 'pending', id, owner: ALICE, leafIndex: 31, token: 'SOL', denomination: 1, pendingKind: 'contribution',
      })],
    }]));
    await payment({ owner: ALICE, id }, 'PAY-SIG-31');
    expect(indexRows()[0]!.at).toBe(0);
    const [rec] = await pendingRecords('meta-alice', ALICE);
    expect(rec!.paymentSignature).toBe('PAY-SIG-31');
    expect(rec!.at, 'the exact time left the index and was sealed nowhere').toBe(AT);
  });

  it('another wallet\u2019s legacy row under the same identity keeps its order when this wallet\u2019s read empties the index', async () => {
    // `load` opens every body of the identity and returns only the owner's. A
    // read for ALICE used to coarsen BOB's pre-round-1 row without sealing its
    // time first; at 0 that would lose BOB's order for good.
    const s = await storeSession('meta-alice');
    const mk = (id: string, owner: string, at: number, leafIndex: number) => ({
      id,
      label: s.label,
      at,
      kind: 'contribution',
      paid: true,
      claimed: false,
      sealed: [sealRecord(s.legacyAddress, {
        p01store: 1, kind: 'pending', id, owner, leafIndex, token: 'SOL', denomination: 1, pendingKind: 'contribution', paymentSignature: `PAY-${leafIndex}`,
      })],
    });
    localStorage.setItem(V2, JSON.stringify([
      mk('4'.repeat(32), BOB, AT, 42),
      mk('5'.repeat(32), BOB, AT - 90_000, 41),
      mk('6'.repeat(32), ALICE, AT - 30_000, 43),
    ]));
    expect((await pendingRecords('meta-alice', ALICE)).map((r) => r.leafIndex)).toEqual([43]);
    expect(indexRows().map((r) => r.at)).toEqual([0, 0, 0]);
    const bobs = await pendingRecords('meta-alice', BOB);
    expect(bobs.map((r) => r.leafIndex)).toEqual([41, 42]);
    expect(bobs.map((r) => r.at)).toEqual([AT - 90_000, AT]);
  });

  it('an unpaid reservation keeps its exact time: the 20-minute window is what it decides', async () => {
    await remember(record({ leafIndex: 51, at: AT }));
    expect(indexRows()[0]!.at).toBe(AT);
  });
});
