// @vitest-environment jsdom
/**
 * What issuance HANDS BACK and what it LEAVES BEHIND, with the real sealing.
 *
 * Run: cd apps/web && pnpm test
 *
 * WHY THIS FILE IS SEPARATE FROM issue-note.test.ts
 * ────────────────────────────────────────────────
 * That suite stops at the inventory loop on purpose: its fixture answers with
 * an empty tree, so the route refuses before it seals anything. The questions
 * here only exist AFTER the seal — which note came out, which bytes the buyer
 * got, and which rows the store is left holding — so this one builds a real
 * tree, derives the treasury's own commitments, and lets `encryptNote` run.
 *
 * ⚠️ THE NAME SAYS `node` AND THE ENVIRONMENT IS jsdom, which is a measurement
 * rather than a preference. `vitest.config.ts` runs `__tests__/setup.tsx` for
 * every file it collects, and that setup writes to `window` at module scope, so
 * an environment docblock naming node fails the file before a single test
 * loads: `ReferenceError: window is not defined` at `setup.tsx:261`
 * (wp-logs/ISSUE-1-nodeenv-probe.log).
 *
 * ⛔ THE LINE-1 DOCBLOCK IS LOAD-BEARING AND HAS TO STAY LINE 1. Vitest reads
 * the FIRST match of that directive ANYWHERE in the file, not only in a
 * docblock (`groupFilesByEnv`, vitest/dist/chunks/coverage.DL5VHqXY.js:2406),
 * so a sentence mentioning it further down would pick the environment instead.
 * This paragraph is written without the directive for that reason, and the
 * failure it causes is the one recorded in the probe log above.
 *
 * What "node" means in the NAME is the route's nodejs-runtime path with
 * nothing stubbed out between the leaf and the blob.
 *
 * The one realm stub below is what RED-0 measured for the same reason
 * (kvRowsAtRest.test.ts): under this jsdom config tweetnacl and the test share
 * one `Uint8Array` and `TextEncoder`'s bytes are from another, so `secretbox`
 * refuses a note whose bytes are perfectly good.
 *
 * WHAT IS PINNED HERE, AND WHERE THE OLD BEHAVIOUR IS RECORDED
 * ───────────────────────────────────────────────────────────
 *   1. a second paid code never re-seals a note the address already holds
 *   2. the same code, retried, returns the identical bytes (no second claim)
 *   3. the reply and the stored reply do not MOVE with the leaf, and no row
 *      moves with, or holds, the recipient
 *   4. the release rules around the one write that matters
 *   5. the rows that name a code and a payment together are gone at redemption
 *   6. no caller is left expecting a field the reply stopped carrying
 *   7. the sealed blob carries no root and no path
 *   8. a leaf the history read did not bring back is never claimed
 *   9. the walk cap falls after the gates rather than before them
 *  10. the maturity gate, pinned, with its own control
 *  11. every answer, refusals included, read in worlds that differ in the
 *      leaf or in who asks
 *  12. a claim row the store could not read gives the code back
 *
 * And after EVERY case, of every number above: the route wrote nothing to the
 * server log (`routeLog`).
 *
 * The red for 1-5, on the route before ISSUE-1, is in wp-logs/ISSUE-1-r0-red.log;
 * the red for 6, on the callers before fix round 1, is in wp-logs/ISSUE-1-red.log;
 * the red for 7-9, on the route before ISSUE-2, is in wp-logs/ISSUE-2-red.log
 * (re-run on the resumed tree in wp-logs/ISSUE-2-red-resume.log).
 * 10 passes on both: it pins a rule neither work package changed, so it is
 * declared in no red block.
 * ISSUE-2 fix round 1 added three cases: the mixed-leaf 502 in 8, the exact
 * key allowlist in 7 and "stops at the first note it can issue" in 9. Their
 * reds are in wp-logs/ISSUE-2-fix1/ (red-fix1.log on the tracked tree for the
 * last one, mutants-fix1.log for the verifier's surviving mutants).
 * ISSUE-2 fix round 2 added the taller-tree world in 7, the key set and the
 * two-index world on the 502 in 8, and "even beside a note that is only too
 * young" in 8. The route already behaved, so their reds are the verifier's
 * surviving mutants R2, R3 and R8 (wp-logs/ISSUE-2-fix2/mutants-fix2.log,
 * against mutants-pre-fix2.log where the same three stayed green).
 * ISSUE-2 web-run fix round 1 added "even beside a note that is already spent"
 * and "... already held" in 8. The route already behaved, so their reds are
 * the ordering mutants that stayed green on the tree before them, O1 (the
 * verifier's R14), G1 and G4 (web-run/logs/ISSUE-2-webfix1/ordering-pre-webfix1.log
 * against ordering-webfix1.log). Its resumed half added "even beside a leaf not
 * deposited yet" in 8, whose red is G5 (web-run/logs/ISSUE-2-webfix1/resume/
 * ordering-pre-resume.log against ordering-final.log).
 * ISSUE-2 web-run fix round 2 added, in 9, one case per pure gate the cap must
 * not count (spent, missing, not deposited yet) and, in 8, "is never claimed
 * when it was ACQUIRED rather than configured". The route already behaved, so
 * their reds are the verifier's surviving mutants V1, V13, V14 and V5, each
 * captured in web-run/logs/ISSUE-2-webfix2/sandbox-<V>/wp-logs/ISSUE-2-red.log;
 * before these cases all four stayed green (ISSUE-2-webfix2/mutants-pre-webfix2.log).
 * ISSUE-1 web-run fix round 1 added "is the same length whichever note is
 * sealed in it" in 3, whose red is a real one, on the route before the pad
 * (web-run/logs/ISSUE-1-webfix1/sandbox-length/wp-logs/ISSUE-1-red.log). It
 * also widened 2, 4 and 5 and added 11. The route already behaved there, so
 * their reds are the verifier's surviving mutants R1, R3, R6, R8, R10 and R15
 * (wp-logs/verify/ISSUE-1-r3-mutants.log), each captured in
 * web-run/logs/ISSUE-1-webfix1/sandbox-<R>/wp-logs/ISSUE-1-red.log; before
 * these edits all six stayed green (ISSUE-1-webfix1/mutants-before.log).
 * ISSUE-1 web-run fix round 2 made the fake store fail in the production
 * client's own shape (`upstashError`: the failed command, value included, and
 * whatever another buyer had batched with it), added the store and RPC
 * failures to 11 with leaf worlds 64 and 3 and a concurrent-buyer world, added
 * leaf 64 to 3, and ran 4 and 5 with 87- and 86-character signatures. The
 * route passed the store's text on, so the red is a real one, on the route
 * before the fix (web-run/logs/ISSUE-1-webfix2/sandbox-upstash/wp-logs/
 * ISSUE-1-red.log); the verifier's surviving mutants X1, X6, X7 and X9 are
 * captured beside it (ISSUE-1-webfix2/sandbox-<X>/).
 * ISSUE-1 web-run fix round 3 replaced 11's list of log markers with
 * `routeLog`, read after every case, and added 12. The route logs nothing, so
 * the log check's reds are the verifier's surviving mutants Z1, Z2 and Z9 and
 * this round's Y1-Y6 (web-run/logs/ISSUE-1-webfix3/mutants-before.log and
 * mutants-before-extra.log, where all nine stayed green), each captured in
 * web-run/logs/ISSUE-1-webfix3/sandbox-<M>/. 12 has a real red, on the route
 * that answered an unreadable claim row with the 402 and kept the code
 * (web-run/logs/ISSUE-1-webfix3/sandbox-minted/wp-logs/ISSUE-1-red.log).
 * ISSUE-1 web-run fix 4 (web-run/logs/ISSUE-1-webfix4/) added three cases to
 * 4 (a write that landed but could not be read back, with overlapping
 * retries; the same with the reply still unreadable at the retry; a write
 * that neither landed nor could be read back), two states to 11 (a stored
 * reply unreadable on a first claim; the retry of a sale whose reply landed
 * unread), a network-address world to 3 and 11, and moved the server-log
 * capture ahead of the route's import. The first two cases and the two states
 * have a real red, on the route that sold again after a landed write
 * (web-run/logs/ISSUE-1-webfix4/sandbox-double/wp-logs/ISSUE-1-red.log). The
 * rest pin behaviour the route already had, so their reds are the verifier's
 * surviving mutants W1, W1b, W2, W5 and W6 (web-run/logs/verify-ISSUE-1-r3/
 * mutants.log, mutants-2.log), each captured in
 * web-run/logs/ISSUE-1-webfix4/sandbox-<W>/.
 *
 * ⛔ WHAT A GREEN HERE DOES NOT CLOSE. This drives ONE route with a fixture
 * tree. The cross-route dump — what contribute-note, relay-to-buyer and this
 * route leave together — is measured by `__tests__/lib/kvRowsAtRest.test.ts`,
 * whose pin KV-1 flips. Case 3 reads the leaf side by moving it (four leaf
 * worlds, 17, 23, 302 and 64, that differ only in which leaf is in stock, plus
 * a recipient world and a network-address world that differ only in who
 * asks), so a value that agrees on those four leaves would pass it; that
 * differential is the one in RED-0, with eight worlds.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

type Commitment = { leafIndex: number; commitment: bigint; depositSlot: number | null };

const h = vi.hoisted(() => ({
  store: null as unknown,
  /** Tasks the route handed to next/server `after()`; drained before each dump. */
  deferred: [] as unknown[],
  tree: new Map<string, Commitment>(),
  currentSlot: 500_000_000,
  /** Makes the sealing step fail, for the release rules. */
  sealThrows: false,
  /** Makes the rate limiter's store call fail (case 11). */
  rateLimitError: null as null | (() => Error),
  /** The network address the route handed the rate limiter, last call. */
  askedFrom: null as string | null,
  /** Makes a Connection call fail, by method name (case 11). */
  rpcError: {} as Record<string, (() => Error) | undefined>,
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    // The real `after` throws outside a request scope (next/dist/server/after/
    // after.js, error E468), so it is captured and drained here exactly as the
    // runtime would run it.
    after: (task: unknown) => {
      h.deferred.push(task);
    },
  };
});

vi.mock('@/lib/waitlist/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/waitlist/store')>();
  return {
    ...actual,
    getStore: () => h.store,
    rateLimitExceeded: async (_kv: unknown, ip: string) => {
      h.askedFrom = ip;
      if (h.rateLimitError) throw h.rateLimitError();
      return false;
    },
  };
});

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    Connection: class {
      async getGenesisHash() {
        const fail = h.rpcError.getGenesisHash;
        if (fail) throw fail();
        return 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
      }
      async getSlot() {
        const fail = h.rpcError.getSlot;
        if (fail) throw fail();
        return h.currentSlot;
      }
    },
  };
});

vi.mock('@/lib/privacy/pool/denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/privacy/pool/denominatedPool')>();
  return {
    ...actual,
    fetchPoolCommitments: vi.fn(async () => new Map(h.tree)),
    fetchSpentNullifierSet: vi.fn(async () => new Set<string>()),
    // The real one derives a PDA, which throws under jsdom ("Unable to find a
    // viable program address nonce", RED-0 dry run 1). The spent set is empty,
    // so `false` is the real answer; issue-note.test.ts stubs it the same way.
    isNullifierSpentInSet: vi.fn(() => false),
  };
});

vi.mock('@/lib/privacy/pool/noteCrypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/privacy/pool/noteCrypto')>();
  return {
    ...actual,
    encryptNote: (address: string, plaintext: Uint8Array) => {
      // A library error that quotes its input, as many do: the start of the
      // note (its pool and its secret) and the address it was sealed to.
      // Case 11 reads whether any of it reaches an answer.
      if (h.sealThrows) {
        throw new Error(
          `the sealing step failed on ${Buffer.from(plaintext).toString('utf8').slice(0, 120)} for ${address}`,
        );
      }
      return actual.encryptNote(address, plaintext);
    },
  };
});

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/issue-note/route';
import {
  createCommitmentV3,
  deriveNoteMaterial,
  fetchPoolCommitments,
  fetchSpentNullifierSet,
  getPoolsForTokenV3,
  isNullifierSpentInSet,
  pubkeyToField,
  shareableNoteToReceipt,
  type ShareableNote,
} from '@/lib/privacy/pool/denominatedPool';
import { deriveNoteBlinding } from '@/lib/privacy/pool/noteBlinding';
import { createNoteEncryptionAddress, decryptNote } from '@/lib/privacy/pool/noteCrypto';
import {
  notePaidCodeKey,
  notePaidKey,
  relayPaymentContributionKey,
  contributionBinding,
} from '@/lib/privacy/paymentBinding';
import type { KvLike } from '@/lib/waitlist/store';

// ── the fixture ──────────────────────────────────────────────────────────────

const TICKET = 'test-ticket';
const SEED_HEX = 'ab'.repeat(32);
const SEED = Uint8Array.from(Buffer.from(SEED_HEX, 'hex'));
const DENOM = 0.1;
const POOL = getPoolsForTokenV3('SOL').find((p) => p.denomination === DENOM)!;
const POOL_KEY = POOL.poolPDA.toBase58();
/** Old enough for the maturity gate at any plausible `minAgeSlots`. */
const ANCIENT_SLOT = 1_000;
/** A payment signature in the shape the routes store, base58 and 88 characters. */
const SIG = 'ZP2'.repeat(29) + 'z';
/**
 * The same, one and two characters shorter. A 64-byte signature is 88 base58
 * characters only when its value reaches 58^87: of 200,000 random ones, 38,829
 * were 87 characters and 8 were 86 (web-run/logs/ISSUE-1-webfix2/
 * sig-lengths.log). A sweep anchored to 88 left one payment in five behind and
 * passed every case while SIG was the only one (verifier mutant X6,
 * web-run/logs/verify-ISSUE-1-r1/mutants.log).
 */
const SIG_87 = 'ZP2'.repeat(29);
const SIG_86 = 'ZP2'.repeat(28) + 'zz';
const EVERY_SIG_LENGTH = [SIG, SIG_87, SIG_86];

const BUYER_SEED = new Uint8Array(32).fill(77);
const RECIPIENT = createNoteEncryptionAddress(BUYER_SEED);
const OTHER_BUYER_SEED = new Uint8Array(32).fill(123);
const OTHER_RECIPIENT = createNoteEncryptionAddress(OTHER_BUYER_SEED);
/** Documentation addresses (RFC 5737), for the worlds that move only who connects. */
const ASKER_IP = '198.51.100.9';
const OTHER_ASKER_IP = '203.0.113.77';
/** The address `request()` comes from; beforeEach puts it back to ASKER_IP. */
let askerIp = ASKER_IP;

const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');
const claimKeyOf = (code: string) => `p01:note:claim:${code}`;
const mintedKeyOf = (code: string) => `p01:note:claim-minted:${code}`;
const issuedKeyOf = (leafIndex: number) => `p01:note:issued:${POOL_KEY}:${leafIndex}`;
const sealedKeyOf = (code: string) => `p01:note:sealed:${sha256Hex(code)}`;

/**
 * What `claim-minted:<code>` holds, in every shape a live store can contain.
 *
 * ⛔ THE FIXTURE IS THE WRITERS' OWN SHAPE, CHECKED AGAINST THEIR SOURCE. This
 * file used to mint `contrib:<pool>:<leaf>:payment:<sig>`, a shape nothing has
 * written since KV-1, so a sweep that only understood that shape passed every
 * case while the rows production writes today stayed behind (verifier r3
 * mutants R8 and R15, wp-logs/verify/ISSUE-1-r3-mutants.log). Case 5 reads
 * `contribute-note` and `claim-for-payment` and fails if either writes another.
 */
const mintedNow = (sig: string) => `payment:${sig}`;
const MINTED_NOW = mintedNow(SIG);
/** The shape contribute-note wrote before KV-1. An unredeemed claim still holds it. */
const mintedBeforeKv1 = (leafIndex: number, sig = SIG) =>
  `contrib:${POOL_KEY}:${leafIndex}:payment:${sig}`;
/** What `/api/mint-claim` stores: 16 hex of sha256 of the operator's reference, and no payment. */
const MINTED_BY_HAND = sha256Hex('manual').slice(0, 16);

/**
 * EXACTLY WHAT A SALE ANSWERS WITH. Case 3 asserts the route sends these and
 * nothing else; case 6 asserts no caller expects anything else back. One list,
 * both sides, so a field added to the route can never be half-known.
 */
const REPLY_KEYS = ['denomination', 'disclosure', 'merklePath', 'ok', 'sealedNote', 'token'];
/** `replayed` on a retried code (case 2); `error` on every refusal. */
const REPLY_EXTRAS = ['replayed', 'error'];

function treasuryCommitmentAt(leafIndex: number): bigint {
  const { secret, nullifierPreimage } = deriveNoteMaterial(SEED, POOL.poolPDA, leafIndex);
  return createCommitmentV3(
    nullifierPreimage,
    secret,
    deriveNoteBlinding(SEED, POOL.poolPDA, leafIndex),
    pubkeyToField(POOL.tokenMint),
  );
}

/**
 * A tree holding somebody else's deposits plus the treasury leaves named.
 *
 * The foreign leaves are the same in every world, so two worlds differ in the
 * treasury leaf and in nothing else — which is what case 3 rests on.
 */
function setTree(treasuryLeaves: number[]): void {
  const tree = new Map<string, Commitment>();
  const put = (leafIndex: number, commitment: bigint) => {
    tree.set(commitment.toString(), { leafIndex, commitment, depositSlot: ANCIENT_SLOT });
  };
  [0, 1, 2].forEach((leafIndex, i) => put(leafIndex, 900_001n + BigInt(i) * 7919n));
  for (const leafIndex of treasuryLeaves) put(leafIndex, treasuryCommitmentAt(leafIndex));
  h.tree = tree;
}

