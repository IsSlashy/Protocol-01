/**
 * What the subscribe screen WRITES, measured by clicking Subscribe.
 *
 * Two defects lived on this screen until 2026-09-02, and neither could be
 * seen by the tests that existed:
 *
 *   1. A registry arrival rewrote the merchant's period into a 1/7/30/365-day
 *      bucket before opening the vault. `CreateSubscription.intervals.test.ts`
 *      pins the four bucket constants and so could only ever agree with it.
 *      The merchant SDK requires the vault's interval to EQUAL the registry's,
 *      so a merchant registered at any other period refused every key this
 *      screen sold. The assertion that catches it is on the argument handed to
 *      `createPrivateVault`, for a period that is not a bucket.
 *
 *   2. The license key was derived and saved only after a fetchVault and a
 *      removeNote, i.e. after more RPC. The order is pinned here by reading
 *      the license store from inside the `removeNote` stub. (The deeper fix,
 *      the service persisting the key the instant the tx confirms, is pinned
 *      in `shared/services/subscriptionVault.licenseOrder.test.ts`.)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import CreateSubscription from './CreateSubscription';
import { useLicenseStore } from '@/shared/store/license';
import { licenseKeyForPrivate } from '@/shared/services/license';
import {
  createNullifierV3,
  goldilocksU64To32,
  deriveNullifierPDA,
} from '@/shared/services/denominatedPool';
import { clearSpentNullifierSetCache } from '@/shared/services/spentSet';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

/**
 * Everything the mock factories close over. `vi.mock` is hoisted above the
 * imports, so anything a factory reads has to be hoisted with it.
 */
const h = vi.hoisted(() => {
  const NOTE = {
    secret: 123456789012345678n,
    nullifierPreimage: 42n,
    depositEpoch: 0n,
    tokenMint: 0n,
    commitment: 777n,
    leafIndex: 0,
    denomination: 1_000_000_000n,
    pool: 'Pool111',
    token: 'SOL' as const,
    denominationHuman: 1,
    shieldedAt: 0,
    merkleRoot: 1n,
  };
  const POOL = {
    token: 'SOL' as const,
    tokenMint: { toBase58: () => '11111111111111111111111111111111' },
    denomination: 1,
    denominationAtomic: 1_000_000_000n,
    decimals: 9,
    poolPDA: { toBase58: () => 'Pool111' },
    treePDA: { toBase58: () => 'Tree111' },
    version: 'v3' as const,
  };
  return {
    NOTE,
    POOL,
    /** What `getNotes()` hands the screen. A test installs its own list. */
    notes: [NOTE] as Array<typeof NOTE>,
    /** What `getConnection()` returns. A test installs its own recorder. */
    conn: null as unknown,
    createPrivateVault: vi.fn(),
    removeNote: vi.fn(),
    fetchServiceRegistry: vi.fn(),
  };
});

vi.mock('@/shared/store/wallet', () => ({
  useWalletStore: () => ({ _keypair: {}, network: 'devnet', isUnlocked: true }),
}));

vi.mock('@/shared/store/denominatedPool', () => ({
  useDenominatedPoolStore: () => ({
    getSpendableNote: () => h.notes[0] ?? null,
    getNotes: () => h.notes,
    removeNote: h.removeNote,
  }),
}));

vi.mock('@/shared/store/subscriptionVault', () => ({
  useSubscriptionVaultStore: () => ({
    createPrivateVault: h.createPrivateVault,
    addVault: vi.fn(),
  }),
}));

/**
 * ⛔ SPREAD THE REAL MODULE — only the PDA derivation is faked, because
 * `PublicKey.findProgramAddressSync` throws under jsdom here for every input
 * (measured 2026-09-16, `wp-logs/EXT-RPC-env-probe.log`). The fakes stay
 * FAITHFUL: a nullifier is still a function of the note's two secrets and a
 * PDA is still a function of (pool, nullifier). The spent-set detector below
 * leans on exactly that, and a constant fake would make it prove nothing.
 */
