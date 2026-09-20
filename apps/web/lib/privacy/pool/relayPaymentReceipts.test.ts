/**
 * relayPaymentReceipts — what the receipt for a relayed deposit leaves on disk.
 *
 * ## How to run this file
 *
 * `vitest.config.ts` only includes `__tests__/**`, so this file is picked up by
 * the pool config, whose glob is `lib/**\/*.test.ts`:
 *
 *   npx vitest run --config vitest.pool.config.mts lib/privacy/pool/relayPaymentReceipts.test.ts
 *
 * It runs in a `node` environment, which has no `localStorage`, so one is
 * installed below — the same shim `pendingContribution.test.ts` and
 * `storeEncryption.test.ts` use, and for the same reason: the module already
 * treats a missing `localStorage` as "no records", and a shim keeps the tests
 * honest about which writes actually reach storage.
 *
 * The worker is NOT stubbed. `poolRequest` routes into the real
 * `handlePoolRequest`, so a record is sealed by the real hybrid
 * X25519 + ML-KEM-768 and opened by the real envelope filter.
 *
 * ## WHAT THIS SUITE EXISTS FOR
 *
 * 🚨 SWEEP4 round 1, confirmed item 5. The receipt was written in CLEAR:
 *
 *   { ephemeralPubkey, signature, valueLamports, feeLamports,
 *     requiredLamports, till, createdAt }
 *
 * `signature` is the buyer's wallet -> till transfer, which names the wallet on
 * chain and is timestamped by the ledger. `ephemeralPubkey` is the key that
 * FUNDS THE DEPOSIT, whose commitment the pool republishes. Side by side in one
 * localStorage row, they are the (buyer, deposit) join the inventory swap
 * exists to break — readable by any extension with the `storage` permission,
 * by a device thief, and by anything that reads a profile backup. No key, no
 * chain analysis: one `JSON.parse`.
 *
 * ⛔ AND THE RULE THE FIX MUST NOT BREAK. This store is what stops a buyer
 * paying twice (its own header). A receipt that cannot be read back is a second
 * full denomination out of the buyer's wallet, so every case below that asserts
 * a leak is closed has a sibling that asserts the receipt still comes back.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Version-skew dial: `stripRelayReceipts` answers `poolOpenRecords` the way a
 * worker from before this fix does — without the `relayReceipts` array.
 * Everything else is the real handler.
 */
const skew = vi.hoisted(() => ({ stripRelayReceipts: false }));

vi.mock('../workerClient', async () => {
  const { handlePoolRequest } = await import('../worker/poolHandlers');
  return {
    poolRequest: async (req: never, onProgress?: (step: string) => void) => {
      const res = await handlePoolRequest(req, onProgress);
      if (skew.stripRelayReceipts && (res as { kind?: string }).kind === 'poolOpenRecords') {
        const aged = { ...(res as Record<string, unknown>) };
        delete aged.relayReceipts;
        return aged;
      }
      return res;
    },
  };
});

const { clearPoolState, setPoolSeed } = await import('../worker/poolHandlers');
const { StaleWorkerError, storeSession } = await import('../sealedStore');
const {
  forgetRelayPayment,
  listRelayPayments,
  recallRelayPayment,
  rememberRelayPayment,
  storageAvailable,
} = await import('./relayPaymentReceipts');

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

