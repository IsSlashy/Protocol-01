/**
 * The contribution path, faster without a new request or a new party
 * (shield-speed proposals G, H and P0 part 2).
 *
 * Run: cd apps/web && pnpm test:pool
 *
 * G. Popup #2 (the relay proof, `fundEphemeralForJob`) and popup #3 (the
 *    confirm, `walletClaimProof`) sign the SAME message, `claimChallenge(paySig)`,
 *    and go to the same deployment. The first signature is reused for the
 *    confirm, in memory only, when it was made over exactly this payment.
 *    Conditions (privacy G (a)(b), correctness G (a)(b)(d)): never in the
 *    record, the worker messages, the outcome, a progress line or an error; a
 *    missing or mismatched proof prompts as before and never throws.
 *
 * H. The relay terms GET starts as soon as the local refusals have passed and
 *    the record is kept, beside `poolContributePrepare`, and is still awaited
 *    where it was, before any check that gates the payment. Conditions
 *    (privacy H 1-2, correctness H 1-2): not started from a refused flow, its
 *    rejection is never unhandled, a prepare failure wins and aborts it.
 *
 * P0 (2). The confirm's 409 "not on the tree" is retried, at most twice, only
 *    while the route says the leaf is above the highest one it sees
 *    (correctness P0: leafIndex > highestOnTree; the reserve and the confirm
 *    share one 5-per-IP-per-hour budget, so no retry sequence may reach a 429).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import nacl from 'tweetnacl';

const poolRequest = vi.fn();
vi.mock('../workerClient', () => ({
  poolRequest: (...args: unknown[]) => poolRequest(...args),
}));

const fundEphemeralForJob = vi.fn();
const prefetchRelayTerms = vi.fn();
vi.mock('./ephemeralFunder', () => ({
  fundEphemeralForJob: (...args: unknown[]) => fundEphemeralForJob(...args),
  prefetchRelayTerms: (...args: unknown[]) => prefetchRelayTerms(...args),
  fetchFunderLookup: async () => ({ configured: true, funder: FUNDER }),
  funderTicket: () => 'test-ticket',
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

import { contributeToPool } from '../shieldClient';
import { claimChallenge } from '../claimChallenge';
import { handlePoolRequest, setPoolSeed, type PoolNoteView } from '../worker/poolHandlers';
import { pendingRecords as openPending } from '../pendingContribution';
import { rateLimitExceeded, type KvLike } from '@/lib/waitlist/store';

const wallet = Keypair.generate();
const OWNER = wallet.publicKey;
const FUNDER = 'QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB';
const POOL = 'HfSsGRgVFJGBiiEtRXrHocNPw5dyTQ78hEZH8GWpXaAG';
const EPHEMERAL = 'SysvarC1ock11111111111111111111111111111111';
const LEAF = 41;
const PAYSIG = 'PAYSIG';

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

/** Every signMessage call the wallet saw, as the challenge text. */
let signed: string[] = [];
const signMessage = async (message: Uint8Array) => {
  signed.push(Buffer.from(message).toString('utf8'));
  return nacl.sign.detached(message, wallet.secretKey);
};
/** The proof the wallet makes for `sig`, as the page encodes it. */
function proofFor(sig: string): string {
  return Buffer.from(
    nacl.sign.detached(new Uint8Array(Buffer.from(claimChallenge(sig), 'utf8')), wallet.secretKey),
  ).toString('base64');
}

type Call = { method: string; url: string; body?: Record<string, unknown>; status: number };
let calls: Call[] = [];
const posts = (url: string, action?: string) =>
  calls.filter((c) => c.method === 'POST' && c.url === url && (action === undefined || c.body?.action === action));

function json(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}

/** An in-memory KV with the two methods the limiter uses. */
function memoryKv(): KvLike {
  const m = new Map<string, number>();
  return {
    incr: async (k: string) => {
      m.set(k, (m.get(k) ?? 0) + 1);
      return m.get(k)!;
    },
    expire: async () => undefined,
  } as unknown as KvLike;
}

/**
 * The deployment. `confirmAnswers` is the sequence of confirm answers; after
 * it runs out the confirm succeeds. With `limiter`, reserve and confirm share
 * the route's real limiter (`rateLimitExceeded`, 5 per IP per hour, checked
 * BEFORE the action branch, as `contribute-note/route.ts:241` does).
 */
