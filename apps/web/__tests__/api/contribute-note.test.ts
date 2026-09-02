/**
 * CONTRIBUTING A LEAF YOU DO NOT OWN, the mixer, tested.
 *
 * 🚨 THE PROPERTY THIS SUITE EXISTS FOR: `reserve` hands back a COMMITMENT and
 * never an opening. The whole reason this flow has no drain is that the
 * depositor cannot spend what they deposit, and the only way to break that is
 * for a secret to escape the server. Two cases below recompute the treasury's
 * derivation independently and assert the response carries the commitment and
 * nothing else.
 *
 * The second property is arithmetic: one payment earns exactly one claim. A
 * second confirmation must return the SAME code, never mint another, and so
 * must a confirmation of a payment the fallback route already claimed. One
 * contribution paying for two notes is the treasury going backwards.
 *
 * The third is WHO may confirm. Leaf indices are public and the ticket ships
 * in the bundle, so a confirm that any caller could replay handed the claim
 * code to whoever read the tree first. A confirm now proves it is the payer
 * (a signature over the claim challenge, verified against the fee payer of the
 * payment) and names the leaf the relay funded WITH that payment.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import nacl from 'tweetnacl';
import { Keypair } from '@solana/web3.js';

const mockGetStore = vi.fn();
const mockRateLimitExceeded = vi.fn();

vi.mock('@/lib/waitlist/store', () => ({
  getStore: () => mockGetStore(),
  rateLimitExceeded: (...args: unknown[]) => mockRateLimitExceeded(...args),
}));

/** What `getTransaction` answers for the payment. `null` = not on chain yet. */
let paymentTx: unknown = null;

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    Connection: class {
      async getGenesisHash() {
        return 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
      }
      async getTransaction() {
        return paymentTx;
      }
    },
  };
});

vi.mock('@/lib/privacy/pool/denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/privacy/pool/denominatedPool')>();
  return {
    ...actual,
    fetchPoolCommitments: vi.fn(async () => new Map()),
  };
});

import {
  createCommitmentV3,
  deriveNoteMaterial,
  getPoolsForTokenV3,
  pubkeyToField,
} from '@/lib/privacy/pool/denominatedPool';
import { deriveNoteBlinding } from '@/lib/privacy/pool/noteBlinding';
import { POST } from '@/app/api/contribute-note/route';

const TICKET = 'test-ticket';
const SEED_HEX = 'ab'.repeat(32);
const SEED_BYTES = Uint8Array.from(SEED_HEX.match(/../g)!.map((h) => parseInt(h, 16)));

/** Contributions are DEPOSITS, so only a pool open to deposits can take one. */
const POOL = getPoolsForTokenV3('SOL').find((p) => p.deposits === 'open')!;
const POOL_KEY = POOL?.poolPDA.toBase58();
const CLOSED = getPoolsForTokenV3('SOL').find((p) => p.deposits !== 'open')!;

/** The wallet that paid the till: keys[0] of the payment. */
const wallet = Keypair.generate();
const PAYSIG = '4'.repeat(87);

/** The treasury's own commitment at a leaf, recomputed here, independently. */
function treasuryCommitmentAt(leafIndex: number): bigint {
  const { secret, nullifierPreimage } = deriveNoteMaterial(SEED_BYTES, POOL.poolPDA, leafIndex);
  return createCommitmentV3(
    nullifierPreimage,
    secret,
    deriveNoteBlinding(SEED_BYTES, POOL.poolPDA, leafIndex),
    pubkeyToField(POOL.tokenMint),
  );
}

/** A tree holding these leaves, keyed by commitment as the real reader returns. */
function tree(entries: Array<{ leafIndex: number; commitment: bigint }>) {
  return new Map(
    entries.map((e) => [e.commitment.toString(), { ...e, depositSlot: 1 }]),
  );
}