function clone<T>(v: T): T {
  return v === null || typeof v !== 'object' ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** A value as a dump prints it: never `undefined`, never a throw. */
function dumpText(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
}

interface Row {
  key: string;
  value: string;
  ttlSeconds: number | null;
}

/**
 * A failed store call, worded as the production client words it.
 *
 * 🚨 THE TEXT NAMES THE COMMAND, VALUE INCLUDED. `@vercel/kv` is
 * `@upstash/redis` 1.38.0, and a request it cannot complete throws
 * `${body.error}, command was: ${JSON.stringify(request body)}`
 * (node_modules/@upstash/redis/nodejs.js:226). With auto-pipelining that body
 * is every command batched into the request, another buyer's included. A fake
 * that threw a constant text could not see the route pass it on, and the route
 * did: the 503 for a reply that could not be stored carried the sealed reply,
 * a failed leaf claim named the leaf's key, and one buyer's refusal carried
 * another's claim code (verifier probe P1-P3, web-run/logs/verify-ISSUE-1-r1/
 * probe-upstash.log).
 */
function upstashError(command: unknown[], batchedWith: unknown[][] = []): Error {
  return new Error(
    `ERR max daily request limit exceeded, command was: ${JSON.stringify([command, ...batchedWith])}`,
  );
}

/** Redis semantics for every KvLike method, with the TTL a dump would show. */
class FakeKv implements KvLike {
  readonly scalars = new Map<string, { v: unknown; ttl: number | null }>();
  /**
   * Every store operation this request made, in order.
   *
   * [gate r1, RED 7f] The uniform refusal equalizes the BYTES of the answer.
   * It cannot equalize the WORK: the "all held" walk runs one `incr` per
   * candidate leaf and the "all spent" and "too young" walks `continue` before
   * that line, so the number of round trips — and with it the latency — still
   * moves with the inventory state a re-poller is reading. This counter is what
   * turns that from a claim into a measurement.
   */
  readonly ops: string[] = [];
  readonly sets = new Map<string, Set<string>>();
  /** Keys with this prefix refuse to be written, for the release rules. */
  failSetPrefix: string | null = null;
  /**
   * Keys with this prefix ARE written and the call still throws — the store
   * took the write and the answer was lost on the way back.
   */
  landThenFailSetPrefix: string | null = null;
  /** Any get, set or incr this matches fails as a request does (case 11). */
  failWhen: ((op: 'get' | 'set' | 'incr', key: string) => boolean) | null = null;
  /**
   * Once a set of a key with this prefix has been ATTEMPTED, landed or not,
   * every get of such a key fails: the store stopped answering between the
   * write and the read-back (case 4, "one note for one code").
   */
  unreadableAfterWritePrefix: string | null = null;
  private writeAttempted = false;
  /** Another buyer's commands, batched into the same request as each failing one. */
  batchedWith: unknown[][] = [];

  private fail(command: unknown[]): never {
    throw upstashError(command, this.batchedWith);
  }

  /** The store answers again: every failure mode above is switched off. */
  heal(): void {
    this.failSetPrefix = null;
    this.landThenFailSetPrefix = null;
    this.failWhen = null;
    this.unreadableAfterWritePrefix = null;
    this.writeAttempted = false;
  }

  private unreadable(key: string): boolean {
    const prefix = this.unreadableAfterWritePrefix;
    return this.writeAttempted && prefix !== null && key.startsWith(prefix);
  }

  async get<T>(key: string): Promise<T | null> {
    this.ops.push(`get ${key}`);
    if (this.failWhen?.('get', key) || this.unreadable(key)) this.fail(['get', key]);
    const e = this.scalars.get(key);
    return (e ? clone(e.v) : null) as T | null;
  }
  async set(key: string, value: unknown, opts?: { ex?: number }): Promise<void> {
    this.ops.push(`set ${key}`);
    if (this.unreadableAfterWritePrefix && key.startsWith(this.unreadableAfterWritePrefix)) {
      this.writeAttempted = true;
    }
    if ((this.failSetPrefix && key.startsWith(this.failSetPrefix)) || this.failWhen?.('set', key)) {
      this.fail(['set', key, JSON.stringify(value)]);
    }
    this.scalars.set(key, { v: clone(value), ttl: opts?.ex ?? null });
    if (this.landThenFailSetPrefix && key.startsWith(this.landThenFailSetPrefix)) {
      this.fail(['set', key, JSON.stringify(value)]);
    }
  }
  async del(key: string): Promise<void> {
    this.scalars.delete(key);
    this.sets.delete(key);
  }
  async incr(key: string): Promise<number> {
    this.ops.push(`incr ${key}`);
    if (this.failWhen?.('incr', key)) this.fail(['incr', key]);
    const e = this.scalars.get(key);
    const n = Number(e?.v ?? 0) + 1;
    this.scalars.set(key, { v: n, ttl: e?.ttl ?? null });
    return n;
  }
  async expire(key: string, seconds: number): Promise<void> {
    const e = this.scalars.get(key);
    if (e) e.ttl = seconds;
  }
  async sadd(key: string, member: string): Promise<void> {
    const s = this.sets.get(key) ?? new Set<string>();
    s.add(String(member));
    this.sets.set(key, s);
  }
  async srem(key: string, member: string): Promise<void> {
    this.sets.get(key)?.delete(String(member));
  }
  async scard(key: string): Promise<number> {
    return this.sets.get(key)?.size ?? 0;
  }
  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }
  async mget(keys: string[]): Promise<(number | null)[]> {
    return keys.map((k) => {
      const v = this.scalars.get(k)?.v;
      return v === undefined || v === null ? null : Number(v);
    });
  }

  has(key: string): boolean {
    return this.scalars.has(key) || this.sets.has(key);
  }

  /** Everything a dump would show, sorted so two worlds compare as text. */
  rows(): Row[] {
    const out: Row[] = [];
    for (const [key, { v, ttl }] of this.scalars) out.push({ key, value: dumpText(v), ttlSeconds: ttl });
    for (const [key, members] of this.sets) {
      if (members.size > 0) out.push({ key, value: [...members].sort().join(','), ttlSeconds: null });
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
}

let kv: FakeKv;

/**
 * Every line written to the server log while a case runs, and the rule is that
 * there is none.
 *
 * 🚨 A SERVER LOG IS A COPY OF WHAT IS WRITTEN TO IT, kept by the host, and
 * CONSTRAINTS goal 4 counts a leaked log as an adversary. This route writes
 * nothing to one: no console call, no stream write. So nothing at all may be
 * written, in any case of this file. A list of markers is not that rule: a
 * line naming the issued leaf index or its commitment passed all 87 tests
 * (verifier mutants Z1, Z2 and Z9, web-run/logs/verify-ISSUE-1-r2/mutants.log).
 * Comparing the lines across worlds is not that rule either. It still passes
 * whatever is the same in every world, such as the claim code or the payment
 * signature (mutants Y3 and Y4). The process streams reach the same log, so
 * they are read too (Y2, Y6), and so is every path a case drives, not only
 * case 11's (Y1). All nine stayed green before this check existed
 * (web-run/logs/ISSUE-1-webfix3/mutants-before.log, mutants-before-extra.log).
 *
 * ⛔ AND IT IS INSTALLED BEFORE THE ROUTE'S MODULE LOADS, in `vi.hoisted`,
 * which vitest runs ahead of every import. It used to be a set of spies put
 * in place per case, so a logger the route bound when its module loaded
 * (`const trace = console.info.bind(console)`, or the same of
 * `process.stdout.write`) held the function from before the spies, and wrote
 * the issued leaf and its commitment past all 91 tests (verifier web-run r3
 * mutants W5 and W6, web-run/logs/verify-ISSUE-1-r3/mutants-2.log). The
 * functions are replaced outright, not spied on, so `restoreAllMocks` leaves
 * them alone; `process._rawDebug` and `fetch` (a request to a log service)
 * are read as well. "the server-log check itself" holds the controls, and the
 * import check beside them keeps the route from reaching any other way out.
 */
const serverLog = vi.hoisted(() => {
  const lines: string[] = [];
  // Self-contained: this runs before every import and every helper below.
  const show = (x: unknown): string => {
    if (typeof x === 'string') return x;
    if (x instanceof Error) return `${x.name}: ${x.message}`;
    try {
      const text = JSON.stringify(x);
      return text === undefined ? String(x) : text;
    } catch {
      return String(x);
    }
  };
  // `ArrayBuffer.isView`, not `instanceof Uint8Array`: Node's Buffer is not
  // an instance of this realm's Uint8Array (see the header).
  const chunkText = (chunk: unknown): string =>
    ArrayBuffer.isView(chunk)
      ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8')
      : show(chunk);
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
      lines.push(`console.${level}: ${args.map(show).join(' ')}`);
    });
  }
  for (const [name, stream] of [
    ['stdout', process.stdout],
    ['stderr', process.stderr],
  ] as const) {
    replace(stream, 'write', (chunk: unknown) => {
      lines.push(`${name}: ${chunkText(chunk)}`);
      return true;
    });
  }
  replace(process, '_rawDebug', (...args: unknown[]) => {
    lines.push(`rawDebug: ${args.map(show).join(' ')}`);
  });
  replace(globalThis, 'fetch', async (input: unknown) => {
    lines.push(`fetch: ${String(input)}`);
    throw new Error('this test has no network');
  });
  const raw = process as unknown as { _rawDebug: (...args: unknown[]) => void };
  return {
    lines,
    /** Bound here, before the route's module loads, the way a module binds a logger. */
    boundAtLoad: {
      info: console.info.bind(console),
      write: process.stdout.write.bind(process.stdout) as (chunk: string) => boolean,
      rawDebug: raw._rawDebug.bind(process),
      fetch: globalThis.fetch.bind(globalThis),
    },
    restore: () => {
      for (const put of undo.reverse()) put();
    },
  };
});
const routeLog = serverLog.lines;

/**
 * The operator's password, as this file's fixture.
 *
 * [SWEEP4 round 1, server lane] Every exhaustion now answers a BUYER the same
 * bytes, whatever the walk found, so that a claim code which comes back cannot
 * be re-polled into a reading of the inventory. The counts still exist, and
 * they are still answered - to the one caller who proves they run the
 * deployment, and to no other
 * caller holding it (route.ts, `exhausted`). Everything a case here reads about
 * an exhaustion is therefore read through this header; the cases that read what
 * a BUYER is told pass `{ asOperator: false }` and assert the opposite - that
 * the answer does not move with the state of the inventory.
 */
const ADMIN_PASSWORD = 'operator-password-fixture';

/**
 * ⚠️ `asOperator: false` OMITS THE HEADER; it does not send a wrong one. Those
 * are two different callers and only one of them exercises the comparison in
 * `asksAsOperator`, so `password` sends whatever string is given and a case
 * about a WRONG password can be about a wrong password. All three reach the
 * same public answer; the guard at the end of section 13 pins that the DEFAULT
 * is deliberate, because roughly 95 assertions in this file rest on it.
 */
function request(
  body: unknown,
  opts: { asOperator?: boolean; password?: string } = {},
): NextRequest {
  const asOperator = opts.asOperator !== false;
  const header =
    opts.password !== undefined
      ? { 'x-admin-password': opts.password }
      : asOperator
        ? { 'x-admin-password': ADMIN_PASSWORD }
        : {};
  return new NextRequest('http://localhost:3000/api/issue-note', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-p01-funder-ticket': TICKET,
      'x-real-ip': askerIp,
      ...header,
    },
    body: JSON.stringify(body),
  } as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

async function drainAfter(): Promise<void> {
  while (h.deferred.length > 0) {
    const task = h.deferred.shift();
    await (typeof task === 'function' ? (task as () => unknown)() : task);
  }
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
  /** Every header, as a capture of the wire shows them (case 11). */
  headers: string;
}

/**
 * The headers of a reply, sorted. `date` is left out: it is the clock of the
 * call, not a property of the note or of the asker.
 */
function headerText(res: Response): string {
  return JSON.stringify([...res.headers].filter(([name]) => name !== 'date').sort());
}

/**
 * Mint a claim the way contribute-note and claim-for-payment do today:
 * `payment:<sig>`, no leaf (case 5 checks this against their source). The
 * leaf the payment funded is still named by every caller, because it is what
 * the legacy shape carried.
 */
function mintClaim(code: string, _fundedLeaf: number, value: string = MINTED_NOW): void {
  kv.scalars.set(mintedKeyOf(code), { v: value, ttl: null });
}

async function issue(
  code: string,
  over: Record<string, unknown> = {},
  opts: { asOperator?: boolean; password?: string } = {},
): Promise<Reply> {
  const res = await POST(
    request(
      {
        recipientAddress: RECIPIENT,
        token: 'SOL',
        denomination: DENOM,
        claimCode: code,
        ...over,
      },
      opts,
    ),
  );
  await drainAfter();
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    headers: headerText(res),
  };
}

/**
 * The same call, for the cases where today's route THROWS instead of answering.
 *
 * The error is swallowed rather than asserted on: what these cases read is the
 * state of the store afterwards, so a crash must not be the subject of an
 * assertion (PROTOCOL.md, "wrapped-runtime-error").
 */
async function issueSwallowing(code: string): Promise<Reply | null> {
  const reply = await issue(code).catch(() => null);
  await drainAfter();
  return reply;
}

