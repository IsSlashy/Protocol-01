/**
 * recoverReads — what one Recover click tells the RPC (RECOVER-1, ledger rows D3 and D1).
 *
 * Run: cd apps/web && npx vitest run --config vitest.pool.config.mts lib/privacy/pool/recoverReads.test.ts
 *
 * THE ADVERSARY is the RPC provider (Helius, `CONSTRAINTS.md`): it sees every
 * account this browser reads, from which address, and later sees every spend.
 * A withdrawal, an exchange and a subscription are paid by an ephemeral derived
 * from (pool seed, pool, leaf of the note SPENT) (`deriveUnshieldEphemeral`;
 * `subscribeEphemeral.ts` reuses it). A note never spent has no such account on
 * chain yet, so reading that ephemeral, or a proof-buffer address derived from
 * it, names the key that will pay for the note's spend before the spend exists.
 * Recover used to do that for every held note (the note list) and for every
 * leaf near the tree head (the window): one click handed over the future payer
 * of every note the user holds.
 *
 * WHAT THE DEFAULT RECOVER MAY READ NOW:
 *   - the shield window near the head (deposit side, unchanged);
 *   - the spend key of a note this browser marked: a spent mark
 *     (`recordSpentNote`, a payout, a subscription) or a spend attempt, written
 *     into the same sealed store BEFORE the ephemeral is funded. That key has
 *     already touched the chain from this browser.
 * "Check every note" keeps the old list, on its own labelled click.
 *
 * HOW. The worker is real (`handlePoolRequest` behind the `poolRequest` seam),
 * the recovery is real (`recoverStuckFloat`), and the RPC is a recording fetch
 * under the worker's own Connection (`createPacedFetch` is the seam): every
 * JSON-RPC request that Connection would send is logged, method and params.
 * Pinned: the tree head (`readTreeLeafCount`), the buffer close (a recorder),
 * and, in the spend flows, the worker's prepare and the funding step, which are
 * what the flows are built around and not what is under test.
 *
 * TWO DETECTORS, because one is not enough (`wp-logs/PROTOCOL.md`):
 *   1. NAMES. For every untouched note: its ephemeral under every seed the
 *      worker searches, and every buffer address derived from that key (PDA and
 *      derived keypair, circuits 1-8, attempts 0-2). None may appear in any
 *      request. This is the detector that catches a read made whatever the user
 *      holds: the window derived the spend key of every leaf near the head.
 *   2. WORLDS. The same click in worlds that differ only in which leaves the
 *      untouched notes occupy. The request log must be byte-identical; the
 *      determinism case runs first, so an unseeded draw cannot hide a join.
 * Each carries a positive control: the marked note's key IS read, and "Check
 * every note" DOES read the untouched ones and moves the log between worlds.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, type Connection, type Transaction } from '@solana/web3.js';

import { derivePoolSeeds, seedsInSearchOrder } from './seedDerivation';
import { findPoolV3 } from './denominatedPool';
import { deriveUnshieldEphemeral } from './unshieldEphemeral';
import { deriveShieldEphemeral } from './shieldEphemeral';
import { deriveProofBufferKeypair, getProofBufferPDA } from './stark';

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** Every JSON-RPC request the worker's Connection sent: method and params, in order. */
const rpc = vi.hoisted(() => ({
  log: [] as string[],
  /** getAccountInfo answers, by address; everything else reads as absent. */
  accounts: new Map<string, unknown>(),
}));

/** Buffers the recovery closed, by address. */
const closed = vi.hoisted(() => ({ list: [] as string[] }));

/** Worker kinds answered by a stub instead of the real handler. */
const seam = vi.hoisted(() => ({
  stubs: new Map<string, (req: Record<string, unknown>) => unknown>(),
  /** Every request kind that crossed the seam, in order. */
  kinds: [] as string[],
}));

/** The funding step: what it saw when called. */
const funding = vi.hoisted(() => ({
  calls: 0,
  /** Run when the funding step is reached, before it fails. */
  onCall: null as null | (() => void),
  /** What the funding step throws; the default is the failure that strands float. */
  error: null as null | (() => Error),
}));

