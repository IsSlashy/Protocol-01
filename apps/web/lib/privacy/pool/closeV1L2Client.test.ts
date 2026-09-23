/**
 * close-v1 lane L2, client side: what a buyer's click may pay, and what it
 * leaves behind when something fails after the money moved.
 *
 * Run: cd apps/web && npx vitest run --config vitest.pool.config.mts lib/privacy/pool/closeV1L2Client.test.ts
 *
 * Real: `shieldToPool`, `contributeToPool`, `resumeContribution`,
 * `exchangeNoteForIssued`, `fundEphemeralForJob` (relay branch, receipts), the
 * sealed stores and the worker's store handlers, the worker's new
 * `poolRelayEphemeralProof`. Stubbed: the deployment's HTTP answers, the RPC,
 * and the prover jobs (prepare / execute / import).
 *
 *   F56  "deposit my own note" paid the till, then refused to relay because the
 *        message signer was never forwarded and was checked after the payment.
 *   F57  a relay that failed after the payment left the payment on a receipt
 *        keyed by the leaf's ephemeral; the next click reserved another leaf and
 *        paid again (audit-v1-opus/r3-client/probes/relayReceiptOrphan).
 *   F58  a young paymentless reservation shadowed a paid one; the resume never
 *        presented the payment and the next click paid again
 *        (audit-v1-opus/r3-client/probes/resumeShadow).
 *   F11  (client half) the contribution's fallback names the deposit key the
 *        relay funded and proves it holds it.
 *   F07  (resume half) a resumed issued note hands its claim code back.
 *   F70 / F59  the note-in exchange refuses before spending (EXCHANGE_DISABLED).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, PublicKey, SystemProgram, Transaction, type Connection } from '@solana/web3.js';
import nacl from 'tweetnacl';

const poolRequest = vi.fn();
vi.mock('../workerClient', () => ({
  poolRequest: (...args: unknown[]) => poolRequest(...args),
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
  resumeContribution,
  shieldToPool,
} from '../shieldClient';
import { StaleWorkerError } from '../sealedStore';
import { handlePoolRequest, setPoolSeed } from '../worker/poolHandlers';
import { pendingFor, pendingRecords } from '../pendingContribution';
import { listRelayPayments } from './relayPaymentReceipts';
import { deriveShieldEphemeral } from './shieldEphemeral';
import { derivePoolSeedLegacy } from './seedDerivation';
import { claimChallenge } from '../claimChallenge';

const POOL = 'HfSsGRgVFJGBiiEtRXrHocNPw5dyTQ78hEZH8GWpXaAG';
const SEED_SIG = Uint8Array.from({ length: 64 }, (_, i) => (i * 3 + 1) & 0xff);
const wallet = Keypair.generate();
const OWNER = wallet.publicKey;
const signMessage = async (m: Uint8Array) => nacl.sign.detached(m, wallet.secretKey);
const signOne = async (tx: Transaction) => {
  tx.sign(wallet);
  return tx;
};

const RELAY_TERMS = {
  ok: true,
  ready: true,
  reasons: [] as string[],
  funder: 'QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB',
  till: 'BQWLmnLmQPzQvJVGrJyBRA6RPBEqMhMQZ5oXQKmDMhcE',
  feeWallet: 'CtVBK3rQpsPBLuqvhtFbwXcjXWv5PoyqjbJPZ3mV7iVv',
  maxRelayLamports: 2_500_000_000,
  maxRentSubsidyLamports: 650_000_000,
  funderLamports: 5_000_000_000,
  relayFeeLamports: 5_000,
  relaysRemaining: 3,
  relaysPerHour: 3,
};

/** The contribution ephemeral the worker derives for a leaf, independently of the worker. */
function contributionEphemeral(leaf: number): string {
  return deriveShieldEphemeral(derivePoolSeedLegacy(SEED_SIG), new PublicKey(POOL), leaf)
    .publicKey.toBase58();
}

type Call = { method: string; url: string; body?: Record<string, unknown> };
let calls: Call[] = [];
let sentPayments: string[] = [];
let reserveLeaf = 40;
let relayFailures = 0;
let confirmStatus = 200;
let claimStatus = 200;
let exchangeTerms: Record<string, unknown> = {};
/** What `/api/claim-for-payment` answers when `claimStatus` is not 200 (the real route's body). */
let claimRefusal: Record<string, unknown> = { ok: false, error: 'busy' };
/** The chain, as `getSignatureStatuses` and `getBlockHeight` read it. A sent payment has landed unless listed here. */
const chainStatus = new Map<string, { err: unknown } | null>();
let blockHeight = 0;