/** Every key and every value, as one string: what a storage dump reads. */
function rawDump(): string {
  return ls
    .dump()
    .map(([k, v]) => `${k}\n${v}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const META = 'meta-under-test';
const SIGNATURE = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff);
const OTHER_META = 'meta-somebody-else';
const OTHER_SIGNATURE = Uint8Array.from({ length: 64 }, (_, i) => (i * 13 + 1) & 0xff);

/** The depositing key. Deterministic in (seed, pool, leafIndex): the job id. */
const EPHEMERAL = 'EPHEMERALdepositingKEY11111111111111111111Aa';
const EPHEMERAL_2 = 'EPHEMERALdepositingKEY22222222222222222222Bb';
/** The buyer's wallet -> till transfer. 88 chars, on-chain length. */
const PAYSIG = '5VERYrecognizableTILLpaymentSIGNATURE'.padEnd(88, 'p');
const TILL = 'F6R1sEJNLSCNGA3GXtwpofu55XqukDdn3U9jerLtW8wE';

const RECEIPT = {
  ephemeralPubkey: EPHEMERAL,
  signature: PAYSIG,
  valueLamports: 1_003_000_000,
  feeLamports: 10_000_000,
  requiredLamports: 1_573_486_080,
  till: TILL,
  createdAt: '2026-09-20T09:41:07.123Z',
};

beforeEach(() => {
  ls.clear();
  clearPoolState();
  setPoolSeed(META, SIGNATURE);
  setPoolSeed(OTHER_META, OTHER_SIGNATURE);
  skew.stripRelayReceipts = false;
});

describe('🚨 the receipt joins the buyer to the deposit, so nothing of it is in clear', () => {
  it('leaves no payment signature, no ephemeral and no till in the dump', async () => {
    rememberRelayPayment(await storeSession(META), RECEIPT);

    const dump = rawDump();
    // The positive control: the dump is not empty, so the absences below are
    // absences and not an empty store answering everything.
    expect(dump, 'nothing was written at all').not.toBe('');
    expect(dump, 'the dump carries the till payment signature').not.toContain(PAYSIG);
    expect(dump, 'the dump carries the depositing ephemeral').not.toContain(EPHEMERAL);
    expect(dump, 'the dump carries the till the buyer paid').not.toContain(TILL);
  });

  it('leaves no lamport amount and no exact time in the dump', async () => {
    rememberRelayPayment(await storeSession(META), RECEIPT);

    const dump = rawDump();
    // 1,003,000,000 is the denomination plus the 0.3% fee: a buyer's whole
    // purchase price, and with the till payment beside it, the amount to look
    // for on chain. The ISO instant dates the transfer to the millisecond.
    expect(dump, 'the dump carries what the buyer paid').not.toContain('1003000000');
    expect(dump, 'the dump carries the relay pre-fund').not.toContain('1573486080');
    expect(dump, 'the dump dates the payment to the millisecond').not.toContain(
      RECEIPT.createdAt,
    );
  });

  it('still hands the receipt back, which is what stops the second charge', async () => {
    rememberRelayPayment(await storeSession(META), RECEIPT);

    const got = await recallRelayPayment(META, EPHEMERAL);
    expect(got, 'the receipt could not be read back; the buyer would pay twice').not.toBeNull();
    expect(got!.signature).toBe(PAYSIG);
    expect(got!.valueLamports).toBe(RECEIPT.valueLamports);
    expect(got!.feeLamports).toBe(RECEIPT.feeLamports);
    expect(got!.requiredLamports).toBe(RECEIPT.requiredLamports);
    expect(got!.till).toBe(TILL);
    expect(got!.createdAt).toBe(RECEIPT.createdAt);
  });

  it('survives a reload: nothing in memory is load-bearing', async () => {
    rememberRelayPayment(await storeSession(META), RECEIPT);

    // A page reload. The worker's seeds are gone until the wallet signs again,
    // and every module-scope cache with them.
    clearPoolState();
    setPoolSeed(META, SIGNATURE);

    const got = await recallRelayPayment(META, EPHEMERAL);
    expect(got?.signature, 'the receipt did not survive a reload').toBe(PAYSIG);
  });
});

describe('the receipt belongs to one identity', () => {
  it('is not handed to another identity on the same device', async () => {
    rememberRelayPayment(await storeSession(META), RECEIPT);

    expect(
      await recallRelayPayment(OTHER_META, EPHEMERAL),
      "another identity on this device read a receipt that is not its own",
    ).toBeNull();
    expect(
      (await listRelayPayments(OTHER_META)).length,
      'another identity listed a receipt that is not its own',
    ).toBe(0);
  });

  it('answers null for a job that has no receipt', async () => {
    rememberRelayPayment(await storeSession(META), RECEIPT);
    expect(await recallRelayPayment(META, EPHEMERAL_2)).toBeNull();
  });
});

describe('the receipt is dropped only once the lamports have moved', () => {
  it('forgets exactly the one job, leaving the other outstanding', async () => {
    const session = await storeSession(META);
    const id = rememberRelayPayment(session, RECEIPT);
    rememberRelayPayment(session, { ...RECEIPT, ephemeralPubkey: EPHEMERAL_2 });

    forgetRelayPayment(id);

    expect(await recallRelayPayment(META, EPHEMERAL)).toBeNull();
    expect(
      (await recallRelayPayment(META, EPHEMERAL_2))?.signature,
      'forgetting one job dropped the other',
    ).toBe(PAYSIG);
  });

  /**
   * ⚠️ THIS CASE CHANGED WITH THE FIX, AND HERE IS WHY.
   *
   * The clear store de-duplicated on WRITE: `rememberRelayPayment` filtered the
   * list by `ephemeralPubkey`, so one job held one receipt. The sealed store
   * cannot do that without opening every body, and the id that would make it
   * possible without opening — a hash of (label, ephemeralPubkey) — is exactly
   * the join the fix removes: the label is in the clear index and every
   * deposit's fee payer is public on chain, so a dump holder could confirm the
   * pair by hashing.
   *
   * So the property moved rather than weakened. Two bodies for one job may
   * coexist; NEITHER is dropped, because each names money that left a wallet,
   * and `recallRelayPayment` answers with the newest — the one the relay will
   * accept. The old case asserted the storage layout; this one asserts the
   * outcome the buyer feels.
   */
  it('answers with the newest payment for a job, and drops neither', async () => {
    const session = await storeSession(META);
    const SECOND = 'SECONDpaymentSIGNATURE'.padEnd(88, 'q');
    rememberRelayPayment(session, RECEIPT);
    rememberRelayPayment(session, {
      ...RECEIPT,
      signature: SECOND,
      createdAt: '2026-09-20T09:44:11.500Z',
    });

    expect(
      (await recallRelayPayment(META, EPHEMERAL))?.signature,
      'the retry would be shown a payment the relay has already refused',
    ).toBe(SECOND);
    expect(
      (await listRelayPayments(META)).map((r) => r.signature).sort(),
      'a receipt naming money that left a wallet was dropped',
    ).toEqual([SECOND, PAYSIG].sort());
  });
});

describe('what an older worker and an older build leave behind', () => {
  it('refuses rather than reporting "no payment" when the worker predates the kind', async () => {
    rememberRelayPayment(await storeSession(META), RECEIPT);

    // A tab left open across a deploy: a newer page, an older worker, which
    // answers `poolOpenRecords` without the array it has never heard of.
    skew.stripRelayReceipts = true;
    await expect(
      recallRelayPayment(META, EPHEMERAL),
      'an older worker answered "no payment outstanding", which is a second charge',
    ).rejects.toThrow(StaleWorkerError);
  });

  it('still reads a clear row an earlier build wrote, and can drop it', async () => {
    // ⛔ Money safety before leak closure: a v1 row is a payment that already
    // left a wallet, and nothing in it says whose identity it belongs to. It
    // stays readable (see the module header) until the job it names is done.
    localStorage.setItem('p01_relay_payment_receipts_v1', JSON.stringify([RECEIPT]));

    const got = await recallRelayPayment(META, EPHEMERAL);
    expect(got?.signature, 'a receipt from an earlier build was lost').toBe(PAYSIG);

    forgetRelayPayment(got!.id);
    expect(await recallRelayPayment(META, EPHEMERAL)).toBeNull();
    expect(
      localStorage.getItem('p01_relay_payment_receipts_v1'),
      'the emptied clear store stayed behind, still advertising the old format',
    ).toBeNull();
  });

  it('never writes a new receipt into the clear store', async () => {
    rememberRelayPayment(await storeSession(META), RECEIPT);
    expect(localStorage.getItem('p01_relay_payment_receipts_v1')).toBeNull();
  });
});

describe('storageAvailable still answers before any money moves', () => {
  it('is true with a working store and false without one', () => {
    expect(storageAvailable()).toBe(true);
    const real = globalThis.localStorage;
    vi.stubGlobal('localStorage', {
      ...real,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(storageAvailable(), 'a store that throws on write reported itself usable').toBe(false);
    vi.stubGlobal('localStorage', real);
  });
});
