/**
 * The gate in front of the notes.
 *
 * Run: cd apps/web && pnpm test
 *
 * WHY THIS IS STRICTER THAN THE FUNDER'S SUITE
 * ────────────────────────────────────────────
 * A funder grant is rent that comes back. A note IS the denomination and does
 * not. So the failure modes worth pinning are the ones that hand over value:
 * an unminted claim, a reused claim, two callers racing for one note, and the
 * ticket — which ships in the browser bundle — being enough on its own.
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
      /**
       * 🚨 THE METHOD WHOSE ABSENCE READ AS A DIFFERENT BUG.
       *
       * The maturity gate added on 2026-08-18 reads the chain's slot. This stub
       * did not have the method, so the call threw, the route caught it as "the
       * chain's slot could not be read" and answered 502 — and the two cases
       * below, which assert a 503 about WHO HOLDS the inventory, failed with
       * "expected 502 to be 503". The route was right and the stub was a version
       * behind; a reader chasing that pair would have gone looking in the
       * inventory logic, which is fine.
       *
       * Large enough that the configured minimum age is satisfied, so these
       * cases keep exercising the inventory loop rather than the maturity
       * refusal — which has its own case.
       */
      async getSlot() {
        return 500_000_000;
      }
    },
  };
});

/**
 * A pool history that answers but matches nothing.
 *
 * Enough to reach the inventory loop, which is what the claim and idempotency
 * cases are about, and NOT enough to reach the sealing step — which would drag
 * tweetnacl into jsdom, where `instanceof Uint8Array` fails across realms on
 * bytes that are perfectly good. The sealing assertions live in the pool suite,
 * which runs in node.
 *
 * The route then answers 500 "does not match the chain", after claiming the
 * leaf. That is the state these cases inspect.
 */
vi.mock('@/lib/privacy/pool/denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/privacy/pool/denominatedPool')>();
  return {
    ...actual,
    fetchPoolCommitments: vi.fn(async () => ({
      get: () => undefined,
      values: () => [] as unknown[],
    })),
    // Nothing spent, so these cases exercise the inventory logic rather than
    // the spent-note refusal. The refusal has its own case below.
    fetchSpentNullifierSet: vi.fn(async () => new Set<string>()),
    isNullifierSpentInSet: vi.fn(() => false),
  };
});

import { createNoteEncryptionAddress } from '@/lib/privacy/pool/noteCrypto';
import { POST } from '@/app/api/issue-note/route';

const TICKET = 'test-ticket';
const SEED = 'ab'.repeat(32);
/**
 * A REAL receive address, derived like any recipient's.
 *
 * A hand-built buffer of the right LENGTH is not enough once a case reaches the
 * sealing step: the bytes are an X25519 key and an ML-KEM public key, and nacl
 * rejects nonsense with "unexpected type, use Uint8Array". Deriving it means
 * every case exercises the same address shape a buyer actually presents.
 */
const BUYER_SEED = new Uint8Array(32).fill(77);
const RECIPIENT = createNoteEncryptionAddress(BUYER_SEED);

/** Claim keys the fake KV considers minted. */
let mintedClaims: Set<string>;
/** Counter per key, so `incr` behaves like Redis. */
let counters: Map<string, number>;

function fakeKv() {
  return {
    incr: vi.fn(async (key: string) => {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    }),
    get: vi.fn(async (key: string) =>
      mintedClaims.has(key.replace('p01:note:claim-minted:', '')) ? 'paid-ref' : null,
    ),
    expire: vi.fn(),
    set: vi.fn(),
  };
}

function req(body: unknown, ticket: string | null = TICKET) {
  return new NextRequest('http://localhost:3000/api/issue-note', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(ticket ? { 'x-p01-funder-ticket': ticket } : {}),
      'x-real-ip': '198.51.100.9',
    },
    body: JSON.stringify(body),
  } as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

const CLAIM = 'AAAAAAAAAAAAAAAAAAAAAAAA';
const goodBody = (over: Record<string, unknown> = {}) => ({
  recipientAddress: RECIPIENT,
  token: 'SOL',
  denomination: 0.1,
  claimCode: CLAIM,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // `stubEnv` does NOT auto-restore, so a case that stubs an extra variable
  // leaves it set for every case after it — which is how a test asserting a 429
  // started reading a denomination another test had pinned and failed on a 400.
  // Restoring first makes each case state its whole environment.
  vi.unstubAllEnvs();
  mintedClaims = new Set([CLAIM]);
  counters = new Map();
  vi.stubEnv('P01_TREASURY_POOL_SEED', SEED);
  vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '23,24');
  vi.stubEnv('P01_FUNDER_TICKET', TICKET);
  mockGetStore.mockReturnValue(fakeKv());
  mockRateLimitExceeded.mockResolvedValue(false);
});

