/**
 * CONTRIBUTING A LEAF YOU DO NOT OWN — the mixer, tested.
 *
 * 🚨 THE PROPERTY THIS SUITE EXISTS FOR: `reserve` hands back a COMMITMENT and
 * never an opening. The whole reason this flow has no drain is that the
 * depositor cannot spend what they deposit, and the only way to break that is
 * for a secret to escape the server. Two cases below recompute the treasury's
 * derivation independently and assert the response carries the commitment and
 * nothing else.
 *
 * The second property is arithmetic: one deposit earns exactly one claim. A
 * second confirmation must return the SAME code, never mint another — one
 * contribution paying for two notes is the treasury going backwards.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetStore = vi.fn();
const mockRateLimitExceeded = vi.fn();

vi.mock('@/lib/waitlist/store', () => ({
  getStore: () => mockGetStore(),
  rateLimitExceeded: (...args: unknown[]) => mockRateLimitExceeded(...args),
}));

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    Connection: class {
      async getGenesisHash() {
        return 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
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

/** The treasury's own commitment at a leaf — recomputed here, independently. */
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
    del: vi.fn(),
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

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  counters = new Map();
  values = new Map();
  sets = new Map();
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
});

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
    // collect — the exact double-spend this design exists to make impossible.
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

  it('never hands the same leaf to two contributors', async () => {
    const a = await (await POST(req({ action: 'reserve' }))).json();
    const b = await (await POST(req({ action: 'reserve' }))).json();
    expect(a.leafIndex).toBe(6);
    expect(b.leafIndex, 'two contributors were given the same leaf').toBe(7);
    expect(b.commitment).toBe(treasuryCommitmentAt(7).toString());
  });
});

describe('confirm pays only for a contribution that actually landed', () => {
  it('refuses a leaf whose treasury commitment is not on the tree', async () => {
    const res = await POST(req({ action: 'confirm', leafIndex: 6 }));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.error).toMatch(/not on the tree/);
    expect(values.size, 'a claim was minted for a deposit that never landed').toBe(0);
  });

  it('🚨 ignores the commitment the caller names, and recomputes ours', async () => {
    // Trusting `body.commitment` would let anyone point at somebody else's
    // existing leaf — leaf 4 below — and be paid a claim for a deposit they
    // never made.
    const res = await POST(req({ action: 'confirm', leafIndex: 4, commitment: '777' }));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.error).toMatch(/not on the tree/);
  });

  it('mints a claim, records the leaf as inventory, and marks the code minted', async () => {
    const { fetchPoolCommitments } = await import('@/lib/privacy/pool/denominatedPool');
    vi.mocked(fetchPoolCommitments).mockResolvedValue(
      tree([
        { leafIndex: 5, commitment: 888n },
        { leafIndex: 6, commitment: treasuryCommitmentAt(6) },
      ]) as never,
    );
    const res = await POST(req({ action: 'confirm', leafIndex: 6 }));
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

    // The contributed leaf is now issuable stock — legitimate here precisely
    // because its opening derives from the treasury seed.
    expect([...(sets.get(`p01:note:inventory:${POOL_KEY}`) ?? [])]).toContain('6');
  });

  it('a second confirmation returns the SAME code rather than minting another', async () => {
    const { fetchPoolCommitments } = await import('@/lib/privacy/pool/denominatedPool');
    vi.mocked(fetchPoolCommitments).mockResolvedValue(
      tree([{ leafIndex: 6, commitment: treasuryCommitmentAt(6) }]) as never,
    );
    const first = await (await POST(req({ action: 'confirm', leafIndex: 6 }))).json();
    const second = await (await POST(req({ action: 'confirm', leafIndex: 6 }))).json();
    expect(second.ok).toBe(true);
    expect(second.replayed).toBe(true);
    expect(second.claimCode, 'one deposit minted two claims').toBe(first.claimCode);
    const mintedCodes = [...values.keys()].filter((k) => k.startsWith('p01:note:claim-minted:'));
    expect(mintedCodes, 'one deposit paid for two notes').toHaveLength(1);
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
