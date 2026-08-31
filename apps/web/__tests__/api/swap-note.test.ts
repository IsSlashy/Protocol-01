/**
 * TAKING A NOTE IN — and, above all, NOT handing one back.
 *
 * Run: cd apps/web && pnpm test
 *
 * 🚨 THE PROPERTY THIS SUITE EXISTS FOR is the first case: the route answers
 * with a TICKET and no note. A note is its opening, and whoever hands one in
 * still knows it — so a swap that verifies note X and returns note Y in the
 * same response lets one caller keep both, spend X, and walk away with two
 * denominations for one. Every other case here is ordinary input validation;
 * that one is the treasury's balance.
 *
 * The second-most important is idempotency: `incr` on a per-leaf key is the
 * only thing standing between one note and two tickets.
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
    // Overridden per case. The default is a tree that holds nothing, which is
    // the "not on the tree" refusal.
    fetchPoolCommitments: vi.fn(async () => new Map()),
    fetchSpentNullifierSet: vi.fn(async () => new Set<string>()),
    isNullifierSpentInSet: vi.fn(() => false),
  };
});

import {
  createCommitmentV3,
  deriveNoteMaterial,
  getPoolsForTokenV3,
  pubkeyToField,
  type ShareableNote,
} from '@/lib/privacy/pool/denominatedPool';
import { deriveNoteBlinding } from '@/lib/privacy/pool/noteBlinding';
import { createNoteEncryptionAddress } from '@/lib/privacy/pool/noteCrypto';
import { POST } from '@/app/api/swap-note/route';

const TICKET = 'test-ticket';
const SEED_HEX = 'ab'.repeat(32);
const SEED_BYTES = Uint8Array.from(
  SEED_HEX.match(/../g)!.map((h) => parseInt(h, 16)),
);
const RECIPIENT = createNoteEncryptionAddress(new Uint8Array(32).fill(77));

/**
 * The pool the route will resolve to. Read from real configuration rather than
 * invented: if the 0.1 SOL pool ever stops being configured, this suite must
 * say so loudly instead of testing a pool nothing uses.
 */
const POOL = getPoolsForTokenV3('SOL').find((p) => p.denomination === 0.1)!;
const POOL_KEY = POOL?.poolPDA.toBase58();

/** An opening that is nobody's derivation — a note handed in by a stranger. */
const THEIRS = { secret: 111n, nullifierPreimage: 222n, blinding: 333n };
const LEAF = 41;

function commitmentOf(o: { secret: bigint; nullifierPreimage: bigint; blinding: bigint }) {
  return createCommitmentV3(
    o.nullifierPreimage,
    o.secret,
    o.blinding,
    pubkeyToField(POOL.tokenMint),
  );
}

function noteFor(
  o: { secret: bigint; nullifierPreimage: bigint; blinding: bigint },
  over: Partial<ShareableNote> = {},
): ShareableNote {
  return {
    version: 1,
    pool: POOL_KEY,
    secret: o.secret.toString(),
    nullifier_preimage: o.nullifierPreimage.toString(),
    deposit_epoch: o.blinding.toString(),
    token_mint: pubkeyToField(POOL.tokenMint).toString(),
    commitment: commitmentOf(o).toString(),
    leafIndex: LEAF,
    token: 'SOL',
    denominationHuman: 0.1,
    ...over,
  };
}

/** A tree that holds exactly this commitment, at this leaf. */
function treeHolding(commitment: bigint, leafIndex = LEAF) {
  return new Map([
    [commitment.toString(), { leafIndex, commitment, depositSlot: 1 }],
  ]);
}

let counters: Map<string, number>;
let sets: Map<string, Set<string>>;
let values: Map<string, string>;

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
  return new NextRequest('http://localhost:3000/api/swap-note', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(ticket ? { 'x-p01-funder-ticket': ticket } : {}),
      'x-real-ip': '198.51.100.9',
    },
    body: JSON.stringify(body),
  } as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