vi.mock('../worker/pacedFetch', () => ({
  createPacedFetch: () => async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    const one = (r: { id: unknown; method: string; params?: unknown[] }) => {
      rpc.log.push(JSON.stringify({ method: r.method, params: r.params ?? [] }));
      const addr = Array.isArray(r.params) && typeof r.params[0] === 'string' ? r.params[0] : '';
      switch (r.method) {
        case 'getAccountInfo':
          return {
            jsonrpc: '2.0',
            id: r.id,
            result: { context: { slot: 1 }, value: rpc.accounts.get(addr) ?? null },
          };
        case 'getBalance':
          return { jsonrpc: '2.0', id: r.id, result: { context: { slot: 1 }, value: 0 } };
        default:
          return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: `not stubbed: ${r.method}` } };
      }
    };
    const out = Array.isArray(body) ? body.map(one) : one(body);
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
}));

vi.mock('./shieldEphemeral', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./shieldEphemeral')>()),
  readTreeLeafCount: vi.fn(async () => HEAD),
}));

vi.mock('./stark', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./stark')>()),
  closeStarkProofBuffer: vi.fn(async (address: PublicKey) => {
    closed.list.push(address.toBase58());
    return 'CLOSESIG';
  }),
}));

vi.mock('./ephemeralFunder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ephemeralFunder')>()),
  // The failure that strands float: the transfer went out, the confirmation
  // did not come back. Whatever runs after this line never runs.
  fundEphemeralForJob: vi.fn(async () => {
    funding.calls += 1;
    funding.onCall?.();
    throw funding.error?.() ?? new Error('the funding transfer was sent; its confirmation timed out');
  }),
}));

vi.mock('../workerClient', async () => {
  const { handlePoolRequest } = await import('../worker/poolHandlers');
  return {
    poolRequest: async (req: Record<string, unknown>, onProgress?: (step: string) => void) => {
      seam.kinds.push(String(req.kind));
      const stub = seam.stubs.get(String(req.kind));
      if (stub) return stub(req);
      return handlePoolRequest(req as never, onProgress);
    },
  };
});

const shieldClient = await import('../shieldClient');
const { resetFunderPubkeyCache } = await import('./ephemeralFunder');
const { clearPoolState, configurePoolHandlers, setPoolSeed } = await import('../worker/poolHandlers');

// ---------------------------------------------------------------------------
// localStorage (node has none): a Map with the Storage surface, plus a dump
// and a restore for the crash simulation.
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
    dump: () => [...m.entries()],
    restore: (entries: Array<[string, string]>) => {
      m.clear();
      for (const [k, v] of entries) m.set(k, v);
    },
  };
}
const ls = makeLocalStorage();
vi.stubGlobal('localStorage', ls);

// The deployment's GET endpoints the flows read before spending. The RPC does
// not go through here: the worker's Connection has its own fetch (above).
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
vi.stubGlobal('fetch', async (url: unknown) => {
  const u = String(url);
  if (u.includes('/api/fund-ephemeral')) return json({ ok: true, configured: false, funder: null });
  if (u.includes('/api/claim-for-payment')) {
    return json({ ok: true, configured: true, till: TILL.toBase58(), priceLamports: 0, reasons: [] });
  }
  if (u.includes('/api/issue-note')) return json({ ok: true, configured: true, denomination: DENOM, token: 'SOL' });
  throw new Error(`unexpected fetch ${u}`);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIGNATURE = new Uint8Array(64);
for (let i = 0; i < 64; i++) SIGNATURE[i] = (i * 11 + 5) & 0xff;
const PASSPHRASE = 'recover reads passphrase';

const META = 'meta-recover-reads';
const META_ARMED = 'meta-recover-reads-armed';
const OWNER = Keypair.fromSeed(new Uint8Array(32).fill(21)).publicKey;
const WALLET = OWNER.toBase58();
const RECIPIENT = Keypair.fromSeed(new Uint8Array(32).fill(22)).publicKey;
const RETAILER = Keypair.fromSeed(new Uint8Array(32).fill(23)).publicKey;
const TILL = Keypair.fromSeed(new Uint8Array(32).fill(24)).publicKey;

const DENOM = 1;
const POOL = findPoolV3('SOL', DENOM)!.poolPDA;
const POOL_58 = POOL.toBase58();
/** The tree head. Leaf 5 sits inside the shield window (HEAD-12..HEAD). */
const HEAD = 10;

/** The note with a mark, and two notes never touched: one near the head, one far below. */
const MARKED = 50;
const NEAR = 5;
const FAR = 400;

const LEGACY_SEEDS = seedsInSearchOrder(derivePoolSeeds(SIGNATURE)).map((c) => c.seed);

/** Circuits 1-8, attempts 0-2: every buffer address a key can own, not only today's. */
function keyNames(ephemeral: PublicKey): string[] {
  const out = [ephemeral.toBase58()];
  for (let circuit = 1; circuit <= 8; circuit++) {
    out.push(getProofBufferPDA(ephemeral, circuit)[0].toBase58());
    for (let attempt = 0; attempt <= 2; attempt++) {
      out.push(deriveProofBufferKeypair(ephemeral, circuit, attempt).publicKey.toBase58());
    }
  }
  return out;
}

/** The spend key of the note at `leaf`, under each seed, with every address derived from it. */
function spendKeyNames(seeds: Uint8Array[], leaf: number): string[] {
  return seeds.flatMap((seed) => keyNames(deriveUnshieldEphemeral(seed, POOL, leaf).publicKey));
}

/** The addresses today's recovery probes for the spend key at `leaf`: the key and its C1/C3 buffers. */
function probedToday(seed: Uint8Array, leaf: number): string[] {
  const e = deriveUnshieldEphemeral(seed, POOL, leaf).publicKey;
  return [
    e.toBase58(),
    ...[1, 3].flatMap((c) => [
      getProofBufferPDA(e, c)[0].toBase58(),
      deriveProofBufferKeypair(e, c).publicKey.toBase58(),
    ]),
  ];
}

/** Every string anywhere in the params of every recorded request. */
function namedByRpc(): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const line of rpc.log) walk(JSON.parse(line));
  return out;
}