function stubDeployment(
  opts: {
    confirmAnswers?: Array<{ status: number; body: Record<string, unknown> }>;
    claim?: number;
    limiter?: { kv: KvLike; limit: number };
  } = {},
) {
  const confirmAnswers = [...(opts.confirmAnswers ?? [])];
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const answer = async (): Promise<{ status: number; body: unknown }> => {
      if (url === '/api/contribute-note' && method === 'POST') {
        if (opts.limiter && (await rateLimitExceeded(opts.limiter.kv, '203.0.113.9', 'p01:contribute-note:v1', opts.limiter.limit))) {
          return { status: 429, body: { ok: false, error: 'too many contributions from this address in the last hour' } };
        }
        if (body?.action === 'reserve') {
          return { status: 200, body: { ok: true, leafIndex: LEAF, commitment: '123', denomination: 1, token: 'SOL' } };
        }
        if (body?.action === 'confirm') {
          const next = confirmAnswers.shift();
          if (next) return next;
          return { status: 200, body: { ok: true, claimCode: 'CONFIRMED', leafIndex: LEAF } };
        }
      }
      if (url === '/api/claim-for-payment' && method === 'POST') {
        if (opts.claim) return { status: opts.claim, body: { ok: false, error: 'the claim route refused' } };
        return { status: 200, body: { ok: true, claimCode: 'FALLBACK', kind: 'transfer', payer: OWNER.toBase58() } };
      }
      throw new Error(`unexpected fetch ${method} ${String(url)}`);
    };
    const { status, body: out } = await answer();
    calls.push({ method, url: String(url), body, status });
    return json(status, out);
  });
}

const notOnTree = (highestOnTree: number) => ({
  status: 409,
  body: {
    ok: false,
    error: 'that contribution is not on the tree',
    leafIndex: LEAF,
    highestOnTree,
    hint: 'The deposit has not landed yet. Confirm once the transaction is finalized.',
  },
});

let order: string[] = [];
/** What the worker was asked, verbatim, for the tripwire. */
let workerMessages: unknown[] = [];

function stubWorker(opts: { prepare?: 'ok' | 'throw'; execute?: 'ok' | 'throw' } = {}) {
  poolRequest.mockImplementation(async (req: Record<string, unknown>) => {
    workerMessages.push(req);
    switch (req.kind) {
      case 'poolContributePrepare':
        order.push('prepare:start');
        await Promise.resolve();
        order.push(`prepare:prefetch-started=${prefetchRelayTerms.mock.calls.length > 0}`);
        if (opts.prepare === 'throw') throw new Error('the proof failed');
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
        if (opts.execute === 'throw') throw new Error('the worker went quiet');
        return { kind: 'poolContributeExecute', txSig: 'DEPOSIT', leafIndex: LEAF, commitment: '123' };
      case 'poolNoteAddress':
      case 'poolStoreLabel':
      case 'poolOpenRecords':
      case 'poolIssueAddress':
        return handlePoolRequest(req as never);
      case 'poolImportNote':
        return { kind: 'poolImportNote', encryptedNote: 'BLOB', note: ISSUED_NOTE, merklePath: 'stored' };
      case 'poolRelayEphemeralProof':
        return { kind: 'poolRelayEphemeralProof', ephemeral: EPHEMERAL, proof: 'EPROOF' };
      default:
        throw new Error(`unexpected worker request: ${String(req.kind)}`);
    }
  });
}

let storage: Map<string, string>;
function installStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  });
  return backing;
}

/** A funder that, like the real one, asks popup #2 for the relay proof and hands it back. */
function funderSigningPopup2(claimProofFor: string | null = PAYSIG) {
  fundEphemeralForJob.mockImplementation(async (req: { signMessage: (m: Uint8Array) => Promise<Uint8Array> }) => {
    order.push('fund');
    const sig = await req.signMessage(new TextEncoder().encode(claimChallenge(PAYSIG)));
    const proof = Buffer.from(sig).toString('base64');
    return {
      fundedBy: 'funder',
      sweepTo: FUNDER,
      funderSignature: 'RELAYSIG',
      operatorFeeLamports: 10_000_000,
      paymentSignature: PAYSIG,
      ...(claimProofFor !== null ? { claimProof: { paymentSignature: claimProofFor, proof } } : {}),
    };
  });
}