/** The commitment the sealed blob in a reply opens to, under the buyer's seed. */
function openedCommitment(body: Record<string, unknown>, seed = BUYER_SEED): bigint {
  const note = JSON.parse(
    Buffer.from(decryptNote(seed, String(body.sealedNote))).toString('utf8'),
  ) as Record<string, string>;
  return createCommitmentV3(
    BigInt(note.nullifier_preimage),
    BigInt(note.secret),
    BigInt(note.deposit_epoch),
    BigInt(note.token_mint),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` leaves a `vi.spyOn(Math, 'random')` in place, so without
  // this a fixed draw from one case would decide the shuffle of every case
  // after it. Vitest 3 restores only spies here, not the module mocks above.
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('P01_TREASURY_POOL_SEED', SEED_HEX);
  vi.stubEnv('P01_FUNDER_TICKET', TICKET);
  vi.stubEnv('P01_TREASURY_NOTE_DENOMINATION', String(DENOM));
  // [SWEEP4 round 1, server lane] The operator password this file proves with.
  // Set for every case, because the DEFAULT request carries the header: the
  // exhaustion assertions below read the operator view deliberately, and the
  // cases about what a BUYER sees opt out with `{ asOperator: false }`.
  vi.stubEnv('ADMIN_PASSWORD', ADMIN_PASSWORD);
  // Empty on purpose: the inventory is then exactly what the treasury can OPEN
  // on the fixture tree, so a world is defined by its tree alone.
  vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '');
  vi.stubEnv('P01_TREASURY_NOTE_MIN_AGE_SLOTS', '');
  // Realm plumbing, not behaviour — see the header.
  vi.stubGlobal(
    'TextEncoder',
    class {
      readonly encoding = 'utf-8';
      encode(s = ''): Uint8Array {
        return new Uint8Array(Buffer.from(s, 'utf8'));
      }
    },
  );
  h.sealThrows = false;
  h.rateLimitError = null;
  h.askedFrom = null;
  h.rpcError = {};
  askerIp = ASKER_IP;
  h.deferred.length = 0;
  kv = new FakeKv();
  h.store = kv;
  // The capture itself stays in place for the whole file (`serverLog`).
  routeLog.length = 0;
});

afterEach(() => {
  // See `routeLog`: after every case, so every path any case drives is read.
  expect(routeLog, 'the route wrote to the server log').toEqual([]);
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  serverLog.restore();
});

// ── 1 ────────────────────────────────────────────────────────────────────────

describe('a second paid code', () => {
  it('never gets a note the address already holds', async () => {
    // 🚨 THE DEFECT THIS PINS (map-A defect 1). The re-seal branch recognised a
    // retry by RECIPIENT, not by claim code — and a true retry of the same code
    // is already refused above it, by the claim counter. So the only caller
    // that ever reached it had paid a SECOND time: they were charged a claim
    // and handed back the note they already had, while a note they could have
    // been given sat in stock.
    setTree([17, 23]);
    // Fisher-Yates with a fixed draw, so both requests walk the candidates in
    // the same order and "which leaf came out" is the only thing that moves.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    mintClaim('CODE-ONE-AAAAAAAA', 17);
    mintClaim('CODE-TWO-BBBBBBBB', 17);
    mintClaim('CODE-THREE-CCCCCC', 17);

    const one = await issue('CODE-ONE-AAAAAAAA');
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    const two = await issue('CODE-TWO-BBBBBBBB');

    expect(two.status, JSON.stringify(two.body)).toBe(200);
    expect(
      openedCommitment(two.body),
      'the second paid code was charged for the note the buyer already held',
    ).not.toBe(openedCommitment(one.body));

    // And when the stock really is gone, the claim comes back rather than being
    // spent on nothing.
    const three = await issue('CODE-THREE-CCCCCC');
    expect(three.status).toBe(503);
    expect(kv.has(claimKeyOf('CODE-THREE-CCCCCC')), 'an unserved claim was kept').toBe(false);
  });
});

// ── 2 ────────────────────────────────────────────────────────────────────────

describe('the same code, retried', () => {
  it('returns the identical sealed body instead of a refusal', async () => {
    // A lost response used to be lost forever: the claim counter answered 409
    // and the note it had sealed was unreachable. The reply is stored under the
    // hash of the code, so the buyer who retries gets the SAME bytes — one
    // claim, one note, however many times the network eats the answer.
    setTree([17]);
    mintClaim('CODE-ONE-AAAAAAAA', 17);

    const one = await issue('CODE-ONE-AAAAAAAA');
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    const again = await issue('CODE-ONE-AAAAAAAA');

    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.sealedNote, 'the retry was sealed again instead of replayed').toBe(
      one.body.sealedNote,
    );
    // ⛔ THE WHOLE BODY, NOT TWO FIELDS OF IT. A replay that put the asker's
    // address beside the stored reply passed a check of `replayed` and
    // `sealedNote` alone (verifier r3 mutant R1, ISSUE-1-r3-mutants.log).
    expect(Object.keys(again.body).sort()).toEqual([...REPLY_KEYS, 'replayed'].sort());
    expect(again.body, 'the replay is not the reply that was stored').toEqual({
      ...one.body,
      replayed: true,
    });
    expect(again.headers, 'the replay carries a header the sale did not').toBe(one.headers);
    // No second leaf was taken out of stock.
    const issuedKeys = kv.rows().filter((r) => /^p01:note:issued:/.test(r.key));
    expect(issuedKeys.map((r) => r.key)).toEqual([issuedKeyOf(17)]);
    // ⛔ NO TTL. A lifetime on this row would make the replay work for a day and
    // then answer 409 to somebody who paid — the shape
    // `__tests__/api/claim-does-not-expire.test.ts` pins for the claim itself.
    const stored = kv.rows().find((r) => r.key === sealedKeyOf('CODE-ONE-AAAAAAAA'));
    expect(stored, 'the reply was not stored').toBeDefined();
    expect(stored!.ttlSeconds).toBeNull();
  });
});

// ── 3 ────────────────────────────────────────────────────────────────────────

/** Every sealed note in `text` that `seed` opens: what the holder of that seed walks away with. */
function notesOpenedBy(seed: Uint8Array, text: string): string[] {
  return (text.match(/p01enc1:[A-Za-z0-9+/=]+/g) ?? []).filter((blob) => {
    try {
      decryptNote(seed, blob);
      return true;
    } catch {
      return false;
    }
  });
}

/** Replace ciphertext THIS seed opens; ciphertext under any other key stays. */
function redact(text: string, seed: Uint8Array): string {
  return text.replace(/p01enc1:[A-Za-z0-9+/=]+/g, (blob) => {
    try {
      decryptNote(seed, blob);
      return 'SEALED-TO-THIS-BUYER';
    } catch {
      return blob;
    }
  });
}

/**
 * Read by what MOVES, not by a list of spellings.
 *
 * Two worlds differ in exactly one thing and the reply is compared whole. A
 * value that names the leaf in ANY encoding moves when the leaf moves; a value
 * that names the buyer moves when the buyer moves. The blob the buyer's own
 * seed opens is redacted, because that is the note they came for — the same
 * exemption, stated the same way, as `__tests__/lib/kvRowsAtRest.test.ts`.
 */
describe('what the reply and the store hold', () => {
  /** One issuance in its own store, so two worlds share nothing but the code. */
  async function world(
    leafIndex: number,
    recipientAddress: string,
    seed: Uint8Array,
    ip: string = ASKER_IP,
  ): Promise<{ reply: Reply; rows: Row[]; counters: Row[] }> {
    kv = new FakeKv();
    h.store = kv;
    h.deferred.length = 0;
    setTree([leafIndex]);
    mintClaim('CODE-ONE-AAAAAAAA', leafIndex);
    askerIp = ip;
    const reply = await issue('CODE-ONE-AAAAAAAA', { recipientAddress });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    // Anti-vacuity for the address worlds: the route read this one.
    expect(h.askedFrom, 'the route never saw the address that asked').toBe(ip);
    const all = kv.rows().map((r) => ({ ...r, value: redact(r.value, seed) }));
    // The per-leaf claim counter is keyed by the leaf and holds nothing else;
    // it is the row RED-0's neutral case N1 names. Every other row has to agree
    // across the two leaf worlds.
    const isCounter = (r: Row) => new RegExp(`^p01:note:issued:${POOL_KEY}:\\d+$`).test(r.key);
    return { reply, rows: all.filter((r) => !isCounter(r)), counters: all.filter(isCounter) };
  }

  /** The address itself, or any 16-character piece of it, anywhere in a row. */
  function namesTheRecipient(row: Row, address = RECIPIENT): boolean {
    const text = `${row.key} ${row.value}`;
    for (let i = 0; i + 16 <= address.length; i += 1) {
      if (text.includes(address.slice(i, i + 16))) return true;
    }
    return false;
  }

  it('does not move when the leaf moves, and does not name the recipient', async () => {
    const a = await world(17, RECIPIENT, BUYER_SEED);
    const b = await world(23, RECIPIENT, BUYER_SEED);
    // A third leaf of the other parity and another magnitude: 17 and 23 are
    // both odd and both two digits, so a value carrying `leaf % 2` or the
    // leaf's length agreed on them (verifier mutant M10, ISSUE-1-r1b-mutants.log).
    const c = await world(302, RECIPIENT, BUYER_SEED);
    // And one of another residue: 17, 23 and 302 are all 2 mod 3, so a reply
    // carrying `leaf % 3`, or a row holding it under the hash of the code,
    // agreed on all three (verifier mutants X1 and X7,
    // web-run/logs/verify-ISSUE-1-r1/mutants.log). 64 is 1 mod 3.
    const d = await world(64, RECIPIENT, BUYER_SEED);
    const other = await world(17, OTHER_RECIPIENT, OTHER_BUYER_SEED);
    // And one that moves only the network address the request comes from: a
    // row grouping replies under a hash of it, or holding it beside the reply,
    // agreed across every world above (verifier web-run r3 mutants W1 and W1b,
    // web-run/logs/verify-ISSUE-1-r3/mutants.log).
    const net = await world(17, RECIPIENT, BUYER_SEED, OTHER_ASKER_IP);

    // Anti-vacuity: the leaf worlds really are different worlds.
    expect(a.counters.map((r) => r.key)).not.toEqual(b.counters.map((r) => r.key));
    expect(a.counters.map((r) => r.key)).not.toEqual(c.counters.map((r) => r.key));
    expect(a.counters.map((r) => r.key)).not.toEqual(d.counters.map((r) => r.key));
    expect(openedCommitment(a.reply.body)).not.toBe(openedCommitment(b.reply.body));
    expect(openedCommitment(c.reply.body)).toBe(treasuryCommitmentAt(302));
    expect(openedCommitment(d.reply.body)).toBe(treasuryCommitmentAt(64));

    for (const moved of [b, c, d]) {
      expect(
        redact(JSON.stringify(a.reply.body), BUYER_SEED),
        'the reply moved with the leaf, so it names it',
      ).toBe(redact(JSON.stringify(moved.reply.body), BUYER_SEED));
      expect(a.rows, 'a stored row moved with the leaf, so it names it').toEqual(moved.rows);
      // Headers too: no case read one, so the leaf in a header passed every
      // body comparison above (verifier r3 mutant R3, ISSUE-1-r3-mutants.log).
      expect(moved.reply.headers, 'a reply header moved with the leaf, so it names it').toBe(
        a.reply.headers,
      );
    }
    expect(other.reply.headers, 'a reply header moved with the recipient, so it names them').toBe(
      a.reply.headers,
    );
    // WHOLE rows, not only their keys: a row whose key is neutral but whose
    // VALUE is a keyless function of the recipient (a hash of the address, a
    // 15-character piece) groups one buyer's notes in a dump just the same
    // (verifier mutants M2 and M12). The buyer's own ciphertext is already
    // redacted per seed, so a value that differs here is not the note.
    expect(other.rows, 'a stored row moved with the recipient, so it names them').toEqual(
      a.rows,
    );
    expect(other.counters, 'a counter moved with the recipient, so it names them').toEqual(
      a.counters,
    );
    expect(
      redact(JSON.stringify(other.reply.body), OTHER_BUYER_SEED),
      'the reply moved with the recipient, so it names them',
    ).toBe(redact(JSON.stringify(a.reply.body), BUYER_SEED));
    expect(net.rows, 'a stored row moved with the network address, so it names it').toEqual(a.rows);
    expect(net.counters, 'a counter moved with the network address, so it names it').toEqual(a.counters);
    expect(
      redact(JSON.stringify(net.reply.body), BUYER_SEED),
      'the reply moved with the network address, so it names it',
    ).toBe(redact(JSON.stringify(a.reply.body), BUYER_SEED));
    expect(net.reply.headers, 'a reply header moved with the network address').toBe(a.reply.headers);

    // The detector's own positive control, before it is believed: it must flag
    // a planted row and pass a counter holding a count (PROTOCOL.md, "the
    // detector has its own positive control").
    const planted = { key: issuedKeyOf(17), value: RECIPIENT, ttlSeconds: null };
    expect(namesTheRecipient(planted), 'the scan misses a recipient in plain sight').toBe(true);
    expect(namesTheRecipient({ ...planted, value: '1' })).toBe(false);

    // The address itself, and any 16-character piece of it, in EVERY row — the
    // counters included. They are exempt from the cross-world comparison above
    // because their KEY names the leaf; nothing exempts what they HOLD.
    for (const row of [...a.rows, ...a.counters]) {
      expect(namesTheRecipient(row), `${row.key} holds a piece of the recipient`).toBe(false);
    }
    for (const row of a.counters) {
      expect(row.value, `${row.key} holds more than a count`).toMatch(/^\d+$/);
    }

    // And the stored reply is exactly the reply, with nothing extra in it.
    const stored = a.rows.find((r) => r.key === sealedKeyOf('CODE-ONE-AAAAAAAA'));
    expect(stored, 'the reply was not stored').toBeDefined();
    expect(Object.keys(JSON.parse(stored!.value)).sort()).toEqual(
      REPLY_KEYS.filter((k) => k !== 'ok').sort(),
    );
    expect(Object.keys(a.reply.body).sort()).toEqual([...REPLY_KEYS].sort());
  });

  it('is the same length whichever note is sealed in it', async () => {
    // 🚨 THE REDACTION ABOVE HIDES THE BLOB, AND THE BLOB'S LENGTH WITH IT. The
    // note is JSON, so its byte count follows the digits of `leafIndex` and of
    // the commitment its deposit published, and the sealed blob carries that
    // count to a capture of the response, or to a copy of the stored reply,
    // with no key. Before the pad, the worlds below (then without leaf 64)
    // sealed to 2088, 2088, 2092 and 2088 characters (web-run/logs/
    // ISSUE-1-webfix1/sandbox-length/wp-logs/ISSUE-1-red.log).
    const worlds = [
      { ...(await world(17, RECIPIENT, BUYER_SEED)), leaf: 17, seed: BUYER_SEED },
      { ...(await world(23, RECIPIENT, BUYER_SEED)), leaf: 23, seed: BUYER_SEED },
      { ...(await world(302, RECIPIENT, BUYER_SEED)), leaf: 302, seed: BUYER_SEED },
      { ...(await world(64, RECIPIENT, BUYER_SEED)), leaf: 64, seed: BUYER_SEED },
      { ...(await world(17, OTHER_RECIPIENT, OTHER_BUYER_SEED)), leaf: 17, seed: OTHER_BUYER_SEED },
    ];
    const opened = worlds.map((w) => decryptNote(w.seed, String(w.reply.body.sealedNote)));
    const texts = opened.map((bytes) => new TextDecoder().decode(bytes));

    // Anti-vacuity: the notes themselves differ in length, so equal lengths
    // below can only come from the route and not from the leaves picked.
    const noteLengths = texts.map((text) => text.replace(/[\s\0]+$/, '').length);
    expect(new Set(noteLengths).size, `every note is ${noteLengths[0]} bytes`).toBeGreaterThan(1);

    const sealedLengths = worlds.map((w) => String(w.reply.body.sealedNote).length);
    expect(sealedLengths, 'the sealed blob is as long as the note in it').toEqual(
      sealedLengths.map(() => sealedLengths[0]),
    );
    const sealedBytes = opened.map((bytes) => bytes.length);
    expect(sealedBytes, 'what is sealed is as long as the note').toEqual(
      sealedBytes.map(() => sealedBytes[0]),
    );

    // ⛔ AND IT STILL OPENS AS EVERY CLIENT OPENS IT. However the length is
    // evened out, the note has to import unchanged: the web worker decodes the
    // bytes, parses them and runs `shareableNoteToReceipt` (poolHandlers.ts
    // `handlePoolImportNote`), the extension does the same, and the mobile
    // store sends the text through `btoa`/`atob` before `JSON.parse`
    // (apps/mobile/services/denominatedPool/index.ts `decodeShareableNote`).
    const parsed = (text: string): ShareableNote | null => {
      try {
        return JSON.parse(text) as ShareableNote;
      } catch {
        return null;
      }
    };
    worlds.forEach((w, i) => {
      const text = texts[i];
      const note = parsed(text);
      expect(note, 'the sealed note no longer parses as JSON').not.toBeNull();
      const web = shareableNoteToReceipt(note!);
      expect(web.commitment, 'the web import refused the note').toBe(treasuryCommitmentAt(w.leaf));
      expect(web.leafIndex).toBe(w.leaf);
      const mobile = parsed(atob(btoa(text)));
      expect(mobile, 'the mobile round trip no longer parses').not.toBeNull();
      expect(shareableNoteToReceipt(mobile!).commitment).toBe(web.commitment);
    });
  });
});

// ── 4 ────────────────────────────────────────────────────────────────────────

describe('the release rules around the one write that matters', () => {
  it('gives back the leaf AND the claim when the sealing fails', async () => {
    // Nothing was handed over, so nothing may stay consumed: the buyer can ask
    // again with the same code and the note goes back into stock.
    setTree([17]);
    mintClaim('CODE-ONE-AAAAAAAA', 17);
    h.sealThrows = true;

    const failed = await issueSwallowing('CODE-ONE-AAAAAAAA');

    expect(kv.has(issuedKeyOf(17)), 'the leaf stayed claimed after a failure').toBe(false);
    expect(kv.has(claimKeyOf('CODE-ONE-AAAAAAAA')), 'the paid claim stayed spent').toBe(false);
    expect(failed?.status).toBe(503);

    // ⛔ AND THE SAME CODE THEN WORKS. Absent keys alone cannot tell a claim
    // given back from one burned: a route that also swept the code's payment
    // trail on this path leaves both keys absent and answers this retry 402
    // "never issued against a payment" (verifier r3 mutant R10,
    // ISSUE-1-r3-mutants.log). The leaf came back too, so it is the note issued.
    h.sealThrows = false;
    const retried = await issue('CODE-ONE-AAAAAAAA');
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(openedCommitment(retried.body), 'the leaf was not given back').toBe(
      treasuryCommitmentAt(17),
    );
  });

  it('keeps the leaf but releases the code when the reply cannot be stored', async () => {
    // ⛔ THE ASYMMETRY IS THE POINT. Once the write has been ATTEMPTED the
    // store may hold a reply this request never read, so the leaf can never go
    // back into stock — two buyers holding one note is worse than one buyer
    // retrying. The code comes back, so the retry is free.
    setTree([17, 23, 29]);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    mintClaim('CODE-ONE-AAAAAAAA', 17);
    mintClaim('CODE-TWO-BBBBBBBB', 17);
    kv.failSetPrefix = 'p01:note:sealed:';

    const failed = await issueSwallowing('CODE-ONE-AAAAAAAA');
    expect(kv.has(claimKeyOf('CODE-ONE-AAAAAAAA')), 'the paid claim stayed spent').toBe(false);
    expect(failed?.status).toBe(503);
    expect(String(failed?.body.error)).toMatch(/retry with the same code/);
    // ⛔ AND THE REFUSAL HANDS NOTHING OVER. The store's error names the write
    // it failed on, value included (`upstashError`), and that value is the
    // sealed reply. A 503 that passed the error on carried the note it says
    // was not delivered, the note of the leaf kept below, and the retry then
    // handed over a second one: one paid code, two notes (verifier probe P1,
    // web-run/logs/verify-ISSUE-1-r1/probe-upstash.log).
    const failedText = JSON.stringify(failed?.body ?? {});
    expect(failedText, 'the 503 carries a sealed note').not.toContain('p01enc1:');
    expect(failedText, 'the 503 names a store key').not.toContain('p01:note:');

    const keptKeys = kv.rows().filter((r) => /^p01:note:issued:/.test(r.key)).map((r) => r.key);
    expect(keptKeys, 'exactly one leaf should be spoken for').toHaveLength(1);
    const keptLeaf = Number(/:(\d+)$/.exec(keptKeys[0])![1]);
    kv.failSetPrefix = null;

    // ⛔ THE RETRY THE 503 ASKS FOR: the SAME code. A route that swept the
    // code's payment trail before the write would answer this buyer 402 "never
    // issued against a payment" and burn a paid code (verifier mutant M1,
    // ISSUE-1-r1b-probe.log). A different code would not see that.
    const retried = await issue('CODE-ONE-AAAAAAAA');
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(
      openedCommitment(retried.body),
      'the kept leaf was handed out on the retry',
    ).not.toBe(treasuryCommitmentAt(keptLeaf));
    // What the buyer holds after doing what the 503 asked: exactly one note.
    const held = [failed, retried].flatMap((r) =>
      notesOpenedBy(BUYER_SEED, JSON.stringify(r?.body ?? {})),
    );
    expect(held, 'one paid code left the buyer holding more than one note').toHaveLength(1);

    // And the kept leaf is not handed to the next caller either.
    const next = await issue('CODE-TWO-BBBBBBBB');
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(
      openedCommitment(next.body),
      'the kept leaf was handed out a second time',
    ).not.toBe(treasuryCommitmentAt(keptLeaf));
    expect(openedCommitment(next.body), 'two codes were given one note').not.toBe(
      openedCommitment(retried.body),
    );
  });

  /** The commitments of every note the buyer can open across `replies`. */
  function notesHeld(replies: Array<Reply | null>): Set<string> {
    return new Set(
      replies
        .flatMap((r) => notesOpenedBy(BUYER_SEED, JSON.stringify(r?.body ?? {})))
        .map((blob) => openedCommitment({ sealedNote: blob }).toString()),
    );
  }
  const issuedKeys = () => kv.rows().filter((r) => /^p01:note:issued:/.test(r.key)).map((r) => r.key);
  const leafOf = (issuedKey: string) => Number(/:(\d+)$/.exec(issuedKey)![1]);

  it('gives one note for one code when the write landed but could not be read back, however the retries overlap', async () => {
    // 🚨 THE WRITE THAT LANDED WHILE THE ROUTE COULD NOT SEE IT. The store took
    // the reply, its answer was lost, and the read-back failed too. The route
    // cannot tell that from a write that never landed, so it gives the code
    // back and answers 503 "retry with the same code". The reply is in the store
    // all the same. A retry that sold again then handed over a second note, and
    // a retry overlapping it replayed the first: one paid code, two notes, two
    // leaves out of stock (verifier web-run r3 probe P-DOUBLE,
    // web-run/logs/verify-ISSUE-1-r3/probe-double.log).
    setTree([17, 23]);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    mintClaim('CODE-ONE-AAAAAAAA', 17);
    kv.landThenFailSetPrefix = 'p01:note:sealed:';
    kv.unreadableAfterWritePrefix = 'p01:note:sealed:';

    const failed = await issueSwallowing('CODE-ONE-AAAAAAAA');
    expect(failed?.status, JSON.stringify(failed?.body)).toBe(503);
    expect(String(failed?.body.error)).toMatch(/retry with the same code/);
    expect(kv.has(claimKeyOf('CODE-ONE-AAAAAAAA')), 'the code was not given back').toBe(false);
    // Anti-vacuity: the write DID land, which is the state this case is about.
    expect(kv.has(sealedKeyOf('CODE-ONE-AAAAAAAA')), 'the reply never reached the store').toBe(true);
    expect(issuedKeys(), 'the leaf went back after its write was attempted').toHaveLength(1);
    const landedLeaf = leafOf(issuedKeys()[0]);
    kv.heal();

    const [r2, r3] = await Promise.all([issue('CODE-ONE-AAAAAAAA'), issue('CODE-ONE-AAAAAAAA')]);
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r3.status, JSON.stringify(r3.body)).toBe(200);
    const held = notesHeld([failed, r2, r3]);
    expect(held.size, 'one paid code left the buyer holding more than one note').toBe(1);
    expect([...held][0], 'the note the store already held was not the one handed over').toBe(
      treasuryCommitmentAt(landedLeaf).toString(),
    );
    expect(issuedKeys(), 'a second leaf left stock for one code').toEqual([issuedKeyOf(landedLeaf)]);
    // It was a redemption, so the code stays spent and its payment trail goes.
    expect(kv.has(claimKeyOf('CODE-ONE-AAAAAAAA')), 'a delivered code was given back').toBe(true);
    expect(kv.has(mintedKeyOf('CODE-ONE-AAAAAAAA')), 'claim-minted survived redemption').toBe(false);
    const later = await issue('CODE-ONE-AAAAAAAA');
    expect(later.body.sealedNote, 'a later retry got another note').toBe(r2.body.sealedNote);
  });

  it('does not sell again while the reply an earlier attempt stored cannot be read', async () => {
    // The same landed write, and the store still cannot read it back when the
    // buyer retries. Selling then is the same double: the reply in the store is
    // a note already sealed to this buyer. So the retry is refused with the
    // code given back, and nothing leaves stock until the store answers.
    setTree([17, 23]);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    mintClaim('CODE-ONE-AAAAAAAA', 17);
    kv.landThenFailSetPrefix = 'p01:note:sealed:';
    kv.unreadableAfterWritePrefix = 'p01:note:sealed:';
    const failed = await issueSwallowing('CODE-ONE-AAAAAAAA');
    expect(failed?.status, JSON.stringify(failed?.body)).toBe(503);
    expect(kv.has(sealedKeyOf('CODE-ONE-AAAAAAAA')), 'the reply never reached the store').toBe(true);
    expect(issuedKeys(), 'the leaf went back after its write was attempted').toHaveLength(1);
    const landedLeaf = leafOf(issuedKeys()[0]);
    kv.landThenFailSetPrefix = null;

    const blind = await issue('CODE-ONE-AAAAAAAA');
    expect(blind.status, JSON.stringify(blind.body)).toBe(503);
    expect(String(blind.body.error)).toMatch(/retry with the same code/);
    expect(kv.has(claimKeyOf('CODE-ONE-AAAAAAAA')), 'the code was not given back').toBe(false);
    expect(issuedKeys(), 'a leaf left stock while the stored reply was unreadable').toEqual([
      issuedKeyOf(landedLeaf),
    ]);

    kv.heal();
    const retried = await issue('CODE-ONE-AAAAAAAA');
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    const held = notesHeld([failed, blind, retried]);
    expect([...held], 'one paid code, one note: the one the store held').toEqual([
      treasuryCommitmentAt(landedLeaf).toString(),
    ]);
  });

  it('gives the code back when the write did not land and could not be read back either', async () => {
    // The other half of the same doubt: a write that never landed, and a
    // read-back that failed. Nothing was delivered, so the code must work
    // again. Keeping it spent here passed every case (verifier web-run r3
    // mutant W2, web-run/logs/verify-ISSUE-1-r3/mutants.log): the buyer's
    // retry is then a 409 for good, and the payment is gone.
    setTree([17, 23]);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    mintClaim('CODE-ONE-AAAAAAAA', 17);
    kv.failSetPrefix = 'p01:note:sealed:';
    kv.unreadableAfterWritePrefix = 'p01:note:sealed:';

    const failed = await issueSwallowing('CODE-ONE-AAAAAAAA');
    expect(failed?.status, JSON.stringify(failed?.body)).toBe(503);
    expect(String(failed?.body.error)).toMatch(/retry with the same code/);
    // Anti-vacuity: the write did NOT land.
    expect(kv.has(sealedKeyOf('CODE-ONE-AAAAAAAA')), 'the reply reached the store').toBe(false);
    expect(kv.has(claimKeyOf('CODE-ONE-AAAAAAAA')), 'the paid claim stayed spent').toBe(false);
    expect(issuedKeys(), 'the leaf went back after its write was attempted').toHaveLength(1);
    const keptLeaf = leafOf(issuedKeys()[0]);
    kv.heal();

    const retried = await issue('CODE-ONE-AAAAAAAA');
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(openedCommitment(retried.body), 'the kept leaf was handed out').not.toBe(
      treasuryCommitmentAt(keptLeaf),
    );
    expect(notesHeld([failed, retried]).size, 'one paid code, one note').toBe(1);
  });

  it('answers 200 when the write landed and only its answer was lost', async () => {
    // The other half of the rule: after a failed write the route READS the
    // row back, and a reply that is there has been delivered — refusing it
    // would hand the buyer a 503 for a note the store already holds for them,
    // and a same-code retry would then be a replay of a note they were told
    // they did not get (verifier mutant M3, ISSUE-1-r1b-mutants.log).
    // Once per signature length a payment can have (see SIG_87).
    for (const sig of EVERY_SIG_LENGTH) {
      kv = new FakeKv();
      h.store = kv;
      h.deferred.length = 0;
      setTree([17]);
      mintClaim('CODE-ONE-AAAAAAAA', 17, mintedNow(sig));
      // The payment trail case 5 sweeps, set up here too: this path answers 200,
      // so it is a redemption and has to sweep like one (verifier mutant N4,
      // ISSUE-1-r2b-mutants.log, returned early here and skipped the sweep).
      await kv.set(notePaidCodeKey(sig), 'CODE-ONE-AAAAAAAA');
      await kv.set(relayPaymentContributionKey(sig), contributionBinding(POOL_KEY, 17));
      await kv.incr(notePaidKey(sig));
      kv.landThenFailSetPrefix = 'p01:note:sealed:';

      const one = await issueSwallowing('CODE-ONE-AAAAAAAA');

      expect(one?.status, JSON.stringify(one?.body)).toBe(200);
      const issuedKeys = kv.rows().filter((r) => /^p01:note:issued:/.test(r.key));
      expect(issuedKeys.map((r) => r.key)).toEqual([issuedKeyOf(17)]);
      expect(kv.has(claimKeyOf('CODE-ONE-AAAAAAAA')), 'a delivered claim was given back').toBe(true);
      const stored = kv.rows().find((r) => r.key === sealedKeyOf('CODE-ONE-AAAAAAAA'));
      expect(stored, 'the reply was not stored').toBeDefined();
      expect(JSON.parse(stored!.value).sealedNote).toBe(one?.body.sealedNote);
      expect(openedCommitment(one!.body)).toBe(treasuryCommitmentAt(17));

      // `issueSwallowing` has drained `after()`, so the sweep has run if it was queued.
      const len = `a ${sig.length}-character signature`;
      expect(kv.has(mintedKeyOf('CODE-ONE-AAAAAAAA')), `claim-minted survived redemption (${len})`).toBe(false);
      expect(kv.has(notePaidCodeKey(sig)), `paid:<sig>:code survived redemption (${len})`).toBe(false);
      expect(
        kv.has(relayPaymentContributionKey(sig)),
        `the relay binding survived redemption (${len})`,
      ).toBe(false);
      expect(kv.has(notePaidKey(sig)), `the payment gate was dropped (${len})`).toBe(true);
    }
  });
});

// ── 5 ────────────────────────────────────────────────────────────────────────

describe('the rows that name a code and a payment together', () => {
  /**
   * Redeem a code whose claim row holds `minted`, beside the payment trail a
   * sale leaves, in a store of its own.
   */
  async function redeemWithTrail(minted: string, sig = SIG): Promise<Reply> {
    kv = new FakeKv();
    h.store = kv;
    h.deferred.length = 0;
    setTree([17]);
    mintClaim('CODE-ONE-AAAAAAAA', 17, minted);
    await kv.set(notePaidCodeKey(sig), 'CODE-ONE-AAAAAAAA');
    await kv.set(relayPaymentContributionKey(sig), contributionBinding(POOL_KEY, 17));
    await kv.incr(notePaidKey(sig));
    return issue('CODE-ONE-AAAAAAAA');
  }

  /** `issue` has drained `after()`, so the sweep has run if it was queued. */
  function expectTheTrailGoneAndTheGatesKept(sig = SIG): void {
    const len = `a ${sig.length}-character signature`;
    expect(kv.has(mintedKeyOf('CODE-ONE-AAAAAAAA')), `claim-minted survived redemption (${len})`).toBe(false);
    expect(kv.has(notePaidCodeKey(sig)), `paid:<sig>:code survived redemption (${len})`).toBe(false);
    expect(
      kv.has(relayPaymentContributionKey(sig)),
      `the relay binding survived redemption (${len})`,
    ).toBe(false);
    expect(kv.has(notePaidKey(sig)), `the payment gate was dropped (${len})`).toBe(true);
    expect(kv.has(claimKeyOf('CODE-ONE-AAAAAAAA')), 'the spent claim was dropped').toBe(true);
  }

  it('are deleted at redemption, and the payment gate is kept', async () => {
    // 🚨 WHAT A DUMP JOINED. `claim-minted:<code>` holds `payment:<sig>`, and
    // the payment resolves publicly to the wallet that made it; `paid:<sig>:code`
    // and the relay's binding say the same thing from the other side. Once the
    // code has been redeemed none of those rows is read again; the gate that
    // stops one payment buying two notes is `p01:note:paid:<sig>`, and it stays.
    // Run on the shape the routes write TODAY (`MINTED_NOW`, checked against
    // their source below): a sweep that parsed only the pre-KV-1 shape passed
    // this case while it minted that shape (verifier r3 mutants R8 and R15).
    // And once per signature length a payment can have (see SIG_87).
    for (const sig of EVERY_SIG_LENGTH) {
      const one = await redeemWithTrail(mintedNow(sig), sig);
      expect(one.status, JSON.stringify(one.body)).toBe(200);
      expectTheTrailGoneAndTheGatesKept(sig);
    }
  });

  it('are deleted too for a claim minted before KV-1, in the shape it wrote then', async () => {
    // `contrib:<pool>:<leaf>:payment:<sig>` — a code, a funded leaf and a
    // payment in one row. Nothing writes it now, and a claim sold before the
    // deploy still holds it until it is redeemed.
    for (const sig of EVERY_SIG_LENGTH) {
      const one = await redeemWithTrail(mintedBeforeKv1(17, sig), sig);
      expect(one.status, JSON.stringify(one.body)).toBe(200);
      expectTheTrailGoneAndTheGatesKept(sig);
    }
  });

  it('leave only the gate behind for a code minted by hand, which names no payment', async () => {
    // `/api/mint-claim` stores a digest of the operator's reference. There is
    // no payment to sweep, and the code's own row still goes.
    setTree([17]);
    mintClaim('CODE-ONE-AAAAAAAA', 17, MINTED_BY_HAND);
    const one = await issue('CODE-ONE-AAAAAAAA');
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(kv.has(mintedKeyOf('CODE-ONE-AAAAAAAA')), 'claim-minted survived redemption').toBe(false);
    expect(kv.has(claimKeyOf('CODE-ONE-AAAAAAAA')), 'the spent claim was dropped').toBe(true);
  });

  it('are read in the shape every minting route writes', () => {
    // The sweep parses the payment out of the claim row, so the shapes minted
    // above must be the shapes the routes write. A new writer, or a writer
    // that moves to another shape, fails here instead of leaving a sweep that
    // silently misses it.
    const WEB = join(__dirname, '../../');
    const WRITE = /kv\.set\(\s*`p01:note:claim-minted:\$\{[^}]+\}`\s*,\s*([^;]*?)\s*\)\s*;/g;
    const writes: Array<{ file: string; value: string }> = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== 'node_modules') walk(path);
        } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const rel = path.slice(WEB.length).split('\\').join('/');
          for (const m of readFileSync(path, 'utf8').matchAll(WRITE)) {
            writes.push({ file: rel, value: m[1] });
          }
        }
      }
    };
    walk(join(WEB, 'app'));
    walk(join(WEB, 'lib'));

    expect(writes.map((w) => w.file).sort(), 'the writers of claim-minted changed').toEqual([
      'app/api/claim-for-payment/route.ts',
      'app/api/contribute-note/route.ts',
      'app/api/mint-claim/route.ts',
    ]);
    for (const { file, value } of writes) {
      if (file === 'app/api/mint-claim/route.ts') {
        expect(value, `${file} writes a shape case 5 does not mint`).toBe('mintedReference');
        expect(readFileSync(join(WEB, file), 'utf8')).toContain(
          "const mintedReference = createHash('sha256').update(reference).digest('hex').slice(0, 16);",
        );
        expect(MINTED_BY_HAND).toMatch(/^[0-9a-f]{16}$/);
      } else {
        expect(value.replace(/\$\{[^}]+\}/g, SIG), `${file} writes a shape case 5 does not mint`).toBe(
          `\`${MINTED_NOW}\``,
        );
      }
    }
  });
});

