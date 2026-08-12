/**
 * storeEncryption — the L5 fix: the local payout/spent/note stores persist
 * ciphertext under an opaque label instead of a cleartext linkage table under
 * the wallet pubkey.
 *
 * What is worth testing, in order of what it costs to get wrong:
 *
 *   1. MIGRATION LOSES NOTHING. Existing users have live v1 entries, and a
 *      payout record names an address with money sitting on it. A v1 store
 *      must stay readable, migrate on first touch, and the migrated record
 *      must still name an address the payout derivation reaches.
 *   2. NOTHING PERSISTED LEAKS. After the round trip, no store key or value
 *      contains the wallet pubkey, a leaf index, a withdrawal signature, a
 *      payout address or a pool id in cleartext. The scan carries a positive
 *      control (the same needles ARE found in the plaintext form), following
 *      denominatedPool.test.ts:678-694 — a negative assertion without one
 *      proves nothing.
 *   3. THE WORKER BOUNDARY HOLDS. `poolOpenRecords` decrypts under the pool
 *      seed, which makes it the one candidate for an accidental decryption
 *      oracle over the note store: a note blob opens under the same seeds and
 *      contains three spendable secrets. The envelope + whitelist must refuse
 *      it. And nothing crossing the wire in either direction may carry the
 *      seed itself.
 *
 * The worker is NOT stubbed: `poolRequest` is routed straight into the real
 * `handlePoolRequest`, so the blobs are sealed and opened by the real hybrid
 * X25519 + ML-KEM-768 and the real envelope filter — while every message is
 * logged for the boundary scan. None of the three handlers involved touches
 * the RPC, so no chain stub is needed.
 *
 * Runs under `vitest.pool.config.mts` (node). localStorage does not exist
 * there; the shim below is a Map with the DOM Storage surface the store
 * helpers use.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import { derivePoolSeedLegacy } from './seedDerivation';
import { findPoolV3 } from './denominatedPool';
import { createNoteEncryptionAddress, encryptNote } from './noteCrypto';

// ---------------------------------------------------------------------------
// Harness: real handlers behind the poolRequest seam, with a wire log
// ---------------------------------------------------------------------------

/** Every JSON message that crossed the main-thread↔worker seam, both ways. */
const wire = vi.hoisted(() => ({ log: [] as string[] }));

/**
 * Version-skew dial (task #12). `strip` lists the `poolOpenRecords` arrays to
 * DELETE from responses, which is byte-for-byte what an older worker sends: it
 * predates those record kinds, so its response never had the fields — and its
 * envelope filter files the unrecognized blobs under `skipped`, which the
 * deletion below leaves untouched as the real old handler would not, a
 * difference no reader consults. Everything else stays the REAL handler.
 */
const skew = vi.hoisted(() => ({ strip: [] as string[] }));

vi.mock('../workerClient', async () => {
  const { handlePoolRequest } = await import('../worker/poolHandlers');
  return {
    poolRequest: async (req: never, onProgress?: (step: string) => void) => {
      wire.log.push(JSON.stringify(req));
      const res = await handlePoolRequest(req, onProgress);
      const kind = (res as { kind?: string }).kind;
      if (kind === 'poolOpenRecords' && skew.strip.length > 0) {
        const aged = { ...(res as Record<string, unknown>) };
        for (const field of skew.strip) delete aged[field];
        wire.log.push(JSON.stringify(aged));
        return aged;
      }
      wire.log.push(JSON.stringify(res));
      return res;
    },
  };
});

const shieldClient = await import('../shieldClient');
const handoffs = await import('../../pay/handoffs');
// Real module since L5b sealed it too; in node its `announce` no-ops (no window).
const subscriptions = await import('../../pay/subscriptions');
const { clearPoolState, handlePoolRequest, setPoolSeed } = await import(
  '../worker/poolHandlers'
);

// ---------------------------------------------------------------------------
// localStorage shim (node has none)
// ---------------------------------------------------------------------------

function makeLocalStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
    /** Test-only: everything persisted, for the leak scan. */
    dump: () => [...m.entries()],
  };
}
const ls = makeLocalStorage();
vi.stubGlobal('localStorage', ls);