function hits(names: string[]): string[] {
  const named = namedByRpc();
  return names.filter((n) => named.has(n));
}

const fakeMainConnection = {} as Connection;
const signOne = async (tx: Transaction) => tx;

/** A fresh browser: empty storage, seeds derived, worker pointed at the recorder. */
function freshBrowser(meta = META, passphrase?: string) {
  ls.clear();
  clearPoolState();
  setPoolSeed(meta, SIGNATURE, passphrase);
  configurePoolHandlers('http://recorder.invalid');
  resetFunderPubkeyCache();
  rpc.log.length = 0;
  rpc.accounts.clear();
  closed.list.length = 0;
  seam.stubs.clear();
  seam.kinds.length = 0;
  funding.calls = 0;
  funding.onCall = null;
  funding.error = null;
}

/** What Recover names, from a clean log. */
async function recover(leaves: number[], opts?: { everyNote?: boolean }, meta = META) {
  rpc.log.length = 0;
  // The 6th argument does not exist before RECOVER-1 and is ignored there.
  const call = shieldClient.recoverStuckFunds as unknown as (
    ...args: unknown[]
  ) => ReturnType<typeof shieldClient.recoverStuckFunds>;
  return call(meta, DENOM, OWNER, undefined, leaves, ...(opts ? [opts] : []));
}

/** The prepare a real worker would answer, naming the spend key of `leaf`. */
function stubPrepare(kind: 'poolUnshieldPrepare' | 'poolSubscribePrepare', leaf: number) {
  seam.stubs.set(kind, () => ({
    kind,
    jobId: `${kind}:job`,
    ephemeralPubkey: deriveUnshieldEphemeral(LEGACY_SEEDS[0]!, POOL, leaf).publicKey.toBase58(),
    requiredLamports: 1_100_000_000,
    denomination: DENOM,
    derivation: 1,
    version: 'v4',
    noteProvenance: 'received',
  }));
}

/**
 * The browser as it was when the funding step was reached. A tab closed
 * there, reopened later, is what a Recover click finds.
 */
let atFunding: Array<[string, string]> | null = null;
function snapshotAtFunding() {
  atFunding = null;
  funding.onCall = () => {
    atFunding = ls.dump();
  };
}

beforeEach(() => {
  freshBrowser();
  atFunding = null;
});

// ---------------------------------------------------------------------------
// 1. The default click
// ---------------------------------------------------------------------------