/** The payment as the chain reports it: fee payer first. */
function paidBy(payer = wallet.publicKey.toBase58(), err: unknown = null) {
  return {
    meta: { err, preBalances: [2e9, 5], postBalances: [2e9 - 1_003_000_000, 5 + 1_003_000_000] },
    transaction: {
      message: {
        getAccountKeys: () => ({
          staticAccountKeys: [{ toBase58: () => payer }, { toBase58: () => 'TILL' }],
        }),
      },
    },
  };
}

/**
 * The challenge, written out rather than imported: it is the wire format a
 * wallet signs, and a test that derived it from the source would pin nothing.
 */
function challenge(sig: string): string {
  return `Protocol 01 - collect the note I paid for.
Payment: ${sig}`;
}

function proofFor(sig: string, kp = wallet) {
  return Buffer.from(
    nacl.sign.detached(new Uint8Array(Buffer.from(challenge(sig), 'utf8')), kp.secretKey),
  ).toString('base64');
}

/** A confirm of leaf `leafIndex`, signed by the wallet that paid. */
function confirmBody(leafIndex: number, over: Record<string, unknown> = {}) {
  return {
    action: 'confirm',
    leafIndex,
    paymentSignature: PAYSIG,
    proof: proofFor(PAYSIG),
    ...over,
  };
}

let counters: Map<string, number>;
let values: Map<string, string>;
let sets: Map<string, Set<string>>;

function fakeKv() {
  return {
    incr: vi.fn(async (key: string) => {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    }),
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, v: string) => {
      values.set(key, v);
    }),
    sadd: vi.fn(async (key: string, member: string) => {
      const s = sets.get(key) ?? new Set<string>();
      s.add(member);
      sets.set(key, s);
    }),
    smembers: vi.fn(async (key: string) => [...(sets.get(key) ?? [])]),
    del: vi.fn(async (key: string) => {
      counters.delete(key);
      values.delete(key);
    }),
    expire: vi.fn(),
  };
}

function req(body: unknown, ticket: string | null = TICKET) {
  return new NextRequest('http://localhost:3000/api/contribute-note', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(ticket ? { 'x-p01-funder-ticket': ticket } : {}),
      'x-real-ip': '198.51.100.9',
    },
    body: JSON.stringify(body),
  } as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

/** The relay funded leaf `leafIndex` with PAYSIG. Written by relay-to-buyer after the send. */
function relayBound(leafIndex: number) {
  values.set(`p01:relay:payment:${PAYSIG}:contribution`, `${POOL_KEY}:${leafIndex}`);
}

const mintedCodes = () => [...values.keys()].filter((k) => k.startsWith('p01:note:claim-minted:'));

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  counters = new Map();
  values = new Map();
  sets = new Map();
  paymentTx = paidBy();
  vi.stubEnv('P01_TREASURY_POOL_SEED', SEED_HEX);
  vi.stubEnv('P01_FUNDER_TICKET', TICKET);
  vi.stubEnv('P01_TREASURY_NOTE_DENOMINATION', String(POOL.denomination));
  mockGetStore.mockReturnValue(fakeKv());
  mockRateLimitExceeded.mockResolvedValue(false);
  const { fetchPoolCommitments } = await import('@/lib/privacy/pool/denominatedPool');
  // A tree whose highest leaf is 5, holding somebody else's commitments.
  vi.mocked(fetchPoolCommitments).mockResolvedValue(
    tree([
      { leafIndex: 4, commitment: 777n },
      { leafIndex: 5, commitment: 888n },
    ]) as never,
  );
  // The ordinary state for a confirm: the relay funded leaf 6 with this payment.
  relayBound(6);
});

/** The tree once the treasury's commitment for leaf 6 has landed. */
async function leafSixLanded() {
  const { fetchPoolCommitments } = await import('@/lib/privacy/pool/denominatedPool');
  vi.mocked(fetchPoolCommitments).mockResolvedValue(
    tree([
      { leafIndex: 5, commitment: 888n },
      { leafIndex: 6, commitment: treasuryCommitmentAt(6) },
    ]) as never,
  );
}

