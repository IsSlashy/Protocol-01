/**
 * THE CONTRIBUTION'S FALLBACK: a buyer who paid the till and whose deposit
 * then failed is still handed the note the payment bought.
 *
 * Run: cd apps/web && pnpm test:pool
 *
 * THE FAILURE THIS PINS. `contributeToPool` pays at `fundEphemeralForJob`,
 * then executes the deposit, then confirms. A throw after the payment used to
 * leave the buyer paid with no claim, and the payment signature died in a
 * local `const` inside the funder. MEASURED 2026-08-31: five faults, about
 * four SOL, discovered by paying.
 *
 * Now the signature comes back out, the confirm proves who paid, and when the
 * deposit does not land the same payment and the same proof go to
 * `/api/claim-for-payment` with the reservation they were bound to. What is
 * measured here is the wire: which route was called with which body, and
 * that the proof verifies under the wallet over the right challenge.
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

// Partial: the real store handlers below load the real module; only the
// pool lookup the client makes is pinned.
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

import { contributeToPool, fetchIssuableNote, resumeContribution } from '../shieldClient';
import { claimChallenge } from '../claimChallenge';
import { handlePoolRequest, setPoolSeed, type PoolNoteView } from '../worker/poolHandlers';
import { pendingRecords as openPending } from '../pendingContribution';

const wallet = Keypair.generate();
const OWNER = wallet.publicKey;
const FUNDER = 'QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB';
const POOL = 'HfSsGRgVFJGBiiEtRXrHocNPw5dyTQ78hEZH8GWpXaAG';
const EPHEMERAL = 'SysvarC1ock11111111111111111111111111111111';
/** The leaf the treasury reserved: the buyer funds it and never owns it. */
const LEAF = 41;

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

/** The wallet's signer, as an adapter exposes it. */
const signMessage = async (message: Uint8Array) => nacl.sign.detached(message, wallet.secretKey);

function verifiesUnderWallet(proofB64: string, signature: string): boolean {
  return nacl.sign.detached.verify(
    new Uint8Array(Buffer.from(claimChallenge(signature), 'utf8')),
    new Uint8Array(Buffer.from(proofB64, 'base64')),
    OWNER.toBytes(),
  );
}

type Req = Record<string, unknown>;
type Call = { method: string; url: string; body?: Record<string, unknown> };

let calls: Call[] = [];
function posts(url: string, action?: string): Call[] {
  return calls.filter(
    (c) => c.method === 'POST' && c.url === url && (action === undefined || c.body?.action === action),
  );
}

function json(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}

/**
 * The deployment. `confirm` and `claim` each either answer with a code or
 * refuse with the given status, so the four orderings the design lists can
 * be walked one by one.
 */
function stubDeployment(opts: { confirm?: number; claim?: number } = {}) {
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, url: String(url), body });

    if (url === '/api/contribute-note' && method === 'POST') {
      if (body?.action === 'reserve') {
        return json(200, { ok: true, leafIndex: LEAF, commitment: '123', denomination: 1, token: 'SOL' });
      }
      if (body?.action === 'confirm') {
        if (opts.confirm) {
          return json(opts.confirm, { ok: false, error: 'the treasury commitment is not at that leaf' });
        }
        return json(200, { ok: true, claimCode: 'CONFIRMED', leafIndex: LEAF });
      }
    }
    if (url === '/api/claim-for-payment' && method === 'POST') {
      if (opts.claim) {
        return json(opts.claim, { ok: false, error: 'the deposit this payment funded landed; confirm it' });
      }
      return json(200, { ok: true, claimCode: 'FALLBACK', kind: 'transfer', payer: OWNER.toBase58() });
    }
    if (url === '/api/issue-note' && method === 'POST') {
      // No leafIndex: the route stopped sending one (`__tests__/api/
      // issue-note.node.test.ts` "are not left expecting a field the reply no
      // longer carries"), so the leaf asserted below is the opened note's.
      return json(200, { ok: true, sealedNote: 'p01enc1:SEALED', disclosure: 'D' });
    }
    throw new Error(`unexpected fetch ${method} ${String(url)}`);
  });
}

/** What the pending store held when the deposit was attempted. */
let storeAtExecute: Array<Record<string, unknown>> | null = null;