vi.mock('@/shared/services/denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/services/denominatedPool')>();
  return {
    ...actual,
    findPoolV3: () => h.POOL,
    createNullifierV3: (np: bigint, s: bigint) => (np << 32n) ^ s,
    goldilocksU64To32: (v: bigint) => {
      const out = new Uint8Array(32);
      let x = v;
      for (let i = 0; i < 8; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
      return out;
    },
    deriveNullifierPDA: (pool: { toBase58(): string }, bytes: Uint8Array) => [
      { toBase58: () => `PDA:${pool.toBase58()}:${Buffer.from(bytes).toString('hex')}` },
      0,
    ],
  };
});

vi.mock('@/shared/services/subscriptionVault', () => ({
  deriveVaultPDA: () => ({ toBase58: () => 'Vault111' }),
  goldilocksU64To32: () => new Uint8Array(32),
  fetchVault: async () => null,
}));

vi.mock('@/shared/services/starkProver', () => ({
  starkProver: {
    start: async () => {},
    generateProof: async () => ({ commitment: '99' }),
  },
}));

/** A slot far past any maturity gate, and no spent nullifier records. */
vi.mock('@/shared/services/wallet', () => ({
  getConnection: () => h.conn,
}));

vi.mock('@/shared/services/onchainServiceRegistry', () => ({
  fetchServiceRegistry: (...a: unknown[]) => h.fetchServiceRegistry(...a),
  NATIVE_MINT: '11111111111111111111111111111111',
}));

/** A real base58 pubkey: the screen constructs a PublicKey from it. */
const RETAILER = 'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c';

/**
 * 100 000 slots is 11.1 hours: not a day, a week, a month or a year, so no
 * bucket can reproduce it. The old screen wrote 216 000 for it.
 */
function service(over: Partial<Record<string, unknown>> = {}) {
  return {
    address: 'Svc111',
    owner: 'Own111',
    retailer: RETAILER,
    tokenMint: '11111111111111111111111111111111',
    priceAtomic: 60_000_000,
    intervalSlots: 100_000,
    subscriberCount: 0,
    supportsOneshot: false,
    supportsVault: true,
    verified: false,
    active: true,
    bump: 0,
    createdAt: 0,
    updatedAt: 0,
    slug: 'acme',
    name: 'Acme Reader',
    iconKey: '',
    category: 'news',
    metadataUri: '',
    ...over,
  };
}

const view = (state?: Record<string, unknown>) =>
  render(
    <MemoryRouter initialEntries={[{ pathname: '/subscriptions/new', state }]}>
      <CreateSubscription />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  // ⛔ THE SPENT SET IS CACHED FOR 30 s IN A MODULE-GLOBAL MAP, keyed by RPC
  // host and pool — which every case here shares. Without this, the first
  // case's answer is served to the rest and they measure nothing: a case
  // that plants a spent note, or one whose RPC fails, would quietly agree
  // with whatever ran before it.
  clearSpentNullifierSetCache();
  h.notes = [h.NOTE];
  h.conn = {
    getSlot: async () => 50_000_000,
    getMultipleAccountsInfo: async (keys: unknown[]) => (keys ?? []).map(() => null),
    getProgramAccounts: async () => [],
  };
  useLicenseStore.getState().reset();
  h.fetchServiceRegistry.mockResolvedValue(service());
  h.createPrivateVault.mockResolvedValue('SIG');
});

