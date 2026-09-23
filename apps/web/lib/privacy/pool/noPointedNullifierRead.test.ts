/**
 * RPC-1 (LEAK-LEDGER D2, D3, F-d): what the web worker asks the RPC while it
 * locates a note for an export, a withdrawal or a subscription.
 *
 * The adversary is the RPC provider (Helius today). It sees every request and
 * the IP that sent it. Two requests hand it a join for free:
 *
 *   - a `getAccountInfo` on THIS note's nullifier PDA. The account does not
 *     exist until the note is spent, so the provider later joins the IP that
 *     asked to the transaction that created it. An export has no spend at all,
 *     so there the question names a note months before anything is published.
 *   - a `getSignaturesForAddress` on the ephemeral that DEPOSITED the note. That
 *     names the deposit, from the buyer's IP, right before the subscription.
 *
 * HOW IT IS MEASURED. The worker's `Connection` is built on `createPacedFetch`,
 * so that module is replaced with a transport that records every JSON-RPC body
 * and answers it. Nothing below mocks `isNullifierSpent`, `fetchSpentNullifierSet`
 * or `isNullifierSpentInSet`: whatever the code under test sends is what the
 * provider would see. The detector has its own positive control (a planted
 * pointed read it must flag), and every flow case first asserts that the
 * recorder saw traffic, so a dead transport cannot pass for a clean one.
 *
 * Runs under `vitest.pool.config.mts` (node).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Connection } from '@solana/web3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import { derivePoolSeedLegacy } from './seedDerivation';
import {
  createCommitmentV3,
  createNullifierV3,
  deriveNullifierPDA,
  findPoolV3,
  goldilocksU64To32,
  pubkeyToField,
  type ShareableNote,
} from './denominatedPool';
import { createNoteEncryptionAddress, encryptNote } from './noteCrypto';
import type { RecoveredNote } from './poolNotes';

// ---------------------------------------------------------------------------
// The recording transport
// ---------------------------------------------------------------------------

type RpcCall = { method: string; params: unknown };
const rpc: RpcCall[] = [];

/** Nullifier PDAs the fake chain holds, i.e. notes already spent. */
let spentPdas: string[] = [];

const ACCOUNT = {
  data: ['', 'base64'],
  executable: false,
  lamports: 1,
  owner: '11111111111111111111111111111111',
  rentEpoch: 0,
  space: 0,
};

function answer(method: string, params: unknown): unknown {
  switch (method) {
    case 'getAccountInfo': {
      const key = Array.isArray(params) ? String(params[0]) : '';
      return { context: { slot: 1 }, value: spentPdas.includes(key) ? ACCOUNT : null };
    }
    case 'getMultipleAccounts':
      return { context: { slot: 1 }, value: [] };
    case 'getProgramAccounts':
      return spentPdas.map((pubkey) => ({ pubkey, account: ACCOUNT }));
    case 'getSignaturesForAddress':
      return [];
    case 'getMinimumBalanceForRentExemption':
      return 1_000_000;
    default:
      return null;
  }
}