/** The worker. `execute: 'throw'` is the worker going quiet after the till was paid. */
function stubWorker(execute: 'ok' | 'throw') {
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
        storeAtExecute = await pendingRecords();
        if (execute === 'throw') throw new Error('the worker went quiet');
        return { kind: 'poolContributeExecute', txSig: 'DEPOSIT', leafIndex: LEAF, commitment: '123' };
      // The pending record is sealed and opened for real (DEV-1): these kinds
      // go to the real handlers, under a real identity.
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

function installStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  });
  return backing;
}

/** The store a build before DEV-1 wrote, in clear: what `seed` below plants. */
const PENDING_KEY = 'p01:pending-contribution:v1';
let storage: Map<string, string>;
/** The pending records, as the store opens them (they are sealed on disk). */
async function pendingRecords(): Promise<Array<Record<string, unknown>>> {
  return (await openPending('meta', OWNER.toBase58())) as unknown as Array<Record<string, unknown>>;
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

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  calls = [];
  storeAtExecute = null;
  storage = installStorage();
  setPoolSeed('meta', new Uint8Array(64).fill(11));
  vi.stubEnv('NEXT_PUBLIC_P01_FUNDER_TICKET', 'test-ticket');
  fundEphemeralForJob.mockResolvedValue({
    fundedBy: 'funder',
    sweepTo: FUNDER,
    funderSignature: 'RELAYSIG',
    operatorFeeLamports: 10_000_000,
    paymentSignature: 'PAYSIG',
  });
  stubWorker('ok');
  stubDeployment();
});

// ===========================================================================

describe('the ordinary contribution, now signed', () => {
  it('tells the funder which reservation the payment is for', async () => {
    await contribute();
    const req = fundEphemeralForJob.mock.calls[0]![0] as Record<string, unknown>;
    expect(req.contribution).toEqual({ token: 'SOL', leafIndex: LEAF });
    expect(req.relayThroughDeployment).toBe(true);
  });

  it('records the payment BEFORE the deposit is attempted', async () => {
    await contribute();
    expect(storeAtExecute).not.toBeNull();
    expect(storeAtExecute![0]).toMatchObject({
      owner: OWNER.toBase58(),
      leafIndex: LEAF,
      paymentSignature: 'PAYSIG',
    });
  });

  it('confirms with the payment and a proof that verifies under the wallet', async () => {
    const out = await contribute();

    const confirms = posts('/api/contribute-note', 'confirm');
    expect(confirms).toHaveLength(1);
    const body = confirms[0]!.body!;
    expect(body).toMatchObject({ token: 'SOL', leafIndex: LEAF, paymentSignature: 'PAYSIG' });
    expect(verifiesUnderWallet(String(body.proof), 'PAYSIG')).toBe(true);
    // Over THIS payment: the same proof says nothing about another.
    expect(verifiesUnderWallet(String(body.proof), 'OTHER')).toBe(false);

    expect(out).toMatchObject({
      txSig: 'DEPOSIT',
      leafIndex: LEAF,
      claimCode: 'CONFIRMED',
      fundedBy: 'funder',
      depositLanded: true,
    });
    // No fallback was needed, so none was made.
    expect(posts('/api/claim-for-payment')).toEqual([]);
  });

  it('refuses before any payment when the record could not be sealed', async () => {
    // DEV-1: the record written before the wallet is asked is sealed, which
    // needs this identity's store session. Without one nothing is paid.
    await expect(
      contributeToPool({
        meta: 'meta-that-never-signed',
        token: 'SOL',
        denomination: 1,
        owner: OWNER,
        connection: {} as Connection,
        signOne: async (t) => t,
        signMessage,
      }),
    ).rejects.toThrow(/No pool keys/);
    expect(fundEphemeralForJob).not.toHaveBeenCalled();
    expect(poolRequest.mock.calls.map((c) => (c[0] as Req).kind)).not.toContain('poolContributePrepare');
  });
});

