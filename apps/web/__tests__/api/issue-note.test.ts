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

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetStore = vi.fn();
const mockRateLimitExceeded = vi.fn();

/**
 * READY-1's switches (the "READY-1" describe at the end of this file). Off,
 * every case above runs exactly as before: `after()` is the real one, which
 * throws outside a request scope, and the note is sealed for real.
 *   - `captureAfter`: tasks handed to next/server `after()` are kept here and
 *     drained by hand, so a case can tell the reply from what runs after it;
 *   - `rpc`: every call the Connection stub below answers;
 *   - `stubSeal`: `encryptNote` returns a fixed blob, because jsdom's typed
 *     arrays fail tweetnacl's realm check (see the history stub below) and one
 *     READY-1 case needs a sale that completes.
 */
const ready = vi.hoisted(() => ({
  captureAfter: false,
  afterTasks: [] as unknown[],
  rpc: [] as string[],
  stubSeal: false,
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (task: Parameters<typeof actual.after>[0]) => {
      if (!ready.captureAfter) return actual.after(task);
      ready.afterTasks.push(task);
    },
  };
});

vi.mock('@/lib/privacy/pool/noteCrypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/privacy/pool/noteCrypto')>();
  return {
    ...actual,
    encryptNote: (...args: Parameters<typeof actual.encryptNote>) =>
      ready.stubSeal ? 'p01enc1:READY-1-STUB' : actual.encryptNote(...args),
  };
});

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
        ready.rpc.push('getGenesisHash');
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
        ready.rpc.push('getSlot');
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
 *
 * ⚠️ THE TREE HOLDS SOMEBODY ELSE'S DEPOSIT AT EVERY INDEX THESE CASES
 * CONFIGURE. It used to be empty, and an index the history read did not bring
 * back is no longer claimed at all (ISSUE-2: `issue-note.node.test.ts` "a leaf
 * the history read did not bring back"), so an empty tree would stop every case
 * here before the claim they inspect. An index that IS on the tree with a
 * commitment that is not ours still reaches the claim, as it always did.
 */
const FOREIGN_LEAVES = [23, 24, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92].map((leafIndex) => ({
  leafIndex,
  commitment: 700_001n + BigInt(leafIndex),
}));
vi.mock('@/lib/privacy/pool/denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/privacy/pool/denominatedPool')>();
  return {
    ...actual,
    fetchPoolCommitments: vi.fn(async () => ({
      get: () => undefined,
      values: () => FOREIGN_LEAVES,
    })),
    // Nothing spent, so these cases exercise the inventory logic rather than
    // the spent-note refusal. The refusal has its own case below.
    fetchSpentNullifierSet: vi.fn(async () => new Set<string>()),
    isNullifierSpentInSet: vi.fn(() => false),
  };
});

import { createNoteEncryptionAddress } from '@/lib/privacy/pool/noteCrypto';
import { GET, POST } from '@/app/api/issue-note/route';
import {
  createCommitmentV3,
  deriveNoteMaterial,
  fetchPoolCommitments,
  fetchSpentNullifierSet,
  getPoolsForTokenV3,
  pubkeyToField,
  type OnChainCommitment,
} from '@/lib/privacy/pool/denominatedPool';
import { deriveNoteBlinding } from '@/lib/privacy/pool/noteBlinding';
import { treasurySeeds } from '@/lib/privacy/treasurySeeds';

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

/**
 * The operator's password, stubbed as ADMIN_PASSWORD wherever a case stubs its
 * environment.
 *
 * An exhaustion refusal states WHICH exhaustion, with its counts, only to a
 * caller holding it (route.ts, `exhausted`): a claim code comes back on every
 * refusal, so a buyer could otherwise re-poll it into a reading of the
 * inventory. What a BUYER is told is pinned in `issue-note.node.test.ts`,
 * "what a paying caller is told when no note comes out". The cases here read
 * the walk, so they ask as the operator.
 */
const ADMIN_PASSWORD = 'operator-password-fixture';

