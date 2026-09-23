/**
 * A BROWSER THAT REFUSES TO STORE ANYTHING MUST NOT BE LET PAY, AND A NOTE
 * WHOSE ONLY COPY COULD NOT BE WRITTEN MUST NOT BE REPORTED COLLECTED.
 *
 * Run: cd apps/web && pnpm test:pool
 *
 * THE RULE (pendingContribution.ts, header): once money cannot be un-spent,
 * what the buyer is owed must survive a reload. Audit v1 round 1 (client
 * axis) measured both halves failing silently when `localStorage` refuses
 * writes, which a full origin quota does, and Firefox with `dom.storage`
 * disabled does for every access (`localStorage` is `null` there):
 *
 *   - `exchangeNoteForIssued` spent the held note to the till, collected,
 *     and RESOLVED, with no receipt, no claim and no note blob on disk;
 *   - `requestIssuedNote` resolved with the issued note although
 *     `storeEncryptedNote` had swallowed the refusal of both of its writes,
 *     and an issued or received note's blob is its only record;
 *   - `contributeToPool` paid the till after `rememberContribution` had
 *     returned an id for a record that was never written.
 *
 * What is real here: shieldClient, pendingContribution, the sealed store and
 * the worker's store handlers under a real identity. Stubbed: the proving
 * worker kinds, the funder, and the deployment's HTTP answers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import nacl from 'tweetnacl';

const poolRequest = vi.fn();
vi.mock('../workerClient', () => ({
  poolRequest: (...args: unknown[]) => poolRequest(...args),
}));

const fundEphemeralForJob = vi.fn();
vi.mock('./ephemeralFunder', () => ({
  fundEphemeralForJob: (...args: unknown[]) => fundEphemeralForJob(...args),
  fetchFunderLookup: async () => ({ configured: true, funder: FUNDER }),
  funderTicket: () => 'test-ticket',
  // [shield-speed H] contributeToPool now asks for the relay terms beside its
  // prepare; the funder is mocked here, so the handle is never awaited.
  prefetchRelayTerms: () => ({
    terms: new Promise(() => undefined),
    answeredAt: () => null,
    abort: () => undefined,
  }),
}));

vi.mock('./denominatedPool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./denominatedPool')>()),
  findPoolV3: () => ({
    poolPDA: new PublicKey(POOL),
    token: 'SOL',
    denomination: 1,
    denominationAtomic: 1_000_000_000n,
    decimals: 9,
  }),
}));

import {
  contributeToPool,
  exchangeNoteForIssued,
  requestIssuedNote,
  loadEncryptedNotes,
  ExchangeAfterSpendError,
} from '../shieldClient';
import { handlePoolRequest, setPoolSeed, type PoolNoteView } from '../worker/poolHandlers';

const wallet = Keypair.generate();
const OWNER = wallet.publicKey;
const TILL = 'BQWLmnLmQPzQvJVGrJyBRA6RPBEqMhMQZ5oXQKmDMhcE';
const FUNDER = 'QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB';
const POOL = 'HfSsGRgVFJGBiiEtRXrHocNPw5dyTQ78hEZH8GWpXaAG';
const EPHEMERAL = 'SysvarC1ock11111111111111111111111111111111';
const LEAF = 16;

const ISSUED_NOTE: PoolNoteView = {
  pool: POOL,
  token: 'SOL',
  denomination: 1,
  counter: 0,
  leafIndex: 21,
  commitment: '777',
  spent: false,
  derivation: 1,
  spentKnown: false,
};

const signMessage = async (message: Uint8Array) => nacl.sign.detached(message, wallet.secretKey);

type Req = Record<string, unknown>;

function kinds(): string[] {
  return poolRequest.mock.calls.map((c) => String((c[0] as Req).kind));
}

function json(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}

/** Every route the three flows reach, answering as a healthy deployment does. */
function stubDeployment() {
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    if (url === '/api/contribute-note' && method === 'POST') {
      if (body?.action === 'reserve') {
        return json(200, { ok: true, leafIndex: LEAF, commitment: '123', denomination: 1, token: 'SOL' });
      }
      if (body?.action === 'confirm') return json(200, { ok: true, claimCode: 'CONFIRMED', leafIndex: LEAF });
    }
    if (url === '/api/claim-for-payment' && method === 'GET') {
      return json(200, {
        ok: true,
        configured: true,
        till: TILL,
        priceLamports: 1_000_000_000,
        withdrawalFloorLamports: 995_000_000,
        reasons: [],
      });
    }
    if (url === '/api/claim-for-payment' && method === 'POST') {
      return json(200, { ok: true, claimCode: 'CLAIM', kind: 'pool-withdrawal', payer: EPHEMERAL });
    }
    if (url === '/api/issue-note' && method === 'GET') {
      return json(200, { ok: true, configured: true, denomination: 1, token: 'SOL' });
    }
    if (url === '/api/issue-note' && method === 'POST') {
      return json(200, { ok: true, sealedNote: 'p01enc1:SEALED', disclosure: 'DISCLOSURE' });
    }
    throw new Error(`unexpected fetch ${method} ${String(url)}`);
  });
}

