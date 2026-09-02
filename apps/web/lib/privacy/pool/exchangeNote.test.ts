/**
 * THE NOTE-IN EXCHANGE, on the client wire: what `exchangeNoteForIssued` sends
 * to the worker and to the deployment, in what order, and what it refuses
 * before a lamport moves.
 *
 * Run: cd apps/web && pnpm test:pool
 *
 * WHY EVERY ASSERTION IS ABOUT ORDER OR ABOUT A REFUSAL
 * ────────────────────────────────────────────────────
 * The exchange spends a note to the deployment's till and buys an older one
 * with the withdrawal itself. Every failure worth having a test for is one
 * where money moved and the wrong thing followed:
 *
 *   the recipient is not the till      the note is withdrawn to somebody and
 *                                      the deployment owes nothing.
 *   the wallet funds the ephemeral     the wallet is one hop from the payment
 *                                      to the till: the join the exchange
 *                                      exists to remove.
 *   the stock check comes after        the till is paid and the claim redeems
 *   the spend                          nothing.
 *   the v3 fallback is accepted        the withdrawal republishes the
 *                                      commitment; the "older note" is then
 *                                      bought with a transaction that names
 *                                      the buyer's own deposit.
 *   the claim is posted without the    the first stranger reading the chain
 *   ephemeral's proof                  collects the note.
 *
 * Everything that leaves the process is stubbed: the worker (`poolRequest`),
 * the funder decision, the pool table, and `fetch`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey, type Connection } from '@solana/web3.js';

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

// The pool table, reduced to the one lookup the exchange makes: the note's
// pool, so the spend is recorded under the key the pickers filter on.
vi.mock('./denominatedPool', () => ({
  findPoolV3: () => ({
    poolPDA: new PublicKey(POOL),
    token: 'SOL',
    denomination: 1,
    denominationAtomic: 1_000_000_000n,
    decimals: 9,
  }),
}));

import {
  exchangeNoteForIssued,
  resumeContribution,
  ExchangeAfterSpendError,
} from '../shieldClient';
import type { PoolNoteView } from '../worker/poolHandlers';

const OWNER = new PublicKey('7gWpzSZAqUiN6uZ9NkfB1gZ5gYtvUvQyFAUhZTjJ6Trh');
/** R, the till: where the deployment collects. */
const TILL = 'BQWLmnLmQPzQvJVGrJyBRA6RPBEqMhMQZ5oXQKmDMhcE';
const FUNDER = 'QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB';
const POOL = 'HfSsGRgVFJGBiiEtRXrHocNPw5dyTQ78hEZH8GWpXaAG';
const EPHEMERAL = 'SysvarC1ock11111111111111111111111111111111';
const LEAF = 16;

/** The note the treasury hands back: older, somebody else's deposit. */
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

type Req = Record<string, unknown>;
type Call = { method: string; url: string; body?: Record<string, unknown> };

function requests(): Req[] {
  return poolRequest.mock.calls.map((c) => c[0] as Req);
}
function requestsOfKind(kind: string): Req[] {
  return requests().filter((r) => r.kind === kind);
}

let calls: Call[] = [];
function posts(url: string): Call[] {
  return calls.filter((c) => c.method === 'POST' && c.url === url);
}

function json(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}

/**
 * The deployment's answers. `issuable: null` is a deployment that stocks
 * nothing; `configured: false` one that cannot sell; `claim404s` how many
 * times the claim route has not yet seen the payment; `claimRefusal` a final
 * refusal with that status.
 */