// ── 6 ────────────────────────────────────────────────────────────────────────

/**
 * WHAT THE OTHER SIDE OF THE WIRE STILL EXPECTS.
 *
 * Case 3 measures the reply this route SENDS. This one measures what the code
 * that reads it BELIEVES, because nothing else compares the two, and the gap
 * is invisible: the three `live*` files below are gated on `P01_LIVE_BUY`, so
 * every run of this repository skips them (baseline/BASELINE.md lists them
 * among the 15 skipped). One left asserting on a dropped field stays green
 * here and goes red on a devnet run that has already spent SOL. The two
 * fixtures are the opposite failure — a stub that answers with a field the
 * route does not send cannot detect the field coming back.
 *
 * Production clients are deliberately NOT scanned. `lib/privacy/shieldClient.ts`
 * (`body.leafIndex ?? imported.note.leafIndex`) and
 * `apps/mobile/services/privacy/deploymentApi.ts` read the leaf through a null
 * branch, which is how a client survives both shapes; a test that asserts
 * equality has no such branch.
 *
 * The red, on the unfixed callers, is wp-logs/ISSUE-1-red.log (fix round 1).
 */
describe('the callers of this route', () => {
  const WEB = join(__dirname, '../../');
  const SELF = '__tests__/api/issue-note.node.test.ts';

  /** Every TEST file under apps/web that drives this route over fetch. */
  const CONSUMERS = [
    'lib/privacy/pool/contributeFallback.test.ts',
    'lib/privacy/pool/exchangeNote.test.ts',
    'lib/privacy/pool/liveBuyIssuedNote.test.ts',
    'lib/privacy/pool/liveIssuedNoteSubscribeV4.test.ts',
    'lib/privacy/pool/liveNoteInExchange.test.ts',
  ];

  /** Fetches this route, or routes a stubbed fetch of it. */
  function drivesTheRoute(text: string): boolean {
    return (
      /fetch\(\s*[`'"][^`'"]*\/api\/issue-note/.test(text) ||
      /url === '\/api\/issue-note'/.test(text)
    );
  }

  function testFilesUnder(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(join(WEB, dir))) {
      const rel = `${dir}/${entry}`;
      if (statSync(join(WEB, rel)).isDirectory()) testFilesUnder(rel, out);
      else if (/\.test\.tsx?$/.test(entry)) out.push(rel);
    }
    return out;
  }

  /** `const <id> = await <res>.json()` right after a fetch of this route. */
  function replyVars(text: string): string[] {
    const out: string[] = [];
    const fetches = /fetch\(\s*[`'"][^`'"]*\/api\/issue-note/g;
    for (let m = fetches.exec(text); m !== null; m = fetches.exec(text)) {
      const parsed = /const (\w+) = await \w+\.json\(\)/.exec(text.slice(m.index, m.index + 900));
      if (parsed) out.push(parsed[1]);
    }
    return [...new Set(out)];
  }

  /** The keys a stubbed fetch answers a POST of this route with. */
  function stubbedKeys(text: string): string[] {
    const out: string[] = [];
    const at = /url === '\/api\/issue-note' && method === 'POST'/g;
    for (let m = at.exec(text); m !== null; m = at.exec(text)) {
      const call = text.indexOf('json(', m.index);
      const open = call < 0 ? -1 : text.indexOf('{', call);
      if (open < 0) continue;
      let depth = 0;
      let close = -1;
      for (let i = open; i < text.length && close < 0; i += 1) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') {
          depth -= 1;
          if (depth === 0) close = i;
        }
      }
      if (close < 0) continue;
      // Depth-aware, so a nested object's keys are not read as the body's, and
      // a key must follow `{`, `,` or whitespace — which is what keeps the
      // colon inside a string literal from being read as one.
      const object = text.slice(open, close + 1);
      let level = 0;
      for (let i = 0; i < object.length; i += 1) {
        const c = object[i];
        if (c === '{' || c === '[' || c === '(') level += 1;
        else if (c === '}' || c === ']' || c === ')') level -= 1;
        else if (level === 1 && /[{,\s]/.test(object[i - 1] ?? '')) {
          const key = /^([A-Za-z_$][\w$]*)\s*:/.exec(object.slice(i));
          if (key) {
            out.push(key[1]);
            i += key[0].length - 1;
          }
        }
      }
    }
    return out;
  }

  it('are a list nothing new can slip past', () => {
    const found = [...testFilesUnder('lib'), ...testFilesUnder('__tests__')]
      .filter((rel) => rel !== SELF)
      .filter((rel) => drivesTheRoute(readFileSync(join(WEB, rel), 'utf8')))
      .sort();
    expect(found, 'a test file drives /api/issue-note and is not in CONSUMERS').toEqual(
      [...CONSUMERS].sort(),
    );
  });

  it('are each still found by the scan, so a green here is not vacuous', () => {
    // Renaming the parsed reply, or the stub's router line, would silently
    // empty this case. Then it would pass on anything.
    const blind = CONSUMERS.filter((rel) => {
      const text = readFileSync(join(WEB, rel), 'utf8');
      return replyVars(text).length === 0 && stubbedKeys(text).length === 0;
    });
    expect(blind, 'the scan no longer finds the reply in these files').toEqual([]);
  });

  it('are not left expecting a field the reply no longer carries', () => {
    const allowed = new Set([...REPLY_KEYS, ...REPLY_EXTRAS]);
    const findings: string[] = [];
    for (const rel of CONSUMERS) {
      const text = readFileSync(join(WEB, rel), 'utf8');
      for (const name of replyVars(text)) {
        const reads = new RegExp(`\\b${name}\\.([A-Za-z_$][\\w$]*)`, 'g');
        for (let m = reads.exec(text); m !== null; m = reads.exec(text)) {
          if (!allowed.has(m[1])) findings.push(`${rel}: reads ${name}.${m[1]} off the reply`);
        }
      }
      for (const key of stubbedKeys(text)) {
        if (!allowed.has(key)) findings.push(`${rel}: stubs the reply with ${key}`);
      }
    }
    expect(findings, findings.join('\n')).toEqual([]);
  });
});
// ── 7 ────────────────────────────────────────────────────────────────────────

/**
 * WHAT THE BLOB CARRIES, AND WHY A ROOT INSIDE IT IS A DATE.
 *
 * The route used to replay the pool's insertions, build a Merkle path for the
 * note it was about to seal, and put the root it computed inside the blob. A
 * root is not a neutral optimisation: it is the tree as it stood at ONE moment,
 * so a spend that proves against it names that moment. `map-C-onchain-
 * observability.md` records a v4 withdrawal whose root was four insertions
 * behind the pool's, which dates the deposit of the note it spent; in v3 all
 * four stale roots were the root of the spent note's own deposit.
 *
 * A note that arrives WITHOUT a path is rebuilt against the pool's current
 * root instead — the root every other spender of that minute is using
 * (`worker/poolHandlers.ts`: `hasPath` decides, and a note with no path is
 * filed with `merklePath: 'none'`).
 *
 * ⛔ AND IT REACHES OLD CLIENTS. A browser holding a cached bundle from before
 * this change takes the same rebuild branch the moment the fields are absent,
 * so nothing has to be deployed to it for the root to stop travelling.
 *
 * The red, on the route as ISSUE-1 left it, is in wp-logs/ISSUE-2-red.log.
 */
describe('the sealed note', () => {
  /** The note the buyer's own seed opens, as the object they will import. */
  function openedNote(body: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(
      Buffer.from(decryptNote(BUYER_SEED, String(body.sealedNote))).toString('utf8'),
    ) as Record<string, unknown>;
  }

  /** Every field the blob may carry: the required fields of ShareableNote. */
  const NOTE_KEYS = [
    'commitment',
    'denominationHuman',
    'deposit_epoch',
    'leafIndex',
    'nullifier_preimage',
    'pool',
    'secret',
    'token',
    'token_mint',
    'version',
  ];

  /**
   * Each value is what the note itself is, and nothing else. The four secret
   * fields are pinned together: they must hash to the treasury commitment at
   * the leaf, so a value swapped for tree state breaks the commitment.
   */
  function expectNoteValues(note: Record<string, unknown>, leafIndex: number): void {
    const opening = createCommitmentV3(
      BigInt(String(note.nullifier_preimage)),
      BigInt(String(note.secret)),
      BigInt(String(note.deposit_epoch)),
      BigInt(String(note.token_mint)),
    );
    expect(opening, 'the secret fields do not open the leaf').toBe(treasuryCommitmentAt(leafIndex));
    expect(note.token_mint).toBe(pubkeyToField(POOL.tokenMint).toString());
    expect(note.commitment).toBe(treasuryCommitmentAt(leafIndex).toString());
    expect(note.leafIndex).toBe(leafIndex);
    expect(note.pool).toBe(POOL_KEY);
    expect(note.token).toBe('SOL');
    expect(note.denominationHuman).toBe(DENOM);
    expect(note.version).toBe(1);
  }

  it('carries no root and no path, so nothing in it dates the deposit', async () => {
    setTree([17]);
    mintClaim('CODE-ONE-AAAAAAAA', 17);

    const one = await issue('CODE-ONE-AAAAAAAA');
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    const note = openedNote(one.body);

    // Anti-vacuity, before anything is read off it: this really is the note the
    // buyer came for, and not an empty object that would satisfy any scan.
    expect(typeof note.secret, JSON.stringify(Object.keys(note))).toBe('string');
    expect(typeof note.nullifier_preimage).toBe('string');
    expect(openedCommitment(one.body)).toBe(treasuryCommitmentAt(17));

    // ⛔ AN EXACT ALLOWLIST, NOT A SPELLING LIST. A filter on /root|path|merkle/
    // passed a root carried under `anchor` and a tree size carried under
    // `treeSize` (fix round 1: wp-logs/verify/ISSUE-2-r1-mutants.log V5, and
    // ISSUE-2-r1-mutants-V13-14.log V13). So the key set is compared whole.
    // Pinning each value below is NOT enough on its own: in this world leaf 17
    // is also the top of the tree, so `leafIndex: max(leafIndex, top)` agreed
    // with every pin (fix round 2: wp-logs/verify/ISSUE-2-r2-mutants.log R2).
    // The taller world at the end of this case is what closes that.
    // `shieldedAt` is optional on ShareableNote and is a time, so it is
    // deliberately absent from the list.
    expect(Object.keys(note).sort(), 'the blob carries a field beyond the note itself').toEqual(
      NOTE_KEYS,
    );
    expectNoteValues(note, 17);
    expect(one.body.merklePath, 'the reply still advertises a path').toBe('none');

    // The stored copy is replayed byte for byte on a retry, so it has to say
    // the same thing — otherwise the root comes back on the second attempt.
    const stored = kv.rows().find((r) => r.key === sealedKeyOf('CODE-ONE-AAAAAAAA'));
    expect(stored, 'the reply was not stored').toBeDefined();
    const storedReply = JSON.parse(stored!.value) as Record<string, unknown>;
    expect(storedReply.merklePath).toBe('none');
    const storedNote = openedNote(storedReply);
    expect(Object.keys(storedNote).sort(), 'the stored blob carries a field beyond the note').toEqual(
      NOTE_KEYS,
    );
    expectNoteValues(storedNote, 17);

    // ⛔ THE SAME LEAF IN A TALLER TREE. Only the tree moves: a foreign deposit
    // at 40 lifts its top above the issued leaf. The note is a function of the
    // leaf alone, so the opened blob must be deep-equal to the one above; any
    // value that reads the tree (its top, its size, a root) moves here.
    kv = new FakeKv();
    h.store = kv;
    setTreeWithSlots([[17, ANCIENT_SLOT]], [0, 1, 2, 40]);
    mintClaim('CODE-TWO-BBBBBBBB', 17);
    const tall = await issue('CODE-TWO-BBBBBBBB');
    expect(tall.status, JSON.stringify(tall.body)).toBe(200);
    const tallNote = openedNote(tall.body);
    expectNoteValues(tallNote, 17);
    expect(tallNote, 'the blob moved with the height of the tree').toEqual(note);
  });
});

// ── 8 ────────────────────────────────────────────────────────────────────────

/**
 * A tree described leaf by leaf, including the slot each deposit landed at and
 * the "the insert carried no slot" case that `depositSlot: null` stands for.
 *
 * `foreign` are leaves this treasury cannot open, so an index can be occupied
 * on the tree without being ours — which is the case the missing-leaf rule has
 * to be told apart from.
 */
function setTreeWithSlots(
  treasury: Array<[leafIndex: number, depositSlot: number | null]>,
  foreign: number[] = [0, 1, 2],
): void {
  const tree = new Map<string, Commitment>();
  foreign.forEach((leafIndex, i) => {
    const commitment = 900_001n + BigInt(i) * 7919n;
    tree.set(commitment.toString(), { leafIndex, commitment, depositSlot: ANCIENT_SLOT });
  });
  for (const [leafIndex, depositSlot] of treasury) {
    const commitment = treasuryCommitmentAt(leafIndex);
    tree.set(commitment.toString(), { leafIndex, commitment, depositSlot });
  }
  h.tree = tree;
}

/**
 * A draw just under 1 makes Fisher-Yates swap every element with itself, so the
 * walk keeps the inventory's own order and "which leaf was examined first"
 * stops being a coin toss. The case that uses it asserts WHICH note came out,
 * so a shuffle that stopped obeying it would fail rather than pass quietly.
 */
const KEEPS_THE_ORDER = 0.999_999;

/** Every field the 502 "history incomplete" refusal may carry: counts, never an index. */
const HISTORY_REFUSAL_KEYS = [
  'configured',
  'error',
  'heldByOthers',
  'hint',
  'missingFromHistory',
  'notOurs',
  'ok',
  'spentLeaves',
  'tooYoung',
];

describe('a leaf the history read did not bring back', () => {
  it('is never claimed, so a short read cannot burn stock', async () => {
    // 🚨 map-A defect 4. `fetchPoolCommitments` walks a signature budget, so an
    // older deposit can be missing from the map while its index sits far below
    // the top of the tree. The route could not tell that from "somebody else's
    // deposit is at that index": it claimed the leaf, counted it as a mismatch,
    // and left the claim behind for ever — so every later request walked past a
    // note that was perfectly good. HIST-1 completes the walk; this is what has
    // to happen on the day it still comes back short.
    setTree([30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40]);
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '5');
    vi.spyOn(Math, 'random').mockReturnValue(KEEPS_THE_ORDER);
    mintClaim('CODE-ONE-AAAAAAAA', 5);

    const one = await issue('CODE-ONE-AAAAAAAA');

    expect(one.status, JSON.stringify(one.body)).toBe(200);
    // The configured leaf comes first in the inventory and the order is kept,
    // so leaf 5 WAS reached before the note that came out: the walk looked at
    // it and left it alone, rather than never getting to it.
    expect(openedCommitment(one.body), 'the walk did not keep the order').toBe(
      treasuryCommitmentAt(30),
    );
    expect(kv.has(issuedKeyOf(5)), 'the missing leaf was claimed, and stays claimed').toBe(false);
  });

  it('answers that the history is incomplete, instead of blaming the seed', async () => {
    // ⛔ 500 'the configured inventory does not match the chain' sends an
    // operator to check P01_TREASURY_POOL_SEED and the pool address for a read
    // that was merely short, and it says so to a buyer who has paid. The two
    // need opposite reactions and only one of them is a misconfiguration.
    setTreeWithSlots([], [0, 1, 2, 9]);
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '5');
    mintClaim('CODE-ONE-AAAAAAAA', 5);

    const one = await issue('CODE-ONE-AAAAAAAA');

    expect(one.status, JSON.stringify(one.body)).toBe(502);
    expect(String(one.body.error)).toMatch(/history/i);
    expect(kv.has(issuedKeyOf(5)), 'the missing leaf was claimed').toBe(false);
    expect(kv.has(claimKeyOf('CODE-ONE-AAAAAAAA')), 'the paid claim was kept').toBe(false);
    expect(Object.keys(one.body).sort(), 'the refusal carries a field beyond its counts').toEqual(
      HISTORY_REFUSAL_KEYS,
    );

    // ⛔ COUNTS ONLY, NEVER AN INDEX. A second world differs in exactly one
    // thing, WHICH configured leaf is missing (6 instead of 5), so a body that
    // names it, hashes it or counts from it moves (fix round 2:
    // wp-logs/verify/ISSUE-2-r2-mutants.log R3 put `firstMissing` in the body).
    kv = new FakeKv();
    h.store = kv;
    setTreeWithSlots([], [0, 1, 2, 9]);
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '6');
    mintClaim('CODE-ONE-AAAAAAAA', 6);
    const other = await issue('CODE-ONE-AAAAAAAA');
    expect(other.status, JSON.stringify(other.body)).toBe(502);
    expect(JSON.stringify(other.body), 'the refusal moved with the missing index').toBe(
      JSON.stringify(one.body),
    );
  });

  it('answers that the history is incomplete even when another configured leaf is somebody else\'s', async () => {
    // The case above has EVERY configured leaf missing, so a route that said
    // "incomplete" only in that case passed it (fix round 1:
    // wp-logs/verify/ISSUE-2-r1-mutants.log V4). One leaf missing beside one
    // foreign leaf is the shape a short read takes on a real list: the foreign
    // one is on the tree and is claimed, the missing one must not be, and the
    // answer still has to be about the history rather than the list.
    setTreeWithSlots([], [0, 1, 2, 9]);
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '5,9');
    mintClaim('CODE-ONE-AAAAAAAA', 5);

    const one = await issue('CODE-ONE-AAAAAAAA');

    expect(one.status, JSON.stringify(one.body)).toBe(502);
    expect(String(one.body.error)).toMatch(/history/i);
    expect(one.body.missingFromHistory).toBe(1);
    // Anti-vacuity: the foreign leaf WAS walked and claimed, so this is the
    // mixed case and not a second copy of the one above.
    expect(one.body.notOurs).toBe(1);
    expect(kv.has(issuedKeyOf(9)), 'the foreign leaf was never reached').toBe(true);
    expect(kv.has(issuedKeyOf(5)), 'the missing leaf was claimed').toBe(false);
    expect(kv.has(claimKeyOf('CODE-ONE-AAAAAAAA')), 'the paid claim was kept').toBe(false);
    expect(Object.keys(one.body).sort(), 'the refusal carries a field beyond its counts').toEqual(
      HISTORY_REFUSAL_KEYS,
    );
  });

  it('answers that the history is incomplete even beside a note that is only too young', async () => {
    // The 502 is said BEFORE the other exhaustions because, while the read is
    // short, their counts only cover what could be seen. Nothing pinned that
    // order: moving the 502 after the spent and too-young refusals left every
    // test green (fix round 2: wp-logs/verify/ISSUE-2-r2-mutants.log R8), and
    // such a route answers "wait for the stock to age" and hides the short read.
    vi.stubEnv('P01_TREASURY_NOTE_MIN_AGE_SLOTS', '100');
    setTreeWithSlots([[17, h.currentSlot - 99]], [0, 1, 2, 9]);
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '5');
    mintClaim('CODE-ONE-AAAAAAAA', 5);

    const one = await issue('CODE-ONE-AAAAAAAA');

    expect(one.status, JSON.stringify(one.body)).toBe(502);
    expect(String(one.body.error)).toMatch(/history/i);
    // Anti-vacuity: the young leaf WAS walked and refused for its age, so this
    // really is the case where the too-young answer was available.
    expect(one.body.tooYoung).toBe(1);
    expect(one.body.missingFromHistory).toBe(1);
    expect(kv.has(issuedKeyOf(17)), 'a young leaf was taken out of stock').toBe(false);
    expect(kv.has(claimKeyOf('CODE-ONE-AAAAAAAA')), 'the paid claim was kept').toBe(false);
  });

  it('answers that the history is incomplete even beside a note that is already spent', async () => {
    // The case above pins the 502 ahead of the too-young refusal only. Moving
    // it to just after the spent refusal left every test green (web run:
    // wp-logs/verify/ISSUE-2-r3-mutants.log R14), and so did a guard that gives
    // way to a spent leaf (web-run/logs/ISSUE-2-webfix1/ordering-pre-webfix1.log
    // G1). Such a route tells a paid buyer every note is spent while a good one
    // may sit at the index the read did not bring back.
    setTreeWithSlots([[17, ANCIENT_SLOT]], [0, 1, 2, 9]);
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '5');
    mintClaim('CODE-ONE-AAAAAAAA', 5);
    const spentPreimage = deriveNoteMaterial(SEED, POOL.poolPDA, 17).nullifierPreimage;
    vi.mocked(isNullifierSpentInSet).mockImplementation(
      (_set, _pda, nullifierPreimage) => nullifierPreimage === spentPreimage,
    );

    let one: Reply;
    try {
      one = await issue('CODE-ONE-AAAAAAAA');
    } finally {
      // `clearAllMocks` keeps an implementation, so the file's default goes back.
      vi.mocked(isNullifierSpentInSet).mockImplementation(() => false);
    }

    expect(one.status, JSON.stringify(one.body)).toBe(502);
    expect(String(one.body.error)).toMatch(/history/i);
    // Anti-vacuity: leaf 17 WAS walked and refused as spent, so this really is
    // the case where the spent answer was available.
    expect(one.body.spentLeaves).toBe(1);
    expect(one.body.missingFromHistory).toBe(1);
    expect(kv.has(issuedKeyOf(17)), 'a spent leaf was claimed').toBe(false);
    expect(kv.has(issuedKeyOf(5)), 'the missing leaf was claimed').toBe(false);
    expect(kv.has(claimKeyOf('CODE-ONE-AAAAAAAA')), 'the paid claim was kept').toBe(false);
    expect(Object.keys(one.body).sort(), 'the refusal carries a field beyond its counts').toEqual(
      HISTORY_REFUSAL_KEYS,
    );
  });

  it('answers that the history is incomplete even beside a note that is already held', async () => {
    // Same order, beside the "already issued" answer: a guard that gives way to a
    // held leaf left every test green (web-run/logs/ISSUE-2-webfix1/
    // ordering-pre-webfix1.log G4). Such a route answers "every note in stock
    // is already issued" while a free one may sit at the missing index.
    setTreeWithSlots([[17, ANCIENT_SLOT]], [0, 1, 2, 9]);
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '5');
    kv.scalars.set(issuedKeyOf(17), { v: 1, ttl: null });
    mintClaim('CODE-ONE-AAAAAAAA', 5);

    const one = await issue('CODE-ONE-AAAAAAAA');

    expect(one.status, JSON.stringify(one.body)).toBe(502);
    expect(String(one.body.error)).toMatch(/history/i);
    // Anti-vacuity: leaf 17 WAS walked and found held, so this really is the
    // case where the held answer was available.
    expect(one.body.heldByOthers).toBe(1);
    expect(one.body.missingFromHistory).toBe(1);
    expect(kv.has(issuedKeyOf(5)), 'the missing leaf was claimed').toBe(false);
    expect(kv.has(claimKeyOf('CODE-ONE-AAAAAAAA')), 'the paid claim was kept').toBe(false);
    expect(Object.keys(one.body).sort(), 'the refusal carries a field beyond its counts').toEqual(
      HISTORY_REFUSAL_KEYS,
    );
  });

  it('answers that the history is incomplete even beside a leaf not deposited yet', async () => {
    // The "empty" answer is the one exhaustion the cases above never put beside
    // a missing leaf: a guard that gives way to a configured leaf past the top
    // of the tree left every test green (web-run/logs/ISSUE-2-webfix1/resume/
    // ordering-pre-resume.log G5). Such a route answers "the note inventory is
    // empty, deposit more" for a read that came back short, which is the loud
    // failure turned quiet that the gate beside `maxLeafOnTree` exists to stop.
    setTreeWithSlots([], [0, 1, 2, 9]);
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '5,40');
    mintClaim('CODE-ONE-AAAAAAAA', 5);

    const one = await issue('CODE-ONE-AAAAAAAA');

    expect(one.status, JSON.stringify(one.body)).toBe(502);
    expect(String(one.body.error)).toMatch(/history/i);
    // Leaf 40 is in the inventory and was skipped as future stock, not as any
    // of the other exhaustions: every other count is 0.
    expect(one.body.configured).toBe(2);
    expect(one.body.missingFromHistory).toBe(1);
    expect(
      [one.body.spentLeaves, one.body.tooYoung, one.body.heldByOthers, one.body.notOurs],
      'another exhaustion was counted, so this is not the "empty" case',
    ).toEqual([0, 0, 0, 0]);
    expect(kv.has(issuedKeyOf(40)), 'a leaf not deposited yet was claimed').toBe(false);
    expect(kv.has(issuedKeyOf(5)), 'the missing leaf was claimed').toBe(false);
    expect(kv.has(claimKeyOf('CODE-ONE-AAAAAAAA')), 'the paid claim was kept').toBe(false);
    expect(Object.keys(one.body).sort(), 'the refusal carries a field beyond its counts').toEqual(
      HISTORY_REFUSAL_KEYS,
    );

    // Anti-vacuity: the same tree with only the leaf past the top answers
    // "empty", so that answer really was the one the 502 has to win against.
    kv = new FakeKv();
    h.store = kv;
    setTreeWithSlots([], [0, 1, 2, 9]);
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '40');
    mintClaim('CODE-ONE-AAAAAAAA', 40);
    const control = await issue('CODE-ONE-AAAAAAAA');
    expect(control.status, JSON.stringify(control.body)).toBe(503);
    expect(String(control.body.error)).toMatch(/inventory is empty/);
    expect(kv.has(issuedKeyOf(40)), 'a leaf not deposited yet was claimed').toBe(false);
  });

  it('is never claimed when it was ACQUIRED rather than configured', async () => {
    // Every case above names the missing leaf in P01_TREASURY_NOTE_LEAVES. The
    // refill path writes the acquired set instead (`recordInventoryLeaf`,
    // `p01:note:inventory:<pool>`), and a gate limited to configured leaves
    // left every test green (web-run/logs/verify-ISSUE-2-r1-mutants.log V5).
    // Such a route claims an acquired leaf a short read left out, keeps it
    // claimed for ever and answers 500 'does not match the chain': map-A
    // defect 4 again, on the stock that refills.
    setTreeWithSlots([], [0, 1, 2, 9]);
    kv.sets.set(`p01:note:inventory:${POOL_KEY}`, new Set(['5']));
    mintClaim('CODE-ONE-AAAAAAAA', 5);

    const one = await issue('CODE-ONE-AAAAAAAA');

    expect(one.status, JSON.stringify(one.body)).toBe(502);
    expect(String(one.body.error)).toMatch(/history/i);
    // Anti-vacuity: nothing is configured (beforeEach) and the tree holds no
    // treasury leaf, so the one leaf in stock came from the acquired set, and
    // it is the one counted missing.
    expect(one.body.configured).toBe(1);
    expect(one.body.missingFromHistory).toBe(1);
    expect(kv.has(issuedKeyOf(5)), 'the missing acquired leaf was claimed').toBe(false);
    expect(kv.has(claimKeyOf('CODE-ONE-AAAAAAAA')), 'the paid claim was kept').toBe(false);
    expect(Object.keys(one.body).sort(), 'the refusal carries a field beyond its counts').toEqual(
      HISTORY_REFUSAL_KEYS,
    );
  });
});