function req(body: unknown, ticket: string | null = TICKET) {
  return new NextRequest('http://localhost:3000/api/issue-note', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(ticket ? { 'x-p01-funder-ticket': ticket } : {}),
      'x-real-ip': '198.51.100.9',
      'x-admin-password': ADMIN_PASSWORD,
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
  vi.stubEnv('ADMIN_PASSWORD', ADMIN_PASSWORD);
  mockGetStore.mockReturnValue(fakeKv());
  mockRateLimitExceeded.mockResolvedValue(false);
  serverLog.length = 0;
});

/**
 * Nothing the route runs here writes to the server log. This file drives
 * the refusals the node suite never reaches: the ticket, the body, the store,
 * the rate limit, and a configured inventory that is not ours. So the rule of
 * `issue-note.node.test.ts` (`routeLog`, which says why) is read here too.
 * Red: mutants Y7 and Y8, web-run/logs/ISSUE-1-webfix3/sandbox-Y7, -Y8.
 *
 * ⛔ Installed in `vi.hoisted`, ahead of the route's import, and by
 * replacing the functions rather than spying on them. Spies made here at
 * module scope came after the import, so a logger the route bound at load
 * kept the function from before them (verifier web-run r3 mutants W5 and W6;
 * on the paths only this file drives, webfix4's W11,
 * web-run/logs/ISSUE-1-webfix4/mutants-before.log).
 */
const capture = vi.hoisted(() => {
  const lines: string[] = [];
  const undo: Array<() => void> = [];
  const replace = (owner: object, key: string, by: unknown) => {
    const slot = owner as Record<string, unknown>;
    const was = slot[key];
    slot[key] = by;
    undo.push(() => {
      slot[key] = was;
    });
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table']) {
    replace(console, level, (...args: unknown[]) => {
      lines.push(`console.${level}: ${args.map(String).join(' ')}`);
    });
  }
  for (const stream of [process.stdout, process.stderr]) {
    replace(stream, 'write', (chunk: unknown) => {
      lines.push(`stream: ${String(chunk)}`);
      return true;
    });
  }
  replace(process, '_rawDebug', (...args: unknown[]) => {
    lines.push(`rawDebug: ${args.map(String).join(' ')}`);
  });
  return {
    lines,
    /** Bound before the route's module loads, the way a module binds a logger. */
    warnBoundAtLoad: console.warn.bind(console),
    restore: () => {
      for (const put of undo.reverse()) put();
    },
  };
});
const serverLog = capture.lines;

afterEach(() => {
  expect(serverLog, 'the route wrote to the server log').toEqual([]);
});

afterAll(() => {
  capture.restore();
});