/** The prefetch handle the real `prefetchRelayTerms` returns: a promise whose rejection is already handled. */
function fakePrefetch(outcome: 'ok' | 'reject' = 'ok') {
  const abort = vi.fn();
  const terms =
    outcome === 'ok'
      ? Promise.resolve({ till: 'TILL' })
      : Promise.reject(new Error('the terms could not be read'));
  terms.catch(() => undefined);
  const handle = { terms, answeredAt: () => Date.now(), abort };
  prefetchRelayTerms.mockImplementation(() => {
    order.push('prefetch');
    return handle;
  });
  return handle;
}

const progress: string[] = [];
function contribute(meta = 'meta') {
  return contributeToPool({
    meta,
    token: 'SOL',
    denomination: 1,
    owner: OWNER,
    connection: {} as Connection,
    signOne: async (t) => t,
    signMessage,
    onProgress: (s: string) => progress.push(s),
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  calls = [];
  order = [];
  signed = [];
  workerMessages = [];
  progress.length = 0;
  storage = installStorage();
  setPoolSeed('meta', new Uint8Array(64).fill(11));
  vi.stubEnv('NEXT_PUBLIC_P01_FUNDER_TICKET', 'test-ticket');
  funderSigningPopup2();
  fakePrefetch();
  stubWorker();
  stubDeployment();
});

// ===========================================================================

describe('G: popup #2 signs the confirm too', () => {
  it('RED: path A asks the wallet to sign exactly once, and the confirm carries that proof', async () => {
    const out = await contribute();
    expect(out.claimCode).toBe('CONFIRMED');
    expect(signed).toEqual([claimChallenge(PAYSIG)]);
    const confirms = posts('/api/contribute-note', 'confirm');
    expect(confirms).toHaveLength(1);
    expect(confirms[0]!.body!.proof).toBe(proofFor(PAYSIG));
  });

  it('RED: the fallback claim reuses it as well when the deposit fails after payment', async () => {
    stubWorker({ execute: 'throw' });
    const out = await contribute();
    expect(out.claimCode).toBe('FALLBACK');
    expect(signed).toHaveLength(1);
    expect(posts('/api/claim-for-payment')[0]!.body!.proof).toBe(proofFor(PAYSIG));
  });

  it('CONTROL: a proof made over another payment is never reused — the wallet is asked, as before', async () => {
    funderSigningPopup2('SOME-OTHER-PAYMENT');
    const out = await contribute();
    expect(out.claimCode).toBe('CONFIRMED');
    expect(signed).toEqual([claimChallenge(PAYSIG), claimChallenge(PAYSIG)]);
    expect(posts('/api/contribute-note', 'confirm')[0]!.body!.proof).toBe(proofFor(PAYSIG));
  });

  it('CONTROL: no proof handed back (an older funder, a wallet-funded job) prompts as before and never throws', async () => {
    funderSigningPopup2(null);
    const out = await contribute();
    expect(out.claimCode).toBe('CONFIRMED');
    expect(signed).toHaveLength(2);
  });

  it('TRIPWIRE: the proof reaches no record, no worker message, no outcome, no progress line and no error', async () => {
    const proof = proofFor(PAYSIG);
    const out = await contribute();
    const records = await openPending('meta', OWNER.toBase58());
    const haystacks = {
      outcome: JSON.stringify(out),
      worker: JSON.stringify(workerMessages),
      progress: progress.join('\n'),
      storageRaw: JSON.stringify([...storage.entries()]),
      records: JSON.stringify(records),
    };
    for (const [where, text] of Object.entries(haystacks)) {
      expect(text.includes(proof), where).toBe(false);
    }

    // And the failure path: both routes refuse, the error names neither proof.
    // A fresh device, so the first flow's record does not stand in the way.
    storage = installStorage();
    setPoolSeed('meta', new Uint8Array(64).fill(11));
    stubWorker({ execute: 'throw' });
    stubDeployment({ claim: 409 });
    const err = await contribute().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message).includes(proof)).toBe(false);
  });
});

