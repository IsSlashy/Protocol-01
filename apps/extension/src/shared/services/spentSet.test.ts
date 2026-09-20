// @vitest-environment node
//
// ⛔ NOT jsdom, which is this package's default. `PublicKey.findProgramAddressSync`
// throws "Unable to find a viable program address nonce" for EVERY input under
// jsdom here — measured 2026-09-16, `wp-logs/EXT-RPC-env-probe.log`. This file
// derives real nullifier PDAs, so it needs node. The subscribe screen's twin of
// these assertions renders React and therefore stays in jsdom with the
// derivation faked: `popup/pages/CreateSubscription.test.tsx`.
/**
 * WHAT THIS CLIENT ASKS THE RPC ABOUT A NOTE — the answer must be "nothing".
 *
 * 🚨 THE CHANNEL. A note's nullifier is secret until its spend publishes it, so
 * a request naming that note's nullifier PDA is a promise about the future: the
 * account does not exist yet, and when it is finally created by a withdrawal,
 * whoever served the earlier request can join the two and recover the device
 * that asked. Nothing has to be broken for this to work, and an honest relayer
 * does not prevent it — on the relayed route the spend arrives from a different
 * IP, which makes that join the ONLY thing tying the withdrawal to the wallet.
 *
 * Two places on this surface were doing exactly that (both re-read 2026-09-16):
 *   - `CreateSubscription.tsx:390-415` batched a `getMultipleAccountsInfo` over
 *     EVERY stored note's PDA on mount — a popup open named the lot;
 *   - `store/denominatedPool.ts:727` asked `getAccountInfo` for one PDA
 *     immediately before the withdrawal it belongs to;
 *   - `services/subscriptionVault.ts:977` (`subscribePrivate`) asked the same
 *     `getAccountInfo` seconds before a subscribe, whose v4 send goes through
 *     the same relayer-or-direct `signSendV3` as the withdrawal (fix round 1,
 *     section 5 below).
 *
 * ⛔ HOW THIS FILE MEASURES IT, AND WHY NOT BY METHOD NAME. Asserting
 * "`getMultipleAccountsInfo` was not called" pins one spelling of the mistake
 * and walks past `getAccountInfo`, `getMultipleAccounts`, a
 * `getProgramAccounts` filtered on a nullifier, or an account the caller reads
 * for some other reason. So the connection here is a RECORDER: every method,
 * every argument. The assertion walks the recorded arguments and asks whether
 * any VALUE derived from a note appears — the PDA, the nullifier bytes, the
 * commitment — whatever method carried it. `the detector flags a note-naming
 * read` is its positive control.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';

/**
 * chrome.storage, installed ABOVE the import graph.
 *
 * ⛔ THE NOTE STORE HYDRATES AT MODULE LOAD, through `shared/storage.ts`. In
 * the node environment there is no `chrome` (the setup file mocks it only for
 * jsdom) and no `localStorage` — Node 26 leaves it undefined unless
 * --localstorage-file is passed, the same effect the baseline records for the
 * ErrorBoundary test. Without this, zustand persist rejects with "Cannot read
 * properties of undefined (reading 'setItem')" and vitest marks the FILE
 * failed however the assertions went.
 */
vi.hoisted(() => {
  const area = () => {
    const mem: Record<string, unknown> = {};
    return {
      get: async (k: string) => ({ [k]: mem[k] }),
      set: async (items: Record<string, unknown>) => { Object.assign(mem, items); },
      remove: async (k: string) => { delete mem[k]; },
      clear: async () => { for (const k of Object.keys(mem)) delete mem[k]; },
    };
  };
  (globalThis as unknown as Record<string, unknown>).chrome = {
    storage: { local: area(), session: area(), sync: area() },
    runtime: {
      id: 'test',
      getURL: (p: string) => p,
      sendMessage: async () => {},
      onMessage: { addListener: () => {}, removeListener: () => {} },
    },
  };
});

/**
 * The connection the STORE gets. Hoisted because `vi.mock` is hoisted above
 * the imports, and each test installs its own recorder.
 */
const h = vi.hoisted(() => ({
  conn: null as unknown,
  prepareUnshield: vi.fn(),
  unshieldDenominatedStarkV3: vi.fn(),
  prepareUnshieldV4: vi.fn(),
  unshieldDenominatedStarkV4: vi.fn(),
  prepareSubscribeV4: vi.fn(),
  saveSecret: vi.fn(),
}));