describe('the deposit fails after the till was paid', () => {
  it('collects through claim-for-payment with the wallet proof and the reservation', async () => {
    stubWorker('throw');
    const out = await contribute();

    const claims = posts('/api/claim-for-payment');
    expect(claims).toHaveLength(1);
    const body = claims[0]!.body!;
    expect(body).toMatchObject({
      signature: 'PAYSIG',
      contribution: { token: 'SOL', leafIndex: LEAF },
    });
    expect(verifiesUnderWallet(String(body.proof), 'PAYSIG')).toBe(true);
    // Nothing landed, so nothing was confirmed.
    expect(posts('/api/contribute-note', 'confirm')).toEqual([]);

    expect(out).toMatchObject({
      txSig: '',
      leafIndex: LEAF,
      claimCode: 'FALLBACK',
      depositLanded: false,
    });
    // The record carries what a resume would need, and the code it earned.
    expect((await pendingRecords())[0]).toMatchObject({
      leafIndex: LEAF,
      paymentSignature: 'PAYSIG',
      claimCode: 'FALLBACK',
    });
  });

  it('makes no fallback for a wallet-paid job, which bought nothing from the till', async () => {
    fundEphemeralForJob.mockResolvedValue({ fundedBy: 'wallet', sweepTo: OWNER.toBase58() });
    stubWorker('throw');
    await expect(contribute()).rejects.toThrow(/went quiet/);
    expect(posts('/api/claim-for-payment')).toEqual([]);
  });

  it('carries both refusals when the fallback is refused too, and keeps the receipt', async () => {
    stubWorker('throw');
    stubDeployment({ claim: 409 });
    const err = await contribute().catch((e: Error) => e);

    expect(String((err as Error).message)).toMatch(/went quiet/);
    expect(String((err as Error).message)).toMatch(/landed; confirm it/);
    expect(String((err as Error).message)).toMatch(/PAYSIG/);
    const [record] = await pendingRecords();
    expect(record).toMatchObject({ leafIndex: LEAF, paymentSignature: 'PAYSIG' });
    expect(record).not.toHaveProperty('claimCode');
  });
});