/** Called the moment the spend lands, so a case can make storage fail after it. */
let afterSpend: () => void = () => {};

function stubWorker() {
  poolRequest.mockImplementation(async (req: Req) => {
    switch (req.kind) {
      case 'poolContributePrepare':
        return {
          kind: 'poolContributePrepare',
          jobId: `contribute:${POOL}:${LEAF}`,
          ephemeralPubkey: EPHEMERAL,
          requiredLamports: 1_573_486_080,
          valueLamports: 1_003_475_300,
          denomination: 1,
          leafIndex: LEAF,
        };
      case 'poolContributeExecute':
        return { kind: 'poolContributeExecute', txSig: 'DEPOSIT', leafIndex: LEAF, commitment: '123' };
      case 'poolUnshieldPrepare':
        return {
          kind: 'poolUnshieldPrepare',
          jobId: `unshield-v4:${POOL}:${LEAF}:${TILL}`,
          ephemeralPubkey: EPHEMERAL,
          requiredLamports: 231,
          denomination: 1,
          derivation: 'v1',
          version: 'v4',
        };
      case 'poolUnshieldExecute':
        afterSpend();
        return {
          kind: 'poolUnshieldExecute',
          txSig: 'TXSIG',
          denomination: 1,
          feePayer: EPHEMERAL,
          ...(req.signClaim ? { claimProof: 'PROOF' } : {}),
        };
      case 'poolNoteAddress':
      case 'poolStoreLabel':
      case 'poolOpenRecords':
      case 'poolIssueAddress':
        return handlePoolRequest(req as never);
      case 'poolImportNote':
        return { kind: 'poolImportNote', encryptedNote: 'BLOB', note: ISSUED_NOTE, merklePath: 'stored' };
      default:
        throw new Error(`unexpected worker request: ${String(req.kind)}`);
    }
  });
}

/**
 * A Storage whose writes can be refused by a rule. `refuse(key, value)`
 * returning true throws the QuotaExceededError a browser throws.
 */
function installStorage(refuse: (key: string, value: string) => boolean = () => false) {
  const backing = new Map<string, string>();
  const refused: string[] = [];
  const state = { refuse };
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (state.refuse(k, v)) {
        refused.push(k);
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      backing.set(k, v);
    },
    removeItem: (k: string) => void backing.delete(k),
  });
  return { backing, refused, state };
}

function contribute() {
  return contributeToPool({
    meta: 'meta',
    token: 'SOL',
    denomination: 1,
    owner: OWNER,
    connection: {} as Connection,
    signOne: async (t) => t,
    signMessage,
  });
}

function exchange() {
  return exchangeNoteForIssued({
    meta: 'meta',
    token: 'SOL',
    denomination: 1,
    leafIndex: LEAF,
    pool: POOL,
    owner: OWNER,
    connection: {} as Connection,
    signOne: async (t) => t,
    claimRetry: { attempts: 2, delayMs: 0 },
  });
}

async function settle<T>(p: Promise<T>): Promise<{ value?: T; error?: Error }> {
  try {
    return { value: await p };
  } catch (e) {
    return { error: e as Error };
  }
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  afterSpend = () => {};
  setPoolSeed('meta', new Uint8Array(64).fill(17));
  vi.stubEnv('NEXT_PUBLIC_P01_FUNDER_TICKET', 'test-ticket');
  fundEphemeralForJob.mockResolvedValue({
    fundedBy: 'funder',
    sweepTo: FUNDER,
    funderSignature: 'RELAYSIG',
    operatorFeeLamports: 10_000_000,
    paymentSignature: 'PAYSIG',
  });
  stubWorker();
  stubDeployment();
});