/**
 * ⚠️ SPREAD THE REAL MODULE AND OVERRIDE ONLY THE FOUR THINGS THAT PROVE OR
 * SPEND. Every read the pool module makes is left REAL, and that is the whole
 * point: the per-note `isNullifierSpent` it exported until fix round 1 reached
 * the recorder below from the store and from `subscribePrivate`, and the
 * detector saw the note being named (both reds: wp-logs/EXT-RPC-r0-red.log,
 * wp-logs/EXT-RPC-red.log). Mocking a read would make the red vanish and leave
 * a test that passes on the leaking code.
 */
vi.mock('./denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./denominatedPool')>();
  return {
    ...actual,
    prepareUnshield: h.prepareUnshield,
    unshieldDenominatedStarkV3: h.unshieldDenominatedStarkV3,
    prepareUnshieldV4: h.prepareUnshieldV4,
    unshieldDenominatedStarkV4: h.unshieldDenominatedStarkV4,
  };
});

/**
 * The subscribe service (section 5). Only the circuit-7 prepare is replaced, and
 * it stops the flow with a sentinel: reaching it is the proof that the
 * pre-flight let the note through. The subscriber-secret store is replaced so
 * that "nothing was saved before the refusal" can be read.
 */
vi.mock('./subscribePrivateStarkV4', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./subscribePrivateStarkV4')>();
  return { ...actual, prepareSubscribeV4: h.prepareSubscribeV4 };
});
vi.mock('../store/subscriptionVault', () => ({
  useSubscriptionVaultStore: { getState: () => ({ saveSecret: h.saveSecret }) },
}));

vi.mock('./wallet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./wallet')>();
  return { ...actual, getConnection: () => h.conn };
});

import {
  fetchSpentNullifierSet,
  isNullifierSpentInSet,
  clearSpentNullifierSetCache,
  NULLIFIER_RECORD_LEN,
  NULLIFIER_RECORD_POOL_OFFSET,
  SPENT_SET_TTL_MS,
} from './spentSet';
import {
  ZK_SHIELDED_PROGRAM_ID,
  createNullifierV3,
  deriveNullifierPDA,
  goldilocksU64To32,
  findPoolV3,
  type PoolConfig,
} from './denominatedPool';
import { subscribePrivate } from './subscriptionVault';
import { useDenominatedPoolStore } from '../store/denominatedPool';
import { useWalletStore } from '../store/wallet';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The real 1 SOL pool, so the filter carries the address the program writes. */
const POOL = findPoolV3('SOL', 1) as PoolConfig;

const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const ELSEWHERE = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

/** A 63-bit blinding, so the note routes to circuit 7 rather than the pair. */
const PRF_BLINDED = '7284991002338477113';

interface Note {
  nullifierPreimage: bigint;
  secret: bigint;
  commitment: bigint;
}

const NOTE_A: Note = { nullifierPreimage: 11n, secret: 22n, commitment: 1001n };
const NOTE_B: Note = { nullifierPreimage: 33n, secret: 44n, commitment: 1002n };

/**
 * Other notes' spends, planted AROUND the one under test (fix round 2).
 *
 * ⛔ A POOL HOLDS MANY RECORDS, AND THE ONE THAT MATTERS IS RARELY FIRST. With
 * a single planted record, a set built from `accounts.slice(0, 1)` passed every
 * case here, while on a real pool it keeps one record of many (verifier
 * mutant N17, `wp-logs/verify/EXT-RPC-r2-mut/N17.txt`; killed in
 * `wp-logs/EXT-RPC-fix2-mut/mutants.log`).
 */
const DECOYS: Note[] = [
  { nullifierPreimage: 55n, secret: 66n, commitment: 1003n },
  { nullifierPreimage: 77n, secret: 88n, commitment: 1004n },
  { nullifierPreimage: 99n, secret: 110n, commitment: 1005n },
];

/**
 * The target's record sits third of five, behind two other spends. The last
 * entry is NOTE_B's nullifier in the 0.1 SOL pool: the same note secrets in
 * another pool are another PDA, so NOTE_B must still read as live here.
 */
const spentAround = (target: Note): string[] => [
  pdaOf(DECOYS[0]),
  pdaOf(DECOYS[1]),
  pdaOf(target),
  pdaOf(DECOYS[2]),
  pdaOf(NOTE_B, (findPoolV3('SOL', 0.1) as PoolConfig).poolPDA),
];

/** The PDA a note's spend will create. Real derivation — this is node. */
function pdaOf(note: Note, pool: PublicKey = POOL.poolPDA): string {
  const nul = createNullifierV3(note.nullifierPreimage, note.secret);
  const [pda] = deriveNullifierPDA(pool, goldilocksU64To32(nul));
  return pda.toBase58();
}