describe('resuming what was already paid for', () => {
  function seed(record: Record<string, unknown>) {
    storage.set(
      PENDING_KEY,
      JSON.stringify([
        { owner: OWNER.toBase58(), token: 'SOL', denomination: 1, leafIndex: LEAF, at: 1, ...record },
      ]),
    );
  }

  it('confirms first, with the recorded payment and a fresh proof', async () => {
    seed({ paymentSignature: 'PAYSIG' });
    const issued = await resumeContribution({ meta: 'meta', owner: OWNER, signMessage });

    const confirms = posts('/api/contribute-note', 'confirm');
    expect(confirms).toHaveLength(1);
    expect(confirms[0]!.body).toMatchObject({ leafIndex: LEAF, paymentSignature: 'PAYSIG' });
    expect(verifiesUnderWallet(String(confirms[0]!.body!.proof), 'PAYSIG')).toBe(true);
    expect(posts('/api/claim-for-payment')).toEqual([]);
    expect(issued?.leafIndex).toBe(21);
    expect(await pendingRecords()).toEqual([]);
  });

  it('falls back on the payment when confirm refuses', async () => {
    seed({ paymentSignature: 'PAYSIG' });
    stubDeployment({ confirm: 409 });
    const issued = await resumeContribution({ meta: 'meta', owner: OWNER, signMessage });

    expect(posts('/api/contribute-note', 'confirm')).toHaveLength(1);
    const claims = posts('/api/claim-for-payment');
    expect(claims).toHaveLength(1);
    expect(claims[0]!.body).toMatchObject({
      signature: 'PAYSIG',
      contribution: { token: 'SOL', leafIndex: LEAF },
    });
    expect(issued?.leafIndex).toBe(21);
  });

  it('goes straight to redeeming when the record already holds a code', async () => {
    seed({ paymentSignature: 'PAYSIG', claimCode: 'FALLBACK' });
    const issued = await resumeContribution({ meta: 'meta', owner: OWNER });
    expect(posts('/api/contribute-note', 'confirm')).toEqual([]);
    expect(posts('/api/claim-for-payment')).toEqual([]);
    expect(posts('/api/issue-note')[0]!.body).toMatchObject({ claimCode: 'FALLBACK' });
    expect(issued?.leafIndex).toBe(21);
  });

  it('refuses without a message signer, and asks for nothing', async () => {
    seed({ paymentSignature: 'PAYSIG' });
    await expect(resumeContribution({ meta: 'meta', owner: OWNER })).rejects.toThrow(
      /message signer/,
    );
    expect(posts('/api/contribute-note', 'confirm')).toEqual([]);
    expect(posts('/api/claim-for-payment')).toEqual([]);
  });

  it('says so for a paymentless record whose reservation could still be live', async () => {
    // Inside the reserve window the deployment still holds this leaf for this
    // buyer, so the attempt may be in flight: refusing loudly is right, and the
    // message tells them not to pay again.
    seed({ at: Date.now() - 60_000 });
    await expect(
      resumeContribution({ meta: 'meta', owner: OWNER, signMessage }),
    ).rejects.toThrow(/without its payment signature/);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('🚨 does not resume a paymentless reservation the deployment has already reclaimed', async () => {
    /**
     * THE DOUBLE PAYMENT THIS CLOSES. A buyer who reserved a leaf and then
     * dismissed the wallet prompt left a record with no `paymentSignature`, and
     * `pendingFor` returned the OLDEST record of any shape. So that dead record
     * was picked on every later resume, the throw above fired every time,
     * `PoolPanel` swallowed it by design ("a resume that throws would BLOCK an
     * ordinary shield"), and the buyer paid a second full denomination. Worse,
     * a LATER record that DID carry a payment was never even looked at.
     *
     * Past the reserve window (`RECLAIM_AFTER_MS`, 20 minutes) the deployment
     * has handed that index to somebody else and no payment exists for it, so
     * there is nothing to collect and nothing to warn about.
     */
    // Past the window AND after `attachPayment` landed, so the record's silence
    // about a payment is evidence rather than an absent field.
    seed({ at: Date.now() - 3 * 20 * 60 * 1000 });
    await expect(
      resumeContribution({ meta: 'meta', owner: OWNER, signMessage }),
    ).resolves.toBeNull();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(await pendingRecords(), 'the dead reservation was kept and will shadow again').toEqual([]);
  });

  it('🚨 a dead reservation does not shadow the paid record written after it', async () => {
    // The measured shape of the loss: click one was abandoned, click two paid
    // and the worker went quiet. The resume must collect for click two.
    storage.set(
      PENDING_KEY,
      JSON.stringify([
        {
          owner: OWNER.toBase58(),
          token: 'SOL',
          denomination: 1,
          leafIndex: 99,
          at: Date.now() - 3 * 20 * 60 * 1000,
        },
        {
          owner: OWNER.toBase58(),
          token: 'SOL',
          denomination: 1,
          leafIndex: LEAF,
          at: Date.now() - 60_000,
          paymentSignature: 'PAYSIG',
        },
      ]),
    );
    const issued = await resumeContribution({ meta: 'meta', owner: OWNER, signMessage });

    const confirms = posts('/api/contribute-note', 'confirm');
    expect(confirms, 'the paid record was never reached').toHaveLength(1);
    expect(confirms[0]!.body).toMatchObject({ leafIndex: LEAF, paymentSignature: 'PAYSIG' });
    expect(issued?.leafIndex).toBe(21);
  });
});

/**
 * READY-1: what the readiness GET says reaches the Shield click, unchanged.
 *
 * The route now answers `issuableNow` (true, false or null: one sample per
 * 10-minute bucket, `__tests__/api/issue-note.test.ts` "READY-1"), and the
 * panel stops before paying on false and on no answer
 * (`__tests__/components/PoolPanel.test.tsx` "READY-1"). This is the wire in
 * between: a false the client dropped would send the buyer to the till against
 * stock that cannot be handed over, and anything but a literal boolean is "not
 * known", never "yes".
 */
describe('READY-1: the readiness answer the client hands the panel', () => {
  /** The deployment's GET, as the route shapes it, with `over` merged in. */
  function stubReadiness(over: Record<string, unknown>) {
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      if (url === '/api/issue-note' && method === 'GET') {
        return json(200, {
          ok: true,
          configured: true,
          inventorySize: 2,
          denomination: 1,
          token: 'SOL',
          reasons: [],
          advisories: [],
          note: 'n',
          ...over,
        });
      }
      throw new Error(`unexpected fetch ${method} ${String(url)}`);
    });
  }

  it('carries issuableNow as the route said it: false, true, and null for absent or anything else', async () => {
    const cases: Array<[unknown, boolean | null]> = [
      [false, false],
      [true, true],
      [null, null],
      [undefined, null],
      ['false', null],
      [0, null],
    ];
    for (const [said, expected] of cases) {
      stubReadiness(said === undefined ? {} : { issuableNow: said });
      expect(await fetchIssuableNote(), `the route said ${JSON.stringify(said)}`).toEqual({
        denomination: 1,
        token: 'SOL',
        issuableNow: expected,
      });
    }
    // One bare GET per ask: nothing in it names the buyer or a note.
    expect(calls).toHaveLength(cases.length);
    for (const c of calls) expect(c).toEqual({ method: 'GET', url: '/api/issue-note', body: undefined });
  });

  it('a deployment that is not configured, or cannot be reached, is null as before', async () => {
    stubReadiness({ configured: false, issuableNow: true });
    expect(await fetchIssuableNote()).toBeNull();
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    expect(await fetchIssuableNote()).toBeNull();
  });
});