describe('H: the relay terms are asked for while the proof is made', () => {
  it('RED: the terms request starts before prepare resolves and the funder is handed that same request', async () => {
    const handle = fakePrefetch();
    await contribute();
    expect(prefetchRelayTerms).toHaveBeenCalledTimes(1);
    expect(order).toContain('prepare:prefetch-started=true');
    expect(order.indexOf('prefetch')).toBeLessThan(order.indexOf('fund'));
    const req = fundEphemeralForJob.mock.calls[0]![0] as Record<string, unknown>;
    expect(req.relayTermsPrefetch).toBe(handle);
  });

  it('a prepare that fails wins over a failing prefetch, aborts it, and nothing is paid', async () => {
    const handle = fakePrefetch('reject');
    stubWorker({ prepare: 'throw' });
    const err = await contribute().catch((e: Error) => e);
    expect(String((err as Error).message)).toMatch(/the proof failed/);
    expect(handle.abort).toHaveBeenCalledTimes(1);
    expect(fundEphemeralForJob).not.toHaveBeenCalled();
    expect(signed).toEqual([]);
  });

  it('CONTROL: a flow refused before its record is kept never asks for the terms', async () => {
    await expect(contribute('meta-that-never-signed')).rejects.toThrow(/No pool keys/);
    expect(prefetchRelayTerms).not.toHaveBeenCalled();
    expect(fundEphemeralForJob).not.toHaveBeenCalled();
  });
});

describe('P0 (2): the confirm waits out a deposit the route has not seen yet, within the hourly budget', () => {
  it('RED: a 409 "not on the tree" above the highest leaf is asked again and confirms, with no fallback', async () => {
    stubDeployment({ confirmAnswers: [notOnTree(LEAF - 1)] });
    const out = await contribute();
    expect(out.claimCode).toBe('CONFIRMED');
    expect(posts('/api/contribute-note', 'confirm')).toHaveLength(2);
    expect(posts('/api/claim-for-payment')).toEqual([]);
  });

  it('at most two retries, then the fallback as before', async () => {
    stubDeployment({ confirmAnswers: [notOnTree(LEAF - 1), notOnTree(LEAF - 1), notOnTree(LEAF - 1), notOnTree(LEAF - 1)] });
    const out = await contribute();
    expect(posts('/api/contribute-note', 'confirm')).toHaveLength(3);
    expect(out.claimCode).toBe('FALLBACK');
  });

  it('CONTROL: "not on the tree" at or below the highest leaf is permanent and is not retried', async () => {
    stubDeployment({ confirmAnswers: [notOnTree(LEAF + 5)] });
    const out = await contribute();
    expect(posts('/api/contribute-note', 'confirm')).toHaveLength(1);
    expect(out.claimCode).toBe('FALLBACK');
  });

  it('CONTROL: no other 409 is retried', async () => {
    for (const error of [
      'this payment has already been redeemed',
      'that contribution sits at a different leaf than claimed',
      'this contribution was already confirmed under a different payment',
      'another contribution is in progress on the pool; retry in a minute',
    ]) {
      calls = [];
      storage = installStorage();
      setPoolSeed('meta', new Uint8Array(64).fill(11));
      stubDeployment({ confirmAnswers: [{ status: 409, body: { ok: false, error, leafIndex: LEAF, highestOnTree: LEAF - 1 } }] });
      await contribute();
      expect(posts('/api/contribute-note', 'confirm'), error).toHaveLength(1);
    }
  });

  it("against the route's real limiter no retry sequence meets a 429, and a reserve is still left", async () => {
    const kv = memoryKv();
    stubDeployment({
      confirmAnswers: [notOnTree(LEAF - 1), notOnTree(LEAF - 1), notOnTree(LEAF - 1)],
      limiter: { kv, limit: 5 },
    });
    await contribute();
    const routeCalls = calls.filter((c) => c.url === '/api/contribute-note');
    expect(routeCalls.map((c) => c.status)).not.toContain(429);
    // reserve + confirm + 2 retries = 4 of 5: the next reserve this hour still fits.
    expect(routeCalls).toHaveLength(4);
    expect(await rateLimitExceeded(kv, '203.0.113.9', 'p01:contribute-note:v1', 5)).toBe(false);
  });
});