function json(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}
function posts(url: string): Call[] {
  return calls.filter((c) => c.method === 'POST' && c.url === url);
}

function stubDeployment() {
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, url: String(url), body });
    if (url === '/api/relay-to-buyer' && method === 'GET') return json(200, RELAY_TERMS);
    if (url === '/api/relay-to-buyer' && method === 'POST') {
      if (relayFailures > 0) {
        relayFailures -= 1;
        return json(502, { ok: false, error: 'the float could not send the pre-fund' });
      }
      return json(200, {
        ok: true,
        signature: `RELAY-${posts('/api/relay-to-buyer').length}`,
        lamports: body?.requiredLamports,
        funder: RELAY_TERMS.funder,
      });
    }
    if (url === '/api/contribute-note' && body?.action === 'reserve') {
      reserveLeaf += 1;
      return json(200, { ok: true, leafIndex: reserveLeaf, commitment: '123', denomination: 1, token: 'SOL' });
    }
    if (url === '/api/contribute-note' && body?.action === 'confirm') {
      return confirmStatus === 200
        ? json(200, { ok: true, claimCode: 'CONFIRMED' })
        : json(confirmStatus, { ok: false, error: 'the treasury commitment is not at that leaf' });
    }
    if (url === '/api/claim-for-payment' && method === 'GET') {
      return json(200, { ok: true, configured: true, till: RELAY_TERMS.till, priceLamports: 1e9, ...exchangeTerms });
    }
    if (url === '/api/claim-for-payment' && method === 'POST') {
      return claimStatus === 200
        ? json(200, { ok: true, claimCode: 'FALLBACK', kind: 'transfer', payer: OWNER.toBase58() })
        : json(claimStatus, claimRefusal);
    }
    if (url === '/api/issue-note' && method === 'GET') {
      return json(200, { ok: true, token: 'SOL', denomination: 1, issuableNow: true });
    }
    if (url === '/api/issue-note' && method === 'POST') {
      return json(200, { ok: true, sealedNote: 'p01enc1:SEALED', disclosure: 'D' });
    }
    throw new Error(`unexpected fetch ${method} ${String(url)}`);
  });
}

const executes: Array<Record<string, unknown>> = [];
let contributeExecute: 'ok' | 'throw' = 'ok';
function stubWorker() {
  poolRequest.mockImplementation(async (req: Record<string, unknown>) => {
    switch (req.kind) {
      case 'poolShieldPrepare':
        return {
          kind: 'poolShieldPrepare',
          jobId: 'shield:50',
          ephemeralPubkey: contributionEphemeral(50),
          requiredLamports: 1_573_486_080,
          valueLamports: 1_003_000_000,
        };
      case 'poolShieldExecute':
        executes.push(req);
        return {
          kind: 'poolShieldExecute',
          txSig: 'DEPOSIT',
          commitment: '9',
          leafIndex: 50,
          denomination: 1,
          encryptedNote: 'BLOB',
        };
      case 'poolContributePrepare': {
        const leaf = Number(req.leafIndex);
        return {
          kind: 'poolContributePrepare',
          jobId: `contribute:${leaf}`,
          ephemeralPubkey: contributionEphemeral(leaf),
          requiredLamports: 1_573_486_080,
          valueLamports: 1_003_475_300,
          denomination: 1,
          leafIndex: leaf,
        };
      }
      case 'poolContributeExecute':
        executes.push(req);
        if (contributeExecute === 'throw') throw new Error('the worker went quiet');
        return { kind: 'poolContributeExecute', txSig: 'DEPOSIT', leafIndex: reserveLeaf, commitment: '123' };
      case 'poolImportNote':
        return {
          kind: 'poolImportNote',
          encryptedNote: 'ISSUED-BLOB',
          note: { pool: POOL, token: 'SOL', denomination: 1, counter: 0, leafIndex: 21, commitment: '777', spent: false, derivation: 1, spentKnown: false },
          merklePath: 'stored',
        };
      case 'poolUnshieldPrepare':
      case 'poolUnshieldExecute':
        executes.push(req);
        throw new Error('the exchange reached the spend');
      default:
        return handlePoolRequest(req as never);
    }
  });
}

