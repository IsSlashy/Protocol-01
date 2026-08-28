/**
 * Selling a note against an on-chain payment.
 *
 * This route runs AFTER the buyer's money has moved, which decides most of what
 * follows: every refusal it can give must either leave the payment reusable, or
 * hand over the thing that was bought. There is no third option that is honest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import nacl from 'tweetnacl';
import { Keypair } from '@solana/web3.js';

const mockGetStore = vi.fn();
const mockRateLimitExceeded = vi.fn();

vi.mock('@/lib/waitlist/store', () => ({
  getStore: () => mockGetStore(),
  rateLimitExceeded: (...a: unknown[]) => mockRateLimitExceeded(...a),
}));

const mockGetTransaction = vi.fn();
vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    Connection: class {
      getTransaction = (...a: unknown[]) => mockGetTransaction(...a);
    },
  };
});

const TILL = 'F6R1sEJNLSCNGA3GXtwpofu55XqukDdn3U9jerLtW8wE';
const buyer = Keypair.generate();
const SIG = '5'.repeat(87);

/** A transaction whose account keys are [payer, till] with the given delta. */
function paidTx(lamports: number, payer = buyer.publicKey.toBase58(), err: unknown = null) {
  return {
    meta: { err, preBalances: [10e9, 1e9], postBalances: [10e9 - lamports, 1e9 + lamports] },
    transaction: {
      message: { getAccountKeys: () => ({ staticAccountKeys: [{ toBase58: () => payer }, { toBase58: () => TILL }] }) },
    },
  };
}

function store() {
  const data = new Map<string, string>();
  const counts = new Map<string, number>();
  return {
    data,
    incr: vi.fn(async (k: string) => {
      const n = (counts.get(k) ?? 0) + 1;
      counts.set(k, n);
      return n;
    }),
    get: vi.fn(async (k: string) => data.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => void data.set(k, v)),
    expire: vi.fn(),
  };
}

function post(body: unknown) {
  return new NextRequest('http://localhost/api/claim-for-payment', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

async function route() {
  return import('@/app/api/claim-for-payment/route');
}

/**
 * The challenge is written out here rather than imported, ON PURPOSE: this is
 * the wire format a wallet has to sign, so a test that derived it from the
 * source would follow the source anywhere it drifted and pin nothing.
 */
function challenge(sig: string): string {
  return `Protocol 01 - collect the note I paid for.
Payment: ${sig}`;
}

function proofFor(sig: string, kp = buyer) {
  return Buffer.from(
    nacl.sign.detached(new Uint8Array(Buffer.from(challenge(sig), 'utf8')), kp.secretKey),
  ).toString('base64');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimitExceeded.mockResolvedValue(false);
  process.env.P01_TILL_ADDRESS = TILL;
  process.env.P01_TREASURY_NOTE_DENOMINATION = '1';
  delete process.env.P01_NOTE_PRICE_LAMPORTS;
});

describe('a claim is only sold against a payment that really landed', () => {
  it('mints one claim for a payment that covers the price', async () => {
    mockGetStore.mockReturnValue(store());
    mockGetTransaction.mockResolvedValue(paidTx(1_003_000_000));
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: proofFor(SIG) }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.claimCode).toMatch(/^[\w-]{43}$/);
    expect(body.expires).toBe(false);
  });

  it('🚨 the same payment returns the SAME claim, never a second one', async () => {
    // A buyer who lost the response has already paid. A second code sells one
    // payment twice; a refusal keeps their money and gives them nothing.
    mockGetStore.mockReturnValue(store());
    mockGetTransaction.mockResolvedValue(paidTx(1_003_000_000));
    const { POST } = await route();
    const first = await (await POST(post({ signature: SIG, proof: proofFor(SIG) }))).json();
    const again = await (await POST(post({ signature: SIG, proof: proofFor(SIG) }))).json();
    expect(again.claimCode).toBe(first.claimCode);
  });

  it('⛔ refuses a stranger who saw the payment on chain', async () => {
    // Every payment to the till is public. The signature cannot be the
    // credential, or the first passer-by collects the note somebody bought.
    mockGetStore.mockReturnValue(store());
    mockGetTransaction.mockResolvedValue(paidTx(1_003_000_000));
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: proofFor(SIG, Keypair.generate()) }));
    expect(res.status).toBe(401);
  });

  it('refuses an underpayment WITHOUT consuming it, so the buyer can top up', async () => {
    const kv = store();
    mockGetStore.mockReturnValue(kv);
    mockGetTransaction.mockResolvedValue(paidTx(500_000_000));
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: proofFor(SIG) }));
    expect(res.status).toBe(402);
    expect(kv.incr).not.toHaveBeenCalled();
  });

  it('⚠️ accepts an OVERPAYMENT, because refusing it would keep the money', async () => {
    mockGetStore.mockReturnValue(store());
    mockGetTransaction.mockResolvedValue(paidTx(5_000_000_000));
    const { POST } = await route();
    expect((await POST(post({ signature: SIG, proof: proofFor(SIG) }))).status).toBe(200);
  });

  it('refuses a transaction that never named the till', async () => {
    mockGetStore.mockReturnValue(store());
    mockGetTransaction.mockResolvedValue({
      meta: { err: null, preBalances: [10e9], postBalances: [9e9] },
      transaction: {
        message: {
          getAccountKeys: () => ({
            staticAccountKeys: [{ toBase58: () => buyer.publicKey.toBase58() }],
          }),
        },
      },
    });
    const { POST } = await route();
    expect((await POST(post({ signature: SIG, proof: proofFor(SIG) }))).status).toBe(400);
  });

  it('refuses a transaction that failed on chain', async () => {
    mockGetStore.mockReturnValue(store());
    mockGetTransaction.mockResolvedValue(paidTx(1_003_000_000, buyer.publicKey.toBase58(), { e: 1 }));
    const { POST } = await route();
    expect((await POST(post({ signature: SIG, proof: proofFor(SIG) }))).status).toBe(400);
  });

  it('⛔ fails closed with no durable store', async () => {
    // Without a counter one payment mints unbounded claims: the inventory given
    // away.
    mockGetStore.mockReturnValue(null);
    const { POST } = await route();
    expect((await POST(post({ signature: SIG, proof: proofFor(SIG) }))).status).toBe(503);
  });

  it('reports its own readiness rather than guessing', async () => {
    mockGetStore.mockReturnValue(store());
    process.env.P01_FUNDER_RPC = 'https://example.invalid';
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.configured).toBe(true);
    expect(body.till).toBe(TILL);
    expect(body.priceLamports).toBe(1_000_000_000);
  });
});
