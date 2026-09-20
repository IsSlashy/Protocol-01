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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    /**
     * ⛔ ONE KEYSPACE, because the real stores have one.
     *
     * This fake kept counters and values in two maps and read only `values`
     * here, so a key written by `incr` read back as `null` through `get`. A
     * route asking "has this payment already been claimed?" the way Upstash
     * answers it — `get` on the counter, which is what `counterValue` in
     * `paymentBinding.ts` exists to parse — was told no however many times it
     * had been claimed. The split was invisible while nothing read a counter
     * that way; it made KV-1's redeemed-payment refusal untestable.
     */
    get: vi.fn(async (key: string) => values.get(key) ?? counters.get(key) ?? null),
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
    //
    // ⛔ AND IT NAMES THE PAYMENT ONLY. It used to carry the funded leaf as
    // well (`contrib:<pool>:<leaf>:payment:<sig>`), which put the code, the
    // leaf and the buyer's wallet in one row of any dump (KV-1). `issue-note`
    // parses the signature back out of this value to sweep the trail at
    // redemption, so the shape is load-bearing.
    const minted = values.get(`p01:note:claim-minted:${body.claimCode}`);
    expect(minted, 'the claim was not marked minted').toBeTruthy();
    expect(minted).toBe(`payment:${PAYSIG}`);
    expect(minted, 'the minted row still names the funded leaf').not.toContain(String(6));

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

  it('🚨 confirms for the buyer handed a leaf whose PREVIOUS reservation was paid out by the fallback', async () => {
    /**
     * THE FUND LOSS THIS PINS, from confirm's side.
     *
     * Buyer A reserved leaf 6, paid, and their relayed deposit never landed;
     * `/api/claim-for-payment` paid them. That fallback used to `incr`
     * `contrib-confirmed:<pool>:6` for a leaf holding NOTHING, with no TTL and
     * no writer that cleared it. Twenty minutes later the reserve loop reclaims
     * index 6 and hands it to buyer B, who pays and deposits honestly. B's
     * confirm hit `confirmations !== 1` and answered 409, giving B's payment
     * gate back; the fallback then answered 409 pointing at confirm. B had paid
     * a full denomination for nothing.
     *
     * So the state left behind is the state asserted here: A's payment carries
     * its own code and the LEAF carries nothing.
     */
    await leafSixLanded();
    const OTHER_PAYSIG = '9'.repeat(87);
    counters.set(`p01:note:paid:${OTHER_PAYSIG}`, 1);
    values.set(`p01:note:paid:${OTHER_PAYSIG}:code`, 'FALLBACK-CODE-FOR-A');
    values.set('p01:note:claim-minted:FALLBACK-CODE-FOR-A', `payment:${OTHER_PAYSIG}`);
    expect(
      counters.get(`p01:note:contrib-confirmed:${POOL_KEY}:6`),
      'the fallback marks the payment, never the leaf',
    ).toBeUndefined();

    const res = await POST(req(confirmBody(6)));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.claimCode, 'the honest depositor was refused a claim').toBeTruthy();
    expect(body.claimCode).not.toBe('FALLBACK-CODE-FOR-A');
    expect(body.replayed).toBeFalsy();
    // B's leaf is stock now, and A's payment still holds the code it bought.
    expect([...(sets.get(`p01:note:inventory:${POOL_KEY}`) ?? [])]).toContain('6');
    expect(values.get(`p01:note:paid:${OTHER_PAYSIG}:code`)).toBe('FALLBACK-CODE-FOR-A');
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

// ── KV-1 · what a copy of the store holds after a confirm ───────────────────
//
// Adversary: whoever holds a dump of this deployment's KV (an Upstash backup,
// a leaked token, an operator). They hold this repository too, which is public,
// so any keyless function of a leaf names it.
//
// ⚠️ WHAT THIS SCAN IS, AND WHERE THE REAL MEASUREMENT LIVES. This reads the
// rows THIS route writes, by token, for one cycle. The measured version — the
// same purchase run in eight worlds, where a row is read by what MOVES it
// rather than by a spelling it was told to look for — is
// `__tests__/lib/kvRowsAtRest.test.ts`, which KV-1 unpins. This is the
// route-level pin: it goes red the day a confirm writes a leaf beside a
// payment again, without the whole differential having to run.

/**
 * A leaf whose decimal form collides with nothing else in this fixture.
 *
 * ⛔ NOT leaf 6. A scan for "6" matches the digit 6 anywhere inside the claim
 * code, so the case would pass or fail on the luck of a UUID draw. The
 * fixture's separation is asserted in the positive control below, not assumed.
 */
const LEAF_AT_REST = 211;

/** The claim code, pinned and DIGIT-FREE, so the leaf scan cannot misread it. */
const FIXED_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' as const;
const FIXED_CODE = FIXED_UUID.replace(/-/g, '');

/** The tree once the treasury's commitment for LEAF_AT_REST has landed. */
async function leafAtRestLanded() {
  const { fetchPoolCommitments } = await import('@/lib/privacy/pool/denominatedPool');
  vi.mocked(fetchPoolCommitments).mockResolvedValue(
    tree([
      { leafIndex: LEAF_AT_REST - 1, commitment: 888n },
      { leafIndex: LEAF_AT_REST, commitment: treasuryCommitmentAt(LEAF_AT_REST) },
    ]) as never,
  );
}

/** Every row a dump holds: counters, values and set members alike. */
function rowsAtRest(): string[] {
  return [
    ...[...counters].map(([key, v]) => `${key} = ${v}`),
    ...[...values].map(([key, v]) => `${key} = ${v}`),
    ...[...sets].map(([key, s]) => `${key} = ${[...s].join(' ')}`),
  ];
}

/**
 * Rows that name `leaf` AND something only this buyer holds.
 *
 * A leaf is read as a maximal run of digits, which is how a reader finds an
 * index in a key or a value whatever punctuation surrounds it.
 *
 * ⛔ THE RELAY BINDING IS EXEMPT, DELIBERATELY. `p01:relay:payment:<sig>:
 * contribution` pairs a payment with the leaf it funded BY CONSTRUCTION, and
 * KV-1 (3) keeps it: it is the only thing stopping a payer confirming somebody
 * else's reservation, it carries no expiry (pinned in `relay-to-buyer.test.ts`)
 * and ISSUE-1 deletes it at redemption. Whether it is still at rest after a
 * redemption is read by `__tests__/lib/kvRowsAtRest.test.ts`, not here.
 */
function leafJoinsBuyer(leaf: number, buyerTokens: string[]): string[] {
  const exempt = `p01:relay:payment:${PAYSIG}:contribution`;
  return rowsAtRest().filter((row) => {
    if (row.startsWith(`${exempt} =`)) return false;
    const digitRuns: string[] = row.match(/\d+/g) ?? [];
    const namesLeaf = digitRuns.includes(String(leaf));
    return namesLeaf && buyerTokens.some((t) => t.length > 0 && row.includes(t));
  });
}

/** What ISSUE-1's `after()` sweep deletes once the code has been redeemed. */
function redeemAndSweep(claimCode: string) {
  values.delete(`p01:note:claim-minted:${claimCode}`);
  values.delete(`p01:note:paid:${PAYSIG}:code`);
  values.delete(`p01:relay:payment:${PAYSIG}:contribution`);
}

describe('🚨 KV-1 · a confirm leaves no row naming the leaf beside the buyer', () => {
  let restoreUuid: (() => void) | null = null;

  beforeEach(async () => {
    const spy = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(FIXED_UUID);
    restoreUuid = () => spy.mockRestore();
    relayBound(LEAF_AT_REST);
    await leafAtRestLanded();
  });

  afterEach(() => {
    restoreUuid?.();
    restoreUuid = null;
  });

  it('the scan flags a planted join and not a lone leaf (positive control)', () => {
    // Without this, a scan that reads nothing at all would pass every case
    // below by finding nothing — the only kind of green worth fearing.
    expect(
      POOL_KEY.match(/\d+/g) ?? [],
      'the pool key itself holds the leaf, so the scan cannot attribute one',
    ).not.toContain(String(LEAF_AT_REST));
    expect(PAYSIG.match(/\d+/g) ?? []).not.toContain(String(LEAF_AT_REST));
    expect(FIXED_CODE, 'the claim code holds digits, so a leaf could be read out of it').not.toMatch(
      /\d/,
    );

    values.set(
      `probe:minted:${FIXED_CODE}`,
      `contrib:${POOL_KEY}:${LEAF_AT_REST}:payment:${PAYSIG}`,
    );
    values.set(`probe:contrib-claim:${POOL_KEY}:${LEAF_AT_REST}`, FIXED_CODE);
    values.set('probe:a-lone-leaf', `${POOL_KEY}:${LEAF_AT_REST}`);
    values.set(`probe:a-lone-payment:${PAYSIG}`, '1');

    const found = leafJoinsBuyer(LEAF_AT_REST, [PAYSIG, FIXED_CODE]);
    expect(found.join(' | ')).toContain('probe:minted');
    expect(found.join(' | ')).toContain('probe:contrib-claim');
    expect(found, 'a row naming only a leaf, or only a payment, is not a join').toHaveLength(2);
  });

  it('⛔ writes no leaf-to-code row and no leaf-to-payment row', async () => {
    const res = await POST(req(confirmBody(LEAF_AT_REST)));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.claimCode).toBe(FIXED_CODE);

    // `contrib-claim` was never read by anything — the fallback route replays
    // off the PAYMENT, not the leaf — and `claim-minted` only has to prove the
    // code was minted, which the payment alone says.
    expect(
      [...values.keys()].filter((k) => k.startsWith('p01:note:contrib-claim:')),
      'the funded leaf still names its claim code',
    ).toEqual([]);
    expect(values.get(`p01:note:claim-minted:${body.claimCode}`)).toBe(`payment:${PAYSIG}`);

    const joins = leafJoinsBuyer(LEAF_AT_REST, [PAYSIG, String(body.claimCode)]);
    expect(joins, `rows joining the funded leaf to this buyer:\n  ${joins.join('\n  ')}`).toEqual([]);
  });

  it('🚨 replays the code when the binding is gone, instead of refusing the payer', async () => {
    // ISSUE-1 deletes the relay binding at redemption, and a lost response can
    // arrive after that. The payer proved who they are; the code they already
    // bought is theirs.
    const first = await (await POST(req(confirmBody(LEAF_AT_REST)))).json();
    expect(first.claimCode).toBeTruthy();
    values.delete(`p01:relay:payment:${PAYSIG}:contribution`);

    const res = await POST(req(confirmBody(LEAF_AT_REST)));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.claimCode, 'the payer was refused the code they had already bought').toBe(
      first.claimCode,
    );
    expect(body.replayed).toBe(true);
    expect(mintedCodes(), 'a second code was minted for one payment').toHaveLength(1);
  });

  it('🚨 refuses a payment whose code has been redeemed, and mints nothing', async () => {
    const first = await (await POST(req(confirmBody(LEAF_AT_REST)))).json();
    redeemAndSweep(String(first.claimCode));

    const res = await POST(req(confirmBody(LEAF_AT_REST)));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.error).toMatch(/already been redeemed/i);
    expect(mintedCodes(), 'a redeemed payment minted a second code').toHaveLength(0);
    expect(counters.get(`p01:note:paid:${PAYSIG}`), 'a refusal consumed the mint gate again').toBe(
      1,
    );
  });

  it('a first confirm reads the payment counter, never the code row, before it mints', async () => {
    // LATENCY, KV-1 fix round 1. A code is written only after `incr(paid)`, so
    // a counter reading 0 already says "no code": reading the code row too
    // would be a second round trip to Upstash on every purchase for an answer
    // the counter gave. Replays and refusals pay that read; a sale does not.
    const kv = fakeKv();
    mockGetStore.mockReturnValue(kv);
    const res = await POST(req(confirmBody(LEAF_AT_REST)));
    expect(res.status).toBe(200);
    const readKeys = kv.get.mock.calls.map((c) => String(c[0]));
    expect(readKeys, 'the counter was never read before minting').toContain(
      `p01:note:paid:${PAYSIG}`,
    );
    expect(
      readKeys.filter((k) => k === `p01:note:paid:${PAYSIG}:code`),
      'a first purchase paid a GET for a code row that cannot exist yet',
    ).toEqual([]);
  });

  it('⛔ still refuses a STRANGER replaying a public signature, with a code on file', async () => {
    // KV-1 fix round 2. The early replay answers from the PAYMENT alone, and a
    // payment signature is public, so the replay must sit BEHIND the payer
    // proof: above it, whoever reads the till's history collects the code
    // somebody else bought. The stranger case above never planted a code, so
    // it could not see that. Mirrors claim-for-payment's case of the same
    // name; mutants V1 and V1c are killed by it (wp-logs/KV-1-fix2/mutants.log).
    const paidKey = `p01:note:paid:${PAYSIG}`;
    counters.set(paidKey, 1);
    values.set(`${paidKey}:code`, 'CONFIRMED-CODE');

    const res = await POST(
      req(confirmBody(LEAF_AT_REST, { proof: proofFor(PAYSIG, Keypair.generate()) })),
    );
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(401);
    expect(JSON.stringify(body), 'a stranger collected the code somebody else bought').not.toContain(
      'CONFIRMED-CODE',
    );
    expect(mintedCodes()).toHaveLength(0);
    expect(counters.get(paidKey)).toBe(1);

    // Positive control: the same store answers the PAYER with that code, so
    // the 401 above is the proof check and not a fixture that answers nobody.
    const own = await POST(req(confirmBody(LEAF_AT_REST)));
    expect(own.status).toBe(200);
    expect((await own.json()).claimCode).toBe('CONFIRMED-CODE');
  });

  it('⛔ a replay naming a leaf that is not the treasury\'s on the tree adds nothing to inventory', async () => {
    // KV-1 fix round 2. The early replay runs before the binding check, so the
    // payer names any leaf index they like; `recordInventoryLeaf` there is
    // guarded by the treasury's own commitment sitting at that index. Without
    // the guard a payer holding a code could put somebody else's leaf into
    // stock, and `issue-note` would then fail a paying buyer on a note it
    // cannot open. Mutant V5 is killed by it (wp-logs/KV-1-fix2/mutants.log).
    const inventory = () => [...(sets.get(`p01:note:inventory:${POOL_KEY}`) ?? [])];
    const first = await (await POST(req(confirmBody(LEAF_AT_REST)))).json();
    expect(inventory(), 'the confirm that minted did not record its own leaf').toEqual([
      String(LEAF_AT_REST),
    ]);

    // LEAF_AT_REST - 1 is on the tree but holds somebody else's commitment;
    // LEAF_AT_REST + 50 is past the tree's height.
    for (const other of [LEAF_AT_REST - 1, LEAF_AT_REST + 50]) {
      const res = await POST(req(confirmBody(other)));
      const body = await res.json();
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(body.claimCode, 'the replay did not return the code this payment bought').toBe(
        first.claimCode,
      );
      expect(inventory(), `leaf ${other} entered inventory on a replay`).toEqual([
        String(LEAF_AT_REST),
      ]);
    }
    expect(mintedCodes()).toHaveLength(1);
  });

  it('🚨 a confirm that loses the gate to a concurrent one before its code is written gets 409, and mints nothing', async () => {
    // KV-1 deviation 3: the branch below `incr` said 503 "could not be read"
    // and now says 409, the same refusal the early read gives for the same
    // state. Reached only by a race: the counter read 0, then a concurrent
    // confirm took the gate before this one's `incr`, and has not written its
    // code yet. Mutant V9 (the old 503 put back) is killed by it
    // (wp-logs/KV-1-fix2/mutants.log).
    const paidKey = `p01:note:paid:${PAYSIG}`;
    const base = fakeKv();
    const kv = {
      ...base,
      // The read happened before the concurrent request's `incr` landed.
      get: vi.fn(async (key: string) => (key === paidKey ? null : base.get(key))),
    };
    mockGetStore.mockReturnValue(kv);
    counters.set(paidKey, 1); // the concurrent request's `incr`

    const res = await POST(req(confirmBody(LEAF_AT_REST)));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.error).toMatch(/already been redeemed/i);
    expect(kv.get.mock.calls.map((c) => String(c[0])), 'the race branch never looked for the code').toContain(
      `${paidKey}:code`,
    );
    expect(mintedCodes(), 'a lost race minted a second code for one payment').toHaveLength(0);
    expect(values.get(`${paidKey}:code`)).toBeUndefined();
  });
});