const goodBody = (over: Record<string, unknown> = {}) => ({
  note: noteFor(THEIRS),
  recipientAddress: RECIPIENT,
  ...over,
});

beforeEach(async () => {
  vi.clearAllMocks();
  // `stubEnv` does not auto-restore, so each case states its whole environment.
  vi.unstubAllEnvs();
  counters = new Map();
  sets = new Map();
  values = new Map();
  vi.stubEnv('P01_TREASURY_POOL_SEED', SEED_HEX);
  vi.stubEnv('P01_FUNDER_TICKET', TICKET);
  mockGetStore.mockReturnValue(fakeKv());
  mockRateLimitExceeded.mockResolvedValue(false);
  const { fetchPoolCommitments } = await import('@/lib/privacy/pool/denominatedPool');
  vi.mocked(fetchPoolCommitments).mockResolvedValue(
    treeHolding(commitmentOf(THEIRS)) as never,
  );
});

describe('the 0.1 SOL pool this suite is written against', () => {
  it('is configured, or every case below is testing nothing', () => {
    expect(POOL, 'no 0.1 SOL pool is configured').toBeTruthy();
  });
});

describe('🚨 a swap hands NO note back', () => {
  it('accepts the note, returns a ticket, and seals nothing', async () => {
    const res = await POST(req(goodBody()));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe('queued');
    expect(typeof body.ticket).toBe('string');
    expect(body.ticket).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    // ⛔ THE PROPERTY. A note handed back here would be a note handed to
    // someone who still holds the one they gave us — two denominations for one.
    expect(body.sealedNote, 'the swap handed a note back in the same request').toBeUndefined();
  });

  it('mints a ticket inside issue-note\'s claim alphabet, so the claim can be filled', async () => {
    // The ticket becomes a claim code. A code outside `/^[A-Za-z0-9_-]{8,64}$/`
    // would be refused by the very endpoint meant to honour it — the caller's
    // note taken, the replacement unreachable.
    const res = await POST(req(goodBody()));
    const { ticket } = await res.json();
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('records the opening BEFORE putting the leaf in the queue', async () => {
    // A worker that enumerates a leaf whose opening is not stored yet reads a
    // corrupt queue. Ordering is the whole guarantee, so it is pinned.
    const kv = fakeKv();
    mockGetStore.mockReturnValue(kv);
    await POST(req(goodBody()));
    const openingCall = kv.set.mock.invocationCallOrder[0];
    const saddCall = kv.sadd.mock.invocationCallOrder[0];
    expect(kv.set).toHaveBeenCalled();
    expect(kv.sadd).toHaveBeenCalled();
    expect(openingCall, 'the leaf was queued before its opening was stored').toBeLessThan(
      saddCall,
    );
    expect(kv.sadd).toHaveBeenCalledWith(`p01:note:pending:${POOL_KEY}`, String(LEAF));
  });
});

describe('the same note cannot be queued twice', () => {
  it('refuses the second submission instead of minting a second ticket', async () => {
    const first = await POST(req(goodBody()));
    expect(first.status).toBe(200);
    const second = await POST(req(goodBody()));
    const body = await second.json();
    expect(second.status, JSON.stringify(body)).toBe(409);
    expect(body.error).toMatch(/already queued/);
  });
});

describe('the opening is verified, not trusted', () => {
  it('refuses a note that does not open to the commitment it declares', async () => {
    const note = noteFor(THEIRS, { commitment: '999' });
    const res = await POST(req(goodBody({ note })));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.error).toMatch(/does not open to the commitment/);
  });

  it('refuses a commitment that is on no tree, and queues nothing', async () => {
    const { fetchPoolCommitments } = await import('@/lib/privacy/pool/denominatedPool');
    vi.mocked(fetchPoolCommitments).mockResolvedValueOnce(new Map() as never);
    const res = await POST(req(goodBody()));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.error).toMatch(/not on the pool tree/);
    expect([...counters.keys()].filter((k) => k.startsWith('p01:note:pending-leaf:'))).toHaveLength(
      0,
    );
  });

  it('refuses an already-spent note', async () => {
    const { isNullifierSpentInSet } = await import('@/lib/privacy/pool/denominatedPool');
    vi.mocked(isNullifierSpentInSet).mockReturnValueOnce(true);
    const res = await POST(req(goodBody()));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.error).toMatch(/already been spent/);
  });

  it('⛔ refuses a note the treasury itself derives, so it cannot buy back its own stock', async () => {
    const mine = deriveNoteMaterial(SEED_BYTES, POOL.poolPDA, LEAF);
    const opening = {
      secret: mine.secret,
      nullifierPreimage: mine.nullifierPreimage,
      blinding: deriveNoteBlinding(SEED_BYTES, POOL.poolPDA, LEAF),
    };
    const { fetchPoolCommitments } = await import('@/lib/privacy/pool/denominatedPool');
    vi.mocked(fetchPoolCommitments).mockResolvedValueOnce(
      treeHolding(commitmentOf(opening)) as never,
    );
    const res = await POST(req(goodBody({ note: noteFor(opening) })));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.error).toMatch(/issued by this deployment/);
  });

  it('\u26d4 refuses one of our own notes submitted under a FALSE leafIndex', async () => {
    // \U0001f6a8 THE ATTACK THE FIRST VERSION LET THROUGH. The ownership guard
    // derived the treasury's note at `note.leafIndex` -- a caller-controlled
    // field validated only as a non-negative integer -- so a note this
    // deployment had just sold, resubmitted with leafIndex 999999, was compared
    // against the treasury note at leaf 999999, found different, and queued.
    // The chain lookup then resolved the real leaf anyway. The treasury would
    // have bought back its own stock and paid both pool fees to do it.
    const mine = deriveNoteMaterial(SEED_BYTES, POOL.poolPDA, LEAF);
    const opening = {
      secret: mine.secret,
      nullifierPreimage: mine.nullifierPreimage,
      blinding: deriveNoteBlinding(SEED_BYTES, POOL.poolPDA, LEAF),
    };
    const { fetchPoolCommitments } = await import('@/lib/privacy/pool/denominatedPool');
    // The chain says LEAF. The submission says 999999.
    vi.mocked(fetchPoolCommitments).mockResolvedValueOnce(
      treeHolding(commitmentOf(opening)) as never,
    );
    const note = noteFor(opening, { leafIndex: 999_999 });
    const res = await POST(req(goodBody({ note })));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.error).toMatch(/issued by this deployment/);
    expect(body.leafIndex, 'the guard answered on the caller\'s index').toBe(LEAF);
  });

  it('refuses a note that declares no commitment at all', async () => {
    // Omission used to skip the comparison entirely (`if (note.commitment &&
    // ...)`), which left the caller's index as the only claim to check -- and
    // the guard that checked it was keyed on that same index.
    const note = noteFor(THEIRS);
    delete (note as { commitment?: string }).commitment;
    const res = await POST(req(goodBody({ note })));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.error).toMatch(/must declare its commitment/);
  });
});

describe('the gates in front of it', () => {
  it('refuses without the ticket header', async () => {
    const res = await POST(req(goodBody(), null));
    expect(res.status).toBe(401);
  });

  it('refuses a recipient address that is not a note address', async () => {
    const res = await POST(req(goodBody({ recipientAddress: 'not-an-address' })));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/p01pq:/);
  });

  it('refuses a denomination this deployment cannot serve back', async () => {
    // The ticket would be unfillable: the note taken, and nothing in stock that
    // can pay it. Better to refuse before anything is queued.
    vi.stubEnv('P01_TREASURY_NOTE_DENOMINATION', '1');
    const res = await POST(req(goodBody()));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.error).toMatch(/deals in 1 SOL notes/);
  });

  it('refuses when no durable store is configured', async () => {
    mockGetStore.mockReturnValue(null);
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(503);
  });
});