/** Every spelling of "this note" that could ride in a request. */
function noteAliases(note: Note): string[] {
  const nul = createNullifierV3(note.nullifierPreimage, note.secret);
  const bytes = goldilocksU64To32(nul);
  return [
    pdaOf(note),
    nul.toString(),
    note.commitment.toString(),
    note.nullifierPreimage.toString(),
    note.secret.toString(),
    Buffer.from(bytes).toString('hex'),
    Buffer.from(bytes).toString('base64'),
  ].filter((s) => s.length >= 4);
}

// ---------------------------------------------------------------------------
// The recorder, and the detector that reads what it recorded
// ---------------------------------------------------------------------------

interface Call {
  method: string;
  args: unknown[];
}

type Responder = (method: string, args: unknown[]) => unknown;

function recordingConnection(
  respond: Responder,
  endpoint = 'https://devnet.helius-rpc.com/?api-key=NOT-A-REAL-KEY',
) {
  const calls: Call[] = [];
  const conn = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop === 'rpcEndpoint') return endpoint;
        // A promise-like probe must not be recorded as a request.
        if (prop === 'then') return undefined;
        return (...args: unknown[]) => {
          calls.push({ method: prop, args });
          return respond(prop, args);
        };
      },
    },
  );
  return { conn: conn as never, calls };
}

/**
 * Walk every recorded argument and report each place a note is named.
 *
 * Values are read the way a provider reads them: a PublicKey by its base58, a
 * byte array by its hex AND its base64, a bigint and a number by their digits,
 * a string as itself. Nesting is followed to the bottom, so a PDA inside an
 * array inside a filter is found.
 */