function stubDeployment(
  opts: {
    configured?: boolean;
    issuable?: { denomination: number; token: 'SOL' | 'USDC' } | null;
    claim404s?: number;
    claimRefusal?: number;
  } = {},
) {
  let claimAttempts = 0;
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, url: String(url), body });

    if (url === '/api/claim-for-payment' && method === 'GET') {
      const configured = opts.configured ?? true;
      return json(200, {
        ok: true,
        configured,
        till: configured ? TILL : null,
        priceLamports: 1_000_000_000,
        withdrawalFloorLamports: 995_000_000,
        reasons: configured ? [] : ['P01_TILL_ADDRESS is unset or not a public key.'],
      });
    }
    if (url === '/api/issue-note' && method === 'GET') {
      const issuable = opts.issuable === undefined ? { denomination: 1, token: 'SOL' } : opts.issuable;
      return issuable
        ? json(200, { ok: true, configured: true, ...issuable })
        : json(200, { ok: true, configured: false });
    }
    if (url === '/api/claim-for-payment' && method === 'POST') {
      claimAttempts += 1;
      if (claimAttempts <= (opts.claim404s ?? 0)) {
        return json(404, { ok: false, error: 'that payment is not on chain yet; confirm it and retry' });
      }
      if (opts.claimRefusal) {
        return json(opts.claimRefusal, { ok: false, error: 'that transaction paid the till less than a note costs' });
      }
      return json(200, {
        ok: true,
        claimCode: 'CLAIM',
        kind: 'pool-withdrawal',
        payer: EPHEMERAL,
        received: 995_000_000,
      });
    }
    if (url === '/api/issue-note' && method === 'POST') {
      return json(200, {
        ok: true,
        sealedNote: 'p01enc1:SEALED',
        leafIndex: ISSUED_NOTE.leafIndex,
        disclosure: 'DISCLOSURE',
      });
    }
    throw new Error(`unexpected fetch ${method} ${String(url)}`);
  });
}

/** The worker, answering each request kind the exchange reaches. */
function stubWorker(version: 'v3' | 'v4' = 'v4') {
  poolRequest.mockImplementation(async (req: Req) => {
    switch (req.kind) {
      case 'poolUnshieldPrepare':
        return {
          kind: 'poolUnshieldPrepare',
          jobId: version === 'v4' ? `unshield-v4:${POOL}:${LEAF}:${TILL}` : `unshield:${POOL}:${LEAF}`,
          ephemeralPubkey: EPHEMERAL,
          requiredLamports: 231,
          denomination: 1,
          derivation: 'v1',
          version,
        };
      case 'poolUnshieldExecute':
        return {
          kind: 'poolUnshieldExecute',
          txSig: 'TXSIG',
          denomination: 1,
          feePayer: EPHEMERAL,
          ...(req.signClaim ? { claimProof: 'PROOF' } : {}),
        };
      case 'poolNoteAddress':
        return { kind: 'poolNoteAddress', address: 'p01pq:ADDR' };
      case 'poolStoreLabel':
        return { kind: 'poolStoreLabel', label: 'L', legacyAddress: 'p01pq:ADDR' };
      case 'poolImportNote':
        return {
          kind: 'poolImportNote',
          encryptedNote: 'BLOB',
          note: ISSUED_NOTE,
          merklePath: 'stored',
        };
      default:
        throw new Error(`unexpected worker request: ${String(req.kind)}`);
    }
  });
}

/**
 * A `localStorage` this environment does not otherwise have, so the receipt
 * the exchange keeps between the spend and the note can be read back.
 */
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
function pendingRecords(storage: Map<string, string>): Array<Record<string, unknown>> {
  return JSON.parse(storage.get(PENDING_KEY) ?? '[]');
}

function exchange(over: Partial<Parameters<typeof exchangeNoteForIssued>[0]> = {}) {
  return exchangeNoteForIssued({
    meta: 'meta',
    token: 'SOL',
    denomination: 1,
    leafIndex: LEAF,
    pool: POOL,
    owner: OWNER,
    connection: {} as Connection,
    signOne: async (t) => t,
    claimRetry: { attempts: 5, delayMs: 0 },
    ...over,
  });
}

let storage: Map<string, string>;

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  calls = [];
  storage = installStorage();
  vi.stubEnv('NEXT_PUBLIC_P01_FUNDER_TICKET', 'test-ticket');
  fundEphemeralForJob.mockResolvedValue({
    fundedBy: 'funder',
    sweepTo: FUNDER,
    funderSignature: 'GRANTSIG',
  });
  stubWorker('v4');
  stubDeployment();
});