describe('the pool this suite rests on', () => {
  it('is open to deposits, or nothing can be contributed at all', () => {
    expect(POOL, 'no SOL pool accepts deposits').toBeTruthy();
    expect(POOL.deposits).toBe('open');
  });
});

describe('🚨 reserve hands back a commitment and never an opening', () => {
  it('returns the treasury commitment for the next free leaf', async () => {
    const res = await POST(req({ action: 'reserve' }));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    // The tree's highest leaf is 5, so the next free index is 6.
    expect(body.leafIndex).toBe(6);
    // Recomputed here from the seed: the server must hand back OUR derivation,
    // because a claim is only earned when this exact value lands on the tree.
    expect(body.commitment).toBe(treasuryCommitmentAt(6).toString());
  });

  it('⛔ leaks no secret, no nullifier and no blinding', async () => {
    // The one property that would collapse the whole flow. If the depositor
    // learns the opening, they hold the note they deposited AND the note they
    // collect: the exact double-spend this design exists to make impossible.
    const res = await POST(req({ action: 'reserve' }));
    const body = await res.json();
    const serialised = JSON.stringify(body);
    const { secret, nullifierPreimage } = deriveNoteMaterial(SEED_BYTES, POOL.poolPDA, 6);
    const blinding = deriveNoteBlinding(SEED_BYTES, POOL.poolPDA, 6);
    expect(serialised).not.toContain(secret.toString());
    expect(serialised).not.toContain(nullifierPreimage.toString());
    expect(serialised).not.toContain(blinding.toString());
    for (const key of ['secret', 'nullifier_preimage', 'nullifierPreimage', 'deposit_epoch']) {
      expect(body[key], `reserve returned ${key}`).toBeUndefined();
    }
  });

  /**
   * 🚨 KNOWN DEFECT, PINNED AS ONE. `it.fails` passes while the route hands
   * the SAME leaf to two contributors, and goes red the day it stops, so the
   * fix is noticed and this note removed.
   *
   * The reclaim added on 2026-08-31 clears the marker at `start` whenever a
   * second reservation finds it taken ("the tree is the authority; a marker on
   * an index the tree has not reached describes an attempt that died"). But
   * `start` is `maxLeafOnTree + 1` BY DEFINITION, so the tree can never have
   * reached it, and the reclaim fires on every second reservation inside the
   * hour: a live contributor thirty seconds into proving loses their index to
   * the next arrival, and one of the two deposits fails on chain after the
   * till was paid.
   *
   * This case used to pass because the fake store's `del` was a no-op, so the
   * reclaim never actually cleared anything: green for the wrong reason. The
   * store now deletes, as the real ones do.
   */
  it('never hands the same leaf to two live contributors', async () => {
    const a = await (await POST(req({ action: 'reserve' }))).json();
    const b = await (await POST(req({ action: 'reserve' }))).json();
    expect(a.leafIndex).toBe(6);
    expect(b.leafIndex, 'two contributors were given the same leaf').toBe(7);
    expect(b.commitment).toBe(treasuryCommitmentAt(7).toString());
  });

  it('reclaims the edge leaf only once its reservation is older than the proving window', async () => {
    const a = await (await POST(req({ action: 'reserve' }))).json();
    expect(a.leafIndex).toBe(6);
    // Age the marker past the window: the holder's attempt must be dead.
    values.set(`p01:note:contrib-reserved:${POOL_KEY}:6:at`, String(Date.now() - 21 * 60 * 1000));
    const b = await (await POST(req({ action: 'reserve' }))).json();
    expect(b.leafIndex, 'a dead reservation at the tree edge was not reclaimed').toBe(6);
    // And a third, live, contributor walks past it again.
    const c = await (await POST(req({ action: 'reserve' }))).json();
    expect(c.leafIndex).toBe(7);
  });

  it('a marker without a recorded age (written before ages existed) is reclaimable', async () => {
    counters.set(`p01:note:contrib-reserved:${POOL_KEY}:6`, 1);
    const a = await (await POST(req({ action: 'reserve' }))).json();
    expect(a.leafIndex).toBe(6);
  });
});