// ── 9 ────────────────────────────────────────────────────────────────────────

describe('an inventory larger than the walk', () => {
  it('issues a candidate past the 512th, because the cap comes after the gates', async () => {
    // 🚨 map-A defect 5. The union was cut to 512 BEFORE any gate ran, and the
    // leaves DISCOVERED on the tree were last in that union — so the cut fell
    // on exactly the stock a growing deployment depends on. A buyer was then
    // told 'the notes in stock are too recently deposited' while a mature note
    // sat at index 599, unexamined.
    const YOUNG = h.currentSlot - 1;
    const entries: Array<[number, number | null]> = [];
    for (let leafIndex = 0; leafIndex < 600; leafIndex += 1) {
      entries.push([leafIndex, leafIndex === 599 ? ANCIENT_SLOT : YOUNG]);
    }
    setTreeWithSlots(entries, []);
    mintClaim('CODE-ONE-AAAAAAAA', 599);

    const one = await issue('CODE-ONE-AAAAAAAA');

    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(openedCommitment(one.body), 'a different note came out').toBe(
      treasuryCommitmentAt(599),
    );

    // Anti-vacuity, and the arithmetic this case rests on: the same inventory
    // with NOTHING mature in it reports all 600 candidates as too young. A
    // route that still cut the union before the gates would report 512, so the
    // 600 here is what shows the gates really saw every candidate.
    kv = new FakeKv();
    h.store = kv;
    setTreeWithSlots(
      entries.map(([leafIndex]) => [leafIndex, YOUNG] as [number, number | null]),
      [],
    );
    mintClaim('CODE-TWO-BBBBBBBB', 599);
    const none = await issue('CODE-TWO-BBBBBBBB');

    expect(none.status, JSON.stringify(none.body)).toBe(503);
    expect(none.body.configured, 'the union was cut before the gates').toBe(600);
    expect(none.body.tooYoung).toBe(600);
  }, 30_000);

  // ⛔ ONE CASE PER PURE GATE. The case above drives the maturity gate only.
  // Moving `claimAttempts += 1` above the spent gate, or counting a missing or
  // a not-deposited-yet candidate, left every test green (web-run/logs/
  // verify-ISSUE-2-r1-mutants.log V1, verify-ISSUE-2-r1-mutants-2.log V13 and
  // V14). Each case below puts 599 candidates that one gate skips ahead of one
  // free leaf and keeps the inventory's own order, so the free leaf is the
  // 600th candidate examined: a cap that counted the skipped ones stops at 512
  // and refuses with stock left.
  const issuedRows = () =>
    kv.rows().filter((r) => new RegExp(`^p01:note:issued:${POOL_KEY}:\\d+$`).test(r.key));

  it('issues a free note behind 599 spent ones, because a spent candidate is not a claim', async () => {
    // The likeliest production shape of map-A defect 5: a commitment stays on
    // the tree after its note is spent, so every note sold and later spent is
    // still discovered, and spent leaves come to dominate the union.
    const entries: Array<[number, number | null]> = [];
    for (let leafIndex = 0; leafIndex < 600; leafIndex += 1) entries.push([leafIndex, ANCIENT_SLOT]);
    setTreeWithSlots(entries, []);
    vi.spyOn(Math, 'random').mockReturnValue(KEEPS_THE_ORDER);
    mintClaim('CODE-ONE-AAAAAAAA', 0);
    const free = deriveNoteMaterial(SEED, POOL.poolPDA, 599).nullifierPreimage;
    vi.mocked(isNullifierSpentInSet).mockImplementation(
      (_set, _pda, nullifierPreimage) => nullifierPreimage !== free,
    );

    let one: Reply;
    let spentChecks: number;
    try {
      one = await issue('CODE-ONE-AAAAAAAA');
      spentChecks = vi.mocked(isNullifierSpentInSet).mock.calls.length;
    } finally {
      // `clearAllMocks` keeps an implementation, so the file's default goes back.
      vi.mocked(isNullifierSpentInSet).mockImplementation(() => false);
    }

    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(openedCommitment(one.body), 'a different note came out').toBe(
      treasuryCommitmentAt(599),
    );
    // Anti-vacuity: all 599 spent candidates were checked before the free one,
    // so it really was the 600th candidate, past the 512th.
    expect(spentChecks, 'the free leaf was not the 600th candidate examined').toBe(600);
    expect(issuedRows().length, 'more than one leaf left stock').toBe(1);

    // Control: the same stock with the free leaf spent too refuses as spent,
    // and counts every one of the 600 rather than stopping at 512.
    kv = new FakeKv();
    h.store = kv;
    mintClaim('CODE-TWO-BBBBBBBB', 0);
    vi.mocked(isNullifierSpentInSet).mockImplementation(() => true);
    let none: Reply;
    try {
      none = await issue('CODE-TWO-BBBBBBBB');
    } finally {
      vi.mocked(isNullifierSpentInSet).mockImplementation(() => false);
    }
    expect(none.status, JSON.stringify(none.body)).toBe(503);
    expect(String(none.body.error)).toMatch(/already been spent/);
    expect(none.body.spentLeaves, 'the walk stopped counting at the cap').toBe(600);
  }, 30_000);

  it('issues a free note behind 599 leaves the history read did not bring back, because a missing candidate is not a claim', async () => {
    // A short read leaves out stock the refill path acquired
    // (`p01:note:inventory:<pool>`): each of those indices sits below the top
    // of the tree and is absent from the map. The free leaf is discovered on
    // the tree, so it comes after all of them in the union.
    const MISSING = Array.from({ length: 599 }, (_, i) => i);
    const FREE = 700;
    setTreeWithSlots([[FREE, ANCIENT_SLOT]], []);
    kv.sets.set(`p01:note:inventory:${POOL_KEY}`, new Set(MISSING.map(String)));
    vi.spyOn(Math, 'random').mockReturnValue(KEEPS_THE_ORDER);
    mintClaim('CODE-ONE-AAAAAAAA', FREE);

    const one = await issue('CODE-ONE-AAAAAAAA');

    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(openedCommitment(one.body), 'a different note came out').toBe(
      treasuryCommitmentAt(FREE),
    );
    // The free leaf is the only candidate that reached the spent check: the
    // 599 were stopped by the pure gate before it, and none of them was claimed.
    expect(vi.mocked(isNullifierSpentInSet).mock.calls.length).toBe(1);
    expect(issuedRows().length, 'a missing leaf left stock').toBe(1);

    // Anti-vacuity: the same tree with somebody else's deposit at the free
    // index refuses as a short read and counts all 599 as missing, so they
    // really were skipped by the missing gate, and past the cap's 512.
    kv = new FakeKv();
    h.store = kv;
    setTreeWithSlots([], [FREE]);
    kv.sets.set(`p01:note:inventory:${POOL_KEY}`, new Set(MISSING.map(String)));
    mintClaim('CODE-TWO-BBBBBBBB', FREE);
    const none = await issue('CODE-TWO-BBBBBBBB');
    expect(none.status, JSON.stringify(none.body)).toBe(502);
    expect(String(none.body.error)).toMatch(/history/i);
    expect(none.body.configured).toBe(599);
    expect(none.body.missingFromHistory, 'the walk stopped counting at the cap').toBe(599);
  }, 30_000);

  it('issues a free note behind 599 leaves not deposited yet, because future stock is not a claim', async () => {
    // Acquired indices past the top of the tree read as future stock; a
    // history read that stops short of the newest deposits puts them there.
    const FUTURE = Array.from({ length: 599 }, (_, i) => 1_000 + i);
    const FREE = 17;
    setTreeWithSlots([[FREE, ANCIENT_SLOT]]);
    kv.sets.set(`p01:note:inventory:${POOL_KEY}`, new Set(FUTURE.map(String)));
    vi.spyOn(Math, 'random').mockReturnValue(KEEPS_THE_ORDER);
    mintClaim('CODE-ONE-AAAAAAAA', FREE);

    const one = await issue('CODE-ONE-AAAAAAAA');

    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(openedCommitment(one.body), 'a different note came out').toBe(
      treasuryCommitmentAt(FREE),
    );
    expect(vi.mocked(isNullifierSpentInSet).mock.calls.length).toBe(1);
    expect(issuedRows().length, 'a leaf not deposited yet left stock').toBe(1);

    // Anti-vacuity: the same tree with somebody else's deposit at the free
    // index holds nothing but future stock and answers "empty", not a short
    // read, so the 599 really were skipped as not deposited yet.
    kv = new FakeKv();
    h.store = kv;
    setTreeWithSlots([], [0, 1, 2, FREE]);
    kv.sets.set(`p01:note:inventory:${POOL_KEY}`, new Set(FUTURE.map(String)));
    mintClaim('CODE-TWO-BBBBBBBB', FREE);
    const none = await issue('CODE-TWO-BBBBBBBB');
    expect(none.status, JSON.stringify(none.body)).toBe(503);
    expect(String(none.body.error)).toMatch(/inventory is empty/);
    expect(none.body.configured).toBe(599);
    expect(none.body.notOurs).toBe(0);
  }, 30_000);

  it('stops at the first note it can issue, so a sale does not pay for the whole stock', async () => {
    // ⚠️ LATENCY, PINNED. Gating the whole union before claiming anything made
    // every sale run the spent check (a real PDA derivation, about 0.2 ms each)
    // on every mature candidate: a happy-path POST at a union of 2,048 took
    // 1,239.6 ms median with 2,048 spent checks, and 207.5 ms with 1 once the
    // walk was lazy again (fix round 1: wp-logs/ISSUE-2-fix1/
    // bench-before-fix1.log, bench-after-fix1.log; real PDA derivation, node).
    //
    // The spent check is stubbed in this file, so wall time cannot see this;
    // the NUMBER of spent checks can, and it is what grows with the stock.
    const entries: Array<[number, number | null]> = [];
    for (let leafIndex = 0; leafIndex < 600; leafIndex += 1) entries.push([leafIndex, ANCIENT_SLOT]);
    setTreeWithSlots(entries, []);
    mintClaim('CODE-ONE-AAAAAAAA', 0);

    const one = await issue('CODE-ONE-AAAAAAAA');

    expect(one.status, JSON.stringify(one.body)).toBe(200);
    // Anti-vacuity: the stub IS the one the route calls, so a zero here would
    // mean the gate went missing, not that the walk got cheaper.
    expect(
      vi.mocked(isNullifierSpentInSet).mock.calls.length,
      'the sale ran the spent check on candidates it never needed',
    ).toBe(1);
    const claimed = kv.rows().filter((r) => new RegExp(`^p01:note:issued:${POOL_KEY}:\\d+$`).test(r.key));
    expect(claimed.length, 'more than one leaf left stock').toBe(1);
  }, 30_000);

  it('still stops after 512 claims, when every candidate is already held', async () => {
    // A PIN, not a fix: the cap bounds the store round trips a refusal can
    // cost, and it passes on the route before and after fix round 1. Its
    // control is the cap mutated away or off by one (wp-logs/ISSUE-2-fix1/
    // mutants-fix1.log F4, F5), which reads 600 and 511 here.
    const entries: Array<[number, number | null]> = [];
    for (let leafIndex = 0; leafIndex < 600; leafIndex += 1) entries.push([leafIndex, ANCIENT_SLOT]);
    setTreeWithSlots(entries, []);
    for (let leafIndex = 0; leafIndex < 600; leafIndex += 1) {
      kv.scalars.set(issuedKeyOf(leafIndex), { v: 1, ttl: null });
    }
    mintClaim('CODE-ONE-AAAAAAAA', 0);

    const one = await issue('CODE-ONE-AAAAAAAA');

    expect(one.status, JSON.stringify(one.body)).toBe(503);
    expect(String(one.body.error)).toMatch(/already issued/);
    expect(one.body.configured).toBe(600);
    expect(one.body.heldByOthers, 'the walk did not stop at the cap').toBe(512);
  }, 30_000);
});