function connection(over: Record<string, unknown> = {}): Connection {
  return {
    getBalance: async () => 0,
    getLatestBlockhash: async () => ({ blockhash: SystemProgram.programId.toBase58(), lastValidBlockHeight: 1 }),
    sendRawTransaction: async () => {
      const s = `PAY-${sentPayments.length + 1}`;
      sentPayments.push(s);
      return s;
    },
    confirmTransaction: async () => ({ value: { err: null } }),
    getAccountInfo: async () => null,
    getSignatureStatuses: async (sigs: string[]) => ({
      value: sigs.map((sig) =>
        chainStatus.has(sig)
          ? chainStatus.get(sig)!
          : sentPayments.includes(sig)
            ? { err: null, confirmationStatus: 'confirmed' }
            : null,
      ),
    }),
    getBlockHeight: async () => blockHeight,
    ...over,
  } as unknown as Connection;
}

function installStorage() {
  const m = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  });
}

function contribute() {
  return contributeToPool({
    meta: 'meta',
    token: 'SOL',
    denomination: 1,
    owner: OWNER,
    connection: connection(),
    signOne,
    signMessage,
  });
}

/** What PoolPanel does on a Shield click: resume first (failing soft), and contribute only if nothing was resumed. */
async function panelClick() {
  const resumed = await resumeContribution({ meta: 'meta', owner: OWNER, signMessage }).catch(
    (e: unknown) => {
      if (e instanceof StaleWorkerError) throw e;
      return null;
    },
  );
  if (resumed) return { resumed };
  return { contributed: await contribute() };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  poolRequest.mockReset();
  calls = [];
  sentPayments = [];
  executes.length = 0;
  reserveLeaf = 40;
  relayFailures = 0;
  confirmStatus = 200;
  claimStatus = 200;
  contributeExecute = 'ok';
  exchangeTerms = {};
  claimRefusal = { ok: false, error: 'busy' };
  chainStatus.clear();
  blockHeight = 0;
  installStorage();
  stubDeployment();
  stubWorker();
  vi.stubEnv('NEXT_PUBLIC_P01_FUNDER_TICKET', 'test-ticket');
  setPoolSeed('meta', SEED_SIG);
});

// ── F56 ─────────────────────────────────────────────────────────────────────

describe('F56 · "deposit my own note" asks for the message signer before it pays', () => {
  it('🚨 without a message signer, nothing is paid', async () => {
    await expect(
      shieldToPool({ meta: 'meta', token: 'SOL', denomination: 1, owner: OWNER, connection: connection(), signOne }),
    ).rejects.toThrow(/sign a message/i);
    expect(sentPayments, 'the till was paid before the refusal').toEqual([]);
    expect(posts('/api/relay-to-buyer')).toEqual([]);
  });

  it('🚨 with one, the signer reaches the relay and the deposit runs', async () => {
    const out = await shieldToPool({
      meta: 'meta',
      token: 'SOL',
      denomination: 1,
      owner: OWNER,
      connection: connection(),
      signOne,
      signMessage,
    });
    expect(sentPayments).toEqual(['PAY-1']);
    const relay = posts('/api/relay-to-buyer');
    expect(relay).toHaveLength(1);
    expect(
      nacl.sign.detached.verify(
        new Uint8Array(Buffer.from(claimChallenge('PAY-1'), 'utf8')),
        new Uint8Array(Buffer.from(String(relay[0]!.body!.proof), 'base64')),
        OWNER.toBytes(),
      ),
    ).toBe(true);
    expect(executes.map((e) => e.kind)).toEqual(['poolShieldExecute']);
    expect(executes[0]!.sweepTo).toBe(RELAY_TERMS.funder);
    expect(out.fundedBy).toBe('funder');
  });
});

// ── F57 + F11 (client) ──────────────────────────────────────────────────────