// ===========================================================================

describe('what the exchange puts on the wire', () => {
  it('withdraws to the TILL on circuit 7, with the wallet as identity only', async () => {
    await exchange();

    const [prep] = requestsOfKind('poolUnshieldPrepare');
    expect(prep).toBeDefined();
    // The recipient is the address the deployment collects at, read from the
    // deployment and never from a constant.
    expect(prep!.recipient).toBe(TILL);
    expect(prep!.ownerPubkey).toBe(OWNER.toBase58());
    expect(prep!.leafIndex).toBe(LEAF);
  });

  it('keeps the wallet off chain: the funder is asked with neverExposeWallet and the value is float only', async () => {
    await exchange();

    expect(fundEphemeralForJob).toHaveBeenCalledTimes(1);
    const req = fundEphemeralForJob.mock.calls[0]![0] as Record<string, unknown>;
    expect(req.neverExposeWallet).toBe(true);
    expect(req.ephemeralPubkey).toBe(EPHEMERAL);
    expect(req.valueLamports).toBe(0);
  });

  it('asks the worker to sign the claim, and never a relayer', async () => {
    await exchange();

    const [exec] = requestsOfKind('poolUnshieldExecute');
    expect(exec).toBeDefined();
    expect(exec!.signClaim).toBe(true);
    expect(exec!.recipient).toBe(TILL);
    expect(exec!.relayerUrl).toBeUndefined();
  });

  it('posts the withdrawal and the ephemeral proof, then redeems the claim it bought', async () => {
    const out = await exchange();

    const claims = posts('/api/claim-for-payment');
    expect(claims).toHaveLength(1);
    expect(claims[0]!.body).toEqual({ signature: 'TXSIG', proof: 'PROOF' });

    const issues = posts('/api/issue-note');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.body).toMatchObject({
      claimCode: 'CLAIM',
      recipientAddress: 'p01pq:ADDR',
      token: 'SOL',
      denomination: 1,
    });
    // The issued note enters through the same import path a hand-delivered
    // note takes, so a wrong or corrupted issuance cannot enter as money.
    const [imported] = requestsOfKind('poolImportNote');
    expect(imported!.sealedNote).toBe('p01enc1:SEALED');

    // Order: spend, claim, redeem. A redeem before the claim has no code; a
    // claim before the spend has no payment.
    const order = calls.filter((c) => c.method === 'POST').map((c) => c.url);
    expect(order).toEqual(['/api/claim-for-payment', '/api/issue-note']);

    expect(out).toMatchObject({
      spendSig: 'TXSIG',
      claimCode: 'CLAIM',
      feePayer: EPHEMERAL,
      issued: { leafIndex: 21, disclosure: 'DISCLOSURE', merklePath: 'stored' },
    });
    expect(out.issued.note.leafIndex).toBe(21);
  });

  it('retries the claim while the deployment has not seen the payment, without spending again', async () => {
    stubDeployment({ claim404s: 2 });
    const out = await exchange();

    const claims = posts('/api/claim-for-payment');
    expect(claims).toHaveLength(3);
    for (const c of claims) expect(c.body).toEqual({ signature: 'TXSIG', proof: 'PROOF' });
    // ONE withdrawal. A retry that prepared again would spend a second note.
    expect(requestsOfKind('poolUnshieldExecute')).toHaveLength(1);
    expect(out.claimCode).toBe('CLAIM');
  });

  it('clears the receipt once the note is in hand', async () => {
    await exchange();
    expect(pendingRecords(storage)).toEqual([]);
  });
});