describe('default Recover names no untouched note’s spend key', () => {
  it('default Recover names no untouched note’s spend key', async () => {
    // Three held notes; only MARKED has a mark (a spent record, today's API).
    await shieldClient.recordSpentNote(META, WALLET, `${POOL_58}:${MARKED}`);
    await recover([NEAR, MARKED, FAR]);

    // Positive controls: the recorder sees the recovery's reads, and the
    // marked note's key and its buffers ARE read.
    expect(hits([deriveShieldEphemeral(LEGACY_SEEDS[0]!, POOL, HEAD).publicKey.toBase58()])).toHaveLength(1);
    const marked = probedToday(LEGACY_SEEDS[0]!, MARKED);
    expect(hits(marked)).toEqual(marked);

    // The untouched notes: nothing that names the key that will pay for them.
    expect(hits(spendKeyNames(LEGACY_SEEDS, NEAR)), 'the note near the head').toEqual([]);
    expect(hits(spendKeyNames(LEGACY_SEEDS, FAR)), 'the note far below the head').toEqual([]);

    // "Check every note" keeps today's list: all three are read.
    await recover([NEAR, MARKED, FAR], { everyNote: true });
    for (const leaf of [NEAR, MARKED, FAR]) {
      const probed = probedToday(LEGACY_SEEDS[0]!, leaf);
      expect(hits(probed), `deep check, leaf ${leaf}`).toEqual(probed);
    }
  });

  it('the default Recover says how many held notes it left unchecked', async () => {
    await shieldClient.recordSpentNote(META, WALLET, `${POOL_58}:${MARKED}`);
    const res = (await recover([NEAR, MARKED, FAR])) as { skippedNotes?: number };
    expect(res.skippedNotes).toBe(2);
    const deep = (await recover([NEAR, MARKED, FAR], { everyNote: true })) as { skippedNotes?: number };
    expect(deep.skippedNotes ?? 0).toBe(0);
  });

  it('only a literal `everyNote: true` reads every note: a click event passed by mistake does not', async () => {
    // `onClick={handleRecover}` hands the handler a MouseEvent; if that ever
    // reached here it must not read as the user's consent.
    await shieldClient.recordSpentNote(META, WALLET, `${POOL_58}:${MARKED}`);
    await recover([NEAR, MARKED, FAR], { everyNote: { type: 'click' } as unknown as boolean });
    const marked = probedToday(LEGACY_SEEDS[0]!, MARKED);
    expect(hits(marked)).toEqual(marked);
    expect(hits(spendKeyNames(LEGACY_SEEDS, NEAR))).toEqual([]);
    expect(hits(spendKeyNames(LEGACY_SEEDS, FAR))).toEqual([]);
  });

  it('a mark store the worker cannot open reads no spend key, and says every note went unchecked', async () => {
    await shieldClient.recordSpentNote(META, WALLET, `${POOL_58}:${MARKED}`);
    seam.stubs.set('poolOpenRecords', () => {
      throw new Error('No pool keys for this identity. Reconnect and sign to derive.');
    });
    const res = (await recover([NEAR, MARKED, FAR])) as { skippedNotes?: number };
    for (const leaf of [NEAR, MARKED, FAR]) {
      expect(hits(spendKeyNames(LEGACY_SEEDS, leaf)), `leaf ${leaf}`).toEqual([]);
    }
    expect(res.skippedNotes).toBe(3);
    // Positive control: the recovery itself still ran (the shield window).
    expect(hits([deriveShieldEphemeral(LEGACY_SEEDS[0]!, POOL, HEAD).publicKey.toBase58()])).toHaveLength(1);
  });

  it('one Recover click over every pool opens the mark store once', async () => {
    // The panel runs the pools in parallel, and each mark read opens every
    // sealed record in the worker.
    await shieldClient.recordSpentNote(META, WALLET, `${POOL_58}:${MARKED}`);
    const opens = () => seam.kinds.filter((k) => k === 'poolOpenRecords').length;
    seam.kinds.length = 0;
    await recover([NEAR, MARKED, FAR]);
    const onePool = opens();
    expect(onePool).toBeGreaterThan(0);
    seam.kinds.length = 0;
    const call = shieldClient.recoverStuckFunds as unknown as (...args: unknown[]) => Promise<unknown>;
    await Promise.all(
      [1, 2, 3, 4, 5, 6].map(() => call(META, DENOM, OWNER, undefined, [NEAR, MARKED, FAR])),
    );
    expect(opens()).toBe(onePool);
    // A settled read is not reused: the next click reads again.
    seam.kinds.length = 0;
    await recover([NEAR, MARKED, FAR]);
    expect(opens()).toBe(onePool);
  });

  it('with a passphrase armed, no derivation’s key of an untouched note is read', async () => {
    freshBrowser(META_ARMED, PASSPHRASE);
    const seeds = seedsInSearchOrder(derivePoolSeeds(SIGNATURE, PASSPHRASE)).map((c) => c.seed);
    expect(seeds).toHaveLength(2);
    await shieldClient.recordSpentNote(META_ARMED, WALLET, `${POOL_58}:${MARKED}`);
    await recover([NEAR, MARKED, FAR], undefined, META_ARMED);
    // Positive control: the marked note is read under BOTH derivations.
    for (const seed of seeds) {
      const marked = probedToday(seed, MARKED);
      expect(hits(marked)).toEqual(marked);
    }
    expect(hits(spendKeyNames(seeds, NEAR))).toEqual([]);
    expect(hits(spendKeyNames(seeds, FAR))).toEqual([]);
  });
});