describe('F57 · a relay that fails after the payment never leads to a second payment', () => {
  it('🚨 the next click collects what the first payment bought instead of paying again', async () => {
    relayFailures = 1;
    // Click 1: the till is paid, the relay answers 502.
    await expect(panelClick()).rejects.toThrow(/float could not send/);
    expect(sentPayments).toEqual(['PAY-1']);
    const [record] = await pendingRecords('meta', OWNER.toBase58());
    expect(record, 'the paid record does not name its payment').toMatchObject({
      leafIndex: 41,
      paymentSignature: 'PAY-1',
    });

    // Click 2: the deposit never landed, so confirm refuses and the payment
    // itself is presented; nothing is paid again.
    confirmStatus = 409;
    const out = await panelClick();
    expect(sentPayments, 'the till was paid twice').toEqual(['PAY-1']);
    expect(out.resumed?.claimCode).toBe('FALLBACK');
    const [claim] = posts('/api/claim-for-payment');
    expect(claim!.body).toMatchObject({ signature: 'PAY-1', contribution: { token: 'SOL', leafIndex: 41 } });
    // F11, client half: the key the relay was asked to fund, and its proof.
    expect(claim!.body!.ephemeral).toBe(contributionEphemeral(41));
    expect(
      nacl.sign.detached.verify(
        new Uint8Array(
          Buffer.from(
            'Protocol 01 - the deposit key this payment funded gave the float back.\nPayment: PAY-1',
            'utf8',
          ),
        ),
        new Uint8Array(Buffer.from(String(claim!.body!.ephemeralProof), 'base64')),
        new PublicKey(contributionEphemeral(41)).toBytes(),
      ),
    ).toBe(true);
    // The payment is collected, so its relay receipt is gone too.
    expect(await listRelayPayments('meta')).toEqual([]);
    expect(await pendingRecords('meta', OWNER.toBase58())).toEqual([]);
  });

  it('⛔ a fresh contribution is refused, before anything is paid, while a paid one is still owed', async () => {
    relayFailures = 1;
    await expect(contribute()).rejects.toThrow(/float could not send/);
    // The resume cannot finish right now (the deployment is having a bad minute).
    confirmStatus = 503;
    claimStatus = 503;
    const err = await panelClick().catch((e: Error) => e);
    expect(String((err as Error).message)).toMatch(/^PAYMENT_OUTSTANDING:/);
    expect(sentPayments).toEqual(['PAY-1']);
    expect(calls.filter((c) => c.body?.action === 'reserve')).toHaveLength(1);
  });
});

// ── F58 ─────────────────────────────────────────────────────────────────────

describe('F58 · a paid record always wins the resume over a younger paymentless one', () => {
  it('🚨 the paid record is the one presented, and no third payment is made', async () => {
    // Click 1: the buyer dismisses the wallet prompt for the till payment.
    const dismiss = async () => {
      throw new Error('User rejected the request.');
    };
    await expect(
      contributeToPool({
        meta: 'meta', token: 'SOL', denomination: 1, owner: OWNER,
        connection: connection(), signOne: dismiss, signMessage,
      }),
    ).rejects.toThrow(/User rejected/);
    // Click 2: paid, then the worker goes quiet and the deployment refuses both collects.
    contributeExecute = 'throw';
    confirmStatus = 503;
    claimStatus = 503;
    await expect(contribute()).rejects.toThrow(/do NOT contribute again/);
    expect(sentPayments).toEqual(['PAY-1']);

    const next = await pendingFor('meta', OWNER.toBase58());
    expect(next?.paymentSignature, 'the unpaid reservation shadowed the paid one').toBe('PAY-1');

    // Click 3, inside 20 minutes of click 1.
    calls = [];
    await panelClick().catch(() => undefined);
    expect(calls.some((c) => c.body?.paymentSignature === 'PAY-1' || c.body?.signature === 'PAY-1')).toBe(true);
    expect(sentPayments, 'a third click paid the till again').toEqual(['PAY-1']);
  });
});

// ── F07 (resume half) ───────────────────────────────────────────────────────

describe('F07 · a resumed issued note hands back its claim code', () => {
  it('🚨 resumeContribution returns the code the note was bought with', async () => {
    relayFailures = 1;
    await expect(contribute()).rejects.toThrow();
    confirmStatus = 409;
    const out = await resumeContribution({ meta: 'meta', owner: OWNER, signMessage });
    expect(out?.claimCode).toBe('FALLBACK');
  });
});

// ── F70 / F59 ───────────────────────────────────────────────────────────────