describe('a registry arrival', () => {
  it('writes the registry interval and price verbatim, not a bucket', async () => {
    view({ service: 'Svc111' });
    await screen.findByText('Acme Reader');

    fireEvent.click(screen.getByRole('button', { name: /^Subscribe$/ }));
    await waitFor(() => expect(h.createPrivateVault).toHaveBeenCalledTimes(1));

    const args = h.createPrivateVault.mock.calls[0][0];
    expect(args.intervalSlots).toBe(100_000n);
    expect(args.rate).toBe(60_000_000n);
    expect(args.retailer).toBe(RETAILER);
    expect(args.serviceId).toBe('acme');
    expect(args.serviceName).toBe('Acme Reader');
  });

  it('shows the exact period, read-only, with no picker', async () => {
    view({ service: 'Svc111' });
    await screen.findByText('Acme Reader');

    expect(screen.getByText('every 11.1 hours')).toBeInTheDocument();
    expect(screen.getByText(/written to your\s+vault exactly as listed/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Yearly' })).not.toBeInTheDocument();
    expect(screen.queryByText(/not recognised by a merchant/i)).not.toBeInTheDocument();
  });

  it('refuses a merchant billed in a token a SOL note cannot pay', async () => {
    h.fetchServiceRegistry.mockResolvedValue(
      service({ tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }),
    );
    view({ service: 'Svc111' });
    await screen.findByText('Acme Reader');

    fireEvent.click(screen.getByRole('button', { name: /^Subscribe$/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot pay from a SOL note/i);
    expect(h.createPrivateVault).not.toHaveBeenCalled();
  });

  it('shows and files the key before the post-confirmation cleanup runs', async () => {
    const expectedKey = licenseKeyForPrivate(h.NOTE.secret, 'acme');
    let keyWhenNoteRemoved: string | null | undefined;
    h.removeNote.mockImplementation(() => {
      keyWhenNoteRemoved = useLicenseStore.getState().getLicense(RETAILER, 'zk')?.licenseKey;
    });

    view({ service: 'Svc111' });
    await screen.findByText('Acme Reader');
    fireEvent.click(screen.getByRole('button', { name: /^Subscribe$/ }));

    expect(await screen.findByText(expectedKey)).toBeInTheDocument();
    await waitFor(() => expect(h.removeNote).toHaveBeenCalledTimes(1));
    expect(keyWhenNoteRemoved).toBe(expectedKey);

    const entry = useLicenseStore.getState().getLicense(RETAILER, 'zk');
    expect(entry?.licenseKey).toBe(expectedKey);
    expect(entry?.vaultAddress).toBe('Vault111');
    expect(entry?.serviceTag).toBe('acme');
    expect(useLicenseStore.getState().vaultTags['Vault111']?.confirmedAt).toBeTypeOf('number');
  });
});

describe('a personal payment', () => {
  it('keeps the frequency picker and says a merchant will not recognise it', () => {
    view();
    expect(screen.getByRole('button', { name: 'Yearly' })).toBeInTheDocument();
    expect(screen.getByText(/not\s+recognised by a merchant's registry check/i)).toBeInTheDocument();
  });
});

// ===========================================================================
// What the screen ASKS THE RPC when it opens
// ===========================================================================

/**
 * 🚨 THE CHANNEL THIS CLOSES. Until 2026-09-16 the mount effect batched a
 * `getMultipleAccountsInfo` over EVERY stored note's nullifier PDA (lines
 * 390-415). Those accounts DO NOT EXIST YET — a nullifier is secret until its
 * spend publishes it — so opening the popup handed the RPC provider a list of
 * addresses that would each be created later by a withdrawal. The provider
 * joins on the PDA and recovers the device that pre-queried it, with nothing
 * broken and no relayer involved.
 *
 * ⛔ MEASURED BY WHAT THE REQUESTS CARRY, NOT BY METHOD NAME. Asserting
 * "`getMultipleAccountsInfo` was not called" pins one spelling and walks past
 * `getAccountInfo`, a nullifier-filtered `getProgramAccounts`, or whatever the
 * next refactor reaches for. The connection below records every call, and the
 * assertion walks the arguments asking whether any value derived from a note
 * appears. `the detector flags a note-naming read` is its positive control.
 *
 * The service twin of these assertions, with REAL PDA derivation, is in
 * `shared/services/spentSet.test.ts`.
 */

interface Call { method: string; args: unknown[] }

function recordingConnection(respond: (m: string, a: unknown[]) => unknown) {
  const calls: Call[] = [];
  const conn = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'rpcEndpoint') return 'https://devnet.helius-rpc.com/?api-key=NOT-A-REAL-KEY';
      if (prop === 'then') return undefined;
      return (...args: unknown[]) => { calls.push({ method: prop, args }); return respond(prop, args); };
    },
  });
  return { conn, calls };
}

/** The filter that selects the notes' pool, as literals. */
const THIS_POOL_FILTERS = () => [{ dataSize: 41 }, { memcmp: { offset: 8, bytes: h.POOL.poolPDA.toBase58() } }];

/**
 * Answers the pool-wide question, and nothing per note.
 *
 * ⛔ THE PLANTED RECORDS COME BACK ONLY FOR THE NOTES' POOL (fix round 2). A
 * fake that ignored the filter let a mount reading some other account's set
 * still "drop the spent note" here, while on devnet that read returns nothing
 * and no note is ever dropped (verifier mutant N18,
 * `wp-logs/verify/EXT-RPC-r2-mut/N18.txt`; killed in
 * `wp-logs/EXT-RPC-fix2-mut/mutants.log`).
 */
const poolWideOnly = (spent: string[]) => (method: string, args: unknown[] = []) => {
  if (method === 'getProgramAccounts') {
    const filters = (args[1] as { filters?: unknown } | undefined)?.filters;
    if (JSON.stringify(filters) !== JSON.stringify(THIS_POOL_FILTERS())) return Promise.resolve([]);
    return Promise.resolve(spent.map((s) => ({ pubkey: { toBase58: () => s }, account: { data: new Uint8Array(0) } })));
  }
  if (method === 'getMultipleAccountsInfo') return Promise.resolve([null, null, null]);
  if (method === 'getAccountInfo') return Promise.resolve(null);
  if (method === 'getSlot') return Promise.resolve(50_000_000);
  return Promise.resolve(null);
};

const countOf = (calls: Call[], method: string) => calls.filter((c) => c.method === method).length;

/** Every spelling of "this note" that could ride in a request. */
function noteAliases(n: typeof h.NOTE): string[] {
  const nul = createNullifierV3(n.nullifierPreimage, n.secret);
  const bytes = goldilocksU64To32(nul);
  return [
    deriveNullifierPDA(h.POOL.poolPDA, bytes)[0].toBase58(),
    nul.toString(),
    n.commitment.toString(),
    n.secret.toString(),
    Buffer.from(bytes).toString('hex'),
  ].filter((s) => s.length >= 4);
}

const pdaOf = (n: typeof h.NOTE) =>
  deriveNullifierPDA(h.POOL.poolPDA, goldilocksU64To32(createNullifierV3(n.nullifierPreimage, n.secret)))[0].toBase58();

/** Walk every recorded argument and report each place a note is named. */
function noteNamingCalls(calls: Call[], aliases: string[]): string[] {
  const hits: string[] = [];
  const readable = (v: unknown): string[] => {
    if (typeof v === 'string') return [v];
    if (typeof v === 'bigint' || typeof v === 'number') return [v.toString()];
    if (v instanceof Uint8Array) {
      const b = Buffer.from(v);
      return [b.toString('hex'), b.toString('base64')];
    }
    const k = v as { toBase58?: unknown } | null;
    if (k && typeof k.toBase58 === 'function') return [(k.toBase58 as () => string)()];
    return [];
  };
  const walk = (v: unknown, path: string, method: string, depth: number): void => {
    if (depth > 8 || v === null || v === undefined) return;
    for (const s of readable(v)) {
      for (const a of aliases) if (s.includes(a)) hits.push(`${method}${path} names ${a.slice(0, 12)}...`);
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`, method, depth + 1)); return; }
    if (typeof v === 'object' && !(v instanceof Uint8Array)) {
      const k = v as { toBase58?: unknown };
      if (typeof k.toBase58 === 'function') return;
      for (const [key, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${path}.${key}`, method, depth + 1);
    }
  };
  for (const c of calls) c.args.forEach((a, i) => walk(a, `(arg${i})`, c.method, 0));
  return hits;
}

/**
 * Let the mount effect finish. Deliberately NOT `waitFor` on the property
 * under test: on the old behaviour that would end in a timeout, and a timeout
 * is not a measurement of anything (`wp-logs/PROTOCOL.md`). This always
 * completes, and then the assertion speaks.
 */
async function settle() {
  for (let i = 0; i < 8; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

describe('what the subscribe screen asks the RPC on mount', () => {
  const NOTE_B = { ...h.NOTE, secret: 999n, nullifierPreimage: 43n, commitment: 888n };

  beforeEach(() => {
    h.notes = [h.NOTE, NOTE_B];
  });

  it('asks the pool once for its spent set, and names no note', async () => {
    const rec = recordingConnection(poolWideOnly([]));
    h.conn = rec.conn;

    view();
    await settle();

    expect(countOf(rec.calls, 'getProgramAccounts')).toBe(1);
    // ...and it is the notes' own pool that was asked.
    expect(rec.calls.filter((c) => c.method === 'getProgramAccounts').map((c) => (c.args[1] as { filters?: unknown }).filters))
      .toEqual([THIS_POOL_FILTERS()]);
    expect(noteNamingCalls(rec.calls, [...noteAliases(h.NOTE), ...noteAliases(NOTE_B)])).toEqual([]);
  });

  it('still drops a note the pool says is spent', async () => {
    // ⛔ THE SCAN MUST KEEP WORKING. Closing the channel by deleting the check
    // would leave a spent note funding this screen and failing ~2 min into the
    // proof, which is the defect the scan was added for.
    // NOTE_B's record sits third of four: a pool holds many, and a scan that
    // kept only the first one returned passed with a single plant (verifier
    // mutant N17, `wp-logs/verify/EXT-RPC-r2-mut/N17.txt`).
    const others = [{ ...h.NOTE, secret: 5n, nullifierPreimage: 6n }, { ...h.NOTE, secret: 7n, nullifierPreimage: 8n }, { ...h.NOTE, secret: 9n, nullifierPreimage: 10n }];
    const rec = recordingConnection(poolWideOnly([pdaOf(others[0]), pdaOf(others[1]), pdaOf(NOTE_B), pdaOf(others[2])]));
    h.conn = rec.conn;

    view();
    await settle();

    expect(h.removeNote).toHaveBeenCalledTimes(1);
    expect(h.removeNote).toHaveBeenCalledWith(NOTE_B.commitment.toString());
  });

  it('surfaces an unreadable pool instead of silently trusting the local list', async () => {
    const rec = recordingConnection((method: string) =>
      method === 'getProgramAccounts' ? Promise.reject(new Error('rpc 503')) : Promise.resolve(null));
    h.conn = rec.conn;

    view();
    await settle();

    // queryBy + a plain assertion, so the old behaviour fails on an assertion
    // rather than on a timeout.
    const alert = screen.queryByRole('alert');
    expect(alert?.textContent ?? '').toMatch(/spent|could not be checked/i);
  });

  it('keeps every note when the pool cannot be read', async () => {
    // A read that failed is not evidence that a note is gone. Dropping notes
    // on an RPC error would delete the only copy of an imported secret.
    const rec = recordingConnection((method: string) =>
      method === 'getProgramAccounts' ? Promise.reject(new Error('rpc 503')) : Promise.resolve(null));
    h.conn = rec.conn;

    view();
    await settle();

    expect(h.removeNote).not.toHaveBeenCalled();
  });

  it('the detector flags a note-naming read, and not a pool-wide one (positive control)', () => {
    const aliases = noteAliases(h.NOTE);
    const pda = pdaOf(h.NOTE);

    const mustFlag: Call[] = [
      { method: 'getMultipleAccountsInfo', args: [[{ toBase58: () => pda }]] },
      { method: 'getAccountInfo', args: [{ toBase58: () => pda }] },
      { method: 'getAccountInfo', args: [pda] },
      { method: 'anythingElse', args: [{ deep: [{ pda }] }] },
    ];
    for (const c of mustFlag) {
      expect(noteNamingCalls([c], aliases), `missed: ${c.method}`).not.toEqual([]);
    }

    const mustNotFlag: Call[] = [
      { method: 'getProgramAccounts', args: [{ toBase58: () => 'Prog111' }, { filters: [{ dataSize: 41 }, { memcmp: { offset: 8, bytes: 'Pool111' } }] }] },
      { method: 'getSlot', args: ['confirmed'] },
    ];
    for (const c of mustNotFlag) {
      expect(noteNamingCalls([c], aliases), `false positive: ${c.method}`).toEqual([]);
    }
  });
});