const recordingFetch = (async (_url: unknown, init?: { body?: unknown }) => {
  const body = JSON.parse(String(init?.body ?? 'null')) as
    | { id: unknown; method: string; params: unknown }
    | Array<{ id: unknown; method: string; params: unknown }>;
  const one = (r: { id: unknown; method: string; params: unknown }) => {
    rpc.push({ method: r.method, params: r.params });
    return { jsonrpc: '2.0', id: r.id, result: answer(r.method, r.params) };
  };
  const out = Array.isArray(body) ? body.map(one) : one(body);
  return new Response(JSON.stringify(out), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as unknown as typeof fetch;

vi.mock('../worker/pacedFetch', () => ({ createPacedFetch: () => recordingFetch }));

/** Does any recorded request carry `value` anywhere in its parameters? */
function rpcNames(value: string): RpcCall[] {
  return rpc.filter((c) => JSON.stringify(c.params ?? null).includes(value));
}

// ---------------------------------------------------------------------------
// Fixtures: one note in the 0.1 SOL pool whose commitment really recomputes
// ---------------------------------------------------------------------------

const SIGNATURE = new Uint8Array(64);
for (let i = 0; i < 64; i++) SIGNATURE[i] = (i * 7 + 3) & 0xff;
const SEED = derivePoolSeedLegacy(SIGNATURE);
const MY_ADDRESS = createNoteEncryptionAddress(SEED);
const META = 'meta-rpc-1';

const DENOM = 0.1;
const POOL = findPoolV3('SOL', DENOM)!;
const POOL_58 = POOL.poolPDA.toBase58();
const TOKEN_MINT_FIELD = pubkeyToField(POOL.tokenMint);

const SECRET = 918273645546372819n;
const NULLIFIER_PREIMAGE = 192837465564738291n;
/** A PRF-sized blinding, so the circuit-7 job does not refuse it as an epoch. */
const BLINDING = 7_284_991_002_338_477_113n;
const LEAF = 5;
const COMMITMENT = createCommitmentV3(NULLIFIER_PREIMAGE, SECRET, BLINDING, TOKEN_MINT_FIELD);

/** This note's nullifier PDA: the account a pointed read would name. */
const NULLIFIER_PDA = deriveNullifierPDA(
  POOL.poolPDA,
  goldilocksU64To32(createNullifierV3(NULLIFIER_PREIMAGE, SECRET)),
)[0].toBase58();

/** The fee payer of the deposit transaction: always a fresh ephemeral. */
const DEPOSIT_EPHEMERAL = '8Eq1jsbB6HxjF6ucupbHKik6nqTaL2u4mkKw3BnTfooe';

const RETAILER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

/** The blob shape `poolImportNote` files (source: 'received'). */
function blob(extra: Record<string, unknown> = { source: 'received' }): string {
  const note: ShareableNote & Record<string, unknown> = {
    version: 1,
    pool: POOL_58,
    secret: SECRET.toString(),
    nullifier_preimage: NULLIFIER_PREIMAGE.toString(),
    deposit_epoch: BLINDING.toString(),
    token_mint: TOKEN_MINT_FIELD.toString(),
    commitment: COMMITMENT.toString(),
    leafIndex: LEAF,
    token: 'SOL',
    denominationHuman: DENOM,
    shieldedAt: 1_700_000_000_000,
    ...extra,
  };
  return encryptNote(MY_ADDRESS, utf8ToBytes(JSON.stringify(note)));
}

const SEED_NOTE: RecoveredNote = {
  counter: LEAF,
  spent: false,
  receipt: {
    secret: SECRET,
    nullifierPreimage: NULLIFIER_PREIMAGE,
    noteBlinding: BLINDING,
    tokenMint: TOKEN_MINT_FIELD,
    commitment: COMMITMENT,
    leafIndex: LEAF,
    denomination: 100_000_000n,
    pool: POOL_58,
    token: 'SOL',
    denominationHuman: DENOM,
    shieldedAt: 1_700_000_000_000,
    source: 'shielded',
  },
} as unknown as RecoveredNote;

/** What the seed search finds. Empty = the note is only in a blob. */
let seedNotes: RecoveredNote[] = [];

// ---------------------------------------------------------------------------
// Module stubs. None of them is on the path the RPC assertions measure.
// ---------------------------------------------------------------------------

vi.mock('./denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./denominatedPool')>();
  return {
    ...actual,
    // [flow-speed W1] The circuit-7 WITHDRAWAL job is real up to its prepare,
    // which stops on a sentinel (no fallback needle, so the handler rethrows).
    prepareUnshieldV4: async () => {
      throw new Error('STOP: the circuit-7 withdrawal proof was reached');
    },
    // The history walk is pool-keyed (HIST-1 / SPEND-1 own it). A map is served
    // here so the leaf carries a deposit payer, which is what the subscribe
    // prepare used to walk. The spent-set read and its membership test stay REAL.
    fetchPoolCommitments: async () =>
      new Map([
        [
          COMMITMENT.toString(),
          {
            commitment: COMMITMENT,
            leafIndex: LEAF,
            depositPayer: DEPOSIT_EPHEMERAL,
            depositSlot: 1234,
            signature: 'DEPOSIT_SIGNATURE',
          },
        ],
      ]),
  };
});

vi.mock('./poolNotes', () => ({
  scanPoolForSeed: async () => ({ notes: [] }),
  recoverNotes: async (_c: unknown, _p: unknown, _s: unknown, o?: { onlyLeaf?: number }) =>
    seedNotes.filter((n) => o?.onlyLeaf === undefined || n.receipt.leafIndex === o.onlyLeaf),
}));
vi.mock('./recoverFloat', () => ({ recoverStuckFloat: async () => [] }));
vi.mock('./shieldEphemeral', () => ({
  readTreeLeafCount: async () => 0,
  prepareShield: async () => {
    throw new Error('not exercised');
  },
  executeShield: async () => {
    throw new Error('not exercised');
  },
  recordShieldBreadcrumb: async () => undefined,
}));
vi.mock('./starkProver', () => ({
  starkProver: { start: async () => undefined, computeCommitment: async () => '424242' },
}));
vi.mock('./unshieldEphemeral', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./unshieldEphemeral')>();
  return {
    ...actual,
    prepareUnshieldJob: async () => ({
      jobId: 'unshield-job',
      ephemeral: { publicKey: { toBase58: () => 'EPH_UNSHIELD' } },
      requiredLamports: 42,
    }),
  };
});
// The v3 subscribe job is a stub so the prepare answers; the circuit-7 job is
// REAL up to its proof, which is replaced by a sentinel throw (not a fallback
// needle, so the handler rethrows it).
vi.mock('./subscribeEphemeral', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./subscribeEphemeral')>();
  return {
    ...actual,
    prepareSubscribeJob: async (receipt: unknown) => ({
      jobId: 'subscribe-v3-job',
      receipt,
      ephemeral: { publicKey: { toBase58: () => 'EPH_SUBSCRIBE' } },
      requiredLamports: 43,
    }),
  };
});
vi.mock('./subscribePrivateStarkV4', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./subscribePrivateStarkV4')>();
  return {
    ...actual,
    prepareSubscribeV4: async () => {
      throw new Error('STOP: the circuit-7 proof was reached');
    },
  };
});