describe('a leaf the treasury has not deposited into yet', () => {
  it('is skipped WITHOUT consuming its claim slot, so it works once deposited', async () => {
    // The point of a range: `83-200` authorises future stock. A leaf past the
    // end of the tree must not answer 500 'does not match the chain' and mark
    // itself issued — that burns a slot which would have been good.
    const { fetchPoolCommitments } = await import('@/lib/privacy/pool/denominatedPool');
    // A tree that holds leaf 5 and nothing above it.
    vi.mocked(fetchPoolCommitments).mockResolvedValueOnce({
      get: () => undefined,
      values: () => [{ leafIndex: 5, commitment: 1n }],
    } as never);
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '90-92');
    const res = await POST(req(goodBody()));
    // Empty stock, NOT a configuration error — and no leaf was claimed.
    expect(res.status).toBe(503);
    const claimed = [...counters.keys()].filter((k) => k.startsWith('p01:note:issued:'));
    expect(claimed, 'a future leaf must not consume its slot').toHaveLength(0);
  });

  it('⛔ an EMPTY commitment map still fails LOUD, because that is an RPC, not a tree', async () => {
    // Treating an unreadable pool as 'all future stock' would answer a calm
    // 'inventory is empty' for a broken read — a loud failure turned quiet.
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '23');
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/does not match the chain/);
  });
});

describe('how the inventory is authorised', () => {
  // A range is AUTHORISATION, not discovery: it removes the config change after
  // every restock — the step that would otherwise be forgotten and leave a
  // stocked pool reporting empty — without turning the route into a scan.
  it('accepts a range, and it means every leaf inside it', async () => {
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '83-92');
    const { GET } = await import('@/app/api/issue-note/route');
    const body = await (await GET()).json();
    expect(body.inventorySize).toBe(10);
  });

  it('mixes ranges and single leaves, and never counts one twice', async () => {
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '83-85,84,90');
    const { GET } = await import('@/app/api/issue-note/route');
    expect((await (await GET()).json()).inventorySize).toBe(4); // 83,84,85,90
  });

  it('⛔ a typo cannot build an inventory big enough to take the route down', async () => {
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '0-99999999');
    const { GET } = await import('@/app/api/issue-note/route');
    expect((await (await GET()).json()).inventorySize).toBe(512);
  });

  it('an unset variable is still EMPTY, not leaf zero', async () => {
    // `''.split(',')` is `['']` and `Number('')` is 0, which is an integer and
    // >= 0 — so this once reported one leaf of stock and called itself
    // configured.
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '');
    const { GET } = await import('@/app/api/issue-note/route');
    const body = await (await GET()).json();
    expect(body.inventorySize).toBe(0);
    expect(body.configured).toBe(false);
  });

  it('a backwards or malformed range is ignored, not guessed at', async () => {
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '92-83,abc,,7');
    const { GET } = await import('@/app/api/issue-note/route');
    expect((await (await GET()).json()).inventorySize).toBe(1); // just 7
  });
});

describe('which note comes out of stock', () => {
  it('🚨 is not the configured order, so purchase order cannot be mapped to a leaf', async () => {
    // MEASURED shape of the bug: the loop walked `P01_TREASURY_NOTE_LEAVES` as
    // written, so the first buyer always got the first leaf. An analyst
    // watching the inventory be spent sees them go in order, infers the rule,
    // and maps the Nth payment at the till to the Nth leaf — handing back the
    // buyer-to-note link this route exists to break.
    //
    // The signal used here is the KV claim key, which carries the leaf index:
    // whichever leaf the route TRIED first is the one it incremented first,
    // whether or not the request went on to succeed.
    const firstTried: string[] = [];
    for (let run = 0; run < 25; run += 1) {
      vi.unstubAllEnvs();
      vi.stubEnv('P01_TREASURY_POOL_SEED', SEED);
      vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '83,84,85,86,87,88,89,90,91,92');
      vi.stubEnv('P01_FUNDER_TICKET', TICKET);
      counters = new Map();
      mintedClaims = new Set([CLAIM]);
      mockGetStore.mockReturnValue(fakeKv());
      await POST(req(goodBody()));
      const claimed = [...counters.keys()].filter((k) => k.startsWith('p01:note:issued:'));
      if (claimed.length > 0) firstTried.push(claimed[0]);
    }
    expect(firstTried.length, 'no leaf was ever claimed; the harness is wrong').toBeGreaterThan(0);
    // 25 runs over 10 leaves: seeing one value throughout would be a 1-in-10^24
    // coincidence, so this is a real signal rather than a flaky one.
    expect(new Set(firstTried).size).toBeGreaterThan(1);
  });
});