describe('confirm pays only for a contribution that actually landed', () => {
  it('refuses a leaf whose treasury commitment is not on the tree', async () => {
    const res = await POST(req(confirmBody(6)));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.error).toMatch(/not on the tree/);
    expect(mintedCodes(), 'a claim was minted for a deposit that never landed').toHaveLength(0);
    // And the payment is NOT consumed: the fallback route must still be able
    // to claim it if the deposit never lands.
    expect(counters.get(`p01:note:paid:${PAYSIG}`)).toBeUndefined();
  });

  it('🚨 ignores the commitment the caller names, and recomputes ours', async () => {
    // Trusting `body.commitment` would let anyone point at somebody else's
    // existing leaf (leaf 4 below) and be paid a claim for a deposit they
    // never made.
    relayBound(4);
    const res = await POST(req(confirmBody(4, { commitment: '777' })));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.error).toMatch(/not on the tree/);
  });

  it('mints a claim, records the leaf as inventory, and marks the code minted under the payment', async () => {
    await leafSixLanded();
    const res = await POST(req(confirmBody(6)));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    // Inside issue-note's claim alphabet, or the endpoint meant to honour it
    // would refuse the code this route just sold.
    expect(body.claimCode).toMatch(/^[A-Za-z0-9_-]{8,64}$/);

    // ⛔ Non-empty: issue-note tests `if (!minted)`, so an empty value would
    // burn a paying buyer's claim without releasing it.
    const minted = values.get(`p01:note:claim-minted:${body.claimCode}`);
    expect(minted, 'the claim was not marked minted').toBeTruthy();
    expect(minted).toContain(String(6));
    expect(minted).toContain(`payment:${PAYSIG}`);

    // The same code under the payment, so the fallback route replays it.
    expect(values.get(`p01:note:paid:${PAYSIG}:code`)).toBe(body.claimCode);
    expect(counters.get(`p01:note:paid:${PAYSIG}`)).toBe(1);

    // The contributed leaf is now issuable stock, legitimate here precisely
    // because its opening derives from the treasury seed.
    expect([...(sets.get(`p01:note:inventory:${POOL_KEY}`) ?? [])]).toContain('6');
  });

  it('a second confirmation returns the SAME code rather than minting another', async () => {
    await leafSixLanded();
    const first = await (await POST(req(confirmBody(6)))).json();
    const second = await (await POST(req(confirmBody(6)))).json();
    expect(second.ok).toBe(true);
    expect(second.replayed).toBe(true);
    expect(second.claimCode, 'one deposit minted two claims').toBe(first.claimCode);
    expect(mintedCodes(), 'one deposit paid for two notes').toHaveLength(1);
  });

  it('🚨 a confirm after the FALLBACK already claimed the payment returns that code', async () => {
    // The deposit had not landed when the client gave up, so it collected at
    // /api/claim-for-payment; then the deposit landed after all and the client
    // (or its resume) confirms. One payment, one code: the fallback's.
    await leafSixLanded();
    counters.set(`p01:note:paid:${PAYSIG}`, 1);
    values.set(`p01:note:paid:${PAYSIG}:code`, 'FALLBACK-CODE');
    const res = await POST(req(confirmBody(6)));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.claimCode).toBe('FALLBACK-CODE');
    expect(body.replayed).toBe(true);
    expect(mintedCodes(), 'the confirm minted a second code for a paid payment').toHaveLength(0);
    // The leaf DID land and IS the treasury's, so it is recorded as stock
    // here; the fallback could not, because it ran before the deposit landed.
    expect([...(sets.get(`p01:note:inventory:${POOL_KEY}`) ?? [])]).toContain('6');
  });

  it('⛔ refuses a leaf confirmed under a DIFFERENT payment, and gives that payment back', async () => {
    // The loser of a reservation race: its payment is bound to the same leaf,
    // but the leaf's code belongs to the payment that deposited it.
    await leafSixLanded();
    counters.set(`p01:note:contrib-confirmed:${POOL_KEY}:6`, 1);
    values.set(`p01:note:contrib-claim:${POOL_KEY}:6`, 'WINNERS-CODE');
    const res = await POST(req(confirmBody(6)));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.claimCode).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('WINNERS-CODE');
    // Released: nothing was minted for it, so it stays claimable where it belongs.
    expect(counters.get(`p01:note:paid:${PAYSIG}`)).toBeUndefined();
  });
});