const { clearPoolState, configurePoolHandlers, handlePoolRequest, setPoolSeed } = await import(
  '../worker/poolHandlers'
);

beforeEach(() => {
  rpc.length = 0;
  spentPdas = [];
  seedNotes = [];
  clearPoolState();
  configurePoolHandlers('http://rpc.invalid');
  setPoolSeed(META, SIGNATURE);
});

const base = { meta: META, token: 'SOL' as const, denomination: DENOM, leafIndex: LEAF };

// ===========================================================================

describe('the detector', () => {
  it('flags a planted pointed read and ignores the pool-wide one (positive control)', async () => {
    const conn = new Connection('http://rpc.invalid', { fetch: recordingFetch });
    await conn.getProgramAccounts(POOL.poolPDA);
    expect(rpcNames(NULLIFIER_PDA)).toEqual([]);
    await conn.getAccountInfo(deriveNullifierPDA(
      POOL.poolPDA,
      goldilocksU64To32(createNullifierV3(NULLIFIER_PREIMAGE, SECRET)),
    )[0]);
    expect(rpcNames(NULLIFIER_PDA).map((c) => c.method)).toEqual(['getAccountInfo']);
  });
});

describe('export, received withdrawal and subscribe prepare read no nullifier PDA', () => {
  it('export of a received note', async () => {
    const res = await handlePoolRequest({
      kind: 'poolExportNote' as const,
      ...base,
      recipientAddress: createNoteEncryptionAddress(new Uint8Array(32).fill(0x42)),
      encryptedNotes: [blob()],
    });
    expect(res.sealedNote).toMatch(/^p01enc1:/);
    // Anti-vacuity: the transport under the handler is the recorder.
    expect(rpc.length).toBeGreaterThan(0);
    expect(rpcNames(NULLIFIER_PDA)).toEqual([]);
    expect(rpc.filter((c) => c.method === 'getProgramAccounts').length).toBe(1);
  });

  it('withdrawal prepare of a received note', async () => {
    await handlePoolRequest({
      kind: 'poolUnshieldPrepare' as const,
      ...base,
      encryptedNotes: [blob()],
    });
    expect(rpc.length).toBeGreaterThan(0);
    expect(rpcNames(NULLIFIER_PDA)).toEqual([]);
    expect(rpc.filter((c) => c.method === 'getProgramAccounts').length).toBe(1);
  });

  it('circuit-7 subscribe prepare of a note the seed search finds', async () => {
    seedNotes = [SEED_NOTE];
    await expect(
      handlePoolRequest({
        kind: 'poolSubscribePrepare' as const,
        ...base,
        retailer: RETAILER,
        rate: '250000',
        intervalSlots: '216000',
      }),
    ).rejects.toThrow(/STOP: the circuit-7 proof was reached/);
    expect(rpc.length).toBeGreaterThan(0);
    expect(rpcNames(NULLIFIER_PDA)).toEqual([]);
    // One pool-wide spent-set read for the whole request: the job reuses the
    // set the handler already read. A job that re-reads it on its own sends a
    // second, heavier getProgramAccounts (fix round 1, mutant V1).
    expect(rpc.filter((c) => c.method === 'getProgramAccounts').length).toBe(1);
  });

  it('[flow-speed W1] circuit-7 withdrawal prepare reads the spent set ONCE, seed note and received note', async () => {
    // RED at HEAD: 2 getProgramAccounts, the handler's and the job's own
    // byte-identical second read.
    for (const world of ['seed', 'received'] as const) {
      rpc.length = 0;
      seedNotes = world === 'seed' ? [SEED_NOTE] : [];
      await expect(
        handlePoolRequest({
          kind: 'poolUnshieldPrepare' as const,
          ...base,
          recipient: RETAILER,
          ownerPubkey: DEPOSIT_EPHEMERAL,
          ...(world === 'received' ? { encryptedNotes: [blob()] } : {}),
        }),
      ).rejects.toThrow(/STOP: the circuit-7 withdrawal proof was reached/);
      expect(rpc.length, world).toBeGreaterThan(0);
      expect(rpcNames(NULLIFIER_PDA), world).toEqual([]);
      expect(rpc.filter((c) => c.method === 'getProgramAccounts').length, world).toBe(1);
    }
  });

  it('[flow-speed W1] the refusal of a spent note survives on the circuit-7 withdrawal', async () => {
    spentPdas = [NULLIFIER_PDA];
    seedNotes = [];
    await expect(
      handlePoolRequest({
        kind: 'poolUnshieldPrepare' as const,
        ...base,
        recipient: RETAILER,
        ownerPubkey: DEPOSIT_EPHEMERAL,
        encryptedNotes: [blob()],
      }),
    ).rejects.toThrow(/already been withdrawn/);
    expect(rpc.filter((c) => c.method === 'getProgramAccounts').length).toBe(1);
    expect(rpcNames(NULLIFIER_PDA)).toEqual([]);
  });

  it('a spent received note is still refused, from the pool-wide set', async () => {
    // The refusal must survive the change. Both reads answer "spent" here, so
    // the refusal alone does not tell the pointed read from the pool-wide one;
    // the PDA assertion does.
    spentPdas = [NULLIFIER_PDA];
    await expect(
      handlePoolRequest({ kind: 'poolUnshieldPrepare' as const, ...base, encryptedNotes: [blob()] }),
    ).rejects.toThrow(/already been withdrawn/);
    expect(rpc.some((c) => c.method === 'getProgramAccounts')).toBe(true);
    expect(rpcNames(NULLIFIER_PDA)).toEqual([]);
  });
});