describe('F70 · the note-in exchange refuses before it spends anything', () => {
  const exchange = () =>
    exchangeNoteForIssued({
      meta: 'meta',
      token: 'SOL',
      denomination: 1,
      leafIndex: 7,
      owner: OWNER,
      connection: connection(),
      signOne,
    });

  it('🚨 refuses with EXCHANGE_DISABLED when the deployment says the exchange is off', async () => {
    // The build flag is ON here, so what stops the spend is the deployment's
    // GET answer and nothing else (verifier round 1: without the flag this case
    // passed with the GET check deleted, `mut-F70-client-terms.log`).
    vi.stubEnv('NEXT_PUBLIC_P01_ALLOW_NOTE_EXCHANGE', '1');
    exchangeTerms = { exchange: false };
    await expect(exchange()).rejects.toThrow(/^EXCHANGE_DISABLED:/);
    expect(executes, 'the note was spent into the till').toEqual([]);
  });

  it('🚨 refuses by default, whatever the deployment answers, and says nothing was spent', async () => {
    const err = await exchange().catch((e: Error) => e);
    expect(String((err as Error).message)).toMatch(/^EXCHANGE_DISABLED:.*Nothing was spent/);
    expect(executes).toEqual([]);
  });
});

// ── F57, round 2: a payment that paid nothing is not owed anything ──────────
//
// Verifier round 1 (`verify-r1/probe-failed-payment.test.ts`): the payment was
// put on the record BEFORE its confirmation, and nothing took it back off when
// it landed and failed, or never landed. The record then named a payment that
// bought nothing, was never pruned, and every later contribution was refused
// with PAYMENT_OUTSTANDING, for good.

describe('F57 (round 2) · a payment that paid nothing never blocks the next contribution', () => {
  const contributeOn = (conn: Connection) =>
    contributeToPool({ meta: 'meta', token: 'SOL', denomination: 1, owner: OWNER, connection: conn, signOne, signMessage });
  const expiry = () => {
    const e = new Error('Signature PAY-1 has expired: block height exceeded.');
    e.name = 'TransactionExpiredBlockheightExceededError';
    return e;
  };
  const failedOnChain = {
    ok: false,
    error: 'that transaction failed on chain, so it paid nothing',
    code: 'PAYMENT_FAILED_ON_CHAIN',
  };

  it('🚨 landed and FAILED: the record lets go of it, and the next click pays and completes', async () => {
    const failing = connection({
      confirmTransaction: async () => ({ value: { err: { InstructionError: [0, 'Custom'] } } }),
    });
    chainStatus.set('PAY-1', { err: { InstructionError: [0, 'Custom'] } });
    await expect(contributeOn(failing)).rejects.toThrow(/Payment to the deployment failed/);
    expect(sentPayments).toEqual(['PAY-1']);
    expect(
      await pendingRecords('meta', OWNER.toBase58()),
      'the record still names a payment that paid nothing',
    ).toEqual([]);
    // What the real route answers for PAY-1, should anything present it.
    confirmStatus = 409;
    claimStatus = 400;
    claimRefusal = failedOnChain;
    const err = await panelClick().then(
      () => null,
      (e: Error) => e,
    );
    expect(String(err?.message ?? ''), 'a payment that paid nothing blocks contributing').not.toMatch(
      /^PAYMENT_OUTSTANDING:/,
    );
    expect(sentPayments).toEqual(['PAY-1', 'PAY-2']);
  });

  it('🚨 expired and never landed: dropped with its relay receipt, and the next click pays once', async () => {
    const expiring = connection({
      confirmTransaction: async () => {
        throw expiry();
      },
    });
    chainStatus.set('PAY-1', null);
    blockHeight = 2;
    await expect(contributeOn(expiring)).rejects.toThrow(/^PAYMENT_EXPIRED: .*expired before it landed, so nothing was paid/);
    expect(await pendingRecords('meta', OWNER.toBase58())).toEqual([]);
    expect(await listRelayPayments('meta')).toEqual([]);
    const out = await contribute();
    expect(out.claimCode).toBe('CONFIRMED');
    expect(sentPayments).toEqual(['PAY-1', 'PAY-2']);
  });

  it('an expiry the chain contradicts (the payment landed) carries on, and pays nothing twice', async () => {
    const lateConfirm = connection({
      confirmTransaction: async () => {
        throw expiry();
      },
    });
    const out = await contributeOn(lateConfirm);
    expect(out.claimCode).toBe('CONFIRMED');
    expect(sentPayments).toEqual(['PAY-1']);
    expect(posts('/api/relay-to-buyer')).toHaveLength(1);
  });

  it('🚨 a record left by a lost confirmation is dropped once the deployment says its payment FAILED on chain', async () => {
    const lost = connection({
      confirmTransaction: async () => {
        throw new Error('fetch failed');
      },
    });
    await expect(contributeOn(lost)).rejects.toThrow(/fetch failed/);
    expect((await pendingRecords('meta', OWNER.toBase58()))[0]?.paymentSignature).toBe('PAY-1');
    confirmStatus = 409;
    claimStatus = 400;
    claimRefusal = failedOnChain;
    const resumed = await resumeContribution({ meta: 'meta', owner: OWNER, signMessage });
    expect(resumed, 'a payment that paid nothing was treated as owed').toBeNull();
    expect(await pendingRecords('meta', OWNER.toBase58())).toEqual([]);
  });

  it('🚨 the guard drops a payment the chain does not know past the height it was valid until', async () => {
    const lost = connection({
      confirmTransaction: async () => {
        throw new Error('fetch failed');
      },
    });
    await expect(contributeOn(lost)).rejects.toThrow(/fetch failed/);
    expect((await pendingRecords('meta', OWNER.toBase58()))[0]).toMatchObject({
      paymentSignature: 'PAY-1',
      paymentValidUntil: 1,
    });
    chainStatus.set('PAY-1', null);
    blockHeight = 5;
    const out = await contribute();
    expect(out.claimCode).toBe('CONFIRMED');
    expect(sentPayments).toEqual(['PAY-1', 'PAY-2']);
  });

  it('⛔ the guard still refuses while such a payment may yet land, or the chain cannot be read', async () => {
    const lost = connection({
      confirmTransaction: async () => {
        throw new Error('fetch failed');
      },
    });
    await expect(contributeOn(lost)).rejects.toThrow(/fetch failed/);
    chainStatus.set('PAY-1', null);
    blockHeight = 1; // not past the lastValidBlockHeight it was signed under (1)
    await expect(contribute()).rejects.toThrow(/^PAYMENT_OUTSTANDING:/);
    const unreadable = connection({
      getSignatureStatuses: async () => {
        throw new Error('rpc down');
      },
    });
    blockHeight = 5;
    await expect(contributeOn(unreadable)).rejects.toThrow(/^PAYMENT_OUTSTANDING:/);
    expect(sentPayments).toEqual(['PAY-1']);
  });
});