/** True when any persisted key OR value contains `needle`. The leak scan. */
function storesContain(needle: string): boolean {
  return ls.dump().some(([k, v]) => k.includes(needle) || v.includes(needle));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIGNATURE = new Uint8Array(64);
for (let i = 0; i < 64; i++) SIGNATURE[i] = (i * 7 + 3) & 0xff;
const SEED = derivePoolSeedLegacy(SIGNATURE); // active == v1: no passphrase set

const META = 'meta-under-test';
const WALLET = '7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU';
const POOL_58 = findPoolV3('SOL', 0.1)!.poolPDA.toBase58();

const PAYOUT_ROOT = shieldClient.derivePoolPayoutRoot(new Uint8Array(64).fill(9));
const PAYOUT_ADDRESS = shieldClient
  .derivePoolPayoutKeypair(PAYOUT_ROOT, POOL_58, 57)
  .publicKey.toBase58();

/** One withdrawal's record, with a realistic 88-char signature so the leak
 *  scan hunts a needle of on-chain length, not a toy string. */
const REC = {
  pool: POOL_58,
  leafIndex: 57,
  address: PAYOUT_ADDRESS,
  txSig: '5VERYrecognizableWITHDRAWALsignature'.padEnd(88, 'w'),
  denomination: 0.1,
};

beforeEach(() => {
  ls.clear();
  clearPoolState();
  setPoolSeed(META, SIGNATURE);
  wire.log.length = 0;
  skew.strip = [];
});

// ---------------------------------------------------------------------------
// 1. Migration
// ---------------------------------------------------------------------------

describe('v1 → v2 migration', () => {
  it('reads a v1 cleartext payout store, migrates it, and keeps the address derivable', async () => {
    // A store exactly as the pre-L5 build wrote it: cleartext records keyed by
    // the wallet pubkey.
    ls.setItem('p01_pay_pool_payouts_v1', JSON.stringify({ [WALLET]: [REC] }));

    // First read serves the record...
    expect((await shieldClient.loadPayouts(META, WALLET)).records).toEqual([REC]);

    // ...and has migrated it: the v1 key is GONE (an empty leftover would keep
    // advertising the old format forever), and the v2 value is ciphertext.
    expect(ls.getItem('p01_pay_pool_payouts_v1')).toBeNull();
    const v2 = JSON.parse(ls.getItem('p01_pay_pool_payouts_v2')!) as Record<string, string[]>;
    const blobs = Object.values(v2).flat();
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.startsWith('p01enc1:')).toBe(true);
    // The index is the opaque label, not the wallet.
    expect(Object.keys(v2)).not.toContain(WALLET);

    // Second read answers from the ciphertext alone.
    const [rec] = (await shieldClient.loadPayouts(META, WALLET)).records;
    expect(rec).toEqual(REC);

    // THE FUND-CRITICAL PROPERTY: the migrated record still names the address
    // the untouched derivation reaches from (root, pool, leafIndex). A user
    // who cannot find this address has lost the money sitting on it.
    expect(
      shieldClient
        .derivePoolPayoutKeypair(PAYOUT_ROOT, rec!.pool, rec!.leafIndex)
        .publicKey.toBase58(),
    ).toBe(REC.address);
  });

  it('migrates v1 spent marks and note blobs the same way', async () => {
    ls.setItem('p01_pay_spent_notes_v1', JSON.stringify({ [WALLET]: [`${POOL_58}:57`] }));
    ls.setItem('p01_pay_notes_v1', JSON.stringify({ [WALLET]: ['p01enc1:old-note-blob'] }));

    expect((await shieldClient.knownSpentNoteKeys(META, WALLET)).keys.has(`${POOL_58}:57`)).toBe(true);
    expect(await shieldClient.loadEncryptedNotes(META, WALLET)).toEqual(['p01enc1:old-note-blob']);

    expect(ls.getItem('p01_pay_spent_notes_v1')).toBeNull();
    expect(ls.getItem('p01_pay_notes_v1')).toBeNull();

    // Still served after migration.
    expect((await shieldClient.knownSpentNoteKeys(META, WALLET)).keys.has(`${POOL_58}:57`)).toBe(true);
    expect(await shieldClient.loadEncryptedNotes(META, WALLET)).toEqual(['p01enc1:old-note-blob']);
  });

  it('with NO worker session, v1 entries are served untouched — never migrated, never hidden', async () => {
    const noSeeds = 'meta-with-no-seeds';
    ls.setItem('p01_pay_pool_payouts_v1', JSON.stringify({ [WALLET]: [REC] }));
    ls.setItem('p01_pay_spent_notes_v1', JSON.stringify({ [WALLET]: ['poolA:1'] }));

    // The fallback is what keeps a pre-L5 user's records visible before the
    // wallet has signed (and if the worker ever restarts mid-session).
    const view = await shieldClient.loadPayouts(noSeeds, WALLET);
    expect(view.records).toEqual([REC]);
    // An ABSENT worker is not a SKEWED worker: nothing migrated, the v1 view
    // is complete, and a "reload this tab" banner over it would be the false
    // alarm in the other direction.
    expect(view.staleWorker).toBe(false);
    expect((await shieldClient.knownSpentNoteKeys(noSeeds, WALLET)).keys.has('poolA:1')).toBe(true);

    // Migration must NOT have run: there is no label to file under and no
    // address to seal to. The cleartext stays until a session exists.
    expect(ls.getItem('p01_pay_pool_payouts_v1')).not.toBeNull();
    expect(ls.getItem('p01_pay_spent_notes_v1')).not.toBeNull();
  });

  it('records only migrate for the wallet that owns them', async () => {
    const other = { ...REC, leafIndex: 3 };
    ls.setItem(
      'p01_pay_pool_payouts_v1',
      JSON.stringify({ [WALLET]: [REC], otherWallet: [other] }),
    );

    await shieldClient.loadPayouts(META, WALLET);

    // The other wallet's bucket is untouched, waiting for ITS session.
    const v1 = JSON.parse(ls.getItem('p01_pay_pool_payouts_v1')!) as Record<string, unknown[]>;
    expect(v1[WALLET]).toBeUndefined();
    expect(v1.otherWallet).toEqual([other]);
  });
});

