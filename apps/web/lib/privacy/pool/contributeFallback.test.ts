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
}));

vi.mock('./denominatedPool', () => ({
  findPoolV3: () => ({
    poolPDA: new PublicKey(POOL),
    token: 'SOL',
    denomination: 1,
    denominationAtomic: 1_000_000_000n,
    decimals: 9,
  }),
}));

import { contributeToPool, resumeContribution } from '../shieldClient';
import { claimChallenge } from '../claimChallenge';
import type { PoolNoteView } from '../worker/poolHandlers';

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
      return json(200, { ok: true, sealedNote: 'p01enc1:SEALED', leafIndex: 21, disclosure: 'D' });
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
        storeAtExecute = pendingRecords();
        if (execute === 'throw') throw new Error('the worker went quiet');
        return { kind: 'poolContributeExecute', txSig: 'DEPOSIT', leafIndex: LEAF, commitment: '123' };
      case 'poolNoteAddress':
        return { kind: 'poolNoteAddress', address: 'p01pq:ADDR' };
      case 'poolStoreLabel':
        return { kind: 'poolStoreLabel', label: 'L', legacyAddress: 'p01pq:ADDR' };
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

const PENDING_KEY = 'p01:pending-contribution:v1';
let storage: Map<string, string>;
function pendingRecords(): Array<Record<string, unknown>> {
  return JSON.parse(storage.get(PENDING_KEY) ?? '[]');
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
    expect(pendingRecords()[0]).toMatchObject({
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
    const [record] = pendingRecords();
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
    expect(pendingRecords()).toEqual([]);
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

  it('says so for a record from before the payment was kept', async () => {
    seed({});
    await expect(
      resumeContribution({ meta: 'meta', owner: OWNER, signMessage }),
    ).rejects.toThrow(/without its payment signature/);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
});