describe('subscribe prepare never names the depositing ephemeral', () => {
  it('no RPC parameter equals depositPayer', async () => {
    seedNotes = [SEED_NOTE];
    const res = await handlePoolRequest({ kind: 'poolSubscribePrepare' as const, ...base });
    expect(res.jobId).toBe('subscribe-v3-job');
    expect(rpc.length).toBeGreaterThan(0);
    expect(rpcNames(DEPOSIT_EPHEMERAL)).toEqual([]);
  });
});

describe('the worker reports where the note came from, from local facts only', () => {
  it('a note the seed search finds is an own deposit', async () => {
    seedNotes = [SEED_NOTE];
    const res = await handlePoolRequest({ kind: 'poolSubscribePrepare' as const, ...base });
    expect((res as unknown as { noteProvenance?: string }).noteProvenance).toBe('own-deposit');
  });

  it('a blob filed by the import is received', async () => {
    const res = await handlePoolRequest({
      kind: 'poolSubscribePrepare' as const,
      ...base,
      encryptedNotes: [blob()],
    });
    expect((res as unknown as { noteProvenance?: string }).noteProvenance).toBe('received');
  });

  it('a blob with no source marker (the shield-time blob) is an own deposit', async () => {
    const res = await handlePoolRequest({
      kind: 'poolSubscribePrepare' as const,
      ...base,
      encryptedNotes: [blob({})],
    });
    expect((res as unknown as { noteProvenance?: string }).noteProvenance).toBe('own-deposit');
  });
});

// ---------------------------------------------------------------------------
// Source scan: no non-test caller of the pointed read is left in apps/web
// ---------------------------------------------------------------------------

const WEB = join(__dirname, '../../..');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) sources(abs, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(name) && !/\.test\.[a-z]+$/.test(name)) out.push(abs);
  }
  return out;
}

describe('no non-test caller of isNullifierSpent(', () => {
  it('the web app source has none', () => {
    const files = ['lib', 'app', 'components', 'scripts'].flatMap((d) => sources(join(WEB, d)));
    const hits: string[] = [];
    let setCallers = 0;
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (/\bisNullifierSpentInSet\(/.test(text)) setCallers += 1;
      text.split(/\r?\n/).forEach((line, i) => {
        if (/\bisNullifierSpent\(/.test(line)) hits.push(`${f.slice(WEB.length + 1)}:${i + 1}`);
      });
    }
    // Anti-vacuity: the walk reached the files that use the pool-wide form.
    expect(setCallers).toBeGreaterThan(3);
    expect(hits).toEqual([]);
  });
});