// ---------------------------------------------------------------------------
// 2. Leak regression
// ---------------------------------------------------------------------------

describe('nothing persisted leaks', () => {
  /** The subscription flavour of the table: adds the MERCHANT to the chain. */
  const SUB_LEAK = {
    vaultPDA: '7WaBm7Kq5WDYa5ykFgaUes1ZCXHXqkyfquJEkmBxzyqw',
    retailer: 'q8R2oNtnCH1Y3Pgjm8okR1Vz6wuxwMwPyoCxm5emLdr',
    serviceTag: 'bitwarden-test-leak-needle',
    token: 'SOL',
    denomination: 1,
    rate: '50000000',
    intervalSlots: '1500',
    openTxSig: 'SUBSCRIBEtxSIGNATUREveryRECOGNIZABLE'.padEnd(88, 's'),
    pool: POOL_58,
    leafIndex: 57,
    openedAt: 1_000,
  };

  // Every needle is a linkage value the L5 stores used to hold in cleartext.
  // All are ≥11 chars, so a chance hit inside base64 ciphertext is ~(1/64)^11
  // per window — not a flake source.
  const NEEDLES = [
    WALLET,
    REC.address,
    REC.txSig,
    REC.pool,
    '"leafIndex"',
    SUB_LEAK.vaultPDA,
    SUB_LEAK.retailer,
    SUB_LEAK.openTxSig,
  ];

  it('after a full round trip, no store key or value carries a linkage value in cleartext', async () => {
    await shieldClient.recordPayout(META, WALLET, REC);
    await shieldClient.recordSpentNote(META, WALLET, `${REC.pool}:${REC.leafIndex}`);
    await shieldClient.storeEncryptedNote(META, WALLET, 'p01enc1:opaque-note-blob');
    await handoffs.recordHandoff(META, WALLET, {
      pool: REC.pool,
      leafIndex: REC.leafIndex,
      sealedAt: 1_723_400_000_000,
    });
    await subscriptions.recordSubscription(META, WALLET, SUB_LEAK);

    // POSITIVE CONTROL first: the exact scan finds every needle in what the
    // pre-L5 store would have persisted, so the assertions below cannot pass
    // because the scan is blind.
    const v1Shape = JSON.stringify({
      [WALLET]: {
        payouts: [REC],
        spent: [`${REC.pool}:${REC.leafIndex}`],
        subscriptions: [SUB_LEAK],
      },
    });
    for (const needle of NEEDLES) {
      expect(v1Shape.includes(needle)).toBe(true);
    }
    // ...and finds a value planted in the shim itself.
    ls.setItem('planted', REC.txSig);
    expect(storesContain(REC.txSig)).toBe(true);
    ls.removeItem('planted');

    for (const needle of NEEDLES) {
      expect(storesContain(needle)).toBe(false);
    }

    // And the round trip still answers correctly from the ciphertext.
    expect((await shieldClient.loadPayouts(META, WALLET)).records).toEqual([REC]);
    expect(
      (await shieldClient.knownSpentNoteKeys(META, WALLET)).keys.has(`${REC.pool}:${REC.leafIndex}`),
    ).toBe(true);
  });

  it('writes are deduplicated on the plaintext, so retries do not grow the stores', async () => {
    await shieldClient.recordPayout(META, WALLET, REC);
    await shieldClient.recordPayout(META, WALLET, REC);
    await shieldClient.recordSpentNote(META, WALLET, `${REC.pool}:${REC.leafIndex}`);
    await shieldClient.recordSpentNote(META, WALLET, `${REC.pool}:${REC.leafIndex}`);

    const count = (key: string) =>
      Object.values(JSON.parse(ls.getItem(key)!) as Record<string, string[]>).flat().length;
    expect(count('p01_pay_pool_payouts_v2')).toBe(1);
    expect(count('p01_pay_spent_notes_v2')).toBe(1);
    expect((await shieldClient.loadPayouts(META, WALLET)).records).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. The worker boundary
// ---------------------------------------------------------------------------

describe('poolOpenRecords is not a decryption oracle', () => {
  const OWN_ADDRESS = createNoteEncryptionAddress(SEED);
  const NOTE_SECRET = '111119999911111';
  const NOTE_PREIMAGE = '222228888822222';

  it('refuses a note blob: no envelope, no fields cross, counted as skipped', async () => {
    // A blob exactly as the shield writes it — decrypts fine under this seed,
    // carries three spendable secrets, has NO `p01store` envelope.
    const noteBlob = encryptNote(
      OWN_ADDRESS,
      utf8ToBytes(
        JSON.stringify({
          version: 1,
          pool: POOL_58,
          secret: NOTE_SECRET,
          nullifier_preimage: NOTE_PREIMAGE,
          deposit_epoch: '12345',
          commitment: '999',
          leafIndex: 3,
        }),
      ),
    );
    // Positive control in the SAME call: a proper record does come back, so
    // "nothing crossed" cannot mean "the handler opened nothing".
    const payoutBlob = encryptNote(
      OWN_ADDRESS,
      utf8ToBytes(JSON.stringify({ p01store: 1, kind: 'payout', ...REC })),
    );

    const res = await handlePoolRequest({
      kind: 'poolOpenRecords',
      meta: META,
      blobs: [noteBlob, payoutBlob],
    });

    expect(res.payouts).toHaveLength(1);
    expect(res.skipped).toBe(1);
    const crossed = JSON.stringify(res);
    expect(crossed).not.toContain(NOTE_SECRET);
    expect(crossed).not.toContain(NOTE_PREIMAGE);
  });

  it('whitelist-copies a payout record: smuggled extra fields do not cross', async () => {
    // An envelope-carrying blob with a secret smuggled alongside the record
    // fields. Only the five whitelisted fields may come back.
    const smuggle = encryptNote(
      OWN_ADDRESS,
      utf8ToBytes(
        JSON.stringify({ p01store: 1, kind: 'payout', ...REC, secret: NOTE_SECRET }),
      ),
    );
    const res = await handlePoolRequest({
      kind: 'poolOpenRecords',
      meta: META,
      blobs: [smuggle],
    });
    expect(res.payouts).toEqual([REC]);
    expect(JSON.stringify(res)).not.toContain(NOTE_SECRET);
  });
});

// ---------------------------------------------------------------------------
// 4. The subscription store (L5b) — sealed to the V1 address by ruling
// ---------------------------------------------------------------------------

describe('subscription store', () => {
  const PASSPHRASE = 'six quiet otters file taxes';
  const SUB = {
    vaultPDA: '7WaBm7Kq5WDYa5ykFgaUes1ZCXHXqkyfquJEkmBxzyqw',
    retailer: 'q8R2oNtnCH1Y3Pgjm8okR1Vz6wuxwMwPyoCxm5emLdr',
    serviceTag: 'bitwarden-test',
    token: 'SOL',
    denomination: 1,
    rate: '50000000',
    intervalSlots: '1500',
    openTxSig: 'SUBSCRIBEtxSIGNATUREveryRECOGNIZABLE'.padEnd(88, 's'),
    pool: POOL_58,
    leafIndex: 57,
    openedAt: 1_000,
  };

  it('migrates a v1 cleartext store, and the record keeps feeding knownSpentNoteKeys', async () => {
    ls.setItem('p01_pay_subscriptions_v1', JSON.stringify({ [WALLET]: [SUB] }));

    const list = (await subscriptions.loadSubscriptions(META, WALLET)).records;
    expect(list).toEqual([SUB]);
    expect(ls.getItem('p01_pay_subscriptions_v1')).toBeNull();
    const v2 = JSON.parse(ls.getItem('p01_pay_subscriptions_v2')!) as Record<string, string[]>;
    const blobs = Object.values(v2).flat();
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.startsWith('p01enc1:')).toBe(true);
    expect(Object.keys(v2)).not.toContain(WALLET);

    // The lead's non-negotiable: the subscribed note must stay OUT of the
    // pickers through the whole migration — a note that walks back in fails
    // only after a proof and ~1 SOL of buffer rent.
    expect(
      (await shieldClient.knownSpentNoteKeys(META, WALLET)).keys.has(`${POOL_58}:${SUB.leafIndex}`),
    ).toBe(true);
  });

  it('survives passphrase arm AND disarm — the ruling the V1 address exists for', async () => {
    // Session with a passphrase armed: records seal to the V1 address anyway.
    clearPoolState();
    setPoolSeed('meta-armed', SIGNATURE, PASSPHRASE);
    await subscriptions.recordSubscription('meta-armed', WALLET, SUB);
    // CONTRAST CONTROL: a payout record written in the same armed session
    // seals to the ACTIVE (salted) address, by design.
    await shieldClient.recordPayout('meta-armed', WALLET, REC);

    // The passphrase is disarmed: only the signature-derived seed remains.
    clearPoolState();
    setPoolSeed('meta-disarmed', SIGNATURE);

    // The subscription record is still there — proof of purchase survives.
    const after = (await subscriptions.loadSubscriptions('meta-disarmed', WALLET)).records;
    expect(after.map((r) => r.vaultPDA)).toEqual([SUB.vaultPDA]);

    // The payout record is NOT: sealed to the salted address, it degrades to
    // a rescan, exactly as its store's contract allows. This is the contrast
    // that proves the subscription result above is the V1 address at work and
    // not the scan passing vacuously.
    expect((await shieldClient.loadPayouts('meta-disarmed', WALLET)).records).toEqual([]);

    // And the reverse direction: recorded without a passphrase, read with one.
    clearPoolState();
    setPoolSeed('meta-rearmed', SIGNATURE, PASSPHRASE);
    const rearmed = (await subscriptions.loadSubscriptions('meta-rearmed', WALLET)).records;
    expect(rearmed.map((r) => r.vaultPDA)).toEqual([SUB.vaultPDA]);
  });

  it('with NO session, the record falls back to v1 rather than being dropped', async () => {
    const noSeeds = 'meta-without-seeds-subs';
    await subscriptions.recordSubscription(noSeeds, WALLET, SUB);
    const v1 = JSON.parse(ls.getItem('p01_pay_subscriptions_v1')!) as Record<string, unknown[]>;
    expect(v1[WALLET]).toEqual([SUB]);
    expect(
      (await subscriptions.loadSubscriptions(null, WALLET)).records.map((r) => r.vaultPDA),
    ).toEqual([SUB.vaultPDA]);
  });
});

// ---------------------------------------------------------------------------
// 5. The handoff store (L5c) — same machinery, its own semantics
// ---------------------------------------------------------------------------

describe('handoff store', () => {
  const HREC = { pool: POOL_58, leafIndex: 57, sealedAt: 1_723_400_000_000 };
  const HKEY = `${POOL_58}:57`;

  it('migrates a v1 cleartext handoff store and keeps serving it', async () => {
    ls.setItem('p01_pay_handoffs_v1', JSON.stringify({ [WALLET]: [HREC] }));

    expect((await handoffs.loadHandoffs(META, WALLET)).records).toEqual([HREC]);
    expect(ls.getItem('p01_pay_handoffs_v1')).toBeNull();
    const v2 = JSON.parse(ls.getItem('p01_pay_handoffs_v2')!) as Record<string, string[]>;
    const blobs = Object.values(v2).flat();
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.startsWith('p01enc1:')).toBe(true);
    expect(Object.keys(v2)).not.toContain(WALLET);

    // Second read answers from the ciphertext alone.
    expect((await handoffs.handoffKeys(META, WALLET)).keys.has(HKEY)).toBe(true);
  });

  it('record → keys → forget round trip, sealed end to end', async () => {
    await handoffs.recordHandoff(META, WALLET, HREC);
    expect((await handoffs.handoffKeys(META, WALLET)).keys.has(HKEY)).toBe(true);
    // Nothing fell back to v1: the record lives sealed.
    expect(ls.getItem('p01_pay_handoffs_v1')).toBeNull();

    // Re-recording the same note replaces, newest sealedAt wins — the
    // append-only ciphertext is deduplicated on the plaintext at read time.
    await handoffs.recordHandoff(META, WALLET, { ...HREC, sealedAt: HREC.sealedAt + 5 });
    const list = (await handoffs.loadHandoffs(META, WALLET)).records;
    expect(list).toHaveLength(1);
    expect(list[0]!.sealedAt).toBe(HREC.sealedAt + 5);

    await handoffs.forgetHandoff(META, WALLET, HREC.pool, HREC.leafIndex);
    expect((await handoffs.handoffKeys(META, WALLET)).keys.size).toBe(0);
    expect((await handoffs.loadHandoffs(META, WALLET)).records).toEqual([]);
  });

  it('forget also purges a v1 leftover, so it cannot resurrect the badge', async () => {
    ls.setItem('p01_pay_handoffs_v1', JSON.stringify({ [WALLET]: [HREC] }));
    await handoffs.forgetHandoff(META, WALLET, HREC.pool, HREC.leafIndex);
    expect((await handoffs.handoffKeys(META, WALLET)).keys.size).toBe(0);
    expect(ls.getItem('p01_pay_handoffs_v1')).toBeNull();
  });

  it('with NO session, the record falls back to v1 — the double-promise guard survives', async () => {
    const noSeeds = 'meta-without-seeds-handoff';
    await handoffs.recordHandoff(noSeeds, WALLET, HREC);
    // Written in the old cleartext shape rather than dropped: withholding the
    // note from the pickers is what stops the same coin being promised twice.
    const v1 = JSON.parse(ls.getItem('p01_pay_handoffs_v1')!) as Record<string, unknown[]>;
    expect(v1[WALLET]).toEqual([HREC]);
    // And both the session-less and the sessioned read serve it.
    expect((await handoffs.handoffKeys(null, WALLET)).keys.has(HKEY)).toBe(true);
    expect((await handoffs.handoffKeys(META, WALLET)).keys.has(HKEY)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Version skew (task #12) — an OLDER worker answering a NEWER page must be
//    detected and stated, never read as an empty store. After migration the v1
//    cleartext buckets are gone, so "collapse the missing array into []" used
//    to paint every list empty — indistinguishable, to the user, from their
//    money-tracking records having vanished. And worse than the painting: the
//    REWRITING writers (recordSubscription, forgetSubscription, forgetHandoff)
//    would rewrite the bucket from that skew-blinded view and actually destroy
//    every sealed record. Both halves are pinned here.
// ---------------------------------------------------------------------------

describe('version-skewed worker (task #12)', () => {
  const HREC = { pool: POOL_58, leafIndex: 57, sealedAt: 1_723_400_000_000 };
  const HREC2 = { pool: POOL_58, leafIndex: 58, sealedAt: 1_723_400_000_005 };
  const subRec = (vaultPDA: string, openedAt: number, serviceName?: string) => ({
    vaultPDA,
    retailer: 'q8R2oNtnCH1Y3Pgjm8okR1Vz6wuxwMwPyoCxm5emLdr',
    serviceTag: 'bitwarden-test',
    ...(serviceName === undefined ? {} : { serviceName }),
    token: 'SOL',
    denomination: 1,
    rate: '50000000',
    intervalSlots: '1500',
    openedAt,
  });

  it('distinguishes the three states: skewed says so, empty stays ordinary, populated reads', async () => {
    // GENUINELY EMPTY: no blobs means no round trip at all, so the flag cannot
    // fire — the wire log is the positive control that nothing was even asked.
    expect(await subscriptions.loadSubscriptions(META, WALLET)).toEqual({
      records: [],
      staleWorker: false,
    });
    expect(await handoffs.loadHandoffs(META, WALLET)).toEqual({ records: [], staleWorker: false });
    expect(await shieldClient.loadPayouts(META, WALLET)).toEqual({
      records: [],
      staleWorker: false,
    });
    expect(wire.log.join('\n')).not.toContain('poolOpenRecords');

    await subscriptions.recordSubscription(META, WALLET, subRec('vault-a', 1_000));
    await handoffs.recordHandoff(META, WALLET, HREC);
    await shieldClient.recordPayout(META, WALLET, REC);
    await shieldClient.recordSpentNote(META, WALLET, `${POOL_58}:57`);

    // POPULATED, current worker: records read, no flag.
    expect((await subscriptions.loadSubscriptions(META, WALLET)).staleWorker).toBe(false);
    expect((await handoffs.loadHandoffs(META, WALLET)).records).toEqual([HREC]);
    expect((await shieldClient.loadPayouts(META, WALLET)).records).toEqual([REC]);

    // SKEWED: the same store read through an older worker. The records really
    // are unreadable from this tab — what changed is that the readers now SAY
    // so instead of serving the emptiness as truth.
    skew.strip = ['subscriptions', 'handoffs', 'payouts', 'spentKeys'];
    const subs = await subscriptions.loadSubscriptions(META, WALLET);
    expect(subs).toEqual({ records: [], staleWorker: true });
    expect(await handoffs.loadHandoffs(META, WALLET)).toEqual({ records: [], staleWorker: true });
    expect((await shieldClient.loadPayouts(META, WALLET)).staleWorker).toBe(true);
    const spent = await shieldClient.knownSpentNoteKeys(META, WALLET);
    expect(spent.staleWorker).toBe(true);

    // HEALED (the reload): the same blobs, a current worker, everything back.
    // This is what makes the notice's "your records are intact" sentence true.
    skew.strip = [];
    expect(
      (await subscriptions.loadSubscriptions(META, WALLET)).records.map((r) => r.vaultPDA),
    ).toEqual(['vault-a']);
    expect((await handoffs.loadHandoffs(META, WALLET)).records).toEqual([HREC]);
    expect((await shieldClient.loadPayouts(META, WALLET)).records).toEqual([REC]);
    expect((await shieldClient.knownSpentNoteKeys(META, WALLET)).keys.has(`${POOL_58}:57`)).toBe(
      true,
    );
  });

  it('detects skew PER KIND: a worker missing only subscriptions flags only that store', async () => {
    await subscriptions.recordSubscription(META, WALLET, subRec('vault-a', 1_000));
    await shieldClient.recordPayout(META, WALLET, REC);
    skew.strip = ['subscriptions'];
    expect((await subscriptions.loadSubscriptions(META, WALLET)).staleWorker).toBe(true);
    // The linkage stores opened fine — no false alarm on the payout list.
    expect(await shieldClient.loadPayouts(META, WALLET)).toEqual({
      records: [REC],
      staleWorker: false,
    });
    // knownSpentNoteKeys unions both stores, so the subscription skew flags it
    // while the payout-derived key still contributes.
    const view = await shieldClient.knownSpentNoteKeys(META, WALLET);
    expect(view.staleWorker).toBe(true);
    expect(view.keys.has(`${REC.pool}:${REC.leafIndex}`)).toBe(true);
  });

  it('recordSubscription against a skewed worker APPENDS — it must not destroy the store', async () => {
    await subscriptions.recordSubscription(META, WALLET, subRec('vault-a', 1_000));

    // The old behaviour rewrote the bucket from the skew-empty snapshot,
    // leaving only vault-b. The guard appends instead.
    skew.strip = ['subscriptions'];
    await subscriptions.recordSubscription(META, WALLET, subRec('vault-b', 2_000));
    // Replace-under-skew: re-recording vault-a appends a newer copy; the read
    // side keeps the LAST record per vault, so the replacement still lands.
    await subscriptions.recordSubscription(META, WALLET, subRec('vault-a', 3_000, 'Renamed'));

    skew.strip = [];
    const { records } = await subscriptions.loadSubscriptions(META, WALLET);
    expect(records.map((r) => r.vaultPDA).sort()).toEqual(['vault-a', 'vault-b']);
    expect(records.find((r) => r.vaultPDA === 'vault-a')!.serviceName).toBe('Renamed');
  });

  it('forgetSubscription against a skewed worker refuses the rewrite', async () => {
    await subscriptions.recordSubscription(META, WALLET, subRec('vault-a', 1_000));
    await subscriptions.recordSubscription(META, WALLET, subRec('vault-b', 2_000));

    skew.strip = ['subscriptions'];
    await subscriptions.forgetSubscription(META, WALLET, 'vault-a');

    // Nothing removed and, crucially, nothing destroyed: the forget is one
    // click away in a reloaded tab, the records are not recoverable at all.
    skew.strip = [];
    expect(
      (await subscriptions.loadSubscriptions(META, WALLET)).records.map((r) => r.vaultPDA).sort(),
    ).toEqual(['vault-a', 'vault-b']);
  });

  it('forgetHandoff against a skewed worker refuses the rewrite', async () => {
    await handoffs.recordHandoff(META, WALLET, HREC);
    await handoffs.recordHandoff(META, WALLET, HREC2);

    skew.strip = ['handoffs'];
    await handoffs.forgetHandoff(META, WALLET, HREC.pool, HREC.leafIndex);

    // The old rewrite deleted the whole label here (empty `keep` plus empty
    // tail) — every double-promise guard gone at once. Both must survive.
    skew.strip = [];
    const { records } = await handoffs.loadHandoffs(META, WALLET);
    expect(records.map((r) => r.leafIndex).sort()).toEqual([57, 58]);
  });
});

describe('the pool seed never reaches the main thread', () => {
  it('no message crossing the worker seam carries the seed in any encoding', async () => {
    await shieldClient.recordPayout(META, WALLET, REC);
    await shieldClient.recordSpentNote(META, WALLET, `${REC.pool}:${REC.leafIndex}`);
    await shieldClient.loadPayouts(META, WALLET);
    await shieldClient.knownSpentNoteKeys(META, WALLET);

    const traffic = wire.log.join('\n');
    // POSITIVE CONTROLS: the log really is the traffic. The sealed blobs cross
    // (that is the design), and so does the record plaintext coming BACK from
    // the worker — payout records are UI data; the SEED is the boundary.
    expect(traffic).toContain('poolOpenRecords');
    expect(traffic).toContain('p01enc1:');
    expect(traffic).toContain(REC.address);

    for (const secret of [SEED, SIGNATURE]) {
      expect(traffic).not.toContain(bytesToHex(secret));
      expect(traffic).not.toContain(Buffer.from(secret).toString('base64'));
      expect(traffic).not.toContain(JSON.stringify(Array.from(secret)));
    }
  });

  it('the store label is opaque: derived one-way, never the wallet or the seed', async () => {
    const res = await handlePoolRequest({ kind: 'poolStoreLabel', meta: META });
    expect(res.label).toMatch(/^[0-9a-f]{32}$/);
    expect(res.label).not.toBe(bytesToHex(SEED).slice(0, 32));
    expect(res.label).not.toContain(WALLET);
    // Stable: the stores must resolve to the same bucket every session.
    expect((await handlePoolRequest({ kind: 'poolStoreLabel', meta: META })).label).toBe(
      res.label,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. The notes-changed announcement
// ---------------------------------------------------------------------------

describe('storeEncryptedNote announces the write', () => {
  it('dispatches NOTES_CHANGED_EVENT on the sealed path AND the v1 fallback', async () => {
    // Node has no `window`; give the announcer one for this test. Deliberately
    // NOT vi.stubGlobal: unstubAllGlobals would also tear down the
    // localStorage stub the whole file runs on.
    const target = new EventTarget();
    let fired = 0;
    target.addEventListener(shieldClient.NOTES_CHANGED_EVENT, () => {
      fired += 1;
    });
    (globalThis as { window?: EventTarget }).window = target;
    try {
      // Sealed path: META has seeds (beforeEach), the blob lands in v2.
      await shieldClient.storeEncryptedNote(META, WALLET, 'p01enc1:announced-blob');
      expect(fired).toBe(1);

      // Fallback path: no seeds for this meta, the blob lands in v1. The event
      // fires regardless of which store took the write, because the listener
      // (PoolPanel's backup count) re-reads through `loadEncryptedNotes`,
      // which unions both — a received note that fell back must still count.
      await shieldClient.storeEncryptedNote('meta-without-seeds-announce', WALLET, 'p01enc1:v1-blob');
      expect(fired).toBe(2);
    } finally {
      delete (globalThis as { window?: EventTarget }).window;
    }
  });
});