describe('the default click does not move with the untouched notes', () => {
  /** One world: a fresh browser holding MARKED plus two untouched notes. */
  async function world(untouched: [number, number], opts?: { everyNote?: boolean }): Promise<string[]> {
    freshBrowser();
    await shieldClient.recordSpentNote(META, WALLET, `${POOL_58}:${MARKED}`);
    await recover([untouched[0], MARKED, untouched[1]], opts);
    return [...rpc.log];
  }

  it('the same world twice sends byte-identical requests (determinism)', async () => {
    const base = await world([NEAR, FAR]);
    const again = await world([NEAR, FAR]);
    expect(base.length).toBeGreaterThan(0);
    expect(again).toEqual(base);
  });

  it('moving the untouched notes to other leaves changes no request', async () => {
    // Positive control first: the deep check DOES move with them.
    const deepBase = await world([NEAR, FAR], { everyNote: true });
    const deepOther = await world([7, 900], { everyNote: true });
    expect(deepOther).not.toEqual(deepBase);

    const base = await world([NEAR, FAR]);
    const other = await world([7, 900]);
    expect(other).toEqual(base);
  });
});

// ---------------------------------------------------------------------------
// 2. A spend attempt is marked before its ephemeral is funded
// ---------------------------------------------------------------------------

describe('a spend attempt is marked before its ephemeral is funded', () => {
  /** Recover in the browser as it stood when funding began; returns what it names. */
  async function recoverFromFundingMoment() {
    expect(funding.calls).toBe(1);
    expect(atFunding).not.toBeNull();
    ls.restore(atFunding!);
    await recover([NEAR, FAR]);
    return {
      attempted: hits(probedToday(LEGACY_SEEDS[0]!, FAR)),
      untouched: hits(spendKeyNames(LEGACY_SEEDS, NEAR)),
    };
  }

  it('withdrawal: a funding that failed after sending leaves a key the default Recover reads', async () => {
    stubPrepare('poolUnshieldPrepare', FAR);
    snapshotAtFunding();
    await expect(
      shieldClient.unshieldFromPool({
        meta: META,
        token: 'SOL',
        denomination: DENOM,
        leafIndex: FAR,
        recipient: RECIPIENT,
        owner: OWNER,
        connection: fakeMainConnection,
        signOne,
      }),
    ).rejects.toThrow(/confirmation timed out/);
    const seen = await recoverFromFundingMoment();
    expect(seen.attempted).toEqual(probedToday(LEGACY_SEEDS[0]!, FAR));
    expect(seen.untouched).toEqual([]);
  });

  it('subscription: a funding that failed after sending leaves a key the default Recover reads', async () => {
    stubPrepare('poolSubscribePrepare', FAR);
    snapshotAtFunding();
    await expect(
      shieldClient.subscribeFromPool({
        meta: META,
        token: 'SOL',
        denomination: DENOM,
        leafIndex: FAR,
        retailer: RETAILER,
        rate: 1_000_000n,
        intervalSlots: 216_000n,
        owner: OWNER,
        connection: fakeMainConnection,
        signOne,
      }),
    ).rejects.toThrow(/confirmation timed out/);
    const seen = await recoverFromFundingMoment();
    expect(seen.attempted).toEqual(probedToday(LEGACY_SEEDS[0]!, FAR));
    expect(seen.untouched).toEqual([]);
  });

  it('exchange: a funding that failed after sending leaves a key the default Recover reads', async () => {
    stubPrepare('poolUnshieldPrepare', FAR);
    snapshotAtFunding();
    await expect(
      shieldClient.exchangeNoteForIssued({
        meta: META,
        token: 'SOL',
        denomination: DENOM,
        leafIndex: FAR,
        pool: POOL_58,
        owner: OWNER,
        connection: fakeMainConnection,
        signOne,
        claimRetry: { attempts: 1, delayMs: 0 },
      }),
    ).rejects.toThrow(/confirmation timed out/);
    const seen = await recoverFromFundingMoment();
    expect(seen.attempted).toEqual(probedToday(LEGACY_SEEDS[0]!, FAR));
    expect(seen.untouched).toEqual([]);
  });

  it('relayed withdrawal: it funds nothing, so it marks nothing and its key stays unnamed', async () => {
    // The relayer uploads under its own key; this browser's ephemeral never
    // touches the chain on this path, so a later read would be the first.
    stubPrepare('poolUnshieldPrepare', FAR);
    seam.stubs.set('poolUnshieldExecute', () => {
      throw new Error('the relayer refused the job');
    });
    await expect(
      shieldClient.unshieldFromPool({
        meta: META,
        token: 'SOL',
        denomination: DENOM,
        leafIndex: FAR,
        recipient: RECIPIENT,
        owner: OWNER,
        connection: fakeMainConnection,
        signOne,
        relayerUrl: 'https://relayer.invalid',
      }),
    ).rejects.toThrow(/relayer refused/);
    expect(funding.calls).toBe(0);
    await recover([NEAR, FAR]);
    expect(hits(spendKeyNames(LEGACY_SEEDS, FAR))).toEqual([]);
    expect(hits(spendKeyNames(LEGACY_SEEDS, NEAR))).toEqual([]);
  });

  it('a key stranded before marks existed is reached once a retry finds it dirty ("Run Recover first")', async () => {
    // No mark from the earlier attempt. The retry is refused by the funding
    // step's first check, on a key the page has just read; the mark it wrote
    // before that check is what makes the default Recover the cure the
    // refusal names.
    const { DirtyEphemeralError } = await import('./ephemeralFunder');
    stubPrepare('poolUnshieldPrepare', FAR);
    funding.error = () => new DirtyEphemeralError(1_030_290_360);
    await expect(
      shieldClient.unshieldFromPool({
        meta: META,
        token: 'SOL',
        denomination: DENOM,
        leafIndex: FAR,
        recipient: RECIPIENT,
        owner: OWNER,
        connection: fakeMainConnection,
        signOne,
      }),
    ).rejects.toThrow(/Run Recover first/);
    await recover([NEAR, FAR]);
    const attempted = probedToday(LEGACY_SEEDS[0]!, FAR);
    expect(hits(attempted)).toEqual(attempted);
    expect(hits(spendKeyNames(LEGACY_SEEDS, NEAR))).toEqual([]);
  });

  it('an attempt is not a spend: the note stays offered by every picker', async () => {
    stubPrepare('poolUnshieldPrepare', FAR);
    await expect(
      shieldClient.unshieldFromPool({
        meta: META,
        token: 'SOL',
        denomination: DENOM,
        leafIndex: FAR,
        recipient: RECIPIENT,
        owner: OWNER,
        connection: fakeMainConnection,
        signOne,
      }),
    ).rejects.toThrow(/confirmation timed out/);
    const { keys } = await shieldClient.knownSpentNoteKeys(META, WALLET);
    expect(keys.has(`${POOL_58}:${FAR}`)).toBe(false);
    expect([...keys].filter((k) => !/^[1-9A-HJ-NP-Za-km-z]{32,44}:\d+$/.test(k))).toEqual([]);
    // Positive control: a real spent mark IS reported.
    await shieldClient.recordSpentNote(META, WALLET, `${POOL_58}:${FAR}`);
    expect((await shieldClient.knownSpentNoteKeys(META, WALLET)).keys.has(`${POOL_58}:${FAR}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. A circuit-7 spend's proof buffer is reachable
// ---------------------------------------------------------------------------

describe('a v4 spend’s proof buffer is recovered', () => {
  it('the circuit-7 buffer a marked note’s key owns is found and closed', async () => {
    // Circuit 7 (withdrawal and subscription v4) uploads into a buffer derived
    // from the spend key (`denominatedPool.ts`, `circuitId: CIRCUIT_SPEND`), and
    // only that key can close it (`close = authority`).
    await shieldClient.recordSpentNote(META, WALLET, `${POOL_58}:${MARKED}`);
    const e = deriveUnshieldEphemeral(LEGACY_SEEDS[0]!, POOL, MARKED).publicKey;
    const c7 = deriveProofBufferKeypair(e, 7).publicKey.toBase58();
    rpc.accounts.set(c7, {
      data: ['', 'base64'],
      executable: false,
      lamports: 1_000_000_000,
      owner: PublicKey.default.toBase58(),
      rentEpoch: 0,
      space: 0,
    });
    await recover([MARKED]);
    expect(closed.list).toContain(c7);
  });
});