// ── F11 (client, round 3): the in-flow fallback names the funded key too ─────

describe('F11 (round 3) · the fallback inside contributeToPool proves the deposit key', () => {
  it('🚨 a relay-funded deposit that fails in the same click presents its ephemeral and ephemeralProof', async () => {
    // Mutant C-F11-client-contribute (the `ephemeral:` line of the in-flow
    // fallback deleted) survived every client test: only the resume path was
    // pinned. Without it the route refuses every in-flow relayed fallback with
    // RELAYED_EPHEMERAL_REQUIRED.
    contributeExecute = 'throw';
    const out = await contribute();
    expect(sentPayments, 'one click, one payment').toEqual(['PAY-1']);
    expect(posts('/api/relay-to-buyer')).toHaveLength(1);
    expect(out.claimCode).toBe('FALLBACK');
    const claims = posts('/api/claim-for-payment');
    expect(claims).toHaveLength(1);
    const body = claims[0]!.body!;
    expect(body).toMatchObject({ signature: 'PAY-1', contribution: { token: 'SOL', leafIndex: 41 } });
    expect(body.ephemeral, 'the fallback named no deposit key').toBe(contributionEphemeral(41));
    expect(typeof body.ephemeralProof).toBe('string');
    expect(
      nacl.sign.detached.verify(
        new Uint8Array(
          Buffer.from(
            'Protocol 01 - the deposit key this payment funded gave the float back.\nPayment: PAY-1',
            'utf8',
          ),
        ),
        new Uint8Array(Buffer.from(String(body.ephemeralProof), 'base64')),
        new PublicKey(contributionEphemeral(41)).toBytes(),
      ),
      'the ephemeral proof is not a signature by the key the relay funded',
    ).toBe(true);
  });
});