describe('exchange: a note is never spent into a browser that cannot keep the receipt', () => {
  // [close-v1 F70] The exchange is off by default; these cases are about the
  // receipt of an exchange that runs, so they switch it on.
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_P01_ALLOW_NOTE_EXCHANGE', '1');
  });

  it('refuses BEFORE the spend when every write is refused (full quota)', async () => {
    const { refused } = installStorage(() => true);
    const out = await settle(exchange());
    console.log('[exchange/quota] error =', out.error?.message ?? 'none', '; refused =', JSON.stringify(refused));
    expect(kinds()).not.toContain('poolUnshieldExecute');
    expect(out.error?.message).toMatch(/Nothing was spent/);
    expect(out.error).not.toBeInstanceOf(ExchangeAfterSpendError);
  });

  it('refuses BEFORE the spend when localStorage is null (Firefox, dom.storage disabled)', async () => {
    vi.stubGlobal('localStorage', null);
    const out = await settle(exchange());
    console.log('[exchange/null] error =', out.error?.message ?? 'none');
    expect(kinds()).not.toContain('poolUnshieldExecute');
    expect(out.error?.message).toMatch(/Nothing was spent/);
  });

  it('does not report success when storage starts refusing after the spend, and does not claim the receipt was kept', async () => {
    const storage = installStorage();
    afterSpend = () => {
      storage.state.refuse = () => true;
    };
    const out = await settle(exchange());
    console.log('[exchange/after-spend] error =', out.error?.message ?? 'none', '; refused =', JSON.stringify(storage.refused));
    expect(out.value).toBeUndefined();
    expect(out.error).toBeInstanceOf(ExchangeAfterSpendError);
    expect((out.error as ExchangeAfterSpendError).spendSig).toBe('TXSIG');
    // Nothing on this device says a note is owed, so the error must not say so.
    expect(out.error!.message).not.toMatch(/kept on this device/);
  });

  it('control: with storage working, the exchange completes and keeps the issued note', async () => {
    installStorage();
    const out = await exchange();
    expect(out.issued.note.leafIndex).toBe(21);
    expect(await loadEncryptedNotes('meta', OWNER.toBase58())).toContain('BLOB');
  });
});

describe('contribution: the till is never paid while the owed-record is not on disk', () => {
  it('refuses before any payment when storage takes small probes but not a record (near-full quota)', async () => {
    // A tiny probe ('1', a few bytes) fits; anything record-sized does not.
    // This is the shape the funder's own write probe cannot see.
    const { refused } = installStorage((_k, v) => v.length > 64);
    const out = await settle(contribute());
    console.log('[contribute/near-full] error =', out.error?.message ?? 'none', '; refused =', JSON.stringify(refused));
    expect(fundEphemeralForJob).not.toHaveBeenCalled();
    expect(out.error?.message).toMatch(/Nothing was paid/);
  });

  it('refuses before any payment when only the owed-record write is refused', async () => {
    const { refused } = installStorage((k) => k.startsWith('p01:pending-contribution'));
    const out = await settle(contribute());
    console.log('[contribute/record-only] error =', out.error?.message ?? 'none', '; refused =', JSON.stringify(refused));
    expect(fundEphemeralForJob).not.toHaveBeenCalled();
    expect(out.error?.message).toMatch(/Nothing was paid/);
  });

  it('control: with storage working, the contribution pays and records', async () => {
    installStorage();
    const out = await contribute();
    expect(fundEphemeralForJob).toHaveBeenCalledTimes(1);
    expect(out.claimCode).toBe('CONFIRMED');
  });
});

describe('an issued note is not reported collected when its only copy could not be written', () => {
  it('requestIssuedNote rejects when both note-store writes are refused', async () => {
    const { refused } = installStorage((k) => k.startsWith('p01_pay_notes') || k.startsWith('p01_pay_device_note'));
    const out = await settle(
      requestIssuedNote({
        meta: 'meta',
        walletPubkey: OWNER.toBase58(),
        token: 'SOL',
        denomination: 1,
        claimCode: 'CLAIM',
      }),
    );
    console.log('[issued/refused] value leaf =', out.value?.note.leafIndex, '; error =', out.error?.message ?? 'none', '; refused =', JSON.stringify(refused));
    expect(out.value).toBeUndefined();
    expect(out.error?.message).toMatch(/could not be saved/i);
    expect(await loadEncryptedNotes('meta', OWNER.toBase58())).toEqual([]);
  });

  it('control: with storage working, the issued note is stored', async () => {
    installStorage();
    const out = await requestIssuedNote({
      meta: 'meta',
      walletPubkey: OWNER.toBase58(),
      token: 'SOL',
      denomination: 1,
      claimCode: 'CLAIM',
    });
    expect(out.note.leafIndex).toBe(21);
    expect(await loadEncryptedNotes('meta', OWNER.toBase58())).toContain('BLOB');
  });
});