// ── 10 ───────────────────────────────────────────────────────────────────────

/**
 * THE GATE THAT DECIDES A NOTE IS OLD ENOUGH TO HAND OVER, PINNED.
 *
 * ⚠️ This is a PIN, not a fix: it passes on the route as ISSUE-2 found it and
 * on the route ISSUE-2 leaves, so it is declared in neither red block. What it
 * buys is that the rule cannot be loosened silently — and the rule is the one
 * the whole endpoint rests on (`DEFAULT_MIN_AGE_SLOTS`: a note deposited
 * moments before it is handed over carries the clock of whoever bought it, and
 * no crowd dilutes a one-second window).
 *
 * Its positive control is the second case: the SAME too-young leaf, with the
 * threshold set to 0, is issued. Without that, a harness that refused for some
 * other reason would read exactly like a working gate.
 */
describe('the maturity gate', () => {
  const MIN = 100;

  it('refuses a leaf one slot short, issues it at the threshold, refuses an unknown slot', async () => {
    vi.stubEnv('P01_TREASURY_NOTE_MIN_AGE_SLOTS', String(MIN));

    // One slot short of the threshold.
    setTreeWithSlots([[17, h.currentSlot - (MIN - 1)]]);
    mintClaim('CODE-ONE-AAAAAAAA', 17);
    const young = await issue('CODE-ONE-AAAAAAAA');
    expect(young.status, JSON.stringify(young.body)).toBe(503);
    expect(String(young.body.error)).toMatch(/too recently deposited/);
    expect(young.body.tooYoung).toBe(1);
    expect(young.body.waitSlots, 'the wait was not reported in slots').toBe(1);
    // A leaf skipped for being young is alive and will be good in minutes, so
    // it must not be taken out of stock, and the claim must come back.
    expect(kv.has(issuedKeyOf(17)), 'a young leaf was taken out of stock').toBe(false);
    expect(kv.has(claimKeyOf('CODE-ONE-AAAAAAAA')), 'the paid claim was kept').toBe(false);

    // Exactly at the threshold.
    kv = new FakeKv();
    h.store = kv;
    setTreeWithSlots([[17, h.currentSlot - MIN]]);
    mintClaim('CODE-TWO-BBBBBBBB', 17);
    const ripe = await issue('CODE-TWO-BBBBBBBB');
    expect(ripe.status, JSON.stringify(ripe.body)).toBe(200);
    expect(openedCommitment(ripe.body)).toBe(treasuryCommitmentAt(17));

    // ⛔ An insert that carried no slot is TOO YOUNG, not old enough. "We could
    // not tell how old it is" must not resolve to "old enough", and the reply
    // must not invent a wait for it either.
    kv = new FakeKv();
    h.store = kv;
    setTreeWithSlots([[17, null]]);
    mintClaim('CODE-THREE-CCCCCC', 17);
    const unknown = await issue('CODE-THREE-CCCCCC');
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(503);
    expect(String(unknown.body.error)).toMatch(/too recently deposited/);
    expect(unknown.body.tooYoung).toBe(1);
    expect(unknown.body.waitSlots, 'an unknown slot was reported as a wait').toBeNull();
  });

  it('is what refuses them: the same leaf, at a threshold of 0, is issued', async () => {
    // The positive control for the case above. `minAgeSlots()` reads 0 only
    // from an explicit '0' — a malformed value falls back to the default, which
    // is the direction that cannot quietly turn the rule off.
    vi.stubEnv('P01_TREASURY_NOTE_MIN_AGE_SLOTS', '0');
    setTreeWithSlots([[17, h.currentSlot - (MIN - 1)]]);
    mintClaim('CODE-ONE-AAAAAAAA', 17);

    const one = await issue('CODE-ONE-AAAAAAAA');

    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(openedCommitment(one.body)).toBe(treasuryCommitmentAt(17));
  });
});

// ── 11 ───────────────────────────────────────────────────────────────────────