describe('the refusals that cost nobody anything', () => {
  it('refuses when the deployment issues nothing, before the worker is asked', async () => {
    stubDeployment({ issuable: null });
    await expect(exchange()).rejects.toThrow(/issues no notes/);

    expect(requests()).toEqual([]);
    expect(fundEphemeralForJob).not.toHaveBeenCalled();
    expect(posts('/api/claim-for-payment')).toEqual([]);
  });

  it('refuses a different denomination, because the exchange is like for like', async () => {
    stubDeployment({ issuable: { denomination: 0.1, token: 'SOL' } });
    await expect(exchange()).rejects.toThrow(/like for like/);
    expect(requests()).toEqual([]);
  });

  it('refuses when the deployment cannot sell, and says why', async () => {
    stubDeployment({ configured: false });
    await expect(exchange()).rejects.toThrow(/P01_TILL_ADDRESS is unset/);
    expect(requests()).toEqual([]);
  });

  it('refuses before the pre-fund when the worker could only prove the note on the C1 + C3 pair', async () => {
    // The pair republishes the commitment. An exchange over it would buy the
    // "older note" with a transaction that names the buyer's own deposit.
    stubWorker('v3');
    await expect(exchange()).rejects.toThrow(/cannot be exchanged/);

    expect(requestsOfKind('poolUnshieldPrepare')).toHaveLength(1);
    expect(fundEphemeralForJob).not.toHaveBeenCalled();
    expect(requestsOfKind('poolUnshieldExecute')).toEqual([]);
    expect(posts('/api/claim-for-payment')).toEqual([]);
  });
});

describe('after the spend, the receipt survives whatever happens next', () => {
  it('keeps the signature and the proof when the claim is refused, and names the withdrawal', async () => {
    stubDeployment({ claimRefusal: 402 });
    const err = await exchange().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ExchangeAfterSpendError);
    expect((err as ExchangeAfterSpendError).spendSig).toBe('TXSIG');
    expect(String((err as Error).message)).toMatch(/receipt is kept/);

    const [record] = pendingRecords(storage);
    expect(record).toMatchObject({
      kind: 'exchange',
      owner: OWNER.toBase58(),
      leafIndex: LEAF,
      paymentSignature: 'TXSIG',
      claimProof: 'PROOF',
    });
    expect(record).not.toHaveProperty('claimCode');
    // Nothing was redeemed: there is no code to redeem.
    expect(posts('/api/issue-note')).toEqual([]);
  });

  it('resumes from the receipt: claims again with the same proof and never withdraws twice', async () => {
    stubDeployment({ claimRefusal: 402 });
    await exchange().catch(() => undefined);

    // The deployment recovers; the buyer clicks again.
    vi.clearAllMocks();
    calls = [];
    stubWorker('v4');
    stubDeployment();
    const issued = await resumeContribution({ meta: 'meta', owner: OWNER });

    expect(issued?.leafIndex).toBe(21);
    const claims = posts('/api/claim-for-payment');
    expect(claims).toHaveLength(1);
    expect(claims[0]!.body).toEqual({ signature: 'TXSIG', proof: 'PROOF' });
    expect(requestsOfKind('poolUnshieldPrepare')).toEqual([]);
    expect(requestsOfKind('poolUnshieldExecute')).toEqual([]);
    expect(fundEphemeralForJob).not.toHaveBeenCalled();
    expect(pendingRecords(storage)).toEqual([]);
  });

  it('says so when the worker returned no proof, rather than posting a claim nobody signed', async () => {
    poolRequest.mockImplementation(async (req: Req) => {
      if (req.kind === 'poolUnshieldPrepare') {
        return {
          kind: 'poolUnshieldPrepare',
          jobId: 'j',
          ephemeralPubkey: EPHEMERAL,
          requiredLamports: 231,
          denomination: 1,
          derivation: 'v1',
          version: 'v4',
        };
      }
      if (req.kind === 'poolUnshieldExecute') {
        // An older worker: it ignored `signClaim` and answered as it always had.
        return { kind: 'poolUnshieldExecute', txSig: 'TXSIG', denomination: 1 };
      }
      throw new Error(`unexpected worker request: ${String(req.kind)}`);
    });
    const err = await exchange().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExchangeAfterSpendError);
    expect(String((err as Error).message)).toMatch(/no proof of payment/);
    expect(posts('/api/claim-for-payment')).toEqual([]);
  });
});