describe('the server-log check', () => {
  it('sees a console line and a stream write', () => {
    // Its positive control: a capture that stopped working would otherwise
    // read as a route that logs nothing.
    console.warn('control', 23);
    process.stderr.write('control\n');
    // And a logger bound before the route module loaded (W5, W6, W11).
    capture.warnBoundAtLoad('bound at load', 23);
    expect(serverLog).toEqual([
      'console.warn: control 23',
      'stream: control\n',
      'console.warn: bound at load 23',
    ]);
    serverLog.length = 0;
  });
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
    //
    // ⛔ AND NOT 500 'does not match the chain' EITHER, which it answered until
    // ISSUE-2 — after claiming the leaf for good. That sends an operator to the
    // seed for a read that came back short, and burns a note that is fine. The
    // red is in wp-logs/ISSUE-2-red-resume.log.
    const { fetchPoolCommitments } = await import('@/lib/privacy/pool/denominatedPool');
    vi.mocked(fetchPoolCommitments).mockResolvedValueOnce({
      get: () => undefined,
      values: () => [],
    } as never);
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '23');
    const res = await POST(req(goodBody()));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(502);
    expect(body.error).toMatch(/history/);
    expect(body.error).not.toMatch(/inventory is empty/);
    const claimed = [...counters.keys()].filter((k) => k.startsWith('p01:note:issued:'));
    expect(claimed, 'a leaf the read did not return was claimed').toHaveLength(0);
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
      vi.stubEnv('ADMIN_PASSWORD', ADMIN_PASSWORD);
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

  it('is not handed to a SECOND paid code, however it was addressed', async () => {
    // 🚨 map-A defect 1. The old branch recognised a retry by RECIPIENT, so a
    // caller who had paid TWICE was charged a claim and handed back the note
    // they already held, while a note they could have been given sat in stock.
    // A true retry of one code never reached it: the claim counter refuses that
    // above, and the reply of the call that worked is replayed from its stored
    // copy — `issue-note.node.test.ts`, 'the same code, retried'.
    //
    // ONE leaf in stock, so "was it re-issued" and "was the next one handed out
    // instead" cannot be confused with each other.
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '23');
    mockGetStore.mockReturnValue(rememberingKv());
    const first = await POST(req(goodBody()));
    // The chain is not reachable here, so it stops at the on-chain check —
    // after the leaf has been claimed, which is the state this case is about.
    expect(first.status).not.toBe(503);

    mintedClaims.add('SECOND-CLAIM-CODE-AAAA');
    const again = await POST(req(goodBody({ claimCode: 'SECOND-CLAIM-CODE-AAAA' })));
    const body = await again.json();
    // Spoken for, so the loop walks past it and this request runs out of stock
    // instead of spending a second claim on the same note.
    expect(again.status, JSON.stringify(body)).toBe(503);
    expect(body.error).toMatch(/already issued/);
    expect(body.heldByOthers).toBe(1);
  });

  it('is refused to a different address WITHOUT the refusal naming one', async () => {
    // ⛔ Two people holding one note is a race where the loser paid for nothing,
    // and that is unchanged. What changed is the bookkeeping: a leaf is spoken
    // for by its claim counter alone, so nothing stores who received it (map-A
    // defect 3, `p01:note:issued:<pool>:<leaf>:to`) and the refusal has no
    // address to echo back. The rows are read at rest by
    // `__tests__/lib/kvRowsAtRest.test.ts`.
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '23');
    const ASKER_A = createNoteEncryptionAddress(new Uint8Array(32).fill(9));
    const ASKER_B = createNoteEncryptionAddress(new Uint8Array(32).fill(5));

    /** One world per asker: the same stock, holder and code; only who asks second differs. */
    async function refusalTo(asker: string): Promise<{ status: number; text: string }> {
      counters = new Map();
      mintedClaims = new Set([CLAIM, 'OTHER-CLAIM-CODE-AAAAA']);
      mockGetStore.mockReturnValue(rememberingKv());
      await POST(req(goodBody()));
      const res = await POST(
        req(goodBody({ claimCode: 'OTHER-CLAIM-CODE-AAAAA', recipientAddress: asker })),
      );
      return { status: res.status, text: await res.text() };
    }
    /** The address itself, or any 16-character piece of it, anywhere in the text. */
    const names = (text: string, address: string) => {
      for (let i = 0; i + 16 <= address.length; i += 1) {
        if (text.includes(address.slice(i, i + 16))) return true;
      }
      return false;
    };

    const toA = await refusalTo(ASKER_A);
    const toB = await refusalTo(ASKER_B);
    expect(toA.status, toA.text).toBe(503);
    const body = JSON.parse(toA.text);
    // ⚠️ NOT "the inventory is empty". A stocked pool that refuses this caller
    // and an unstocked deployment need opposite reactions from an operator.
    expect(body.error).toMatch(/already issued/);
    expect(body.heldByOthers).toBe(1);

    // ⛔ READ BY WHAT MOVES, NOT BY A KEY NAME. The same refusal to two askers
    // must be byte-identical: an address under ANY key, or pasted into the hint,
    // makes the two differ (verifier mutants N2 and N3, ISSUE-1-r2b-mutants.log,
    // survived a check that only looked for a `recipientAddress` key).
    expect(ASKER_A, 'the two askers are one address').not.toBe(ASKER_B);
    expect(toB.text, 'the refusal moved with the address that asked, so it names it').toBe(
      toA.text,
    );
    // And by text, for the asker and for the holder, with the scan's own control.
    expect(names(`{"to":"${ASKER_A}"}`, ASKER_A), 'the scan misses an address').toBe(true);
    expect(names(`{"hint":"x${ASKER_A.slice(7, 23)}x"}`, ASKER_A)).toBe(true);
    for (const address of [ASKER_A, RECIPIENT]) {
      expect(names(toA.text, address), 'the refusal holds a piece of an address').toBe(false);
    }
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

  it('walks past a spent leaf to the next candidate instead of stopping there', async () => {
    // An exhausted leaf beside a good one is still a stocked deployment. A
    // caller must not be turned away because the FIRST configured index
    // happens to be used up.
    const pool = await import('@/lib/privacy/pool/denominatedPool');
    vi.mocked(pool.isNullifierSpentInSet).mockImplementation(
      (_set, _pda, _np, _secret) => vi.mocked(pool.isNullifierSpentInSet).mock.calls.length === 1,
    );

    const res = await POST(req(goodBody()));
    const body = await res.json();

    // The assertion used to be `status !== 503`, which this fixture satisfied
    // with a 500: the tree is empty here, so leaf 24 could never be served and
    // the old route refused outright at the mismatch. It passed for the wrong
    // reason. What the case actually wants to pin is that the loop did not stop
    // at the spent leaf, and the counters say so directly: one leaf skipped as
    // spent, one examined after it.
    expect(body.spentLeaves, JSON.stringify(body)).toBe(1);
    expect(body.notOurs, 'the loop stopped at the spent leaf').toBe(1);

    vi.mocked(pool.isNullifierSpentInSet).mockReturnValue(false);
  });
});