/**
 * EVERY ANSWER, REFUSALS INCLUDED, READ BY WHAT MOVES.
 *
 * Case 3 reads the sale. The refusals were read one at a time, where a case
 * happened to look: the 409 for a consumed code carried the asker's address and
 * nothing noticed (verifier r3 mutant R6), and no case read a header at all
 * (R3). So each state the route answers from is run in six worlds: the base
 * (leaf 17, RECIPIENT asking), three other leaves (302, 64 and 3), another
 * asker, and another buyer served in the same tick. Status, body and headers
 * must be the same in all of them, so any function of the leaf, of the asker
 * or of the other buyer moves, in whatever encoding. The one exemption is the
 * note itself, the ciphertext the asker's own seed opens, as in case 3; its
 * length is pinned there ("is the same length whichever note is sealed in it").
 *
 * 🚨 AND EVERY CALL THE ROUTE MAKES TO THE STORE OR THE CHAIN FAILS IN ITS OWN
 * STATE, WITH A TEXT THAT NAMES WHAT IT WAS ASKED. The store fails as the
 * production client does (`upstashError`); the chain fails naming the leaf's
 * commitment and the provider URL. A route that passes that text on hands out
 * a sealed note, a leaf's key or another buyer's claim code (verifier probe
 * P1-P3, web-run/logs/verify-ISSUE-1-r1/probe-upstash.log). The redaction
 * cannot see that alone: the sealed reply a failed write names is the asker's
 * own, so it redacts to the same text in every world. So each answer is also
 * read for what no answer may carry at all, and a refusal for any note.
 */
describe('every answer this route gives', () => {
  interface World {
    leaf: number;
    asker: string;
    seed: typeof BUYER_SEED;
    /** The claim code of another buyer whose commands share a request with this one's. */
    neighbour: string;
    /** The network address the request comes from. */
    ip: string;
  }
  const BASE: World = {
    leaf: 17,
    asker: RECIPIENT,
    seed: BUYER_SEED,
    neighbour: 'CODE-NEXT-11111111',
    ip: ASKER_IP,
  };
  const WORLDS: World[] = [
    BASE,
    // The network address is a world of its own: a row or an answer that
    // carried it, or grouped replies by a hash of it, agreed across every
    // other world (verifier web-run r3 mutants W1 and W1b).
    { ...BASE, ip: OTHER_ASKER_IP },
    { ...BASE, leaf: 302 },
    // 17 and 302 are both 2 mod 3, so a function of `leaf % 3` agreed on them
    // (verifier mutants X1 and X7, web-run/logs/verify-ISSUE-1-r1/mutants.log).
    // 64 is 1 mod 3; 3 is 0 mod 3, and one digit long.
    { ...BASE, leaf: 64 },
    { ...BASE, leaf: 3 },
    { ...BASE, asker: OTHER_RECIPIENT, seed: OTHER_BUYER_SEED },
    // @vercel/kv batches the commands of concurrent requests into one, and a
    // failure names them all (P3). Only the other buyer moves here.
    { ...BASE, neighbour: 'CODE-NEXT-22222222' },
  ];
  const REFUSAL_KEYS = ['error', 'hint', 'ok'];
  /** A refusal with no hint: the store or the chain failed, and a retry is the whole answer. */
  const BARE_REFUSAL_KEYS = ['error', 'ok'];
  const ONE = 'CODE-ONE-AAAAAAAA';
  const GUESS = 'CODE-GUESS-GGGGGG';
  /** Stands in for a provider URL with its key; not a credential. */
  const RPC_URL = 'https://rpc.test.invalid/?api-key=TEST-ONLY-NOT-A-KEY';
  /**
   * What no answer may carry: the store's own wording, a store key, the
   * provider URL, a note address, another buyer's code.
   */
  const NEVER_IN_AN_ANSWER = [
    'command was',
    'p01:note:',
    'api-key=',
    'rpc.test.invalid',
    'p01pq:',
    'CODE-NEXT-',
    ASKER_IP,
    OTHER_ASKER_IP,
  ];

  /**
   * A chain read that failed, worded as web3.js words one ("failed to get info
   * about account <pubkey>", @solana/web3.js lib/index.cjs.js:6348) and as
   * node-fetch words a transport failure ("request to <url> failed",
   * node-fetch/lib/index.js:1501). Measured on Node 26, web3.js 1.98.4 uses
   * the global fetch, which says only "fetch failed"
   * (web-run/logs/ISSUE-1-webfix2/probe-rpc-node-build.log); the rule here
   * does not depend on which one a deployment gets.
   */
  const rpcError = (w: World) => () =>
    new Error(
      `failed to get info about account ${treasuryCommitmentAt(w.leaf)}: request to ${RPC_URL} failed`,
    );
  /** Make the store calls `op` on a key starting with `prefix` fail, for this world. */
  const failing = (op: 'get' | 'set' | 'incr', prefix: string) => {
    kv.failWhen = (o, key) => o === op && key.startsWith(prefix);
  };

  interface State {
    name: string;
    status: number;
    /** The exact key set of the body, where the state has one to pin. */
    keys?: string[];
    run: (w: World) => Promise<Reply>;
  }
  const STATES: State[] = [
    {
      name: 'a sale',
      status: 200,
      keys: REPLY_KEYS,
      run: async (w) => {
        setTree([w.leaf]);
        mintClaim(ONE, w.leaf);
        return issue(ONE, { recipientAddress: w.asker });
      },
    },
    {
      name: 'the replay of a sale',
      status: 200,
      keys: [...REPLY_KEYS, 'replayed'],
      run: async (w) => {
        setTree([w.leaf]);
        mintClaim(ONE, w.leaf);
        await issue(ONE, { recipientAddress: w.asker });
        return issue(ONE, { recipientAddress: w.asker });
      },
    },
    {
      name: 'a sale whose stored reply was written but not acknowledged',
      status: 200,
      keys: REPLY_KEYS,
      run: async (w) => {
        setTree([w.leaf]);
        mintClaim(ONE, w.leaf);
        kv.landThenFailSetPrefix = 'p01:note:sealed:';
        return issue(ONE, { recipientAddress: w.asker });
      },
    },
    {
      name: 'a code that was never minted',
      status: 402,
      keys: REFUSAL_KEYS,
      run: async (w) => {
        setTree([w.leaf]);
        return issue(GUESS, { recipientAddress: w.asker });
      },
    },
    {
      name: 'a consumed code with no stored reply',
      status: 409,
      keys: REFUSAL_KEYS,
      run: async (w) => {
        setTree([w.leaf]);
        await issue(GUESS, { recipientAddress: w.asker });
        return issue(GUESS, { recipientAddress: w.asker });
      },
    },
    {
      name: 'every note held by an earlier sale',
      status: 503,
      run: async (w) => {
        // The holder is the same address in every world; only the asker moves,
        // so the base world is the holder asking again with a second code.
        setTree([w.leaf]);
        mintClaim(ONE, w.leaf);
        mintClaim('CODE-TWO-BBBBBBBB', w.leaf);
        await issue(ONE, { recipientAddress: RECIPIENT });
        return issue('CODE-TWO-BBBBBBBB', { recipientAddress: w.asker });
      },
    },
    {
      name: 'every note too young',
      status: 503,
      run: async (w) => {
        setTreeWithSlots([[w.leaf, h.currentSlot - 1]]);
        mintClaim(ONE, w.leaf);
        return issue(ONE, { recipientAddress: w.asker });
      },
    },
    {
      name: 'every note spent',
      status: 503,
      run: async (w) => {
        setTree([w.leaf]);
        mintClaim(ONE, w.leaf);
        vi.mocked(isNullifierSpentInSet).mockImplementation(() => true);
        try {
          return await issue(ONE, { recipientAddress: w.asker });
        } finally {
          vi.mocked(isNullifierSpentInSet).mockImplementation(() => false);
        }
      },
    },
    {
      name: 'a history that could not be read',
      status: 502,
      keys: BARE_REFUSAL_KEYS,
      run: async (w) => {
        setTree([w.leaf]);
        mintClaim(ONE, w.leaf);
        vi.mocked(fetchPoolCommitments).mockRejectedValueOnce(rpcError(w)());
        return issue(ONE, { recipientAddress: w.asker });
      },
    },
    {
      name: 'a note that could not be sealed',
      status: 503,
      keys: BARE_REFUSAL_KEYS,
      run: async (w) => {
        setTree([w.leaf]);
        mintClaim(ONE, w.leaf);
        h.sealThrows = true;
        try {
          return await issue(ONE, { recipientAddress: w.asker });
        } finally {
          h.sealThrows = false;
        }
      },
    },
    {
      name: 'a reply that could not be stored',
      status: 503,
      keys: BARE_REFUSAL_KEYS,
      run: async (w) => {
        setTree([w.leaf]);
        mintClaim(ONE, w.leaf);
        kv.failSetPrefix = 'p01:note:sealed:';
        return issue(ONE, { recipientAddress: w.asker });
      },
    },
    // ── every other call to the store or the chain, failing in turn ──
    {
      name: 'a rate limiter that could not be read',
      status: 503,
      keys: BARE_REFUSAL_KEYS,
      run: async (w) => {
        setTree([w.leaf]);
        mintClaim(ONE, w.leaf);
        // The bucket is a hash of who is asking; here it moves with the asker.
        h.rateLimitError = () =>
          upstashError(['incr', `wl:rl:${sha256Hex(w.asker).slice(0, 16)}`], kv.batchedWith);
        return issue(ONE, { recipientAddress: w.asker });
      },
    },
    {
      name: 'an RPC that could not be reached',
      status: 502,
      keys: BARE_REFUSAL_KEYS,
      run: async (w) => {
        setTree([w.leaf]);
        mintClaim(ONE, w.leaf);
        h.rpcError.getGenesisHash = rpcError(w);
        return issue(ONE, { recipientAddress: w.asker });
      },
    },
    {
      name: 'a claim that could not be read',
      status: 503,
      keys: BARE_REFUSAL_KEYS,
      run: async (w) => {
        setTree([w.leaf]);
        mintClaim(ONE, w.leaf);
        failing('incr', 'p01:note:claim:');
        return issue(ONE, { recipientAddress: w.asker });
      },
    },
    {
      // 503, not the 402: an unreadable row is no verdict on the code (12).
      name: 'a claim row that could not be read',
      status: 503,
      keys: BARE_REFUSAL_KEYS,
      run: async (w) => {
        setTree([w.leaf]);
        mintClaim(ONE, w.leaf);
        failing('get', 'p01:note:claim-minted:');
        return issue(ONE, { recipientAddress: w.asker });
      },
    },
    {
      name: 'a spent set that could not be read',
      status: 502,
      keys: BARE_REFUSAL_KEYS,
      run: async (w) => {
        setTree([w.leaf]);
        mintClaim(ONE, w.leaf);
        vi.mocked(fetchSpentNullifierSet).mockRejectedValueOnce(rpcError(w)());
        return issue(ONE, { recipientAddress: w.asker });
      },
    },
    {
      name: 'a slot that could not be read',
      status: 502,
      keys: BARE_REFUSAL_KEYS,
      run: async (w) => {
        setTree([w.leaf]);
        mintClaim(ONE, w.leaf);
        h.rpcError.getSlot = rpcError(w);
        return issue(ONE, { recipientAddress: w.asker });
      },
    },
    {
      name: 'a leaf that could not be claimed',
      status: 503,
      keys: BARE_REFUSAL_KEYS,
      run: async (w) => {
        setTree([w.leaf]);
        mintClaim(ONE, w.leaf);
        failing('incr', 'p01:note:issued:');
        return issue(ONE, { recipientAddress: w.asker });
      },
    },
    {
      name: 'a reply that could neither be stored nor read back',
      status: 503,
      keys: BARE_REFUSAL_KEYS,
      run: async (w) => {
        setTree([w.leaf]);
        mintClaim(ONE, w.leaf);
        kv.failSetPrefix = 'p01:note:sealed:';
        // Only the read-BACK fails: a read of the reply that fails before the
        // write is the state "a stored reply that could not be read".
        kv.unreadableAfterWritePrefix = 'p01:note:sealed:';
        return issue(ONE, { recipientAddress: w.asker });
      },
    },
    {
      name: 'a stored reply that could not be read on a first claim',
      status: 503,
      keys: BARE_REFUSAL_KEYS,
      run: async (w) => {
        setTree([w.leaf]);
        mintClaim(ONE, w.leaf);
        failing('get', 'p01:note:sealed:');
        return issue(ONE, { recipientAddress: w.asker });
      },
    },
    {
      name: 'the retry of a sale whose reply landed but could not be read back',
      status: 200,
      keys: [...REPLY_KEYS, 'replayed'],
      run: async (w) => {
        setTree([w.leaf]);
        mintClaim(ONE, w.leaf);
        kv.landThenFailSetPrefix = 'p01:note:sealed:';
        kv.unreadableAfterWritePrefix = 'p01:note:sealed:';
        await issue(ONE, { recipientAddress: w.asker });
        kv.heal();
        return issue(ONE, { recipientAddress: w.asker });
      },
    },
    {
      name: 'a replay whose stored reply could not be read',
      status: 409,
      keys: REFUSAL_KEYS,
      run: async (w) => {
        setTree([w.leaf]);
        mintClaim(ONE, w.leaf);
        await issue(ONE, { recipientAddress: w.asker });
        failing('get', 'p01:note:sealed:');
        return issue(ONE, { recipientAddress: w.asker });
      },
    },
  ];

  for (const state of STATES) {
    it(`does not move with the leaf or the asker: ${state.name}`, async () => {
      const answers: Array<{ w: World; reply: Reply }> = [];
      for (const w of WORLDS) {
        kv = new FakeKv();
        h.store = kv;
        h.deferred.length = 0;
        h.rpcError = {};
        h.rateLimitError = null;
        kv.batchedWith = [
          ['incr', claimKeyOf(w.neighbour)],
          ['get', mintedKeyOf(w.neighbour)],
        ];
        askerIp = w.ip;
        h.askedFrom = null;
        answers.push({ w, reply: await state.run(w) });
        // Anti-vacuity: the route read this world's address.
        expect(h.askedFrom, 'the route never saw the address that asked').toBe(w.ip);
      }
      const [base, ...moved] = answers;
      const shown = (a: { w: World; reply: Reply }) => redact(JSON.stringify(a.reply.body), a.w.seed);

      // Anti-vacuity: the state was really reached, in every world.
      for (const a of answers) expect(a.reply.status, shown(a)).toBe(state.status);
      if (state.keys) {
        expect(Object.keys(base.reply.body).sort(), 'the body carries a key beyond its own').toEqual(
          [...state.keys].sort(),
        );
      }
      if (state.status === 200) {
        // Every leaf world really issued its own note, so an equal body is not
        // two copies of one note.
        for (const a of answers) {
          expect(openedCommitment(a.reply.body, a.w.seed)).toBe(treasuryCommitmentAt(a.w.leaf));
        }
      }

      for (const a of answers) {
        const text = JSON.stringify(a.reply.body);
        for (const marker of NEVER_IN_AN_ANSWER) {
          expect(text, `the answer carries "${marker}"`).not.toContain(marker);
        }
        // A sale hands over its one note; a refusal hands over none, not even
        // one the asker can open (P1: the note a failed write named).
        expect(
          text.match(/p01enc1:[A-Za-z0-9+/=]+/g) ?? [],
          'the answer carries a sealed note it does not hand over',
        ).toHaveLength(state.status === 200 ? 1 : 0);
      }
      // A server log is a copy of the store's text just as an answer is, and
      // here nothing at all may reach one, in any world (see `routeLog`; the
      // afterEach reads it too, for every other case).
      expect(routeLog, 'the route wrote to the server log').toEqual([]);

      for (const a of moved) {
        const what =
          a.w.leaf !== BASE.leaf
            ? 'the leaf'
            : a.w.neighbour !== BASE.neighbour
              ? 'another buyer served at the same time'
              : a.w.ip !== BASE.ip
                ? 'the network address that asked'
                : 'the address that asked';
        expect(shown(a), `the answer moved with ${what}, so it names it`).toBe(shown(base));
        expect(a.reply.headers, `a header moved with ${what}, so it names it`).toBe(
          base.reply.headers,
        );
      }
    });
  }
});

// ── 12 ───────────────────────────────────────────────────────────────────────

/**
 * 🚨 A STORE THAT COULD NOT BE READ IS NO VERDICT ON THE CODE.
 *
 * The route consumes the code (`incr`) and only then reads `claim-minted`. A
 * throw on that read used to be answered as the verdict "this claim code was
 * never issued against a payment", the 402 that burns a code on purpose. So a
 * store blip burned a code somebody had paid for, told them they never paid,
 * and left their retry a 409 for good (verifier web-run r2, minor 3; case 11
 * pinned that 402 in every world). An unreadable row now gives the code back
 * and answers 503 "retry with the same code".
 *
 * ⛔ AND THAT OPENS NO GUESSING ORACLE, which is what the 402's burn protects.
 * The answer to an unreadable row is the same for a paid code and a guessed
 * one, since the route cannot tell them apart either. A guess is still read
 * exactly once before it is burned, whether or not a blip came first. Both
 * are asserted below. Red: web-run/logs/ISSUE-1-webfix3/sandbox-minted/
 * wp-logs/ISSUE-1-red.log.
 */
describe('a claim row the store could not read', () => {
  const ONE = 'CODE-ONE-AAAAAAAA';
  const GUESS = 'CODE-GUESS-GGGGGG';
  const unreadable = (code: string) => {
    kv.failWhen = (op, key) => op === 'get' && key === mintedKeyOf(code);
  };

  it('gives the code back, so the same code works once the store answers', async () => {
    setTree([17]);
    mintClaim(ONE, 17);
    unreadable(ONE);

    const failed = await issue(ONE);

    expect(failed.status, JSON.stringify(failed.body)).toBe(503);
    expect(String(failed.body.error)).toMatch(/retry with the same code/);
    expect(kv.has(claimKeyOf(ONE)), 'the paid code stayed spent').toBe(false);
    expect(
      kv.rows().filter((r) => /^p01:note:(issued|sealed):/.test(r.key)).map((r) => r.key),
      'a leaf was spoken for, or a reply stored, on a code nobody could check',
    ).toEqual([]);
    expect(kv.has(mintedKeyOf(ONE)), 'the claim row was swept before any redemption').toBe(true);

    kv.failWhen = null;
    const retried = await issue(ONE);

    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(openedCommitment(retried.body)).toBe(treasuryCommitmentAt(17));
    const held = [failed, retried].flatMap((r) => notesOpenedBy(BUYER_SEED, JSON.stringify(r.body)));
    expect(held, 'one paid code, one note').toHaveLength(1);
  });

  it('answers a paid code and a guessed one alike, and still reads a guess only once', async () => {
    setTree([17]);
    mintClaim(ONE, 17);
    unreadable(ONE);
    const paid = await issue(ONE);

    kv = new FakeKv();
    h.store = kv;
    h.deferred.length = 0;
    setTree([17]);
    unreadable(GUESS);
    const guessed = await issue(GUESS);

    expect(paid.status, JSON.stringify(paid.body)).toBe(503);
    expect(JSON.stringify(guessed.body), 'the answer tells a paid code from a guess').toBe(
      JSON.stringify(paid.body),
    );
    expect(guessed.status).toBe(paid.status);
    expect(guessed.headers).toBe(paid.headers);

    // The store answers again: the guess gets its one reading, then no other.
    kv.failWhen = null;
    const read = await issue(GUESS);
    expect(read.status, JSON.stringify(read.body)).toBe(402);
    const again = await issue(GUESS);
    expect(again.status, 'a guessed code was read twice').toBe(409);
    expect(kv.has(claimKeyOf(GUESS)), 'a guessed code was given back after its reading').toBe(true);
  });
});

