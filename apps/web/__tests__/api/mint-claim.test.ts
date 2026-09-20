/**
 * WHAT `/api/mint-claim` PUTS IN THE STORE, as opposed to what it is told.
 *
 * Run: cd apps/web && pnpm test
 *
 * `reference` is whatever authorised a mint: an operator's note, or a payment
 * processor's receipt id when the webhook this route is a seam for finally
 * exists. It is written, not verified — the route says so itself — and it used
 * to be written VERBATIM, up to 200 characters, under a key that is the claim
 * code and with no expiry.
 *
 * 🚨 SO A COPY OF THE STORE READ WHATEVER THE OPERATOR HAPPENED TO TYPE: a
 * customer id, an email address, an invoice number, sitting beside the code
 * that names the note it bought. Nothing in this repository ever read the
 * value; `/api/issue-note` only tests `if (!minted)`, i.e. that SOMETHING is
 * there (plan KV-1 (4)).
 *
 * A row no code needs is a row only a dump can use. What is stored now is the
 * first 16 hex of sha256(reference): enough for an operator holding the
 * original receipt to confirm a match, and not a string a reader can lift an
 * identity out of.
 *
 * ⚠️ WHAT THIS DOES NOT CLAIM. A digest of a LOW-ENTROPY reference is
 * recoverable by guessing — an operator who writes "alice@example.com" is
 * protected only against a reader who does not think to try it. This narrows
 * what a dump reads; it does not make the reference a secret, and the value
 * is a hash of the caller's own input, not a keyed one. KVX-1 owns keying.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';

const mockGetStore = vi.fn();
vi.mock('@/lib/waitlist/store', () => ({ getStore: () => mockGetStore() }));

import { POST } from '@/app/api/mint-claim/route';

/** Server-only, and at least 16 characters or the route refuses to mint. */
const SECRET = 'mint-secret-for-this-suite-0123456789';

function store() {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn(async (k: string) => data.get(k) ?? null),
    set: vi.fn(async (k: string, v: unknown) => void data.set(k, v)),
    del: vi.fn(async (k: string) => void data.delete(k)),
    incr: vi.fn(async () => 1),
    expire: vi.fn(),
    sadd: vi.fn(),
    smembers: vi.fn(async () => []),
  };
}

function post(body: unknown, secret: string | null = SECRET) {
  return new NextRequest('http://localhost/api/mint-claim', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      ...(secret ? { 'x-p01-claim-mint': secret } : {}),
    },
  });
}

const digestOf = (reference: string) =>
  createHash('sha256').update(reference).digest('hex').slice(0, 16);

/** An operator reference of the shape that makes this a leak at all. */
const REFERENCE = 'stripe:pi_3PdQ1x2eZvKYlo2C0 for alice@example.com, invoice 41982';

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('P01_CLAIM_MINT_SECRET', SECRET);
  mockGetStore.mockReturnValue(store());
});

describe('mint-claim records a digest of the reference, not the reference', () => {
  it('🚨 stores the digest, and the operator string is nowhere in the store', async () => {
    const kv = store();
    mockGetStore.mockReturnValue(kv);

    const res = await POST(post({ reference: REFERENCE }));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);

    const stored = kv.data.get(`p01:note:claim-minted:${body.claimCode}`);
    // ⛔ Non-empty, or `/api/issue-note` answers 402 "never issued against a
    // payment" and burns a claim somebody paid for on the way out.
    expect(stored, 'nothing was recorded, so a paid claim would be burned').toBeTruthy();
    expect(stored, 'the operator reference is at rest in the store').not.toBe(REFERENCE);
    expect(stored).toBe(digestOf(REFERENCE));
    // ⛔ And nothing else. A substring scan is dodged by one encoding (base64
    // of the reference in a second row passed it: mutant V6,
    // wp-logs/KV-1-fix2/mutants.log), so the store is read whole: one row, the
    // one `issue-note` needs.
    expect([...kv.data.keys()], 'a row beside the claim was written').toEqual([
      `p01:note:claim-minted:${body.claimCode}`,
    ]);

    const dump = [...kv.data.entries()].map(([k, v]) => `${k} = ${String(v)}`).join('\n');
    expect(dump, 'a piece of the reference survives in some other row').not.toContain(
      'alice@example.com',
    );
  });

  it('stores a digest for the default reference too, so the shape never varies', async () => {
    // A caller that sends no reference at all gets 'manual'. If that one were
    // stored raw, the value's shape would tell a reader which mints were
    // manual and which carried a receipt — a distinction worth nothing to us.
    const kv = store();
    mockGetStore.mockReturnValue(kv);
    const body = await (await POST(post({}))).json();
    expect(kv.data.get(`p01:note:claim-minted:${body.claimCode}`)).toBe(digestOf('manual'));
  });

  it('still tells the caller its own reference back, and that the code does not expire', async () => {
    // The operator holds the original, so echoing it costs nothing and is what
    // lets them match a mint to a receipt. The founder ruling on expiry
    // (2026-08-22) is pinned here as well as in claim-does-not-expire.test.ts.
    const res = await POST(post({ reference: REFERENCE }));
    const body = await res.json();
    expect(body.reference).toBe(REFERENCE);
    expect(body.expires).toBe(false);
    expect(body.claimCode).toMatch(/^[\w-]{43}$/);
  });

  it('refuses without the mint secret, and records nothing', async () => {
    const kv = store();
    mockGetStore.mockReturnValue(kv);
    const res = await POST(post({ reference: REFERENCE }, null));
    expect(res.status).toBe(401);
    expect(kv.data.size).toBe(0);
  });

  it('refuses when no mint secret is configured at all', async () => {
    // Unconfigured means no minting, never "minting is open".
    vi.stubEnv('P01_CLAIM_MINT_SECRET', '');
    const res = await POST(post({ reference: REFERENCE }, ''));
    expect(res.status).toBe(503);
  });

  it('fails closed with no durable store', async () => {
    mockGetStore.mockReturnValue(null);
    const res = await POST(post({ reference: REFERENCE }));
    expect(res.status).toBe(503);
  });
});