describe('the payment gate', () => {
  it('refuses with 402 when no claim code is supplied', async () => {
    // The ticket alone must never be enough: it ships in the browser bundle by
    // design, so anyone who reads the bundle would otherwise mint themselves
    // unlimited notes.
    const res = await POST(req(goodBody({ claimCode: undefined })));
    expect(res.status).toBe(402);
    expect((await res.json()).error).toMatch(/claim code is required/);
  });

  it('refuses a claim that was never minted', async () => {
    // A guessed or invented code. It is still CONSUMED — see the next case —
    // so guessing cannot be retried until it works.
    mintedClaims = new Set();
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(402);
    expect((await res.json()).error).toMatch(/never issued against a payment/);
  });

  it('refuses the SECOND redemption of a claim', async () => {
    // One payment, one note. `incr` is what makes this hold under concurrency:
    // read-then-write would let two simultaneous callers both pass.
    const first = await POST(req(goodBody()));
    // The first attempt gets past the gate and fails later (no chain here) —
    // what matters is that the claim is now spent.
    expect(first.status).not.toBe(409);
    const second = await POST(req(goodBody()));
    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatch(/already been used/);
  });

  it('consumes a bad claim too, so guessing cannot be retried', async () => {
    mintedClaims = new Set();
    await POST(req(goodBody()));
    const again = await POST(req(goodBody()));
    expect(again.status).toBe(409);
  });
});

describe('an inventory leaf that was already handed out', () => {
  /** A KV that remembers, so the idempotency branch can be reached. */
  function rememberingKv() {
    const scalars = new Map<string, unknown>();
    return {
      incr: vi.fn(async (key: string) => {
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        return next;
      }),
      get: vi.fn(async (key: string) => {
        if (key.startsWith('p01:note:claim-minted:')) {
          return mintedClaims.has(key.replace('p01:note:claim-minted:', '')) ? 'paid-ref' : null;
        }
        return scalars.get(key) ?? null;
      }),
      set: vi.fn(async (key: string, value: unknown) => {
        scalars.set(key, value);
      }),
      expire: vi.fn(),
    };
  }

  it('is re-issued to the SAME recipient rather than reported as empty', async () => {
    // The leaf used to be consumed outright before the client could confirm it
    // had opened the note, so any failure after that point destroyed the
    // inventory as well as the claim and the retry got "the note inventory is
    // empty". MEASURED on two consecutive live runs. In production that is a
    // paying customer's note burned by a transient error.
    //
    // Re-sealing the same note to the same address gives them what they paid
    // for, because it IS the same note: one commitment, one nullifier,
    // spendable exactly once by whoever holds the secrets.
    // ONE leaf in stock, so "was it re-issued" and "was the next one handed out
    // instead" cannot be confused with each other.
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '23');
    mockGetStore.mockReturnValue(rememberingKv());
    const first = await POST(req(goodBody()));
    // The chain is not reachable here, so it stops at the history read — after
    // the leaf has been claimed, which is the state this case is about.
    expect(first.status).not.toBe(503);

    mintedClaims.add('SECOND-CLAIM-CODE-AAAA');
    const again = await POST(req(goodBody({ claimCode: 'SECOND-CLAIM-CODE-AAAA' })));
    expect(again.status).not.toBe(503);
    expect(await again.json()).not.toMatchObject({ error: expect.stringMatching(/inventory is empty/) });
  });

  it('is NOT re-issued to a different recipient', async () => {
    // ⛔ Two people holding one note is a race where the loser paid for
    // nothing. No amount of retry convenience is worth manufacturing that.
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '23');
    mockGetStore.mockReturnValue(rememberingKv());
    await POST(req(goodBody()));

    mintedClaims.add('OTHER-CLAIM-CODE-AAAAA');
    const other = await POST(
      req(
        goodBody({
          claimCode: 'OTHER-CLAIM-CODE-AAAAA',
          recipientAddress: createNoteEncryptionAddress(new Uint8Array(32).fill(9)),
        }),
      ),
    );
    expect(other.status).toBe(503);
    const body = await other.json();
    // ⚠️ NOT "the inventory is empty". A stocked pool that refuses YOU and an
    // unstocked deployment need opposite reactions — "derive from the same
    // wallet" versus "deposit more notes" — and the flat message sent us
    // reading stock levels while a reloaded page was quietly presenting a new
    // note address. It cost a single-use claim code to work that out.
    expect(body.error).toMatch(/already issued to a different address/);
    expect(body.heldByOthers).toBe(1);
  });
});