describe('⛔ confirm is bound to the payment that funded the leaf', () => {
  it('requires the payment signature', async () => {
    await leafSixLanded();
    const res = await POST(req(confirmBody(6, { paymentSignature: undefined })));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/paymentSignature/);
    expect(mintedCodes()).toHaveLength(0);
  });

  it('requires the proof', async () => {
    await leafSixLanded();
    const res = await POST(req(confirmBody(6, { proof: undefined })));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/proof/);
    expect(mintedCodes()).toHaveLength(0);
  });

  it('🚨 refuses a stranger who read the leaf index off the tree', async () => {
    // THE LEAK THIS CLOSES. Leaf indices are public and the ticket ships in the
    // bundle; a confirm any caller could send handed out the claim code.
    await leafSixLanded();
    const res = await POST(req(confirmBody(6, { proof: proofFor(PAYSIG, Keypair.generate()) })));
    expect(res.status).toBe(401);
    expect(mintedCodes()).toHaveLength(0);
    expect(counters.get(`p01:note:paid:${PAYSIG}`)).toBeUndefined();
  });

  it('refuses a payment that is not on chain', async () => {
    await leafSixLanded();
    paymentTx = null;
    const res = await POST(req(confirmBody(6)));
    expect(res.status).toBe(404);
  });

  it('⛔ refuses a leaf the relay did not fund with this payment', async () => {
    // A payer cannot confirm somebody else's reservation, however well it
    // verifies on the tree.
    await leafSixLanded();
    relayBound(7);
    const res = await POST(req(confirmBody(6)));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.error).toMatch(/did not fund/);
    expect(mintedCodes()).toHaveLength(0);
    expect(counters.get(`p01:note:paid:${PAYSIG}`)).toBeUndefined();
  });

  it('refuses when the relay recorded no contribution for this payment', async () => {
    await leafSixLanded();
    values.delete(`p01:relay:payment:${PAYSIG}:contribution`);
    const res = await POST(req(confirmBody(6)));
    expect(res.status).toBe(400);
    expect(mintedCodes()).toHaveLength(0);
  });
});

describe('the gates in front of it', () => {
  it('refuses without the ticket header', async () => {
    const res = await POST(req({ action: 'reserve' }, null));
    expect(res.status).toBe(401);
  });

  it('refuses an unknown action rather than guessing', async () => {
    const res = await POST(req({ action: 'withdraw-everything' }));
    expect(res.status).toBe(400);
  });

  it('⛔ refuses when the configured pool is closed to deposits', async () => {
    // Finding this out after the buyer has paid the till is the expensive way.
    expect(CLOSED, 'every pool is open; this case is vacuous').toBeTruthy();
    vi.stubEnv('P01_TREASURY_NOTE_DENOMINATION', String(CLOSED.denomination));
    const res = await POST(req({ action: 'reserve' }));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(503);
    expect(body.error).toMatch(/closed to deposits/);
  });

  it('refuses when no durable store is configured', async () => {
    mockGetStore.mockReturnValue(null);
    const res = await POST(req({ action: 'reserve' }));
    expect(res.status).toBe(503);
  });
});