/**
 * WHAT THE REFUSAL SAYS WHEN THE LIMITER ITSELF FAILS.
 *
 * 🚨 Same class as `/api/fund-ephemeral`'s fixed-words refusal. The store words
 * a failed request as `${error}, command was: ${JSON…}`
 * (@upstash/redis/nodejs.js) and auto-pipelining batches other requests into
 * that command list — another route's claim code, a payment signature, another
 * caller's limiter bucket. Interpolating it into the 503 hands the batch to
 * whoever called, on a route that runs on the buyer's paid path.
 *
 * Two worlds, same failure, different batch: the answer must not move.
 */
describe('a limiter that fails says so without passing on what the store carried', () => {
  const batched =
    'ERR max daily request limit exceeded, command was: ' +
    '[["incr","p01:rate:OTHERBUCKET:2026-09-20T10"],' +
    '["set","p01:note:claim-minted:CODE-SALE-123456","payment:5Qv9SigAAAA"]]';

  it('names no claim code, no payment signature and no other bucket', async () => {
    mockRateLimitExceeded.mockRejectedValue(new Error(batched));
    const res = await POST(req({ action: 'reserve', token: 'SOL' }));
    expect(res.status).toBe(503);
    const text = JSON.stringify(await res.json());
    expect(text, 'the refusal echoed the store command').not.toMatch(/command was/);
    expect(text, "the refusal named another route's claim code").not.toMatch(/CODE-SALE-123456/);
    expect(text, 'the refusal named a payment signature').not.toMatch(/5Qv9SigAAAA/);
    expect(text, 'the refusal named a limiter bucket').not.toMatch(/OTHERBUCKET/);
  });

  it('gives the same answer whatever the store was carrying', async () => {
    mockRateLimitExceeded.mockRejectedValue(new Error(batched));
    const one = JSON.stringify(await (await POST(req({ action: 'reserve', token: 'SOL' }))).json());

    mockRateLimitExceeded.mockRejectedValue(
      new Error('ERR quota, command was: [["incr","p01:rate:MINE:2026-09-20T10"]]'),
    );
    const two = JSON.stringify(await (await POST(req({ action: 'reserve', token: 'SOL' }))).json());
    expect(two, 'the refusal moved with what the store was carrying').toBe(one);
  });
});