/**
 * A configured index the tree HAS reached, holding somebody else's deposit.
 *
 * MEASURED 2026-09-03 on devnet: a buyer paid 995,000,000 lamports to the till
 * through the note-in exchange, was handed a claim, and this route answered 500
 * because the shuffle drew leaf 103 -- an index in P01_TREASURY_NOTE_LEAVES
 * that the same buyer had shielded minutes earlier. One stale entry in a list
 * of 318 refused a customer who had already paid.
 */
describe('a configured index that is somebody else\'s leaf', () => {
  it('is skipped and reported, not turned into a refusal of the whole request', async () => {
    const { fetchPoolCommitments } = await import('@/lib/privacy/pool/denominatedPool');
    // Leaf 23 is on the tree, but the commitment there is not the one our seed
    // derives. Leaf 24 is past the tree's edge, so it is "not deposited yet".
    vi.mocked(fetchPoolCommitments).mockResolvedValueOnce({
      get: () => undefined,
      values: () => [{ leafIndex: 23, commitment: 999n }],
    } as never);

    const res = await POST(req(goodBody()));
    const body = await res.json();

    expect(res.status, JSON.stringify(body)).toBe(503);
    expect(body.error).toMatch(/does not own/);
    expect(body.notOurs).toBe(1);
    // 503 and not 500: the list needs pruning, the seed is not wrong.
    expect(body.hint).toMatch(/Prune them/);
  });

  it('still refuses with 500 when NOT ONE configured leaf is ours', async () => {
    // The default fixture's tree is empty, so every candidate mismatches. That
    // is the configuration error the old code feared, and it must still be a
    // 500 rather than a quiet "out of stock".
    const res = await POST(req(goodBody()));
    const body = await res.json();

    expect(res.status, JSON.stringify(body)).toBe(500);
    expect(body.error).toMatch(/does not match the chain/);
    expect(body.notOurs).toBe(body.configured);
    expect(body.hint).toMatch(/seed or the pool is wrong/);
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
    // "configured" left the message when the treasury started DISCOVERING what
    // it owns off the tree: with nothing configured AND nothing openable, the
    // honest sentence is that there is no inventory, not that none was typed.
    expect((await res.json()).error).toMatch(/no note inventory/);
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

/**
 * READINESS SAYS "ISSUABLE NOW" ON A FIXED CLOCK (READY-1, map-A defect 6).
 *
 * The GET answered `configured` and nothing else, so the pool panel paid the
 * till against stock that was all too young, and a deployment that could not
 * answer made it deposit the buyer's own note without asking (the panel half:
 * `__tests__/components/PoolPanel.test.tsx`, "READY-1").
 *
 * THE ADVERSARY IS A CLOCK. A flag refreshed on every issuance tells anyone who
 * polls it the minute a note left stock. So the answer is ONE sample per
 * 10-minute UTC bucket, taken in `after()` by the bucket's first GET, served
 * only inside that bucket, and never touched by a sale. The request path reads
 * one KV row and no chain.
 *
 * HOW. The route is the real one. The chain is this file's stubs (history,
 * spent set, genesis, slot), and the treasury's own leaves are derived from
 * SEED by the real derivation, so the sample and the sale judge the same
 * commitments. `after()` is captured and drained by hand. `Date` is the only
 * faked timer, and each case takes buckets of its own.
 */
describe('READY-1: whether a note is issuable now, sampled once per 10-minute bucket', () => {
  const BUCKET_MS = 10 * 60 * 1000;
  /** 30 s into a bucket; `at(n)` is n buckets later. */
  const T0 = Date.UTC(2026, 8, 19, 10, 0, 30);
  const at = (bucket: number) => T0 + bucket * BUCKET_MS;
  const bucketOf = (ms: number) => Math.floor(ms / BUCKET_MS);
  /** What the Connection stub's `getSlot` answers. */
  const CURRENT_SLOT = 500_000_000;
  /** Past the route's 9,000-slot default minimum age, and well short of it. */
  const MATURE = CURRENT_SLOT - 20_000;
  const YOUNG = CURRENT_SLOT - 100;

  const seedBytes = treasurySeeds({ P01_TREASURY_POOL_SEED: SEED } as unknown as NodeJS.ProcessEnv)[0]!;
  const pool = getPoolsForTokenV3('SOL').find((p) => p.denomination === 0.1)!;
  const poolKey = pool.poolPDA.toBase58();
  const READINESS_ROW = `p01:note:readiness:${poolKey}`;

  /** The treasury's commitment at `leafIndex`, by the route's own derivation. */
  function ours(leafIndex: number): bigint {
    const { secret, nullifierPreimage } = deriveNoteMaterial(seedBytes, pool.poolPDA, leafIndex);
    return createCommitmentV3(
      nullifierPreimage,
      secret,
      deriveNoteBlinding(seedBytes, pool.poolPDA, leafIndex),
      pubkeyToField(pool.tokenMint),
    );
  }

  /** Leaves 0-5: the treasury's own where `oursAt` gives a deposit slot, somebody else's elsewhere. */
  function tree(oursAt: Record<number, number>): Map<string, OnChainCommitment> {
    const out = new Map<string, OnChainCommitment>();
    for (let leafIndex = 0; leafIndex <= 5; leafIndex += 1) {
      const mine = leafIndex in oursAt;
      const commitment = mine ? ours(leafIndex) : 700_001n + BigInt(leafIndex);
      out.set(commitment.toString(), {
        commitment,
        leafIndex,
        depositPayer: null,
        depositSlot: mine ? oursAt[leafIndex]! : MATURE,
        signature: `S${leafIndex}`,
      });
    }
    return out;
  }

  function setTree(oursAt: Record<number, number>) {
    const t = tree(oursAt);
    vi.mocked(fetchPoolCommitments).mockImplementation(async () => t);
  }

  /** A store that keeps what it is given, JSON round-tripped like the real one. */
  function memoryKv() {
    const rows = new Map<string, unknown>();
    const copy = (v: unknown) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
    return {
      rows,
      get: vi.fn(async (k: string) => (rows.has(k) ? copy(rows.get(k)) : null)),
      set: vi.fn(async (k: string, v: unknown, _opts?: { ex?: number }) => {
        rows.set(k, copy(v));
      }),
      del: vi.fn(async (k: string) => {
        rows.delete(k);
      }),
      incr: vi.fn(async (k: string) => {
        const n = Number(rows.get(k) ?? 0) + 1;
        rows.set(k, n);
        return n;
      }),
      expire: vi.fn(async () => undefined),
      smembers: vi.fn(async () => [] as string[]),
    };
  }

  let kv: ReturnType<typeof memoryKv>;
  /** This file's own history and spent-set stubs, put back after each case. */
  let historyImpl: unknown;
  let spentImpl: unknown;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    ready.captureAfter = true;
    ready.afterTasks.length = 0;
    ready.rpc.length = 0;
    kv = memoryKv();
    kv.rows.set(`p01:note:claim-minted:${CLAIM}`, 'payment:READY-1');
    mockGetStore.mockReturnValue(kv);
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '3,4');
    historyImpl = vi.mocked(fetchPoolCommitments).getMockImplementation();
    spentImpl = vi.mocked(fetchSpentNullifierSet).getMockImplementation();
  });

  afterEach(() => {
    ready.captureAfter = false;
    ready.stubSeal = false;
    ready.afterTasks.length = 0;
    vi.useRealTimers();
    if (historyImpl) vi.mocked(fetchPoolCommitments).mockImplementation(historyImpl as never);
    if (spentImpl) vi.mocked(fetchSpentNullifierSet).mockImplementation(spentImpl as never);
  });

  /** Run what the route handed to `after()`, in order, as the platform does once the reply is sent. */
  async function drainAfter() {
    while (ready.afterTasks.length > 0) {
      const task = ready.afterTasks.shift();
      await (typeof task === 'function' ? (task as () => unknown)() : task);
    }
  }

  /** Every chain read: the Connection stub's calls and the two history reads. */
  const rpcCount = () =>
    ready.rpc.length +
    vi.mocked(fetchPoolCommitments).mock.calls.length +
    vi.mocked(fetchSpentNullifierSet).mock.calls.length;

  async function readiness(): Promise<Record<string, unknown>> {
    return (await GET()).json();
  }

  it('no snapshot gives null, with no RPC on the request path; the sample runs in after()', async () => {
    setTree({ 3: MATURE });
    vi.setSystemTime(at(1));
    const body = await readiness();
    expect(body.issuableNow, 'the answer names issuableNow').toBe(null);
    expect(rpcCount(), 'the request path read the chain').toBe(0);
    // Its whole store cost: one read, of the sample row.
    expect(kv.get.mock.calls.map(([k]) => k)).toEqual([READINESS_ROW]);
    expect(kv.set).not.toHaveBeenCalled();
    expect(ready.afterTasks, 'no sample was handed to after()').toHaveLength(1);
    // Positive control: the sample itself does read the chain, after the reply.
    await drainAfter();
    expect(vi.mocked(fetchPoolCommitments)).toHaveBeenCalledTimes(1);
    expect(ready.rpc).toContain('getSlot');
    expect((await readiness()).issuableNow).toBe(true);
  });

  it('all too young gives false, the answer carries no wait time, and the sale agrees', async () => {
    setTree({ 3: YOUNG, 4: YOUNG });
    vi.setSystemTime(at(2));
    await readiness();
    await drainAfter();
    const body = await readiness();
    expect(body.issuableNow).toBe(false);
    // Nothing a clock could be read from: the whole key set, so no wait field sneaks in.
    expect(Object.keys(body).sort()).toEqual([
      'advisories',
      'configured',
      'denomination',
      'inventorySize',
      'issuableNow',
      'note',
      'ok',
      'reasons',
      'token',
    ]);
    // Positive control: asked for, the same stock is refused as too young.
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/too recently deposited/);
  });

  it('the value is stable inside a bucket across an issuance; the next bucket sees it', async () => {
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '3');
    // The whole stock: one mature note.
    setTree({ 3: MATURE });
    ready.stubSeal = true;
    vi.setSystemTime(at(10));
    await readiness();
    await drainAfter();
    expect((await readiness()).issuableNow).toBe(true);
    const rowBefore = JSON.stringify(kv.rows.get(READINESS_ROW));

    // That note is sold nine minutes later, inside the same bucket.
    vi.setSystemTime(at(10) + 9 * 60 * 1000);
    const res = await POST(req(goodBody()));
    expect(res.status, 'the sale did not complete').toBe(200);
    expect(kv.rows.get(`p01:note:issued:${poolKey}:3`)).toBe(1);
    await drainAfter();

    const same = await readiness();
    expect(same.issuableNow, 'the sale moved the answer inside its bucket').toBe(true);
    expect(JSON.stringify(kv.rows.get(READINESS_ROW)), 'the sale touched the sample').toBe(rowBefore);
    expect(ready.afterTasks, 'a GET inside a sampled bucket sampled again').toHaveLength(0);

    // Positive control: the next bucket's sample does see the sale.
    vi.setSystemTime(at(11));
    expect((await readiness()).issuableNow).toBe(null);
    await drainAfter();
    expect((await readiness()).issuableNow).toBe(false);
  });

  it('one sample per bucket: repeated GETs hand over one, and a sample another instance wrote is kept', async () => {
    setTree({ 3: MATURE });
    vi.setSystemTime(at(4));
    await readiness();
    await readiness();
    await readiness();
    expect(ready.afterTasks, 'one bucket, several samples').toHaveLength(1);
    // Another instance sampled this bucket first, and answered the other way.
    kv.rows.set(READINESS_ROW, { bucket: bucketOf(at(4)), issuableNow: false });
    await drainAfter();
    expect(vi.mocked(fetchPoolCommitments), 'a bucket that had its sample was sampled again').not.toHaveBeenCalled();
    // A sampled bucket costs a GET one read, and schedules nothing.
    kv.get.mockClear();
    expect((await readiness()).issuableNow).toBe(false);
    expect(kv.get.mock.calls.map(([k]) => k)).toEqual([READINESS_ROW]);
    expect(ready.afterTasks).toHaveLength(0);

    // And when the other instance lands while this one is reading the chain.
    vi.setSystemTime(at(5));
    const t = tree({ 3: MATURE });
    vi.mocked(fetchPoolCommitments).mockImplementation(async () => {
      kv.rows.set(READINESS_ROW, { bucket: bucketOf(at(5)), issuableNow: false });
      return t;
    });
    await readiness();
    await drainAfter();
    expect((await readiness()).issuableNow, 'the later sample overwrote the first').toBe(false);
  });

  it('unknown stays unknown: a failed read or a short history writes no sample, and the next GET asks again', async () => {
    setTree({ 3: MATURE });
    vi.mocked(fetchSpentNullifierSet).mockRejectedValueOnce(new Error('rpc down'));
    vi.setSystemTime(at(6));
    await readiness();
    await drainAfter();
    expect(kv.rows.has(READINESS_ROW), 'an unread spent set was written as an answer').toBe(false);
    expect((await readiness()).issuableNow).toBe(null);
    expect(ready.afterTasks, 'the next GET did not ask again').toHaveLength(1);
    await drainAfter();
    expect((await readiness()).issuableNow, 'the retry did not answer').toBe(true);

    // Leaf 4 is configured and sits below the top of the tree, but the history
    // read did not bring it back: that is "cannot tell", not "no".
    vi.setSystemTime(at(7));
    const short = tree({ 3: YOUNG });
    for (const [k, e] of short) if (e.leafIndex === 4) short.delete(k);
    vi.mocked(fetchPoolCommitments).mockImplementation(async () => short);
    await readiness();
    await drainAfter();
    expect((await readiness()).issuableNow, 'a short history was answered').toBe(null);
    // Control: the same stock with the history whole is a plain no.
    setTree({ 3: YOUNG });
    await drainAfter();
    expect((await readiness()).issuableNow).toBe(false);
  });

  it('outside a request scope, a GET samples nothing and reads no chain', async () => {
    // The real after(), which throws outside a request scope: the readiness
    // callers in other suites (rateLimitKey.test.ts) run exactly like this.
    ready.captureAfter = false;
    setTree({ 3: MATURE });
    vi.setSystemTime(at(8));
    const body = await readiness();
    expect(body.issuableNow).toBe(null);
    expect(rpcCount()).toBe(0);
    expect(kv.rows.has(READINESS_ROW)).toBe(false);
  });

  it('the sample row holds its bucket and a yes or no, nothing else, and never expires', async () => {
    setTree({ 3: MATURE });
    vi.setSystemTime(at(9));
    await readiness();
    await drainAfter();
    expect(kv.rows.get(READINESS_ROW)).toEqual({ bucket: bucketOf(at(9)), issuableNow: true });
    const writes = kv.set.mock.calls.filter(([k]) => k === READINESS_ROW);
    expect(writes).toHaveLength(1);
    expect(writes[0]![2], 'the row was given an expiry').toBeUndefined();
  });
});