describe('inventory whose notes have already been spent', () => {
  it('refuses, and says spent rather than empty', async () => {
    // 🚨 A COMMITMENT STAYS ON THE TREE AFTER ITS NOTE IS SPENT. So "it is on
    // the tree at the index we expect" — the only on-chain check this route
    // used to make — is true of a note that no longer exists. Without this,
    // a paying customer is sealed a spent note and finds out when their
    // subscription dies on a nullifier collision, after ~150 uploads and about
    // 1 SOL of buffer rent.
    //
    // MEASURED 2026-08-18: leaf 26 was the entire inventory and a subscription
    // spent it. Nothing in this route noticed. The only thing that stopped the
    // next buyer from being handed it was the `:to` marker refusing a different
    // recipient — protection by accident, from a mechanism written for
    // something else entirely.
    const pool = await import('@/lib/privacy/pool/denominatedPool');
    vi.mocked(pool.isNullifierSpentInSet).mockReturnValue(true);

    const res = await POST(req(goodBody()));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/already been spent/);
    expect(body.spentLeaves).toBe(2);
    // ⛔ Never "empty": empty means deposit more, spent means the notes are
    // there and gone. An operator reading the wrong one looks in the wrong place.
    expect(body.error).not.toMatch(/inventory is empty/);

    vi.mocked(pool.isNullifierSpentInSet).mockReturnValue(false);
  });

  it('skips a spent leaf and serves the next one', async () => {
    // An exhausted leaf beside a good one is still a stocked deployment. A
    // caller must not be turned away because the FIRST configured index
    // happens to be used up.
    const pool = await import('@/lib/privacy/pool/denominatedPool');
    vi.mocked(pool.isNullifierSpentInSet).mockImplementation(
      (_set, _pda, _np, _secret) => vi.mocked(pool.isNullifierSpentInSet).mock.calls.length === 1,
    );

    const res = await POST(req(goodBody()));
    // Reaches the chain check on the SECOND leaf rather than refusing outright.
    expect(res.status).not.toBe(503);

    vi.mocked(pool.isNullifierSpentInSet).mockReturnValue(false);
  });
});

describe('the refusals that come before the gate', () => {
  it('401s a bad ticket without touching the claim', async () => {
    const res = await POST(req(goodBody(), 'wrong'));
    expect(res.status).toBe(401);
    expect(counters.size).toBe(0);
  });

  it('503s when the deployment issues no notes', async () => {
    vi.stubEnv('P01_TREASURY_POOL_SEED', '');
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(503);
  });

  it('has an EMPTY inventory when the variable is unset, not a leaf-0 inventory', async () => {
    // `''.split(',')` is `['']` and `Number('')` is 0, which is an integer and
    // is >= 0 — so an unset variable used to produce an inventory of exactly one
    // leaf, index 0, and readiness reported the deployment as configured. Found
    // by curling the built route, not by a test, which is why this one exists.
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '');
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/no note inventory configured/);
  });

  it('400s a recipient that is not a note address', async () => {
    const res = await POST(req(goodBody({ recipientAddress: 'not-an-address' })));
    expect(res.status).toBe(400);
  });

  it('503s without a durable store, rather than issuing untracked', async () => {
    // No store means no claim ledger and no inventory ledger, so a note could
    // be issued twice with nothing recording it.
    mockGetStore.mockReturnValue(null);
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(503);
  });

  it('refuses a pool this treasury did not deposit into, BEFORE spending the claim', async () => {
    // Leaf indices only mean something inside one pool: leaf 34 of the 1 SOL
    // pool and leaf 34 of the 0.1 SOL pool are different notes. Asking for the
    // wrong one used to look the indices up in the wrong tree and fail on the
    // on-chain check — after the claim had been consumed, for a reason that
    // reads like a derivation bug.
    vi.stubEnv('P01_TREASURY_NOTE_DENOMINATION', '1');
    const res = await POST(req(goodBody({ denomination: 0.1 })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/issues 1 SOL notes/);
    // The claim survives, which is the point of checking here.
    expect(counters.size).toBe(0);
  });

  it('429s an IP over its hourly allowance', async () => {
    mockRateLimitExceeded.mockResolvedValue(true);
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(429);
    expect((await res.json()).limit).toBe(3);
  });
});