describe('the server-log check itself', () => {
  it('sees every kind of write it is there to catch', () => {
    // Its positive control (PROTOCOL.md rule 4): without this, a capture that
    // had stopped working would read as a route that logs nothing.
    console.info('control', 17);
    console.error(new Error('control error'));
    console.debug({ leafIndex: 17 });
    process.stdout.write('control stdout\n');
    process.stderr.write(Buffer.from('control stderr\n'));

    expect(routeLog).toEqual([
      'console.info: control 17',
      'console.error: Error: control error',
      'console.debug: {"leafIndex":17}',
      'stdout: control stdout\n',
      'stderr: control stderr\n',
    ]);
    // These five were the test's own, not the route's.
    routeLog.length = 0;
  });

  it('sees a logger bound before the route module loaded, and a request to a log service', async () => {
    // Its control for W5 and W6: each of these was bound in `vi.hoisted`,
    // ahead of every import, exactly as a module binds a logger at load. A
    // capture installed per case never saw them.
    serverLog.boundAtLoad.info('bound at load', 17);
    serverLog.boundAtLoad.write('bound stdout\n');
    serverLog.boundAtLoad.rawDebug('raw', 17);
    await serverLog.boundAtLoad.fetch('https://logs.test.invalid/?leaf=17').catch(() => undefined);

    expect(routeLog).toEqual([
      'console.info: bound at load 17',
      'stdout: bound stdout\n',
      'rawDebug: raw 17',
      'fetch: https://logs.test.invalid/?leaf=17',
    ]);
    routeLog.length = 0;
  });

  it('is the only way out: the route imports nothing else it could write through', () => {
    // A module the route imports is a channel the capture above may not read:
    // `node:fs` writes to a descriptor (`fs.writeSync(1, …)`), `node:console`
    // is another console, a logging library is a request. So the route's
    // imports are pinned; adding one is a decision this list makes visible.
    const ROUTE_IMPORTS = [
      '@/lib/net/clientIp',
      '@/lib/privacy/paymentBinding',
      '@/lib/privacy/pool/denominatedPool',
      // CACHE-1: no console, fs or fetch of its own; it writes public chain
      // data through '@/lib/waitlist/store' below (lib/privacy/pool/kvPoolHistory.test.ts).
      '@/lib/privacy/pool/kvPoolHistory',
      '@/lib/privacy/pool/noteBlinding',
      '@/lib/privacy/pool/noteCrypto',
      '@/lib/privacy/treasurySeeds',
      '@/lib/waitlist/store',
      '@solana/web3.js',
      'next/server',
      'node:crypto',
    ];
    const FROM = /^\s*(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]/gm;
    const specifiers = (text: string) => [...text.matchAll(FROM)].map((m) => m[1]).sort();
    const bare = (text: string) =>
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    // The scan's own control: it reads a one-line and a multi-line import.
    expect(specifiers("import fs from 'node:fs';\nimport {\n  a,\n} from \"x\";\n")).toEqual([
      'node:fs',
      'x',
    ]);

    const code = bare(readFileSync(join(__dirname, '../../app/api/issue-note/route.ts'), 'utf8'));
    expect(specifiers(code), 'the route imports a module this list has not checked').toEqual(ROUTE_IMPORTS);
    expect(code, 'a side-effect import').not.toMatch(/^\s*import\s*['"]/m);
    expect(code, 'a dynamic import').not.toMatch(/\bimport\s*\(/);
    expect(code, 'a require').not.toMatch(/\brequire\s*\(/);
  });
});

// ── 13 ───────────────────────────────────────────────────────────────────────

/**
 * WHAT A PAYING CALLER IS TOLD WHEN NO NOTE COMES OUT.
 *
 * 🚨 SWEEP4 round 1, confirmed item 30. Every exhaustion used to answer with
 * the state that caused it — `spentLeaves`, `heldByOthers`, `tooYoung`,
 * `notOurs`, `waitSlots`, and a different sentence and status for each. The
 * claim code is RELEASED on all of those paths, by design, so the same code can
 * be presented again; which means a buyer holding one paid claim could poll the
 * route and read the inventory changing underneath them. `spentLeaves` going
 * from 0 to 1 between two polls dates a spend to the interval between them, and
 * the deployment's inventory is a public set of leaves.
 *
 * ⛔ THE RULE: same status, same bytes, whatever the walk found — for anyone
 * who is not the operator. The operator proves it with the password and still
 * gets the exhaustion that happened, counts and all, because a deployment that
 * cannot be diagnosed cannot be run.
 *
 * The shape is five WORLDS that differ in exactly one thing, the state of the
 * inventory, read by what MOVES the answer (`wp-logs/PROTOCOL.md`). Each case
 * carries its own positive control: the operator's five answers must all
 * differ, or the buyer's five being identical would prove nothing.
 */
describe('what a paying caller is told when no note comes out', () => {
  /**
   * One exhaustion, from a clean store. The store and the env are rebuilt here
   * rather than in a `beforeEach`, because a case runs several worlds in a row
   * and each has to start from the same place.
   */
  async function refusal(
    world: () => void,
    opts: { asOperator?: boolean; password?: string } = {},
  ): Promise<Reply> {
    kv = new FakeKv();
    h.store = kv;
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '');
    vi.stubEnv('P01_TREASURY_NOTE_MIN_AGE_SLOTS', '');
    // A world may leave the spent check answering `true`; the next world in the
    // same case must not inherit it.
    vi.mocked(isNullifierSpentInSet).mockImplementation(() => false);
    world();
    mintClaim('CODE-ONE-AAAAAAAA', 5);
    return issue('CODE-ONE-AAAAAAAA', {}, opts);
  }

  /** The stock is there and every note has already been handed to somebody. */
  const allHeld = () => {
    setTreeWithSlots([[17, ANCIENT_SLOT]]);
    kv.scalars.set(issuedKeyOf(17), { v: 1, ttl: null });
  };
  /** One of those notes has since been spent: the event a poller is hunting. */
  const oneSpent = () => {
    setTreeWithSlots([[17, ANCIENT_SLOT]]);
    vi.mocked(isNullifierSpentInSet).mockImplementation(() => true);
  };
  /** The stock is there and too new to hand over: it will be good in minutes. */
  const tooYoung = () => {
    vi.stubEnv('P01_TREASURY_NOTE_MIN_AGE_SLOTS', '100');
    setTreeWithSlots([[17, h.currentSlot - 1]]);
  };
  /** A configured leaf the history read did not bring back: an outage, not a state. */
  const historyShort = () => {
    setTreeWithSlots([], [0, 1, 2, 9]);
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '5');
  };
  /** A configured leaf that is occupied on the tree by somebody else's deposit. */
  const notOurs = () => {
    setTreeWithSlots([], [0, 1, 2, 5]);
    vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '5');
  };

  const WORLDS: Array<[label: string, world: () => void]> = [
    ['every note held by an earlier sale', allHeld],
    ['one of them since spent', oneSpent],
    ['every note too young to hand over', tooYoung],
    ['a history that came back short', historyShort],
    ['a configured leaf that is not ours', notOurs],
  ];

  it('answers the same bytes whatever the inventory is doing', async () => {
    const seen: Array<{ world: string; status: number; body: string }> = [];
    for (const [label, world] of WORLDS) {
      askerIp = ASKER_IP;
      const reply = await refusal(world, { asOperator: false });
      seen.push({ world: label, status: reply.status, body: JSON.stringify(reply.body) });
    }

    // Positive control: the worlds really are different worlds. Read through
    // the operator, who is told which exhaustion each one was.
    const operatorAnswers = new Set<string>();
    for (const [, world] of WORLDS) {
      askerIp = ASKER_IP;
      const reply = await refusal(world);
      operatorAnswers.add(`${reply.status} ${JSON.stringify(reply.body)}`);
    }
    expect(
      operatorAnswers.size,
      'the worlds are not distinguishable at all, so this case proves nothing',
    ).toBe(WORLDS.length);

    for (const row of seen.slice(1)) {
      expect(row.status, `the status moved with the inventory (${row.world})`).toBe(seen[0]!.status);
      expect(row.body, `the refusal moved with the inventory (${row.world})`).toBe(seen[0]!.body);
    }
    // And it carries no count at all, so a shape this list does not name cannot
    // creep back in as "just a number".
    for (const field of [
      'configured',
      'spentLeaves',
      'heldByOthers',
      'tooYoung',
      'notOurs',
      'missingFromHistory',
      'waitSlots',
    ]) {
      expect(seen[0]!.body, `the refusal named ${field}`).not.toContain(field);
    }
  });

  it('still tells the operator which exhaustion it was', async () => {
    // The other half of the rule. A deployment that cannot be diagnosed cannot
    // be run, so the counts still exist — for the caller who proved they are
    // the operator, and for no other.
    const seen = new Set<string>();
    for (const [, world] of WORLDS) {
      askerIp = ASKER_IP;
      const reply = await refusal(world);
      seen.add(`${reply.status} ${JSON.stringify(reply.body)}`);
    }
    expect(seen.size, 'two worlds answered the operator the same way').toBe(WORLDS.length);
  });

  it('gives a caller with the wrong password the same answer as anyone else', async () => {
    // ⚠️ THIS CASE SENDS A WRONG PASSWORD, WHICH IT DID NOT USED TO.
    // `{ asOperator: false }` omits the header, so before the repair round the
    // only paths measured here were "header present and right" and "header
    // absent": the comparison in `asksAsOperator` — the one a guesser actually
    // reaches — went through no assertion, while the name said otherwise.
    const none = await refusal(allHeld, { asOperator: false });
    askerIp = ASKER_IP;
    const right = await refusal(allHeld);
    expect(JSON.stringify(right.body), 'the operator view is not the public one').not.toBe(
      JSON.stringify(none.body),
    );

    askerIp = ASKER_IP;
    const wrong = await refusal(allHeld, { password: 'not-the-operator-password' });
    expect(JSON.stringify(wrong.body), 'a wrong password read the operator view').toBe(
      JSON.stringify(none.body),
    );
    expect(wrong.status).toBe(none.status);

    // The same LENGTH as the real one, so a comparison that answered through
    // length could not pass this by being told the sizes differ.
    askerIp = ASKER_IP;
    const sameLength = await refusal(allHeld, { password: 'x'.repeat(ADMIN_PASSWORD.length) });
    expect(
      JSON.stringify(sameLength.body),
      'a wrong password of the right length read the operator view',
    ).toBe(JSON.stringify(none.body));

    // A deployment with no password set answers nobody's detail: the header is
    // then not a key, and "unset equals unsent" would hand the counts to every
    // caller.
    askerIp = ASKER_IP;
    vi.stubEnv('ADMIN_PASSWORD', '');
    const unset = await refusal(allHeld);
    expect(JSON.stringify(unset.body), 'an unset password let the detail out').toBe(
      JSON.stringify(none.body),
    );
  });

  it('🚨 gives an anonymous caller the public answer on a deployment with NO password set', async () => {
    // ⛔ THE BRANCH `if (expected === '' || given === '') return false` EXISTS
    // FOR THIS, AND NOTHING EXERCISED IT. With `ADMIN_PASSWORD` unset AND no
    // header, both sides are '' — and sha256('') === sha256(''), so without
    // that line the digests MATCH and every anonymous caller is an operator.
    // On a deployment that never set a password that hands `spentLeaves`,
    // `heldByOthers`, `tooYoung` and `waitSlots` back to a re-poller: exactly
    // the signal this section exists to remove.
    //
    // The case above stubs `ADMIN_PASSWORD` to '' but still SENDS the header,
    // so `given` was never '' and only the first half of the condition was ever
    // reached. Deleting the whole line left this suite at 64/64
    // (gates4/GATE-r1.md, RED 4).
    vi.stubEnv('ADMIN_PASSWORD', '');
    const anonymous = await refusal(allHeld, { asOperator: false });

    // The positive control: the operator view, read the only way it can be read
    // here — with a password that IS set. This is what the answer above must
    // not be.
    askerIp = ASKER_IP;
    vi.stubEnv('ADMIN_PASSWORD', ADMIN_PASSWORD);
    const operator = await refusal(allHeld);
    // The detail, absent by NAME rather than by comparison, so a future
    // reshaping of the operator body cannot make this pass by coincidence —
    // and so the red NAMES the field that came back rather than reporting a
    // control that fired.
    const text = JSON.stringify(anonymous.body);
    for (const field of ['spentLeaves', 'heldByOthers', 'tooYoung', 'waitSlots']) {
      expect(text, 'an anonymous caller read ' + field).not.toContain(field);
    }
    expect(
      JSON.stringify(operator.body),
      'the operator view is not distinguishable here, so this case proves nothing',
    ).not.toBe(text);
  });

  it('tells the buyer what to do next, and does not promise a free retry', async () => {
    // 🚨 GATE r1, RED 7e. The hint used to say "asking again with the SAME
    // code costs nothing". The CODE costs nothing — it is released — but every
    // POST is charged against `ISSUES_PER_IP_PER_HOUR` (3 by default), so a
    // buyer who had paid and followed that sentence was answered 429 on the
    // fourth attempt and locked out for the hour. The promise had to become
    // true, and the two things the buyer needs are: the code still works, and
    // there is a limit on how often to ask.
    const reply = await refusal(allHeld, { asOperator: false });
    const hint = String((reply.body as { hint?: unknown }).hint ?? '');

    expect(hint, 'the refusal carries no hint at all').not.toBe('');
    expect(hint, 'the hint no longer says the claim code survives').toMatch(/NOT used up|still worth a note/i);
    expect(hint, 'the hint still promises a retry that costs nothing').not.toMatch(/costs nothing/i);
    expect(hint, 'the hint does not mention the limit that decides the retry').toMatch(
      /limits how often|allowance|few minutes/i,
    );
  });

  it('answers the same hint in every world, like the rest of the body', async () => {
    // The hint travels in the same body the case above pins byte for byte, so
    // this is its own guard against someone making the hint the thing that
    // moves with the inventory.
    const hints = new Set<string>();
    for (const [, world] of WORLDS) {
      askerIp = ASKER_IP;
      const reply = await refusal(world, { asOperator: false });
      hints.add(String((reply.body as { hint?: unknown }).hint ?? ''));
    }
    expect(hints.size, 'the hint moved with the inventory').toBe(1);
    expect([...hints][0], 'the refusal carries no hint at all').not.toBe('');
  });

  /**
   * ⚠️ A DISCLOSED RESIDUAL, MEASURED RATHER THAN CLAIMED CLOSED
   * (gate r1, RED 7f). FOUNDER DECISION.
   *
   * The refusal above is equal BYTE FOR BYTE across every world. The WORK is
   * not: the "all held" walk takes the atomic claim (`kv.incr`) on every
   * candidate leaf before finding it spoken for, while "all spent" and "too
   * young" skip to the next leaf before that line and take none. So the number
   * of store round trips — and with it the response latency — still moves with
   * the inventory state, and a re-poller holding one released claim code can
   * read the transition the byte-equal answer hides. That is the same signal
   * item 30 exists to remove, arriving by a slower channel.
   *
   * ⛔ IT IS NOT FIXED HERE, AND THE REASON IS THAT THE OBVIOUS FIX IS WORSE.
   * Equalizing the work means taking the claim on every candidate in every
   * world — consuming inventory to answer a refusal — which trades a timing
   * signal for a stock-burning one. The alternatives (a constant-time walk, a
   * fixed delay) are a design decision about latency on a paid path, so this
   * goes to the founder rather than being patched in a repair round.
   *
   * What this case does is pin the MEASUREMENT, so the residual cannot quietly
   * grow and a future fix shows up as this test failing rather than as nothing.
   */
  it('equalizes the BYTES of the refusal and not the WORK behind it — residual, measured', async () => {
    const work = new Map<string, number>();
    for (const [label, world] of WORLDS) {
      askerIp = ASKER_IP;
      await refusal(world, { asOperator: false });
      work.set(label, kv.ops.filter((o) => o.startsWith('incr p01:note:issued:')).length);
    }

    // The measurement, as of this round. The held world and the not-ours world
    // take the atomic claim on their candidate; the spent, too-young and
    // short-history worlds skip to the next leaf before that line and take
    // none. Two answers, byte for byte identical; two different amounts of work.
    expect(Object.fromEntries(work), 'the store round trips moved from what was measured').toEqual({
      'every note held by an earlier sale': 1,
      'one of them since spent': 0,
      'every note too young to hand over': 0,
      'a history that came back short': 0,
      'a configured leaf that is not ours': 1,
    });

    // And the residual stated as the property it is: the answers are equal, the
    // work is not. When someone closes it, THIS is what goes red.
    expect(
      new Set(work.values()).size,
      'the work is now equal across worlds — the residual is closed, so update this case and tell the founder',
    ).toBeGreaterThan(1);
  });

  /**
   * ⛔ THE DEFAULT IS DELIBERATE, AND THIS IS THE LINE THAT SAYS SO.
   *
   * `request()` sends `x-admin-password` unless a case opts out, so roughly 95
   * pre-existing refusal-string assertions in this file read the OPERATOR view.
   * That is right for them — they are about what an operator is told — but it
   * means the buyer-facing uniformity rests on the handful of cases above that
   * pass `{ asOperator: false }`. Flipping the default would rewrite those 95;
   * pinning it costs one case and fails loudly if someone flips it.
   */
  it('sends the operator header by default, and none when a case opts out', () => {
    const withDefault = request({}, {});
    const optedOut = request({}, { asOperator: false });
    const wrong = request({}, { password: 'something-else' });
    expect(withDefault.headers.get('x-admin-password')).toBe(ADMIN_PASSWORD);
    expect(optedOut.headers.get('x-admin-password')).toBeNull();
    expect(wrong.headers.get('x-admin-password')).toBe('something-else');
  });
});