function noteNamingCalls(calls: Call[], aliases: string[]): string[] {
  const hits: string[] = [];
  const needles = new Set(aliases);

  const readable = (v: unknown): string[] => {
    if (v === null || v === undefined) return [];
    if (typeof v === 'string') return [v];
    if (typeof v === 'bigint' || typeof v === 'number') return [v.toString()];
    if (v instanceof Uint8Array || Array.isArray(v) && v.every((x) => typeof x === 'number')) {
      const b = Buffer.from(v as Uint8Array);
      return [b.toString('hex'), b.toString('base64')];
    }
    const maybeKey = v as { toBase58?: unknown };
    if (typeof maybeKey.toBase58 === 'function') {
      return [(maybeKey.toBase58 as () => string)()];
    }
    return [];
  };

  const walk = (v: unknown, path: string, method: string, depth: number): void => {
    if (depth > 8 || v === null || v === undefined) return;
    for (const s of readable(v)) {
      for (const needle of needles) {
        if (s.includes(needle)) hits.push(`${method}${path} names ${needle.slice(0, 12)}...`);
      }
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`, method, depth + 1));
      return;
    }
    if (typeof v === 'object' && !(v instanceof Uint8Array)) {
      const maybeKey = v as { toBase58?: unknown };
      if (typeof maybeKey.toBase58 === 'function') return;
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        walk(x, `${path}.${k}`, method, depth + 1);
      }
    }
  };

  for (const c of calls) c.args.forEach((a, i) => walk(a, `(arg${i})`, c.method, 0));
  return hits;
}

const countOf = (calls: Call[], method: string) => calls.filter((c) => c.method === method).length;

/**
 * Run a promise to an OUTCOME, so an assertion can speak about it.
 *
 * ⛔ NOT `.rejects.toThrow()`. When the promise RESOLVES — which is exactly
 * the old behaviour these cases pin — vitest reports that as a plain `Error`
 * ("promise resolved ... instead of rejecting"). A red that arrives as an
 * `Error` cannot be told apart from a crash, so it proves nothing and the
 * red-log checker rejects it (`wp-logs/PROTOCOL.md`). Turning the outcome into
 * data makes the failure an AssertionError about a value, which is what the
 * protocol asks for.
 */
async function outcomeOf<T>(p: Promise<T>): Promise<{
  kind: 'resolved' | 'rejected';
  message: string;
  value: T | null;
}> {
  return p.then(
    (value) => ({ kind: 'resolved' as const, message: '', value }),
    (e: unknown) => ({
      kind: 'rejected' as const,
      message: e instanceof Error ? e.message : String(e),
      value: null,
    }),
  );
}

/** One `NullifierRecord` as `getProgramAccounts` returns it with dataSlice 0. */
const record = (pda: string) => ({ pubkey: new PublicKey(pda), account: { data: new Uint8Array(0) } });

/**
 * What the chain answers a `getProgramAccounts`: the planted records ONLY for
 * the program and filter that select NOTE_A's pool, and nothing otherwise
 * (fix round 2).
 *
 * ⛔ A FAKE THAT IGNORES THE FILTER CANNOT SEE A CALLER THAT ASKS THE WRONG
 * ACCOUNT. Before this, `subscribePrivate` reading `treePDA`'s set, the store
 * reading `poolConfig.treePDA`'s, all still "refused the spent note" here, and
 * on devnet they would get an empty set and never refuse anything (verifier
 * mutants N12, N14: `wp-logs/verify/EXT-RPC-r2-mut/`; killed in
 * `wp-logs/EXT-RPC-fix2-mut/mutants.log`).
 */
function recordsFor(args: unknown[], spent: string[], pool: PublicKey = POOL.poolPDA) {
  const [programId, config] = args as [{ toBase58?: () => string } | undefined, { filters?: unknown } | undefined];
  const asksThisPool =
    typeof programId?.toBase58 === 'function' &&
    programId.toBase58() === ZK_SHIELDED_PROGRAM_ID.toBase58() &&
    JSON.stringify(config?.filters) ===
      JSON.stringify([{ dataSize: 41 }, { memcmp: { offset: 8, bytes: pool.toBase58() } }]);
  return asksThisPool ? spent.map(record) : [];
}

/** The pool filter every pre-flight must send, as literals. */
const THIS_POOL_FILTERS = () => [{ dataSize: 41 }, { memcmp: { offset: 8, bytes: POOL.poolPDA.toBase58() } }];
const gpaFilters = (calls: Call[]) =>
  calls
    .filter((c) => c.method === 'getProgramAccounts')
    .map((c) => (c.args[1] as { filters?: unknown } | undefined)?.filters);

/**
 * The default responder: it answers the POOL-WIDE question and nothing else. A
 * per-note read gets the honest "no such account", which is also what the
 * chain says today for an unspent note.
 */
const poolWideOnly = (spent: string[]): Responder => (method, args) => {
  if (method === 'getProgramAccounts') return Promise.resolve(recordsFor(args, spent));
  if (method === 'getAccountInfo') return Promise.resolve(null);
  if (method === 'getMultipleAccountsInfo') return Promise.resolve([]);
  if (method === 'getSlot') return Promise.resolve(50_000_000);
  return Promise.resolve(null);
};

beforeEach(() => {
  vi.clearAllMocks();
  clearSpentNullifierSetCache();
  h.prepareUnshield.mockResolvedValue({ v3: 'prepared' });
  h.unshieldDenominatedStarkV3.mockResolvedValue('SIG_V3');
  h.prepareUnshieldV4.mockResolvedValue({ v4: 'prepared' });
  h.unshieldDenominatedStarkV4.mockResolvedValue('SIG_V4');
});

// ===========================================================================
// 1. The request itself
// ===========================================================================

describe('the spent set is read pool-wide', () => {
  it('asks ONE getProgramAccounts, filtered on the pool, and names no note', async () => {
    const { conn, calls } = recordingConnection(poolWideOnly([pdaOf(NOTE_A)]));

    await fetchSpentNullifierSet(conn, POOL.poolPDA);

    expect(countOf(calls, 'getProgramAccounts')).toBe(1);
    expect(calls).toHaveLength(1);

    const [programId, config] = calls[0].args as [PublicKey, Record<string, unknown>];
    expect(programId.toBase58()).toBe(ZK_SHIELDED_PROGRAM_ID.toBase58());
    // The pool is the filter. `NullifierRecord` is 8 + 32 + 1 bytes with the
    // pool first after the discriminator (nullifier_set.rs:146-156), so this
    // bounds the answer by the pool's spent count and by nothing about us.
    expect(config.filters).toEqual([
      { dataSize: NULLIFIER_RECORD_LEN },
      { memcmp: { offset: NULLIFIER_RECORD_POOL_OFFSET, bytes: POOL.poolPDA.toBase58() } },
    ]);
    // Addresses only: the body holds the pool we already filtered on, plus a bump.
    expect(config.dataSlice).toEqual({ offset: 0, length: 0 });

    expect(noteNamingCalls(calls, [...noteAliases(NOTE_A), ...noteAliases(NOTE_B)])).toEqual([]);
  });

  it('pins the two layout constants to the account the program writes', () => {
    // 8 (discriminator) + 32 (pool) + 1 (bump), pool first.
    expect(NULLIFIER_RECORD_LEN).toBe(41);
    expect(NULLIFIER_RECORD_POOL_OFFSET).toBe(8);
  });

  it('decides membership on the device, with no further request', async () => {
    const { conn, calls } = recordingConnection(poolWideOnly(spentAround(NOTE_A)));

    const spent = await fetchSpentNullifierSet(conn, POOL.poolPDA);
    const before = calls.length;

    expect(isNullifierSpentInSet(spent, POOL.poolPDA, NOTE_A.nullifierPreimage, NOTE_A.secret)).toBe(true);
    expect(isNullifierSpentInSet(spent, POOL.poolPDA, NOTE_B.nullifierPreimage, NOTE_B.secret)).toBe(false);
    // Every planted record is in the set, not only the first one returned.
    expect(spent.size).toBe(5);

    // Deciding cost nothing on the wire — that is the property.
    expect(calls).toHaveLength(before);
  });

  it('the detector flags a note-naming read, and not a pool-wide one (positive control)', () => {
    // ⛔ WITHOUT THIS THE ASSERTIONS ABOVE ARE DECORATION. A detector that
    // found nothing because it looks in the wrong place reports a clean run on
    // a leaking client. Feed it reads it MUST flag and reads it must not.
    const aliases = noteAliases(NOTE_A);
    const notePda = new PublicKey(pdaOf(NOTE_A));

    const mustFlag: Call[] = [
      { method: 'getAccountInfo', args: [notePda] },
      { method: 'getMultipleAccountsInfo', args: [[notePda]] },
      { method: 'getAccountInfo', args: [pdaOf(NOTE_A)] },
      {
        method: 'getProgramAccounts',
        args: [ZK_SHIELDED_PROGRAM_ID, { filters: [{ memcmp: { offset: 8, bytes: pdaOf(NOTE_A) } }] }],
      },
      { method: 'somethingNew', args: [{ deep: { nested: [{ pda: pdaOf(NOTE_A) }] } }] },
    ];
    for (const c of mustFlag) {
      expect(noteNamingCalls([c], aliases), `missed: ${c.method}`).not.toEqual([]);
    }

    const mustNotFlag: Call[] = [
      {
        method: 'getProgramAccounts',
        args: [
          ZK_SHIELDED_PROGRAM_ID,
          {
            dataSlice: { offset: 0, length: 0 },
            filters: [{ dataSize: 41 }, { memcmp: { offset: 8, bytes: POOL.poolPDA.toBase58() } }],
          },
        ],
      },
      { method: 'getSlot', args: ['confirmed'] },
      { method: 'getAccountInfo', args: [POOL.poolPDA] },
    ];
    for (const c of mustNotFlag) {
      expect(noteNamingCalls([c], aliases), `false positive: ${c.method}`).toEqual([]);
    }
  });
});

// ===========================================================================
// 2. Failing closed
// ===========================================================================

describe('an unreadable pool is an error, never an empty set', () => {
  it('raises the RPC failure to the caller', async () => {
    const { conn } = recordingConnection((method) =>
      method === 'getProgramAccounts'
        ? Promise.reject(new Error('rpc 429'))
        : Promise.resolve(null),
    );

    // ⛔ NOT `.rejects.toThrow()` ALONE. An empty set is the dangerous answer
    // here — it reads as "none of your notes is spent" — so assert that the
    // call does not RESOLVE, and say with what it failed.
    const outcome = await outcomeOf(fetchSpentNullifierSet(conn, POOL.poolPDA));

    expect(outcome.kind, `resolved with ${JSON.stringify(outcome.value)}`).toBe('rejected');
    expect(outcome.message).toMatch(/rpc 429/);
  });

  it('does not remember a failure: the next read asks again', async () => {
    let attempt = 0;
    const { conn, calls } = recordingConnection((method) => {
      if (method !== 'getProgramAccounts') return Promise.resolve(null);
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error('rpc 429'))
        : Promise.resolve([record(pdaOf(NOTE_A))]);
    });

    const first = await outcomeOf(fetchSpentNullifierSet(conn, POOL.poolPDA));
    expect(first.kind, `resolved with ${JSON.stringify(first.value)}`).toBe('rejected');
    const spent = await fetchSpentNullifierSet(conn, POOL.poolPDA);

    // A cached rejection would strand the wallet for the whole TTL.
    expect(countOf(calls, 'getProgramAccounts')).toBe(2);
    expect(spent.has(pdaOf(NOTE_A))).toBe(true);
  });
});

// ===========================================================================
// 3. The cache — 30 s, and keyed by nothing secret
// ===========================================================================

describe('the 30 s cache', () => {
  it('the window is 30 s, as a literal', () => {
    // Every other case here works FROM the constant, so a window of an hour
    // would leave them green while a note spent on another device reads as
    // live for that hour. This is the one that pins the number (verifier
    // mutant M13, wp-logs/verify/EXT-RPC-r1b-mutants.log).
    expect(SPENT_SET_TTL_MS).toBe(30_000);
  });

  beforeEach(() => {
    // Only Date is faked: the module's promises still resolve on real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-16T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves a second read inside the window from the first answer', async () => {
    const { conn, calls } = recordingConnection(poolWideOnly([pdaOf(NOTE_A)]));

    await fetchSpentNullifierSet(conn, POOL.poolPDA);
    vi.setSystemTime(Date.now() + SPENT_SET_TTL_MS - 1);
    const again = await fetchSpentNullifierSet(conn, POOL.poolPDA);

    expect(countOf(calls, 'getProgramAccounts')).toBe(1);
    expect(again.has(pdaOf(NOTE_A))).toBe(true);
  });

  it('re-reads once the window has passed', async () => {
    const { conn, calls } = recordingConnection(poolWideOnly([]));

    await fetchSpentNullifierSet(conn, POOL.poolPDA);
    vi.setSystemTime(Date.now() + SPENT_SET_TTL_MS + 1);
    await fetchSpentNullifierSet(conn, POOL.poolPDA);

    expect(countOf(calls, 'getProgramAccounts')).toBe(2);
  });

  it('two reads that race make one request', async () => {
    const { conn, calls } = recordingConnection(poolWideOnly([pdaOf(NOTE_A)]));

    const [one, two] = await Promise.all([
      fetchSpentNullifierSet(conn, POOL.poolPDA),
      fetchSpentNullifierSet(conn, POOL.poolPDA),
    ]);

    // The screen's mount and a withdrawal pre-flight can overlap. "One per
    // pool" has to survive that.
    expect(countOf(calls, 'getProgramAccounts')).toBe(1);
    expect(one.has(pdaOf(NOTE_A))).toBe(true);
    expect(two.has(pdaOf(NOTE_A))).toBe(true);
  });

  it('keeps pools apart', async () => {
    const other = findPoolV3('SOL', 0.1) as PoolConfig;
    const { conn, calls } = recordingConnection(poolWideOnly([]));

    await fetchSpentNullifierSet(conn, POOL.poolPDA);
    await fetchSpentNullifierSet(conn, other.poolPDA);

    expect(countOf(calls, 'getProgramAccounts')).toBe(2);
  });

  it('CANNOT be keyed by the RPC URL: two keys on one host share the answer', async () => {
    // 🚨 THIS IS A LEAK TEST, NOT A PERFORMANCE ONE. The endpoint carries the
    // Helius API key in its query string
    // (`packages/rpc-config/src/endpoints.ts:58-60`), so a cache keyed on the
    // URL writes that key into every entry — the mistake HIST-1 is removing
    // from the web history cache. Two connections that differ ONLY by the key
    // must therefore hit the same entry.
    const a = recordingConnection(poolWideOnly([]), 'https://devnet.helius-rpc.com/?api-key=KEY-ONE');
    const b = recordingConnection(poolWideOnly([]), 'https://devnet.helius-rpc.com/?api-key=KEY-TWO');

    await fetchSpentNullifierSet(a.conn, POOL.poolPDA);
    await fetchSpentNullifierSet(b.conn, POOL.poolPDA);

    expect(countOf(a.calls, 'getProgramAccounts')).toBe(1);
    expect(countOf(b.calls, 'getProgramAccounts')).toBe(0);
  });

  it('still separates two networks, which share pool addresses', async () => {
    // The pool PDA is derived from mint + denomination, so the same address
    // exists on both clusters. Answering a mainnet question with devnet's
    // spent set would refuse a good note or prove a dead one.
    const dev = recordingConnection(poolWideOnly([]), 'https://devnet.helius-rpc.com/?api-key=K');
    const main = recordingConnection(poolWideOnly([]), 'https://mainnet.helius-rpc.com/?api-key=K');

    await fetchSpentNullifierSet(dev.conn, POOL.poolPDA);
    await fetchSpentNullifierSet(main.conn, POOL.poolPDA);

    expect(countOf(dev.calls, 'getProgramAccounts')).toBe(1);
    expect(countOf(main.calls, 'getProgramAccounts')).toBe(1);
  });
});

// ===========================================================================
// 4. The withdrawal pre-flight, through the real store
// ===========================================================================

describe('the unshield pre-flight reads pool-wide and fails closed', () => {
  function seed(note: Note) {
    useDenominatedPoolStore.setState({
      serializedNotes: [
        {
          secret: note.secret.toString(),
          nullifierPreimage: note.nullifierPreimage.toString(),
          depositEpoch: PRF_BLINDED,
          tokenMint: '0',
          commitment: note.commitment.toString(),
          leafIndex: 30,
          denomination: '1000000000',
          pool: POOL.poolPDA.toBase58(),
          token: 'SOL',
          denominationHuman: 1,
          shieldedAt: 0,
        },
      ],
      loading: false,
      error: null,
    });
  }

  const withdraw = (over: { recipient?: string } = {}) =>
    useDenominatedPoolStore
      .getState()
      .unshieldNote({ noteId: NOTE_A.commitment.toString(), recipient: ELSEWHERE, ...over });

  beforeEach(() => {
    useWalletStore.setState({
      publicKey: WALLET,
      network: 'devnet',
      _keypair: { placeholder: true } as never,
    });
    seed(NOTE_A);
  });

  it('asks the pool once and names the note nowhere', async () => {
    const rec = recordingConnection(poolWideOnly([]));
    h.conn = rec.conn;

    await expect(withdraw()).resolves.toEqual({ txSig: 'SIG_V4', version: 'v4' });

    expect(countOf(rec.calls, 'getProgramAccounts')).toBe(1);
    // The NOTE'S pool, not another account of the same program (mutant N14).
    expect(gpaFilters(rec.calls)).toEqual([THIS_POOL_FILTERS()]);
    // ⛔ THE ASSERTION THAT CARRIES THE PROPERTY. The pool module's reads are
    // REAL in this file, so a per-note `getAccountInfo` would land here and be
    // named. Its absence is measured, not assumed.
    expect(noteNamingCalls(rec.calls, noteAliases(NOTE_A))).toEqual([]);
  });

  it('refuses a note the pool says is spent, before either prepare', async () => {
    const rec = recordingConnection(poolWideOnly(spentAround(NOTE_A)));
    h.conn = rec.conn;

    const outcome = await outcomeOf(withdraw());

    expect(outcome.kind, `resolved with ${JSON.stringify(outcome.value)}`).toBe('rejected');
    expect(outcome.message).toMatch(/already been withdrawn/);

    expect(h.prepareUnshieldV4).not.toHaveBeenCalled();
    expect(h.prepareUnshield).not.toHaveBeenCalled();
    expect(noteNamingCalls(rec.calls, noteAliases(NOTE_A))).toEqual([]);
  });

  it('refuses the withdrawal when the pool cannot be read, instead of spending', async () => {
    // ⛔ FAIL CLOSED. The alternative — treating an unreadable pool as "nothing
    // is spent" — is how a note gets proved twice: 2-3 minutes of proving and
    // the buffer rent, to die on the on-chain double-spend guard.
    const rec = recordingConnection((method) =>
      method === 'getProgramAccounts'
        ? Promise.reject(new Error('rpc 503'))
        : Promise.resolve(null),
    );
    h.conn = rec.conn;

    const outcome = await outcomeOf(withdraw());

    expect(outcome.kind, `resolved with ${JSON.stringify(outcome.value)}`).toBe('rejected');
    expect(outcome.message).toMatch(/rpc 503/);

    expect(h.prepareUnshieldV4).not.toHaveBeenCalled();
    expect(h.unshieldDenominatedStarkV4).not.toHaveBeenCalled();
    // The note is kept: a failed read is not evidence that it is gone.
    expect(useDenominatedPoolStore.getState().serializedNotes).toHaveLength(1);
  });

  it('still refuses the paying wallet first, before any RPC at all', async () => {
    // The payee refusal sits above the pre-flight and must stay there: it is
    // free, and it is the one refusal that needs no network.
    const rec = recordingConnection(poolWideOnly([]));
    h.conn = rec.conn;

    await expect(withdraw({ recipient: WALLET })).rejects.toThrow(
      /Refusing to withdraw to the wallet that pays/,
    );

    expect(rec.calls).toHaveLength(0);
  });
});

// ===========================================================================
// 5. The subscribe pre-flight, through the real service
// ===========================================================================

describe('the subscribe pre-flight reads pool-wide and fails closed', () => {
  /** Thrown by the mocked circuit-7 prepare: the pre-flight let the note through. */
  const PREPARE_REACHED = 'sentinel: prepareSubscribeV4 reached';

  function receiptOf(note: Note) {
    return {
      secret: note.secret,
      nullifierPreimage: note.nullifierPreimage,
      depositEpoch: BigInt(PRF_BLINDED),
      tokenMint: 0n,
      commitment: note.commitment,
      leafIndex: 30,
      denomination: 1_000_000_000n,
      pool: POOL.poolPDA.toBase58(),
      token: 'SOL' as const,
      denominationHuman: 1,
      shieldedAt: 0,
    };
  }

  const subscribe = () =>
    subscribePrivate({
      receipt: receiptOf(NOTE_A),
      poolPDA: POOL.poolPDA.toBase58(),
      treePDA: POOL.treePDA.toBase58(),
      retailer: ELSEWHERE,
      rate: 100_000_000n,
      intervalSlots: 216_000n,
      subscriberOwnershipCommitment: 5n,
      vkHashSubscriber: new Uint8Array(32),
    });

  /**
   * An HONEST chain: the pool-wide read and the per-note read agree. A spent
   * note's PDA exists for `getAccountInfo` too, so a client that still asked
   * per note would get the right verdict — and the only thing that can tell
   * the two clients apart is what the request named.
   */
  const honestChain = (spent: string[]): Responder => (method, args) => {
    if (method === 'getProgramAccounts') return Promise.resolve(recordsFor(args, spent));
    if (method === 'getAccountInfo') {
      const key = args[0] as { toBase58?: () => string };
      const named = typeof key?.toBase58 === 'function' ? key.toBase58() : String(key);
      return Promise.resolve(spent.includes(named) ? { data: new Uint8Array(41) } : null);
    }
    return Promise.resolve(null);
  };

  beforeEach(() => {
    useWalletStore.setState({
      publicKey: WALLET,
      network: 'devnet',
      _keypair: { placeholder: true } as never,
    });
    h.prepareSubscribeV4.mockRejectedValue(new Error(PREPARE_REACHED));
    h.saveSecret.mockResolvedValue(undefined);
  });

  it('asks the pool once and names the note nowhere', async () => {
    const rec = recordingConnection(honestChain([]));
    h.conn = rec.conn;

    const outcome = await outcomeOf(subscribe());

    // The pre-flight let a live note through to the prepare...
    expect(outcome.message).toBe(PREPARE_REACHED);
    // ...having asked the POOL, once — the note's own pool, not its tree
    // (mutant N12)...
    expect(countOf(rec.calls, 'getProgramAccounts')).toBe(1);
    expect(gpaFilters(rec.calls)).toEqual([THIS_POOL_FILTERS()]);
    // ⛔ ...and named the note in no request. The old per-note getAccountInfo
    // is REAL here (the pool module is spread), so it would be recorded and
    // flagged.
    expect(noteNamingCalls(rec.calls, noteAliases(NOTE_A))).toEqual([]);
  });

  it('refuses a note the pool says is spent, before saving a secret or preparing', async () => {
    const rec = recordingConnection(honestChain(spentAround(NOTE_A)));
    h.conn = rec.conn;

    const outcome = await outcomeOf(subscribe());

    expect(outcome.kind, `resolved with ${JSON.stringify(outcome.value)}`).toBe('rejected');
    expect(outcome.message).toMatch(/already been spent/);
    expect(h.saveSecret).not.toHaveBeenCalled();
    expect(h.prepareSubscribeV4).not.toHaveBeenCalled();
    expect(noteNamingCalls(rec.calls, noteAliases(NOTE_A))).toEqual([]);
  });

  it('refuses the subscribe when the pool cannot be read, instead of proving', async () => {
    // ⛔ FAIL CLOSED, as the withdrawal does: an unreadable pool is not "nothing
    // is spent".
    const rec = recordingConnection((method) =>
      method === 'getProgramAccounts'
        ? Promise.reject(new Error('rpc 503'))
        : Promise.resolve(null),
    );
    h.conn = rec.conn;

    const outcome = await outcomeOf(subscribe());

    expect(outcome.kind, `resolved with ${JSON.stringify(outcome.value)}`).toBe('rejected');
    expect(outcome.message).toMatch(/rpc 503/);
    expect(h.saveSecret).not.toHaveBeenCalled();
    expect(h.prepareSubscribeV4).not.toHaveBeenCalled();
  });
});
