/**
 * WHAT A COPY OF THE KV HOLDS AFTER ONE PURCHASE, READ ROW BY ROW.
 *
 * Adversary: whoever holds a dump of this deployment's KV (an Upstash backup,
 * a leaked token, an operator). They also hold this repository, which is
 * public, and every other row of the same dump. Plan work package RED-0 wrote
 * this file; KV-1 unpinned the plan's case once ISSUE-1 was green
 * (PLAN-mixing-opacity.json). The red this file produced on the unmodified
 * routes is saved in the session scratchpad as wp-logs/RED-0-red.log (the
 * round-0 detector's red: wp-logs/RED-0-r0-red.log; the round-1 list-based
 * detector's: wp-logs/RED-0-fix1-red.log; the round-3 cases on the round-2
 * detector: web-run/logs/RED-0-webfix1/sandbox/wp-logs/RED-0-red.log; the
 * expiry cases on the round-3 detector, and the hour-turn join on today's
 * routes: web-run/logs/RED-0-webfix2/sandbox-detector/wp-logs/RED-0-red.log
 * and sandbox-live/wp-logs/RED-0-red.log).
 *
 * ONE FULL CYCLE, THROUGH THE REAL ROUTE HANDLERS, ON ONE RECORDING STORE:
 *
 *   1. `POST /api/contribute-note` reserve   -> the leaf the buyer will fund
 *   2. the relay's two rows for that payment, written with the relay's own key
 *      helpers (`relay-to-buyer/route.ts` recordFunded + its one-shot claim);
 *      the relay itself moves lamports and is not driven here
 *   3. `POST /api/contribute-note` confirm   -> the claim code
 *   4. `POST /api/issue-note`                -> an OLDER treasury note, sealed
 *   5. every task handed to next/server `after()` is run before the dump
 *
 * The chain is a fixture (the tree, the slot, the payment transaction). The
 * store, the rate limiter, the derivations and the sealing are the real code.
 * Every world runs the cycle under two clocks (CLOCKS). In `sameHour` the
 * three steps share one hour. In `hourTurns` the hour turns between reserve
 * and confirm.
 *
 * ⛔ THE LEAF SIDE IS MEASURED, NOT LISTED. A dump holder has this public
 * repository, so ANY keyless function of a leaf names it: its commitment, a
 * hash of either, a hash prefix, the deposit slot, the deposit time, a Merkle
 * path, a nullifier, an encoding nobody has thought of yet. A detector that
 * lists spellings can always be dodged by one more, and it was: the round-1
 * verifier walked past 18 of 21 shapes it had not listed
 * (wp-logs/verify/RED-0-r2-detector-probe.log). So the cycle is run in several
 * WORLDS instead, identical but for one thing each, and a row is read by what
 * MOVES it:
 *
 *   base            the reference run
 *   again           base a second time: every random draw and every clock read
 *                   is seeded, so this dump must be byte-identical to base.
 *                   The harness case asserts it. Without it a random source
 *                   nobody seeded would make every row differ in every world,
 *                   which reads as "nothing joins anything" — silent green.
 *   leaf, leaf2     the leaves move (index, commitment, deposit slot, tree
 *                   edge). Anything that differs is a function of the leaves.
 *   rand, rand2     every random draw moves (so the claim code moves)
 *   payer, payer2   the paying wallet, and so the payment signature, moves
 *   recipient, recipient2
 *                   the buyer's note address moves
 *   net, net2       the buyer's IP moves
 *   leaf+rand, …    each leaf world again under each buyer world (2 x 8)
 *
 * Every axis has two alternatives, so a function that happens to give base's
 * value at one of them is still read at the other (controls Y1-Y4).
 *
 * A row that moves with the leaves AND with the buyer joins them, whatever
 * function produced either half. The rules sit above `findings()`.
 *
 * ⛔ EVERY WORLD IS READ, NOT ONLY BASE. A route can write a row for some
 * leaves or some buyers only, and base then holds no such row. Until the
 * continued run's fix round 1 only base's rows were read, so such a row was
 * never examined: with the real issue-note route writing the recipient on the
 * issued leaf only for leaves below 100, the file stayed green
 * (web-run/logs2/verify-RED-0-r1/probe-PM1.log; PM2, PM3 and planted D1-D4
 * the same). The worlds are therefore a grid, three leaf settings by nine
 * buyers, and each of its 27 worlds is read in turn as the reference, against
 * the worlds that differ from it in one thing: the two with its buyer and
 * other leaves, and the eight with its leaves and another buyer. Without the
 * cross worlds a row that exists only for leaf's leaves would have no world
 * that moves its buyer (sabotage R2). A token can only move where a row of its
 * row's shape exists, so a row base lacks is read by what its own tokens do
 * where it exists (G5, G7). Controls D1-D4, PM3, G1-G7, GN1-GN5; sabotage
 * R1-R8 and the verifier's route mutants PM1-PM3 in
 * web-run/logs2/RED-0-cr1/sabotage.log.
 *
 * ⛔ WHY THE PIN CANNOT PASS ON A BROKEN HARNESS OR A BROKEN DETECTOR.
 * One case is pinned with `it.fails`: the hour-turn join, a live leak
 * (HOUR_TURN_JOIN_PINNED below). `it.fails` passes on ANY throw, so a harness
 * that stopped reaching the routes would read as the leak still being there.
 * The cycles therefore never throw into a test: the error is stored, the
 * harness case goes red on it, and the pinned case RETURNS without asserting,
 * which turns `it.fails` red as well. A detector that throws is handled the
 * same way. The detector has its own positive control. It gets planted joins
 * it must flag: among them the nine shapes the round-1 verifier found, the
 * twenty of round 2, the round-3 probes, the expiry cases of web fix 2 and
 * the rows base does not hold (continued run). It also gets neutral rows it
 * must not flag, among them the rows the plan leaves behind. Two plain
 * sibling cases allow only the known joins: none in `sameHour` (KNOWN_LEAKS,
 * which KV-1 emptied), and exactly the pinned ones at the hour turn
 * (KNOWN_HOUR_TURN_LEAKS). So a new finding goes red under either clock. So
 * does any fix of the pinned join, which must then be unpinned. A third plain
 * case then checks that the fix is the prescribed one (the rate limiter's
 * rows, below).
 *
 * WHAT A GREEN HERE DOES NOT CLOSE:
 *   - Only the contribute-then-collect path is driven. The plain-sale branch of
 *     `claim-for-payment` and `mint-claim` write rows this cycle never writes;
 *     KV-1's own tests carry those pins.
 *   - The dump is read once, after the cycle. Between confirm and redemption
 *     the relay binding and the code rows are at rest by design (plan KV-1 (3),
 *     ISSUE-1 (5)); a dump taken in that window is not read here. Nor is one
 *     taken between reserve and confirm. There, in every purchase and whatever
 *     the hour, the reservation rows and the reserve request's rate-limit row
 *     expire within that request's latency of each other. Under this file's
 *     frozen clock that is one instant (probe PMID in
 *     web-run/logs/RED-0-webfix2/sabotage.log; the pinned join below).
 *   - A function of the leaves that takes the SAME value in base, leaf and
 *     leaf2 is invisible: a bucket all three share (the worlds are 211/173,
 *     302/58 and 64/9, so parity, digit count and magnitude all move, but a
 *     one-bit function can still agree on three points). Whether a row exists
 *     is one such function: a row written for none of the three leaf sets, or
 *     for all three, is read as never written or as always written.
 *   - The same holds per buyer axis: a function of the code, the payer, the
 *     recipient or the IP that gives base's value in BOTH alternatives of its
 *     axis is invisible. For one hex digit of a hash that is 1 buyer in 256
 *     (1/16 twice). With one alternative per axis it was 1 in 16, and the
 *     round-3 verifier's one-digit function of the code was found only because
 *     the one draw differed (wp-logs/verify/RED-0-r3-detector-probe.log).
 *   - What the worlds hold fixed is read only by its shape and by what it
 *     shares with other rows: the slot, the denomination, the funder ticket,
 *     and the clock (the clock items below). A new buyer-identifying REQUEST
 *     field that this fixture does not vary would be read as a constant. It
 *     is caught only if its shape is not a plain word or a short number, or
 *     if it ties a leaf row to a buyer row (the short-token item below).
 *   - That belt reads a row only where a world on each side of the reference
 *     holds a row of its shape. A row written for ONE leaf setting only, or
 *     for one buyer only, is read by the differential alone: a leaf row that
 *     carries such an identity and is written only for leaf's leaves is not
 *     flagged. G7 is flagged: it is written for two leaf settings.
 *   - The RECIPIENT rule's differential needs a world that moves the recipient
 *     ALONE. The grid has one only where the reference's buyer is base's or a
 *     recipient alternative (9 of the 27 references). Elsewhere a row is read
 *     for the recipient by its spellings only: the address, a 16+ character
 *     piece of it, its sha256 (G4). So a row written only for some claim
 *     codes, payers or addresses that does not move with the leaves and holds
 *     a salted function of the recipient is not flagged. One that also moves
 *     with the leaves is a JOIN whatever it holds (G3).
 *   - The clock is frozen per step and is the same in every world, so no
 *     world moves it. It is read only by what rows SHARE of it (the INSTANT
 *     rule above `findings()`). Three things are compared, to within one
 *     second. The first is each row's absolute expiry: a backup stores it to
 *     the millisecond, and PTTL reads it back. The second is the instant its
 *     TTL was set: the expiry less the TTL, which is a constant in this public
 *     code. The third is the times that keys and values spell to the second.
 *     This file freezes the clock per step, so every row one request writes
 *     carries that step's instant. Two rows given a TTL in one request are
 *     therefore tied (E1, E2). On today's routes that ties the funded leaf's
 *     reservation rows to the buyer's rate-limit row when the hour turns
 *     between reserve and confirm. That is a LIVE leak, pinned below
 *     (HOUR_TURN_JOIN_PINNED). Its sibling reads findings only, so any fix
 *     that moves the two expiries a second or more apart turns it red, a
 *     whole-minute rounding as well as the prescribed hour bucket's end
 *     (web-run/logs2/verify-RED-0-r1/probe-bucket.log). Which fix landed is
 *     checked by the case on the rate limiter's rows, once the pin is off.
 *   - Instants more than a second apart tie nothing here. Neither does an
 *     expiry on a whole minute, a bucket's end that every row of the bucket
 *     shares (EN1). In production the writes of one request are apart by
 *     that request's latency, which this file does not model: reserve calls
 *     the RPC between the rate limiter (contribute-note/route.ts:230) and the
 *     reservation (:313). With few purchases, a dump holder pairs rows further
 *     apart than a second. So in `sameHour`, where the rate-limit row expires
 *     41 s after the reservation rows (EN2), this file is green, but those
 *     rows are not unlinkable. That is the anonymity-set question below.
 *   - Last access is not recorded: RecordingKv logs no reads. Redis keeps a
 *     last-access clock per key (OBJECT IDLETIME; an RDB saved under an LRU
 *     eviction policy carries it too). A dump that holds it ties every row
 *     one request touches, among them the issue request's leaf row and code
 *     rows. Whether this deployment's store exposes it is not measured here.
 *   - Rows are tied by a short token no world moves (in a key or inside a
 *     longer value) only where one cycle can tell it from vocabulary: digits
 *     held by exactly two rows and not a round amount, or a token with a
 *     letter in it that two rows or more hold and that the production code
 *     (`app/api`, `lib`) never writes literally. So a per-purchase id spelled
 *     as a word that code writes, or made of digits that three rows or more
 *     hold, is read as vocabulary or as a count: one cycle cannot tell a
 *     global sequence number from the many counters that are all `1`.
 *   - One cycle cannot measure an anonymity set: with one payment and one
 *     issuance anybody pairs them. This file finds joins WRITTEN in rows. So
 *     a time coarser than the second ties nothing here. That covers the hour
 *     bucket the rate limiter's keys carry (N19) and an expiry on a bucket's
 *     end (EN1). Neither do two instants more than a second apart, such as
 *     two requests of one purchase (EN2). How many purchases share that
 *     bucket or that window is the anonymity-set question.
 *   - Ciphertext that the buyer's own seed opens (the `sealedNote` run) is
 *     not READ: it is replaced by one word and its length before a row is
 *     compared, so the note this deployment hands the buyer does not read as
 *     a leak. What needs no key is still compared: the blob's LENGTH (X11,
 *     X11b) and its identity, so one blob stored in two rows ties them (X12).
 *     The stored reply is 2920 characters in every world; the same note
 *     sealed without the issue-note pad is 2088 in base and 2084 in both leaf
 *     worlds (web-run/logs/RED-0-webfix1/probe/probe2.log), and before this
 *     round a one-word redaction hid such a gap (2668 against 2660,
 *     wp-logs/verify/RED-0-r3-blob-length-probe.log). Its length and whether
 *     it repeats are what a dump shows of it without the key, so they are
 *     what is compared. Ciphertext under any other key is NOT exempt: it is
 *     compared whole (X10, X10b).
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import { Keypair } from '@solana/web3.js';

type Commitment = { leafIndex: number; commitment: bigint; depositSlot: number | null };

const h = vi.hoisted(() => ({
  store: null as unknown,
  /** Tasks the routes handed to next/server `after()`, run before the dump. */
  deferred: [] as unknown[],
  tree: new Map<string, Commitment>(),
  paymentTx: null as unknown,
  currentSlot: 500_000_000,
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (task: unknown) => {
      h.deferred.push(task);
    },
  };
});

// Only the store resolution is replaced. `rateLimitExceeded` stays the real
// one, so its rows land in the same store as everything else.
vi.mock('@/lib/waitlist/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/waitlist/store')>();
  return { ...actual, getStore: () => h.store };
});

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    Connection: class {
      async getGenesisHash() {
        return 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
      }
      async getTransaction() {
        return h.paymentTx;
      }
      async getSlot() {
        return h.currentSlot;
      }
      /** A slot's wall-clock time, as the chain reports it: a public alias of a deposit. */
      async getBlockTime(slot: number) {
        return blockTimeOfSlot(slot);
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
    // The spent set above is empty, so the real answer is false. The real
    // function derives a PDA, which throws under jsdom ("Unable to find a
    // viable program address nonce", RED-0 dry run 1); issue-note.test.ts
    // stubs it the same way.
    isNullifierSpentInSet: vi.fn(() => false),
  };
});

import { NextRequest } from 'next/server';
import { POST as contributeNote } from '@/app/api/contribute-note/route';
import { POST as issueNote } from '@/app/api/issue-note/route';
import { claimChallenge } from '@/lib/privacy/claimChallenge';
import {
  contributionBinding,
  relayPaymentClaimKey,
  relayPaymentContributionKey,
} from '@/lib/privacy/paymentBinding';
import {
  createCommitmentV3,
  deriveNoteMaterial,
  getPoolsForTokenV3,
  pubkeyToField,
} from '@/lib/privacy/pool/denominatedPool';
import { deriveNoteBlinding } from '@/lib/privacy/pool/noteBlinding';
import { createNoteEncryptionAddress, decryptNote, encryptNote } from '@/lib/privacy/pool/noteCrypto';
import type { KvLike } from '@/lib/waitlist/store';

/**
 * The joins the unmodified routes left, as `<rule> <row kind>`. EMPTY since
 * KV-1: every row that carried one is gone, so any finding at all is unknown
 * and the sibling case below goes red on it. KV-1 also unpinned the plan's
 * case on 2026-09-16 (it was `PINNED_AS_KNOWN_LEAK ? it.fails : it`). Web fix
 * 2 made it a plain `it` with no switch left to flip back: a join found there
 * is a new leak, not a known one.
 *
 * What was here, and what removed it:
 *   relay-to-buyer:723   p01:relay:payment:<sig>:contribution  ISSUE-1 (5),
 *                        deleted at redemption; KV-1 (3) keeps it until then
 *   contribute-note:529  p01:note:contrib-claim:<pool>:<funded>  KV-1 (1),
 *                        the write is gone: nothing ever read it
 *   contribute-note:547  p01:note:claim-minted:<code>  KV-1 (1) drops the leaf
 *                        from the value, ISSUE-1 (5) deletes the row
 *   issue-note:890       p01:note:issued:<pool>:<issued>:to  ISSUE-1 (1)
 */
const KNOWN_LEAKS: readonly string[] = [];

/**
 * ⛔ A LIVE LEAK, PINNED BY RED-0 WEB FIX 2 (2026-09-18): the rows' absolute
 * expiries tie the funded leaf to the buyer's IP bucket.
 *
 * The reserve request writes the reservation rows
 * `p01:note:contrib-reserved:<pool>:<funded>` and `:at` with a TTL of 3600
 * (app/api/contribute-note/route.ts:313-314). In the same request the rate
 * limiter writes `wl:rl:<ip bucket>:<hour>` and expires it 3600 s later
 * (lib/waitlist/store.ts:461-462). In the same hour the confirm call re-sets
 * that row's expiry, and the two no longer match. When the hour turns between
 * reserve and confirm, the confirm call writes a new hour's row instead. The
 * reserve-hour row then keeps the expiry the reserve request gave it, until
 * both expire. A backup stores both expiries and PTTL reads them back. Under
 * this file's frozen clock they are one instant. In production they are apart
 * by the reserve request's latency: the RPC calls between the rate limiter
 * (route.ts:230) and the reservation (:313). A dump holder pairs the rows
 * across that gap unless other rows expire inside it. Measured in this
 * fixture: the `hourTurns` case below with the pin OFF goes red on today's
 * routes with these two findings (web-run/logs/RED-0-webfix2/sandbox-live/
 * wp-logs/RED-0-red.log). The same holds when the buyer's IP changes between
 * reserve and confirm (mutant M5), and in every purchase's reserve-to-confirm
 * window (probe PMID). Both are in web-run/logs/RED-0-webfix2/sabotage.log.
 *
 * Owner: the rate limiter, `rateLimitExceeded` in lib/waitlist/store.ts
 * (RATE-1's file), for the leak sweep. One fix with no added latency is to
 * expire the row at its hour bucket's end with EXPIREAT, an absolute second,
 * instead of `expire(key, 3600)`. (EXPIRE with the seconds left would keep
 * the request's millisecond.) Every row of that bucket then expires at one
 * instant (neutral EN1). Mutant M4 applies exactly that in the store, and this
 * case and its sibling go red, as the fix must make them. Whoever lands it
 * sets HOUR_TURN_JOIN_PINNED to false and empties KNOWN_HOUR_TURN_LEAKS
 * (mutant M4F: then every case is green).
 *
 * ⛔ A RED SIBLING IS NOT PROOF THAT THE PRESCRIBED FIX LANDED. The sibling
 * compares findings, and the INSTANT rule ties two expiries only within one
 * second. So ANY change that moves the rate-limit row's expiry a second or
 * more from the reservation rows' reads as "the fix", including a rounding to
 * the whole minute, which leaves them 50 s apart (probe B3 in
 * web-run/logs2/verify-RED-0-r1/probe-bucket.log). With the pin off, the case
 * on the rate limiter's rows requires each `wl:rl:` row to expire at the end
 * of the hour its own key names. A minute rounding, or an hour edge that is not
 * that end, is red there (mutants M6F, M7F in web-run/logs2/RED-0-cr1/
 * sabotage.log).
 */
const HOUR_TURN_JOIN_PINNED = true;
const KNOWN_HOUR_TURN_LEAKS: readonly string[] = [
  'LINKED p01:note:contrib-reserved:<pool>:<funded>',
  'LINKED p01:note:contrib-reserved:<pool>:<funded>:at',
];

// ── the worlds ───────────────────────────────────────────────────────────────

type LeafName = 'leaf' | 'leaf2';
type BuyerName = 'rand' | 'rand2' | 'payer' | 'payer2' | 'recipient' | 'recipient2' | 'net' | 'net2';
/** A leaf world's leaves under a buyer world's buyer: the rest of the grid (header). */
type CrossName = `${LeafName}+${BuyerName}`;
type HeadName = 'base' | 'again' | LeafName | BuyerName;
type WorldName = HeadName | CrossName;

interface World {
  name: WorldName;
  /** Somebody else's deposits. The highest is the tree edge, so reserve hands out edge + 1. */
  otherLeaves: number[];
  /** The old treasury leaf the buyer is issued, and the leaf their payment funds. */
  issued: number;
  funded: number;
  /** The issued leaf's deposit slot, and how many slots ago the contribution landed. */
  issuedSlot: number;
  fundedAge: number;
  /** Seeds every random draw of the cycle: the claim code, the sealing, the shuffle. */
  randSeed: string;
  /** The paying wallet, and so the payment signature. */
  payerSeed: number;
  /** The buyer's note key, and so the recipient address. */
  buyerSeed: number;
  ip: string;
}

const BASE: World = {
  name: 'base',
  otherLeaves: [0, 1, 2, 3, 50, 100, 150, 172, 174, 200, 210],
  issued: 173,
  funded: 211,
  issuedSlot: 1_234,
  fundedAge: 5,
  randSeed: 'base',
  payerSeed: 5,
  buyerSeed: 77,
  ip: '203.0.113.7',
};

/**
 * One thing moves per world. `again` moves nothing: it is the determinism
 * control, and every other world is meaningless without it.
 */
const HEADS: Record<HeadName, World> = {
  base: BASE,
  again: { ...BASE, name: 'again' },
  leaf: {
    ...BASE,
    name: 'leaf',
    otherLeaves: [0, 1, 2, 3, 50, 100, 150, 172, 174, 200, 301],
    issued: 58,
    funded: 302,
    issuedSlot: 5_678,
    fundedAge: 9,
  },
  leaf2: {
    ...BASE,
    name: 'leaf2',
    otherLeaves: [0, 1, 2, 3, 50, 60, 63],
    issued: 9,
    funded: 64,
    issuedSlot: 4_321,
    fundedAge: 2,
  },
  rand: { ...BASE, name: 'rand', randSeed: 'rand' },
  rand2: { ...BASE, name: 'rand2', randSeed: 'rand2' },
  payer: { ...BASE, name: 'payer', payerSeed: 6 },
  payer2: { ...BASE, name: 'payer2', payerSeed: 7 },
  recipient: { ...BASE, name: 'recipient', buyerSeed: 78 },
  recipient2: { ...BASE, name: 'recipient2', buyerSeed: 79 },
  net: { ...BASE, name: 'net', ip: '198.51.100.9' },
  net2: { ...BASE, name: 'net2', ip: '192.0.2.44' },
};

/**
 * The worlds that move a leaf, and the worlds that move the buyer. Every axis
 * has two alternatives, so a function that happens to agree with one of them
 * is still read at the other (controls Y1-Y4 for the buyer side).
 */
const LEAF_WORLDS: LeafName[] = ['leaf', 'leaf2'];
const BUYER_WORLDS: BuyerName[] = ['rand', 'rand2', 'payer', 'payer2', 'recipient', 'recipient2', 'net', 'net2'];
const RECIPIENT_WORLDS: BuyerName[] = ['recipient', 'recipient2'];

/** The world holding one leaf setting's leaves and one buyer setting's buyer. */
function worldAt(leaves: 'base' | LeafName, buyer: 'base' | BuyerName): WorldName {
  if (leaves === 'base') return buyer;
  return buyer === 'base' ? leaves : `${leaves}+${buyer}`;
}

/** Where a world sits on the grid: whose leaves it holds, and whose buyer. */
function gridOf(n: WorldName): { leaves: 'base' | LeafName; buyer: 'base' | BuyerName } {
  const [a, b] = n.split('+');
  if (b !== undefined) return { leaves: a as LeafName, buyer: b as BuyerName };
  if (a === 'leaf' || a === 'leaf2') return { leaves: a, buyer: 'base' };
  if (a === 'base' || a === 'again') return { leaves: 'base', buyer: 'base' };
  return { leaves: 'base', buyer: a as BuyerName };
}

// Every world is run whatever the read lists above hold, so a list cut short
// changes what is read, and the harness's grid check says so (27 worlds).
const ALL_LEAVES: LeafName[] = ['leaf', 'leaf2'];
const ALL_BUYERS: BuyerName[] = ['rand', 'rand2', 'payer', 'payer2', 'recipient', 'recipient2', 'net', 'net2'];

/**
 * Every leaf world again under every buyer world. Without these a row that
 * exists only for leaf's leaves has no world that moves its buyer, and a row
 * that exists only for one buyer has no world that moves its leaves.
 */
const WORLDS = { ...HEADS } as Record<WorldName, World>;
for (const l of ALL_LEAVES) {
  for (const b of ALL_BUYERS) {
    const { otherLeaves, issued, funded, issuedSlot, fundedAge } = HEADS[l];
    WORLDS[`${l}+${b}`] = { ...HEADS[b], name: `${l}+${b}`, otherLeaves, issued, funded, issuedSlot, fundedAge };
  }
}

/** The grid the detector reads: three leaf settings by nine buyers, 27 worlds. */
const READ_WORLDS: WorldName[] = (['base', ...LEAF_WORLDS] as const).flatMap((l) =>
  (['base', ...BUYER_WORLDS] as const).map((b) => worldAt(l, b)),
);

// ── fixture ──────────────────────────────────────────────────────────────────

const TICKET = 'kv-rows-at-rest-ticket';
const SEED_HEX = 'cd'.repeat(32);
const SEED = Uint8Array.from(SEED_HEX.match(/../g)!.map((b) => parseInt(b, 16)));

/** Contributions are deposits, so the cycle runs in the pool open to them. */
const POOL = getPoolsForTokenV3('SOL').find((p) => p.deposits === 'open')!;
const POOL_KEY = POOL.poolPDA.toBase58();

/**
 * The clock, frozen per step and identical in every world (see the header).
 * Every world runs under both schedules. In `sameHour` the three steps share
 * one hour. In `hourTurns` the hour turns between reserve and confirm. The
 * rate limiter's rows are keyed by the hour and re-expired on every call
 * (lib/waitlist/store.ts `rateLimitExceeded`: incr, then expire 3600). So in
 * `sameHour` the confirm call re-sets the expiry of the row the reserve call
 * wrote. In `hourTurns` it writes a new row, and the reserve-hour row keeps
 * the expiry it got in the reserve request.
 */
type ClockName = 'sameHour' | 'hourTurns';
interface Clock {
  reserve: number;
  confirm: number;
  issue: number;
}
const stepsFrom = (reserve: number): Clock => ({ reserve, confirm: reserve + 41_000, issue: reserve + 79_000 });
const CLOCKS: Record<ClockName, Clock> = {
  sameHour: stepsFrom(Date.UTC(2026, 8, 16, 11, 22, 33, 456)),
  hourTurns: stepsFrom(Date.UTC(2026, 8, 16, 11, 59, 50, 456)),
};
const CLOCK_NAMES = Object.keys(CLOCKS) as ClockName[];

/** A key the buyer does not hold: ciphertext under it is not exempt. */
const OTHER_NOTE_ADDRESS = createNoteEncryptionAddress(new Uint8Array(32).fill(9));

function blockTimeOfSlot(slot: number): number {
  return 1_600_000_000 + Math.floor(slot * 0.4);
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Uint8Array): string {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

function sha256Hex(s: string | Buffer): string {
  return createHash('sha256')
    .update(typeof s === 'string' ? Buffer.from(s, 'utf8') : s)
    .digest('hex');
}

function walletOf(world: World): Keypair {
  return Keypair.fromSeed(new Uint8Array(32).fill(world.payerSeed));
}

/** A payment signature shaped like a real one: 64 bytes, base58. Deterministic. */
function signatureOf(world: World): string {
  return base58(
    nacl.sign.detached(
      new Uint8Array(Buffer.from('kvRowsAtRest till payment', 'utf8')),
      walletOf(world).secretKey,
    ),
  );
}

function treasuryCommitmentAt(leafIndex: number): bigint {
  const { secret, nullifierPreimage } = deriveNoteMaterial(SEED, POOL.poolPDA, leafIndex);
  return createCommitmentV3(
    nullifierPreimage,
    secret,
    deriveNoteBlinding(SEED, POOL.poolPDA, leafIndex),
    pubkeyToField(POOL.tokenMint),
  );
}

function treasuryNullifierPreimageAt(leafIndex: number): bigint {
  return deriveNoteMaterial(SEED, POOL.poolPDA, leafIndex).nullifierPreimage;
}

function putLeaf(leafIndex: number, commitment: bigint, depositSlot: number) {
  h.tree.set(commitment.toString(), { leafIndex, commitment, depositSlot });
}

/** The till payment as the chain reports it: the paying wallet is keys[0]. */
function paidByWallet(wallet: Keypair) {
  return {
    meta: { err: null, preBalances: [3e9, 5], postBalances: [3e9 - 1_003_000_000, 5 + 1_003_000_000] },
    transaction: {
      message: {
        getAccountKeys: () => ({
          staticAccountKeys: [{ toBase58: () => wallet.publicKey.toBase58() }, { toBase58: () => 'TILL' }],
        }),
      },
    },
  };
}

function proofFor(sig: string, wallet: Keypair): string {
  return Buffer.from(
    nacl.sign.detached(new Uint8Array(Buffer.from(claimChallenge(sig), 'utf8')), wallet.secretKey),
  ).toString('base64');
}

// ── seeded randomness ────────────────────────────────────────────────────────
//
// Every random draw the cycle makes is replaced by a counter-mode sha256 stream
// keyed by the world's `randSeed`, one stream per source so a draw added to one
// source cannot shift another. The sources are `crypto.randomUUID` (the claim
// code, contribute-note/route.ts:149), `crypto.getRandomValues` (the note
// nonce, noteCrypto.ts:141, and @noble's ML-KEM), tweetnacl's PRNG (the
// ephemeral X25519 key) and `Math.random` (the inventory shuffle,
// issue-note/route.ts:740). The `again` world proves the list is complete:
// if a source were missed, its dump would differ from base and the harness
// case goes red.

type Spy = { mockRestore: () => void };
let randomSpies: Spy[] = [];

function byteStream(label: string): (n: number) => Buffer {
  let counter = 0;
  return (n: number) => {
    const out = Buffer.alloc(n);
    for (let off = 0; off < n; off += 32) {
      createHash('sha256')
        .update(`${label}:${counter}`)
        .digest()
        .copy(out, off, 0, Math.min(32, n - off));
      counter += 1;
    }
    return out;
  };
}

function restoreRandomness(): void {
  for (const s of randomSpies) s.mockRestore();
  randomSpies = [];
  nacl.setPRNG((x: Uint8Array, n: number) => {
    for (let i = 0; i < n; i += 65536) {
      globalThis.crypto.getRandomValues(x.subarray(i, Math.min(n, i + 65536)));
    }
  });
}

function seedRandomness(seed: string): void {
  restoreRandomness();
  const values = byteStream(`${seed}:getRandomValues`);
  const uuid = byteStream(`${seed}:randomUUID`);
  const naclBytes = byteStream(`${seed}:nacl`);
  const mathRandom = byteStream(`${seed}:Math.random`);
  randomSpies.push(
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((view: ArrayBufferView) => {
      const bytes = values(view.byteLength);
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(bytes);
      return view;
    }) as never),
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation((() => {
      const b = uuid(16);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const x = b.toString('hex');
      return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
    }) as never),
    vi.spyOn(Math, 'random').mockImplementation(() => {
      const b = mathRandom(8);
      return Number(b.readBigUInt64BE() >> 11n) / 2 ** 53;
    }),
  );
  nacl.setPRNG((x: Uint8Array, n: number) => {
    x.set(naclBytes(n));
  });
}

// ── the recording store ──────────────────────────────────────────────────────

interface Row {
  key: string;
  /** A scalar's value as a dump prints it, or a set's members. */
  values: string[];
  ttlSeconds: number | null;
  /**
   * When the row expires, in ms since the epoch: what a backup stores and
   * what PTTL reads back. Absent on planted rows that have no expiry.
   */
  expiresAtMs?: number | null;
}

function clone<T>(v: T): T {
  return v === null || typeof v !== 'object' ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/**
 * A value as a dump prints it: never `undefined`, never a throw. Round-1
 * verifier probe P10 (wp-logs/verify/RED-0-r1-detector-probe.log): a row
 * stored as `undefined` used to reach the detector as `undefined` and crash
 * it, and under `it.fails` that crash read as "the leak is still there".
 */
function dumpText(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
}

/** Redis semantics for every KvLike method, and nothing forgotten. */
class RecordingKv implements KvLike {
  readonly scalars = new Map<string, unknown>();
  readonly sets = new Map<string, Set<string>>();
  /**
   * Per expiring key: the TTL as last set, and the ABSOLUTE expiry it gives.
   * Redis keeps the absolute expiry, to the millisecond. A backup stores it
   * and PTTL reads it back, so two rows given one TTL in one request expire
   * within that request's latency of each other (at one instant under this
   * file's frozen clock). Until web fix 2 only the TTL was kept, and that tie
   * went unseen (web-run/logs/verify-RED-0-r1/probe-hourStraddle.log). SET with EX
   * sets it and SET without EX clears it. INCR and SADD keep it. EXPIRE resets
   * it from the (frozen) clock. DEL, or an SREM that empties a set, drops it.
   */
  readonly expiries = new Map<string, { seconds: number | null; atMs: number }>();

  async get<T>(key: string): Promise<T | null> {
    return (this.scalars.has(key) ? clone(this.scalars.get(key)) : null) as T | null;
  }
  async set(key: string, value: unknown, opts?: { ex?: number }): Promise<void> {
    this.scalars.set(key, clone(value));
    if (opts?.ex) this.expiries.set(key, { seconds: opts.ex, atMs: Date.now() + opts.ex * 1000 });
    else this.expiries.delete(key);
  }
  async del(key: string): Promise<void> {
    this.scalars.delete(key);
    this.sets.delete(key);
    this.expiries.delete(key);
  }
  async incr(key: string): Promise<number> {
    const n = Number(this.scalars.get(key) ?? 0) + 1;
    this.scalars.set(key, n);
    return n;
  }
  async expire(key: string, seconds: number): Promise<void> {
    if (this.scalars.has(key) || (this.sets.get(key)?.size ?? 0) > 0) {
      this.expiries.set(key, { seconds, atMs: Date.now() + seconds * 1000 });
    }
  }
  async sadd(key: string, member: string): Promise<void> {
    const s = this.sets.get(key) ?? new Set<string>();
    s.add(String(member));
    this.sets.set(key, s);
  }
  async srem(key: string, member: string): Promise<void> {
    const s = this.sets.get(key);
    s?.delete(String(member));
    if (s && s.size === 0) {
      this.sets.delete(key);
      this.expiries.delete(key);
    }
  }
  async scard(key: string): Promise<number> {
    return this.sets.get(key)?.size ?? 0;
  }
  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }
  async mget(keys: string[]): Promise<(number | null)[]> {
    return keys.map((k) => {
      const v = this.scalars.get(k);
      return v === undefined || v === null ? null : Number(v);
    });
  }

  /** Everything a dump would show, expiries included. An expiring row is still in the dump. */
  rows(): Row[] {
    const out: Row[] = [];
    const expiry = (key: string) => {
      const e = this.expiries.get(key);
      return { ttlSeconds: e?.seconds ?? null, expiresAtMs: e?.atMs ?? null };
    };
    for (const [key, v] of this.scalars) {
      out.push({ key, values: [dumpText(v)], ...expiry(key) });
    }
    for (const [key, members] of this.sets) {
      if (members.size > 0) out.push({ key, values: [...members], ...expiry(key) });
    }
    return out;
  }
}

// ── the detector ─────────────────────────────────────────────────────────────
//
// Every rule below is about what MOVES a row, not about how a value is spelled.
// The worlds are in the header. Each world of the grid is read in turn as the
// reference (`findings`); "the leaves" and "the buyer" below are the worlds
// that differ from that reference in its leaves or its buyer only
// (`neighboursOf`). At `base` they are LEAF_WORLDS and BUYER_WORLDS.
//
//   MOVED WITH  A row moved with a world when that world's dump has no row
//               under its key, or the row under that key differs in its value,
//               its set members, its TTL or its absolute expiry. Ciphertext the buyer's own seed
//               opens is replaced first, in every world, by one word and its
//               length, so the note handed to the buyer does not read as a
//               difference but a length that moves still does.
//   JOIN        A row that moved with the leaves AND either moved with the
//               buyer, or carries a token that no world moves and that is not
//               a plain word, a short number, an ISO date or the pool key.
//               That second half is the belt for an identity this fixture does
//               not vary (see the header); the first half needs no list.
//   LINKED      Rows sharing a precise token, in a key or inside a value, form
//               one component: a timestamp to the second; a number that is not
//               a round amount and has 10+ digits or sits in exactly two rows
//               (a sequence number rather than a counter); a token with a
//               letter in it that the production code never writes; one sealed
//               blob; one INSTANT (below). A row that moved with the leaves and
//               whose component holds a row that moved with the buyer (or
//               carries such an unmoved token) is a finding.
//   INSTANT     No world moves the clock, so time can tie rows only by what
//               they share. A row carries three kinds of instant: its absolute
//               expiry (a backup stores it to the millisecond, PTTL reads it);
//               the instant its TTL was set (the expiry less the TTL, which is
//               a constant in the public code); and every time a key or value
//               spells to the second (ISO, epoch seconds or ms). Two rows whose
//               instants lie within one second of each other are one
//               component. Like is compared with like (expiry with expiry, set
//               with set), and a spelled time with either. Two spelled times
//               tie here only when spelled differently: the same spelling is
//               the token rule's (P12, P22, Q17). An instant on a whole minute
//               is a bucket's end. Every row of the bucket shares it, so it
//               ties nothing (EN1).
//   RECIPIENT   A row that moved with a world that moves the recipient alone
//               (where the grid has one), or that holds the address, a 16+
//               character piece of it, or its sha256.
//
// Tokens are read after splitting on every non-alphanumeric character; a token
// "moves with X" when some X world that holds a row of its row's shape
// (`shapeOf`) does not hold the token anywhere.

/** An ISO-8601 date or time stays one token, so its digits are not read as numbers. */
const ISO_TIME = /(?:19|20)\d{2}-\d{2}-\d{2}(?:T\d{2}(?::\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:\d{2})?)?/g;

/** Split on every non-alphanumeric character. Hex-looking tokens are lower-cased. */
function tokensOf(text: string): string[] {
  const out: string[] = [];
  const rest = text.replace(ISO_TIME, (m) => {
    out.push(`iso:${m}`);
    return ' ';
  });
  for (const t of rest.split(/[^A-Za-z0-9]+/)) {
    if (t) out.push(/^(0x)?[0-9a-f]+$/i.test(t) ? t.toLowerCase() : t);
  }
  return out;
}

/** A sealed note as `encryptNote` writes it (noteCrypto.ts: `p01enc1:` + base64). */
const SEALED_BLOB = /p01enc1:[A-Za-z0-9+/=]+/g;
/** What `redactSealed` leaves of such a blob: one word and the blob's length. */
const SEALED_MARK = /sealedtobuyer:\d+/g;
const opened = new Map<string, boolean>();

/**
 * Ciphertext the buyer's own seed opens, replaced by one word AND ITS LENGTH.
 *
 * This is the only exemption, and it is stated by WHO CAN OPEN IT rather than
 * by how it looks: a blob under any other key stays in the row and moves with
 * whatever it encrypts (positive controls X10, X10b). Without it the note this
 * deployment seals to the buyer would move with every world and read as a join
 * on the row that stores it (neutral case N5, and sabotage S20).
 *
 * ⛔ WHAT ANYBODY CAN READ OF A BLOB IS KEPT. Its content needs the buyer's
 * key; its length and its identity need no key at all. The note is JSON, so
 * its length follows the digits of the leaf: before the issue-note pad the
 * stored reply was 2668 characters in base and 2660 in both leaf worlds
 * (wp-logs/verify/RED-0-r3-blob-length-probe.log), and a redaction to one word
 * hid that (controls X11, X11b; sabotage L1 in
 * web-run/logs/RED-0-webfix1/sabotage.log). And one blob stored in two rows
 * ties those rows, as any shared id does: each blob's sha256 is handed to
 * LINKED through `blobs` (control X12; sabotage L2).
 */
function redactSealed(text: string, buyerSeed: Uint8Array, blobs?: string[]): string {
  return text.replace(SEALED_BLOB, (blob) => {
    const memo = `${Buffer.from(buyerSeed).toString('hex')}:${blob}`;
    let ok = opened.get(memo);
    if (ok === undefined) {
      try {
        decryptNote(buyerSeed, blob);
        ok = true;
      } catch {
        ok = false;
      }
      opened.set(memo, ok);
    }
    if (!ok) return blob;
    blobs?.push(sha256Hex(blob));
    return `sealedtobuyer:${blob.length}`;
  });
}

interface ReadRow {
  row: Row;
  key: string;
  values: string[];
  /** Key, values, TTL and absolute expiry as one string: what "the row moved" compares. */
  signature: string;
  tokens: string[];
  /**
   * The tokens again, without what `redactSealed` left of a blob: a length two
   * blobs share (every padded note has one) links nothing (neutral N18,
   * sabotage L3), the blob itself links through `blobs`.
   */
  idTokens: string[];
  /** The sha256 of each blob the buyer opens, as stored in this row. */
  blobs: string[];
  /** What this row carries of the clock (the INSTANT rule). */
  instants: Instant[];
  /** The key's shape (`shapeOf`): a world holding a row of this shape holds this row. */
  shape: string;
}

/** Two instants closer than this are one: "to the second" (header). */
const INSTANT_WINDOW_MS = 1_000;

interface Instant {
  /** `expiry`: when the row expires. `set`: when its TTL was set. `value`: a time a key or value spells. */
  kind: 'expiry' | 'set' | 'value';
  ms: number;
  /** The token a `value` instant was read from. */
  token?: string;
}

/** A whole minute is a bucket's end (an EXPIREAT to the hour): every row of the bucket shares it (EN1). */
function onBucketEdge(ms: number): boolean {
  return ms % 60_000 === 0;
}

/**
 * A token that spells an instant to the second: an ISO time with seconds, or
 * epoch seconds (10 digits) or ms (13 digits) from 2017 to 2103 that are not
 * a round amount (N9's rule).
 */
function instantOfToken(t: string): number | null {
  const iso = /^iso:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:\d{2})?$/.exec(t);
  if (iso) {
    const ms = Date.parse(`${iso[1]}${iso[2] ?? 'Z'}`);
    return Number.isFinite(ms) ? ms : null;
  }
  if (!/^(\d{10}|\d{13})$/.test(t) || /0{5}$/.test(t)) return null;
  const ms = t.length === 10 ? Number(t) * 1000 : Number(t);
  return ms >= 1.5e12 && ms < 4.2e12 ? ms : null;
}

function instantsOf(row: Row, texts: string[]): Instant[] {
  const out: Instant[] = [];
  const expiry = row.expiresAtMs ?? null;
  if (expiry !== null && !onBucketEdge(expiry)) {
    out.push({ kind: 'expiry', ms: expiry });
    if (row.ttlSeconds !== null) out.push({ kind: 'set', ms: expiry - row.ttlSeconds * 1000 });
  }
  for (const t of new Set(texts.flatMap((s) => tokensOf(s.replace(SEALED_MARK, ' '))))) {
    const ms = instantOfToken(t);
    if (ms !== null && !onBucketEdge(ms)) out.push({ kind: 'value', ms, token: t });
  }
  return out;
}

/** Like with like, and a spelled time with either; two spelled times only across spellings. */
function instantsTie(x: Instant, y: Instant): boolean {
  if (Math.abs(x.ms - y.ms) >= INSTANT_WINDOW_MS) return false;
  if (x.kind === 'value' && y.kind === 'value') return x.token !== y.token;
  return x.kind === y.kind || x.kind === 'value' || y.kind === 'value';
}

function readRow(row: Row, buyerSeed: Uint8Array): ReadRow {
  const blobs: string[] = [];
  const key = redactSealed(String(row.key), buyerSeed, blobs);
  const values = row.values.map((v) => redactSealed(dumpText(v), buyerSeed, blobs));
  const sorted = [...values].sort();
  return {
    row,
    key,
    values,
    signature: JSON.stringify([key, row.ttlSeconds ?? 'none', row.expiresAtMs ?? 'none', sorted]),
    tokens: [...new Set([key, ...values].flatMap(tokensOf))],
    idTokens: [...new Set([key, ...values].flatMap((s) => tokensOf(s.replace(SEALED_MARK, ' '))))],
    blobs: [...new Set(blobs)],
    instants: instantsOf(row, [key, ...values]),
    shape: shapeOf(key),
  };
}

/**
 * A key with every token the production code does not write replaced by a
 * star, after any 16+ character base64, base58 or hex run is made one token
 * (so a blob's padding cannot change the count). `p01:note:contrib-reserved:
 * <pool>:211:at` and `…:302:at` share one shape, and so do two sealed
 * replies under two codes. A token can only MOVE where a row of its row's
 * shape exists: in a world without one, its absence says nothing about the
 * token (controls G5, G7; sabotage R6). Stars keep the shape of a leaf named by
 * its hash the same in every world (neutral N11, GN4; sabotage R7).
 */
function shapeOf(key: string): string {
  return tokensOf(key.replace(/[A-Za-z0-9+/]{16,}={0,2}/g, ':0:'))
    .map((t) => (sourceWords().has(t) ? t : '*'))
    .join(':');
}

let sourceWordsMemo: ReadonlySet<string> | null = null;

/**
 * Every token with a letter in it that the production code writes literally:
 * key prefixes, JSON field names, fixed strings. Read from `app/api` and `lib`
 * (test files excluded), the two trees that write to the store. A dump holder
 * reads these words in the public repository and finds them in every
 * purchase's rows, so two rows sharing one share vocabulary, not a purchase
 * (neutral N16; without this set N8, N9, N15, N16 and N17 read as joins,
 * sabotage T3 in web-run/logs/RED-0-webfix1/sabotage.log). A line over 2000
 * characters is data, not vocabulary (the STARK wasm in
 * `lib/privacy/pool/starkWasmData.ts` is one 353,804-character line,
 * web-run/logs/RED-0-webfix1/source-lines.log).
 */
function sourceWords(): ReadonlySet<string> {
  if (sourceWordsMemo) return sourceWordsMemo;
  const words = new Set<string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p);
      } else if (/\.(ts|tsx|mts)$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) {
        for (const line of readFileSync(p, 'utf8').split('\n')) {
          if (line.length > 2000) continue;
          for (const t of tokensOf(line)) if (/[A-Za-z]/.test(t)) words.add(t);
        }
      }
    }
  };
  const web = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  walk(join(web, 'app', 'api'));
  walk(join(web, 'lib'));
  sourceWordsMemo = words;
  return words;
}

interface Dump {
  rows: Row[];
  view: View;
}

interface ReadDump {
  reads: ReadRow[];
  byKey: Map<string, string>;
  tokens: Set<string>;
  shapes: Set<string>;
}

function readDump(dump: Dump): ReadDump {
  const reads = dump.rows.map((r) => readRow(r, dump.view.buyerSeed));
  const byKey = new Map<string, string>();
  const tokens = new Set<string>();
  const shapes = new Set<string>();
  for (const r of reads) {
    byKey.set(r.key, r.signature);
    for (const t of r.tokens) tokens.add(t);
    shapes.add(r.shape);
  }
  return { reads, byKey, tokens, shapes };
}

/** A token of a plain shape that no world moves carries no identity by itself. */
function neutralShape(t: string, poolKey: string): boolean {
  return (
    t === poolKey ||
    t.startsWith('iso:') ||
    /^\d{1,13}$/.test(t) ||
    /^[a-z]{1,15}$/i.test(t) ||
    /^[a-z]{1,4}\d{1,2}$/i.test(t)
  );
}

function preview(s: string): string {
  return s.length > 140 ? `${s.slice(0, 140)}…(${s.length} chars)` : s;
}

/** A row key with this world's values replaced by placeholders: stable across runs. */
function kindOf(key: string, v: View): string {
  let k = key.split(POOL_KEY).join('<pool>');
  for (const id of identitiesOf(v)) k = k.split(id.raw).join(`<${id.tag}>`);
  for (const [label, index] of [
    ['funded', v.funded],
    ['issued', v.issued],
  ] as const) {
    k = k.replace(new RegExp(`(^|:)${index}(?=:|$)`, 'g'), `$1<${label}>`);
  }
  return k;
}

interface Finding {
  rule: 'JOIN' | 'LINKED' | 'RECIPIENT';
  kind: string;
  text: string;
}

/**
 * The worlds a reference is read against: those that differ from it in ONE
 * thing. Its leaf neighbours hold its buyer and other leaves; its buyer
 * neighbours hold its leaves and another buyer (each differs from it in one
 * buyer attribute, or in two when the reference itself holds an alternative).
 * Its recipient neighbours move the recipient alone, which the grid offers
 * only when the reference's buyer is base's or a recipient alternative. At
 * `base` these are exactly LEAF_WORLDS, BUYER_WORLDS and RECIPIENT_WORLDS.
 */
function neighboursOf(ref: WorldName): { leaves: WorldName[]; buyer: WorldName[]; recipient: WorldName[] } {
  const me = gridOf(ref);
  const onRecipientAxis = (b: 'base' | BuyerName) => b === 'base' || RECIPIENT_WORLDS.includes(b);
  const buyer = READ_WORLDS.filter((w) => w !== ref && gridOf(w).leaves === me.leaves);
  return {
    leaves: READ_WORLDS.filter((w) => w !== ref && gridOf(w).buyer === me.buyer),
    buyer,
    recipient: onRecipientAxis(me.buyer) ? buyer.filter((w) => onRecipientAxis(gridOf(w).buyer)) : [],
  };
}

/**
 * Every world of the grid is read in turn as the reference, so a row that
 * exists only in some worlds is examined where it exists. Until the continued
 * run's fix round 1 only base was read, and a row absent from base was never
 * examined (web-run/logs2/verify-RED-0-r1/probe-PM1.log; controls D1-D4, PM3,
 * G1-G6; sabotage R1). A finding is reported once per rule and row kind, with
 * the worlds it was read in.
 */
function findings(dumps: Record<string, Dump>): Finding[] {
  const read: Record<string, ReadDump> = {};
  for (const name of READ_WORLDS) read[name] = readDump(dumps[name]);
  const byKind = new Map<string, { finding: Finding; worlds: WorldName[] }>();
  for (const ref of READ_WORLDS) {
    for (const f of findingsFrom(ref, read, dumps[ref].view)) {
      const id = `${f.rule} ${f.kind}`;
      const seen = byKind.get(id);
      if (seen) seen.worlds.push(ref);
      else byKind.set(id, { finding: f, worlds: [ref] });
    }
  }
  return [...byKind.values()].map(({ finding, worlds }) => ({
    ...finding,
    text: `${finding.text} [read in ${worlds.slice(0, 4).join(', ')}${worlds.length > 4 ? ` and ${worlds.length - 4} more` : ''}]`,
  }));
}

/** The rules above, with `ref` as the dump being read (`here`) and its neighbours as the moved worlds. */
function findingsFrom(ref: WorldName, read: Record<string, ReadDump>, view: View): Finding[] {
  const here = read[ref];
  const near = neighboursOf(ref);

  const movedIn = (r: ReadRow, world: string): boolean => {
    const there = read[world].byKey.get(r.key);
    return there === undefined || there !== r.signature;
  };
  const movedWith = (r: ReadRow, worlds: WorldName[]) => worlds.filter((w) => movedIn(r, w));
  /** The worlds that hold a row of r's shape: only there can r's tokens move (`shapeOf`). */
  const holding = (r: ReadRow, worlds: WorldName[]) => worlds.filter((w) => read[w].shapes.has(r.shape));
  const tokenMoves = (r: ReadRow, t: string, worlds: WorldName[]) =>
    holding(r, worlds).filter((w) => !read[w].tokens.has(t));

  const leafMoved = here.reads.map((r) => movedWith(r, near.leaves));
  const buyerMoved = here.reads.map((r) => movedWith(r, near.buyer));
  /**
   * Tokens no world moves and whose shape is not a plain word or a short
   * number. Read only where a world on EACH side holds a row of this shape:
   * with none on one side, a token staying put on the other says nothing (a
   * hash of a leaf, on a row written for one leaf setting only, would read as
   * an identity nobody moves: neutral GN5, sabotage R8).
   */
  const unmoved = here.reads.map((r) =>
    holding(r, near.leaves).length === 0 || holding(r, near.buyer).length === 0
      ? []
      : r.tokens.filter(
          (t) =>
            tokenMoves(r, t, near.leaves).length === 0 &&
            tokenMoves(r, t, near.buyer).length === 0 &&
            !neutralShape(t, POOL_KEY),
        ),
  );

  const carriesBuyer = (i: number) => buyerMoved[i].length > 0 || unmoved[i].length > 0;
  const shown = (r: ReadRow) => `${preview(r.key)} = ${r.values.map(preview).join(' | ')}`;
  const why = (i: number) => {
    const parts: string[] = [];
    if (leafMoved[i].length > 0) parts.push(`moves with the leaves (${leafMoved[i].join(', ')})`);
    if (buyerMoved[i].length > 0) parts.push(`moves with the buyer (${buyerMoved[i].join(', ')})`);
    if (unmoved[i].length > 0) {
      parts.push(
        `carries ${unmoved[i]
          .slice(0, 3)
          .map((t) => JSON.stringify(t.length > 20 ? `${t.slice(0, 20)}…` : t))
          .join(', ')} which no world moves`,
      );
    }
    return parts.join(' and ');
  };
  const out: Finding[] = [];

  here.reads.forEach((r, i) => {
    if (leafMoved[i].length > 0 && carriesBuyer(i)) {
      out.push({ rule: 'JOIN', kind: kindOf(r.row.key, view), text: `JOIN ${shown(r)} :: ${why(i)}` });
    }
  });

  // Rows a reader can match to one another by a value precise enough to be this
  // purchase's, read token by token in keys and inside values alike. A token
  // that moves with the leaves is left to JOIN; one that moves with the buyer
  // needs no clause of its own, since the row holding it already moved with
  // the buyer.
  //
  // Until round 3 a short value counted only when it was a row's WHOLE value,
  // so `ref=<15 letters>;n=1` in a leaf row and a payment row was read as a
  // constant (wp-logs/verify/RED-0-r3-detector-probe.log, Z3). The token
  // clauses below cover what that rule and a 16+ character rule did: removing
  // either one from the file turned nothing red once they were in
  // (web-run/logs/RED-0-webfix1/redundancy-probe.log), so both were folded in.
  const tokenRows = new Map<string, number>();
  for (const r of here.reads) {
    for (const t of r.idTokens) tokenRows.set(t, (tokenRows.get(t) ?? 0) + 1);
  }
  const linkTokensOf = (r: ReadRow): Set<string> => {
    const out2 = new Set<string>();
    for (const t of r.idTokens) {
      if (t === POOL_KEY || tokenMoves(r, t, near.leaves).length > 0) continue;
      if (t.startsWith('iso:')) {
        // A timestamp to the second (P22). An hour bucket is not one.
        if (/T\d{2}:\d{2}:\d{2}/.test(t)) out2.add(t);
      } else if (/^\d+$/.test(t)) {
        // Never a round amount: that is a price (N9). Ten digits or more is an
        // epoch or a value in base units, whatever holds it (P12, P12b). Fewer
        // held by exactly two rows is a sequence number (Q7, Z3c); held by
        // three rows or more it is a count, like the counters that all read 1
        // (N15, N17).
        if (!/0{5}$/.test(t) && (t.length >= 10 || tokenRows.get(t) === 2)) out2.add(t);
      } else if (!sourceWords().has(t)) {
        // A token with a letter in it that the production code never writes:
        // an id (P7, P8, Z3, Z3b, Z3d). What the code writes is in every
        // purchase's rows and ties nothing (N16).
        out2.add(t);
      }
    }
    // One sealed blob in two rows ties them, whatever it holds (X12). Two
    // different blobs of one padded length do not (N18).
    for (const b of r.blobs) out2.add(`blob:${b}`);
    return out2;
  };

  const parent = here.reads.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map<string, number>();
  here.reads.forEach((r, i) => {
    for (const t of linkTokensOf(r)) {
      const j = owner.get(t);
      if (j === undefined) owner.set(t, i);
      else parent[find(i)] = find(j);
    }
  });
  // The INSTANT rule (header of this section). Until web fix 2 the store kept
  // only the TTL, so rows written in one request with one TTL, which a backup
  // or PTTL shows expiring together, tied nothing: the round-3 verifier
  // measured the funded leaf's reservation rows expiring with the buyer's
  // rate-limit row, 0 findings (web-run/logs/verify-RED-0-r1/
  // probe-hourStraddle.log). A spelled time that moves with the leaves is
  // left to JOIN, as a token is above.
  const sharedInstants = here.reads.map(() => new Set<string>());
  const usable = here.reads.map((r) =>
    r.instants.filter((x) => x.kind !== 'value' || tokenMoves(r, x.token ?? '', near.leaves).length === 0),
  );
  for (let i = 0; i < here.reads.length; i += 1) {
    for (let j = i + 1; j < here.reads.length; j += 1) {
      for (const x of usable[i]) {
        for (const y of usable[j]) {
          if (!instantsTie(x, y)) continue;
          parent[find(i)] = find(j);
          sharedInstants[i].add(`${x.kind} ${new Date(x.ms).toISOString()}`);
          sharedInstants[j].add(`${y.kind} ${new Date(y.ms).toISOString()}`);
        }
      }
    }
  }
  here.reads.forEach((r, i) => {
    if (leafMoved[i].length === 0) return;
    const reach = here.reads.filter((_, j) => j !== i && find(j) === find(i) && carriesBuyer(j));
    if (reach.length > 0) {
      const instants = sharedInstants[i].size > 0 ? ` (${[...sharedInstants[i]].slice(0, 2).join(', ')})` : '';
      out.push({
        rule: 'LINKED',
        kind: kindOf(r.row.key, view),
        text: `LINKED ${shown(r)} :: ${why(i)}, and shares a value${instants} with ${reach
          .map((x) => preview(x.key))
          .join(', ')}`,
      });
    }
  });

  const recipientHashes = new Set([sha256Hex(view.recipient), sha256Hex(view.recipient).slice(0, 16)]);
  here.reads.forEach((r, i) => {
    const holds =
      near.recipient.some((w) => movedIn(r, w)) ||
      [r.key, ...r.values].some((s) => s.includes(view.recipient)) ||
      r.tokens.some((t) => recipientHashes.has(t) || (t.length >= 16 && view.recipient.includes(t)));
    if (holds) {
      out.push({
        rule: 'RECIPIENT',
        kind: kindOf(r.row.key, view),
        text: `RECIPIENT ${shown(r)} :: ${why(i) || 'holds the note address'}`,
      });
    }
  });
  return out;
}

// ── the cycle ────────────────────────────────────────────────────────────────

function request(path: string, body: unknown, ip: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-p01-funder-ticket': TICKET,
      'x-real-ip': ip,
      'x-forwarded-for': ip,
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

interface Step {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  handler: (req: NextRequest) => Promise<Response>,
  path: string,
  body: unknown,
  ip: string,
): Promise<Step> {
  const res = await handler(request(path, body, ip));
  await drainAfter();
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Everything a planted row may name, per world. No rule reads it; the cases do. */
interface View {
  name: WorldName;
  funded: number;
  issued: number;
  fundedCommitment: bigint;
  issuedCommitment: bigint;
  issuedNullifier: bigint;
  issuedSlot: number;
  issuedTime: string;
  sig: string;
  wallet: string;
  code: string;
  recipient: string;
  buyerSeed: Uint8Array;
  ip: string;
  /** This world's sealed note, and one sealed to a key the buyer does not hold. */
  sealed: string;
  otherSealed: string;
  /** The same note sealed to the buyer without the route's pad, and a blob whose length is the leaf's. */
  unpadded: string;
  lengthSealed: string;
  /** A different blob sealed to the buyer, of the padded note's length. */
  samePad: string;
  /** The leaf sealed to another key at one length in every world. */
  otherPadded: string;
  issueBody: Record<string, unknown>;
  /** A value that only the `rand` world moves: 64 hex characters. */
  rand: (label: string) => string;
}

function identitiesOf(v: View): Array<{ label: string; tag: string; raw: string }> {
  return [
    { label: 'payment signature', tag: 'sig', raw: v.sig },
    { label: 'claim code', tag: 'code', raw: v.code },
    { label: 'recipient', tag: 'recipient', raw: v.recipient },
    { label: 'paying wallet', tag: 'wallet', raw: v.wallet },
  ];
}

interface Cycle {
  world: World;
  error?: unknown;
  steps: Record<string, Step>;
  rows: Row[];
  claimCode?: string;
  sealedNote?: string;
  otherSealed?: string;
  unpaddedSealed?: string;
  lengthSealed?: string;
  samePadSealed?: string;
  otherPadded?: string;
  /** The commitment the sealed note opens to, recomputed from its secrets. */
  openedCommitment?: bigint;
}

async function runCycle(world: World, clock: Clock): Promise<Cycle> {
  const cycle: Cycle = { world, steps: {}, rows: [] };
  const kv = new RecordingKv();
  const wallet = walletOf(world);
  const sig = signatureOf(world);
  const buyerSeed = new Uint8Array(32).fill(world.buyerSeed);
  const recipient = createNoteEncryptionAddress(buyerSeed);
  h.store = kv;
  h.deferred.length = 0;
  h.paymentTx = paidByWallet(wallet);
  try {
    h.tree = new Map();
    world.otherLeaves.forEach((leaf, i) => putLeaf(leaf, 1_000_003n + BigInt(i) * 7919n, 1_000));
    putLeaf(world.issued, treasuryCommitmentAt(world.issued), world.issuedSlot);
    seedRandomness(world.randSeed);

    vi.setSystemTime(clock.reserve);
    cycle.steps.reserve = await call(contributeNote, '/api/contribute-note', {
      action: 'reserve',
      token: 'SOL',
    }, world.ip);

    // What `/api/relay-to-buyer` leaves once the float has funded the deposit.
    await kv.incr(relayPaymentClaimKey(sig));
    await kv.set(relayPaymentContributionKey(sig), contributionBinding(POOL_KEY, world.funded));

    // The deposit lands: the treasury's commitment at the funded leaf, young.
    putLeaf(world.funded, treasuryCommitmentAt(world.funded), h.currentSlot - world.fundedAge);

    vi.setSystemTime(clock.confirm);
    cycle.steps.confirm = await call(contributeNote, '/api/contribute-note', {
      action: 'confirm',
      token: 'SOL',
      leafIndex: world.funded,
      paymentSignature: sig,
      proof: proofFor(sig, wallet),
    }, world.ip);
    cycle.claimCode = String(cycle.steps.confirm.body.claimCode ?? '');

    vi.setSystemTime(clock.issue);
    cycle.steps.issue = await call(issueNote, '/api/issue-note', {
      recipientAddress: recipient,
      token: 'SOL',
      denomination: POOL.denomination,
      claimCode: cycle.claimCode,
    }, world.ip);

    const sealed = cycle.steps.issue.body.sealedNote;
    let openedText: string | undefined;
    if (typeof sealed === 'string') {
      cycle.sealedNote = sealed;
      openedText = Buffer.from(decryptNote(buyerSeed, sealed)).toString('utf8');
      const note = JSON.parse(openedText) as Record<string, string>;
      cycle.openedCommitment = createCommitmentV3(
        BigInt(note.nullifier_preimage),
        BigInt(note.secret),
        BigInt(note.deposit_epoch),
        BigInt(note.token_mint),
      );
    }
    // Drawn from the same seeded stream, so it is ciphertext this world would
    // really have produced — for a key the buyer does not hold (control X10).
    cycle.otherSealed = encryptNote(
      OTHER_NOTE_ADDRESS,
      new TextEncoder().encode(JSON.stringify({ pool: POOL_KEY, leaf: world.issued })),
    );
    // Both sealed to the buyer, so both are exempt from being read and only
    // their length is left to a dump. The first is this world's note without
    // the route's pad (issue-note `paddedNote` appends spaces, so trimming
    // them gives back the JSON the route sealed before ISSUE-1's pad): the
    // stored reply as it was then (control X11). The second carries the leaf
    // in its length by construction (control X11b; the round-3 verifier's
    // probe Z1).
    if (openedText !== undefined) {
      cycle.unpaddedSealed = encryptNote(recipient, new TextEncoder().encode(openedText.trimEnd()));
    }
    cycle.lengthSealed = encryptNote(recipient, new TextEncoder().encode('x'.repeat(200 + world.issued)));
    // Another blob sealed to the buyer at the padded note's size. Every padded
    // blob has that one length, so sharing it ties nothing (neutral N18).
    if (openedText !== undefined) {
      cycle.samePadSealed = encryptNote(
        recipient,
        new TextEncoder().encode('{}'.padEnd(Buffer.byteLength(openedText, 'utf8'))),
      );
    }
    // The leaf under a key the buyer does not hold, padded so its length is the
    // same in every world: only its content moves (control X10b). Whoever holds
    // that key reads the leaf, so it is compared whole.
    cycle.otherPadded = encryptNote(
      OTHER_NOTE_ADDRESS,
      new TextEncoder().encode(JSON.stringify({ pool: POOL_KEY, leaf: world.issued }).padEnd(128)),
    );
  } catch (e) {
    cycle.error = e;
  }
  cycle.rows = kv.rows();
  return cycle;
}

function viewOf(cycle: Cycle): View {
  const world = cycle.world;
  const buyerSeed = new Uint8Array(32).fill(world.buyerSeed);
  return {
    name: world.name,
    funded: world.funded,
    issued: world.issued,
    fundedCommitment: treasuryCommitmentAt(world.funded),
    issuedCommitment: treasuryCommitmentAt(world.issued),
    issuedNullifier: treasuryNullifierPreimageAt(world.issued),
    issuedSlot: world.issuedSlot,
    issuedTime: new Date(blockTimeOfSlot(world.issuedSlot) * 1000).toISOString(),
    sig: signatureOf(world),
    wallet: walletOf(world).publicKey.toBase58(),
    code: cycle.claimCode || `no-claim-code-${world.randSeed}`,
    recipient: createNoteEncryptionAddress(buyerSeed),
    buyerSeed,
    ip: world.ip,
    sealed: cycle.sealedNote ?? '',
    otherSealed: cycle.otherSealed ?? '',
    unpadded: cycle.unpaddedSealed ?? '',
    lengthSealed: cycle.lengthSealed ?? '',
    samePad: cycle.samePadSealed ?? '',
    otherPadded: cycle.otherPadded ?? '',
    issueBody: cycle.steps.issue?.body ?? {},
    rand: (label: string) => sha256Hex(`${world.randSeed}:${label}`),
  };
}

/** Every cycle, per clock. `cycles` and `views` are the `sameHour` ones, which the plan's case reads. */
let runs: Record<ClockName, Record<WorldName, Cycle>>;
let runViews: Record<ClockName, Record<WorldName, View>>;
let cycles: Record<WorldName, Cycle>;
let views: Record<WorldName, View>;

beforeAll(async () => {
  vi.stubEnv('P01_TREASURY_POOL_SEED', SEED_HEX);
  vi.stubEnv('P01_FUNDER_TICKET', TICKET);
  vi.stubEnv('P01_TREASURY_NOTE_DENOMINATION', String(POOL.denomination));
  vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '');
  vi.stubEnv('P01_TREASURY_NOTE_MIN_AGE_SLOTS', '');
  // Realm plumbing, not behaviour. Under this jsdom config tweetnacl and the
  // test context share jsdom's Uint8Array, and TextEncoder's bytes are not
  // one (RED-0 probe: `teOutGlobal: false, naclRandGlobal: true`), so
  // nacl.secretbox in encryptNote refuses the note. Same bytes, same realm.
  vi.stubGlobal(
    'TextEncoder',
    class {
      readonly encoding = 'utf-8';
      encode(s = ''): Uint8Array {
        return new Uint8Array(Buffer.from(s, 'utf8'));
      }
    },
  );
  // Only Date is faked: the routes read the clock (contribute-note:318, the
  // rate limiter's hour bucket) and a clock that ran between two worlds would
  // read as a difference. Timers themselves stay real.
  vi.useFakeTimers({ toFake: ['Date'] });
  const ran = {} as Record<ClockName, Record<WorldName, Cycle>>;
  for (const clock of CLOCK_NAMES) {
    ran[clock] = {} as Record<WorldName, Cycle>;
    for (const name of Object.keys(WORLDS) as WorldName[]) {
      ran[clock][name] = await runCycle(WORLDS[name], CLOCKS[clock]);
    }
  }
  runs = ran;
  restoreRandomness();
  vi.useRealTimers();
  runViews = Object.fromEntries(
    CLOCK_NAMES.map((clock) => [
      clock,
      Object.fromEntries((Object.keys(ran[clock]) as WorldName[]).map((n) => [n, viewOf(ran[clock][n])])),
    ]),
  ) as Record<ClockName, Record<WorldName, View>>;
  cycles = runs.sameHour;
  views = runViews.sameHour;
}, 120_000);

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  restoreRandomness();
});

/** The dumps the detector reads: the base run, and one per moved world. */
function dumpsOf(rowsOf: (name: WorldName) => Row[], vs: Record<WorldName, View> = views): Record<string, Dump> {
  return Object.fromEntries(
    READ_WORLDS.map((n) => [n, { rows: rowsOf(n), view: vs[n] }]),
  ) as Record<string, Dump>;
}

function cycleDumps(clock: ClockName = 'sameHour'): Record<string, Dump> {
  return dumpsOf((n) => runs[clock][n].rows, runViews[clock]);
}

/** Rows the plan removes by the end of G1, by kind (PLAN-mixing-opacity.json). */
const G1_REMOVES = new Set([
  'p01:note:contrib-claim:<pool>:<funded>', // KV-1 (1)
  'p01:note:claim-minted:<code>', // ISSUE-1 (5), after redemption
  'p01:note:paid:<sig>:code', // ISSUE-1 (5)
  'p01:relay:payment:<sig>:contribution', // ISSUE-1 (5)
  'p01:note:issued:<pool>:<issued>:to', // ISSUE-1 (1)
]);

describe('kv rows at rest after one full purchase cycle', () => {
  it('the cycle runs end to end through both routes, in every world (harness)', () => {
    // Rethrown as itself, never wrapped in `expect`: a crash in the harness
    // must read as a TypeError or an Error, not as an assertion red.
    for (const clock of CLOCK_NAMES) {
      for (const name of Object.keys(WORLDS) as WorldName[]) {
        if (runs[clock][name].error !== undefined) throw runs[clock][name].error;
      }
    }
    for (const clock of CLOCK_NAMES) {
      for (const name of Object.keys(WORLDS) as WorldName[]) {
        const c = runs[clock][name];
        const at = `${clock}/${name}`;
        const statuses = Object.fromEntries(Object.entries(c.steps).map(([k, s]) => [k, s.status]));
        expect(statuses, `${at}: ${JSON.stringify(c.steps)}`).toEqual({
          reserve: 200,
          confirm: 200,
          issue: 200,
        });
        expect(c.steps.reserve.body.leafIndex, `${at}: reserve handed out another leaf`).toBe(
          c.world.funded,
        );
        expect(c.claimCode, `${at}: claim code`).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
        // The buyer receives the OLD leaf, never the one their payment funded.
        expect(c.openedCommitment, `${at}: the sealed note did not open`).toBeDefined();
        expect(c.openedCommitment, `${at}: wrong leaf issued`).toBe(
          treasuryCommitmentAt(c.world.issued),
        );
        expect(c.openedCommitment).not.toBe(treasuryCommitmentAt(c.world.funded));
        expect(c.rows.length, `${at}: the store is empty; nothing was read`).toBeGreaterThan(0);
      }
    }
    expect(h.deferred, 'an after() task was left unrun').toHaveLength(0);

    // ⛔ THE WHOLE DIFFERENTIAL RESTS ON THIS. `again` moves nothing, so its
    // dump must be byte-identical to base. A random draw or a clock read that
    // is not seeded would differ here — and in every other world too, which
    // would make every row "move with everything" and every join invisible.
    const signature = (c: Cycle) =>
      c.rows
        .map((r) => JSON.stringify([r.key, r.ttlSeconds ?? 'none', r.expiresAtMs ?? 'none', [...r.values].sort()]))
        .sort();
    for (const clock of CLOCK_NAMES) {
      expect(signature(runs[clock].again), `${clock}: a random source or a clock read is not seeded`).toEqual(
        signature(runs[clock].base),
      );
      expect(runs[clock].again.sealedNote, `${clock}: the sealing is not deterministic`).toBe(
        runs[clock].base.sealedNote,
      );
      // The expiry a dump holds is recorded. Every row with a TTL expires that
      // TTL after one of the steps' instants, and at least one such row exists
      // (the rate limiter writes one per call), or the instant rule is asleep.
      const steps = Object.values(CLOCKS[clock]);
      const expiring = runs[clock].base.rows.filter((r) => r.ttlSeconds !== null);
      expect(expiring.length, `${clock}: no row has a TTL, so no expiry was read`).toBeGreaterThan(0);
      for (const r of expiring) {
        expect(steps, `${clock}: ${r.key} has a TTL but no absolute expiry`).toContain(
          (r.expiresAtMs ?? Number.NaN) - (r.ttlSeconds ?? 0) * 1000,
        );
      }
    }
    // Each clock must do what its name says, or the case that reads it is asleep.
    const hourOf = (ms: number) => new Date(ms).toISOString().slice(0, 13);
    expect(new Set(Object.values(CLOCKS.sameHour).map(hourOf)).size, 'sameHour spans two hours').toBe(1);
    expect(hourOf(CLOCKS.hourTurns.confirm), 'hourTurns: the hour must turn between reserve and confirm').not.toBe(
      hourOf(CLOCKS.hourTurns.reserve),
    );

    // Each world must actually move the thing it names, or the rule that rests
    // on it is asleep.
    expect(views.leaf.issued).not.toBe(views.base.issued);
    expect(views.leaf2.funded).not.toBe(views.base.funded);
    expect(views.payer.sig).not.toBe(views.base.sig);
    expect(views.recipient.recipient).not.toBe(views.base.recipient);
    expect(views.rand.code, 'the rand world did not move the claim code').not.toBe(views.base.code);
    expect(views.net.ip).not.toBe(views.base.ip);
    // Each buyer axis has a second alternative, which must differ from base
    // AND from the first, or it adds no point to read a function at.
    for (const [first, second, id] of [
      ['rand', 'rand2', (v: View) => v.code],
      ['payer', 'payer2', (v: View) => v.sig],
      ['recipient', 'recipient2', (v: View) => v.recipient],
      ['net', 'net2', (v: View) => v.ip],
    ] as const) {
      expect(id(views[second]), `${second} did not move`).not.toBe(id(views.base));
      expect(id(views[second]), `${second} repeats ${first}`).not.toBe(id(views[first]));
    }
    // The grid: every world holds its leaf setting's leaves and its buyer
    // setting's buyer, or a neighbour read against it moves something else.
    // The claim code is a seeded draw, so this also asserts that the leaves do
    // not shift the buyer's draws (else every code row would move with them).
    expect(READ_WORLDS, 'the grid is not 3 leaf settings by 9 buyers').toHaveLength(27);
    for (const n of READ_WORLDS) {
      const { leaves, buyer } = gridOf(n);
      const lv = views[worldAt(leaves, 'base')];
      const bv = views[worldAt('base', buyer)];
      expect([views[n].funded, views[n].issued, views[n].issuedSlot], `${n}: not the leaves of ${leaves}`).toEqual([
        lv.funded,
        lv.issued,
        lv.issuedSlot,
      ]);
      expect([views[n].sig, views[n].wallet, views[n].recipient, views[n].ip, views[n].code], `${n}: not the buyer of ${buyer}`).toEqual(
        [bv.sig, bv.wallet, bv.recipient, bv.ip, bv.code],
      );
    }
  });

  it('the detector flags a join it is shown, and not a lone leaf (positive control)', async () => {
    const P = POOL_KEY;
    const r = (key: string, ...values: string[]): Row => ({ key, values, ttlSeconds: null });
    const withTtl = (ttl: number, key: string, ...values: string[]): Row => ({ key, values, ttlSeconds: ttl });
    /** A constant nothing moves: the shape of an identity this fixture does not vary. */
    const UNMOVED = 'f3a9c1d2e4b5a6978877665544332211';
    const EPOCH_MS = '1789000000123';
    const ISO_SECOND = '2026-09-16T00:48:50.123Z';
    const be32 = (c: bigint) => Buffer.from(c.toString(16).padStart(64, '0'), 'hex');
    const digits = (s: string, n: number) => BigInt(`0x${s.slice(0, 15)}`).toString().slice(0, n);
    const letters = (s: string, n: number) =>
      s
        .slice(0, n)
        .replace(/\d/g, (d) => 'ghijklmnop'[Number(d)]);
    // A ciphertext-sized base64 run that no world moves (2732 characters).
    const BLOB = Buffer.from(
      Array.from({ length: 64 }, (_, i) => sha256Hex(`kvRowsAtRest blob ${i}`)).join(''),
      'hex',
    ).toString('base64');
    /** A per-purchase id that no world moves (derived, say, from the frozen clock). */
    const ID15 = 'abcdefghijklmno';
    /**
     * One hex digit of a buyer identity, chosen so that the FIRST alternative
     * world of its axis gives the same digit as base and only the SECOND
     * differs (round-3 verifier: with one alternative per axis, a one-digit
     * function of the code was found by a 9-in-10 draw, not by construction).
     * If no such digit exists the case holds a constant and reads as missed.
     */
    const sharedWithFirst = (id: (v: View) => string, first: WorldName, second: WorldName) => {
      for (let k = 0; k < 4096; k += 1) {
        const digit = (v: View) => sha256Hex(`${k}:${id(v)}`).slice(0, 1);
        if (digit(views[first]) === digit(views.base) && digit(views[second]) !== digit(views.base)) return digit;
      }
      return () => 'none';
    };
    /** A row given a TTL at an instant, as the store records it: it expires that TTL later. */
    const ttlSetAt = (atMs: number, ttl: number, key: string, ...values: string[]): Row => ({
      key,
      values,
      ttlSeconds: ttl,
      expiresAtMs: atMs + ttl * 1000,
    });
    /** A row given an absolute expiry (EXPIREAT): a dump shows the expiry, and no TTL constant stands behind it. */
    const expiresAt = (atMs: number, key: string, ...values: string[]): Row => ({
      key,
      values,
      ttlSeconds: null,
      expiresAtMs: atMs,
    });
    /** One request's instant, and the end of its hour bucket. */
    const T0 = Date.UTC(2026, 8, 16, 11, 22, 33, 456);
    const HOUR_END = Date.UTC(2026, 8, 16, 12, 0, 0, 0);
    const reservedRow = (v: View) => `p01:note:contrib-reserved:${P}:${v.funded}`;
    const ipRow = (v: View) => `wl:rl:${sha256Hex(v.ip).slice(0, 12)}:2026-09-16T11`;
    const yCode = sharedWithFirst((v) => v.code, 'rand', 'rand2');
    const ySig = sharedWithFirst((v) => v.sig, 'payer', 'payer2');
    const yRecipient = sharedWithFirst((v) => v.recipient, 'recipient', 'recipient2');
    const yIp = sharedWithFirst((v) => v.ip, 'net', 'net2');

    /** Every planted case is a function of the world, so each world writes its own version. */
    const planted: Array<{ name: string; expect: Array<Finding['rule']>; rows: (v: View) => Row[] }> = [
      // Round 0.
      { name: 'R0a payment key, pool:leaf value', expect: ['JOIN'], rows: (v) => [r(`probe:payment:${v.sig}`, `${P}:${v.issued}`)] },
      {
        name: 'R0b JSON leafIndex beside sha256(code)',
        expect: ['JOIN'],
        rows: (v) => [r('probe:json', JSON.stringify({ leafIndex: v.funded, ref: sha256Hex(v.code) }))],
      },
      { name: 'R0c sha256(code) prefix and leaf in the key', expect: ['JOIN'], rows: (v) => [r(`probe:${sha256Hex(v.code).slice(0, 16)}:${v.funded}`, 'x')] },
      { name: 'R0d the recipient alone', expect: ['RECIPIENT'], rows: (v) => [r('probe:to', v.recipient)] },
      // Today's claim-minted row, then the round-1 verifier's dodges.
      { name: 'C0 claim-minted as the routes write it', expect: ['JOIN'], rows: (v) => [r(`p01:note:claim-minted:${v.code}`, `contrib:${P}:${v.funded}:payment:${v.sig}`)] },
      { name: 'P1 the same join with | separators', expect: ['JOIN'], rows: (v) => [r(`p01:note:claim-minted:${v.code}`, `contrib|${P}|${v.funded}|payment|${v.sig}`)] },
      { name: 'P2 the same join with / separators', expect: ['JOIN'], rows: (v) => [r(`p01:note:claim-minted:${v.code}`, `contrib/${P}/${v.funded}/payment/${v.sig}`)] },
      { name: 'P3 key segment leaf-211', expect: ['JOIN'], rows: (v) => [r(`p01:note:contrib-claim:${P}:leaf-${v.funded}`, v.code)] },
      {
        name: 'P4 leaf as 0xd3 in JSON',
        expect: ['JOIN'],
        rows: (v) => [r(`p01:note:sealed:${v.code}`, JSON.stringify({ pool: P, leaf: `0x${v.funded.toString(16)}` }))],
      },
      { name: 'P5 code as sha256("p01:claim:" + code)', expect: ['JOIN'], rows: (v) => [r(`p01:note:contrib-claim:${P}:${v.funded}`, sha256Hex(`p01:claim:${v.code}`))] },
      { name: 'P6 relay binding keyed by sha256(sig + ":v2")', expect: ['JOIN'], rows: (v) => [r(`p01:relay:payment:${sha256Hex(`${v.sig}:v2`)}:contribution`, `${P}:${v.funded}`)] },
      {
        name: 'P7 leaf and signature through a token no world moves',
        expect: ['JOIN', 'LINKED'],
        rows: (v) => [r(`p01:note:contrib-ref:${P}:${v.funded}`, UNMOVED), r(`p01:note:paid:${v.sig}:ref`, UNMOVED)],
      },
      {
        name: 'P8 leaf and code through a shared random id',
        expect: ['JOIN', 'LINKED'],
        rows: (v) => [r(`p01:note:x:${v.rand('p8')}`, `${P}:${v.issued}`), r(`p01:note:y:${v.rand('p8')}`, v.code)],
      },
      { name: 'P9 recipient as sha256("to:" + recipient)', expect: ['JOIN'], rows: (v) => [r(`p01:note:issued:${P}:${v.issued}:to`, sha256Hex(`to:${v.recipient}`))] },
      { name: 'P11 leaf glued to a word', expect: ['JOIN'], rows: (v) => [r(`p01:note:contrib-claim:${P}:leaf${v.funded}`, v.code)] },
      {
        name: 'P12 a leaf row and a payment row holding one epoch-ms',
        expect: ['LINKED'],
        rows: (v) => [r(`p01:note:contrib-reserved:${P}:${v.funded}:at`, EPOCH_MS), r(`p01:note:paid:${v.sig}:at`, EPOCH_MS)],
      },
      {
        // Three rows, so the two-row rule below cannot be what catches it:
        // this one is the 10+ digit link's own case (sabotage S18).
        name: 'P12b three rows holding one epoch-ms, two of them a leaf and a payment',
        expect: ['LINKED'],
        rows: (v) => [
          r(`p01:note:contrib-reserved:${P}:${v.funded}:at`, EPOCH_MS),
          r(`p01:note:paid:${v.sig}:at`, EPOCH_MS),
          r(`p01:note:heartbeat:${P}:at`, EPOCH_MS),
        ],
      },
      {
        name: 'P13 a row naming a leaf row by the sha256 of its key',
        expect: ['JOIN'],
        rows: (v) => [
          r(`p01:note:contrib-confirmed:${P}:${v.funded}`, '1'),
          r(`p01:note:ref:${sha256Hex(`p01:note:contrib-confirmed:${P}:${v.funded}`)}`, v.sig),
        ],
      },
      { name: 'P14 leaf as sha256(<pool>:<leaf>)', expect: ['JOIN'], rows: (v) => [r(`p01:note:x:${sha256Hex(`${P}:${v.issued}`)}`, v.code)] },
      {
        name: 'P15 leaf as its commitment, in a stored reply',
        expect: ['JOIN'],
        rows: (v) => [r(`p01:note:sealed:${sha256Hex(v.code)}`, JSON.stringify({ sealedNote: 'AAAA', commitment: v.issuedCommitment.toString() }))],
      },
      { name: 'P16 an 8-hex fragment of sha256(sig) on a leaf row', expect: ['JOIN'], rows: (v) => [r(`p01:note:contrib-claim:${P}:${v.funded}`, sha256Hex(v.sig).slice(0, 8))] },
      { name: 'P17 the recipient without its prefix', expect: ['RECIPIENT'], rows: (v) => [r('p01:note:who', v.recipient.slice(v.recipient.indexOf(':') + 1))] },
      { name: 'P18 the paying wallet on the issued leaf', expect: ['JOIN'], rows: (v) => [r(`p01:note:issued:${P}:${v.issued}:by`, v.wallet)] },
      { name: 'P19 leaf as 0xd3 inside a longer value', expect: ['JOIN'], rows: (v) => [r(`p01:note:x:${v.code}`, `pool=${P};leaf=0x${v.funded.toString(16)};n=1`)] },
      { name: 'P20 leaf as bare hex, a whole JSON string', expect: ['JOIN'], rows: (v) => [r(`p01:note:sealed:${v.code}`, JSON.stringify({ pool: P, leaf: v.funded.toString(16) }))] },
      { name: 'P14b leaf as the 16-hex prefix of sha256(<leaf>)', expect: ['JOIN'], rows: (v) => [r(`p01:note:x:${sha256Hex(String(v.issued)).slice(0, 16)}`, v.code)] },
      {
        name: 'P15b leaf as its commitment in padded 0x-hex',
        expect: ['JOIN'],
        rows: (v) => [r(`p01:note:x:${v.code}`, `0x${v.issuedCommitment.toString(16).padStart(64, '0')}`)],
      },
      {
        name: 'P22 a leaf row and a payment row holding one timestamp to the second',
        expect: ['LINKED'],
        rows: (v) => [r(`p01:note:contrib-reserved:${P}:${v.funded}:when`, ISO_SECOND), r(`p01:note:paid:${v.sig}:when`, ISO_SECOND)],
      },
      { name: 'P23 leaf glued to a word in a short value', expect: ['JOIN'], rows: (v) => [r(`p01:note:x:${v.code}`, `leaf${v.funded}`)] },
      { name: 'P24 leaf with leading zeros', expect: ['JOIN'], rows: (v) => [r(`p01:note:x:${v.code}`, `contrib~${P}~000${v.funded}`)] },
      { name: 'P25 sha256 of the recipient', expect: ['RECIPIENT'], rows: (v) => [r('p01:note:who-hash', sha256Hex(v.recipient))] },
      {
        name: 'P27 the claim-minted join, base64-encoded',
        expect: ['JOIN'],
        rows: (v) => [r(`p01:note:contrib-ref:${Buffer.from(JSON.stringify({ pool: P, leaf: v.funded, payment: v.sig })).toString('base64')}`, '1')],
      },
      { name: 'P28 the claim-minted join, hex-encoded', expect: ['JOIN'], rows: (v) => [r('p01:note:ref', Buffer.from(`contrib:${P}:${v.funded}:payment:${v.sig}`).toString('hex'))] },
      { name: 'P29 leaf beside a ciphertext-sized blob', expect: ['JOIN'], rows: (v) => [r(`p01:note:x:${v.code}`, `${v.funded}:${BLOB}`)] },
      // Round 2: the shapes the round-1 list walked past
      // (wp-logs/verify/RED-0-r2-detector-probe.log).
      { name: 'Q1 key = sha256(commitment, decimal), value the code', expect: ['JOIN'], rows: (v) => [r(`p01:inv:${sha256Hex(v.issuedCommitment.toString())}`, v.code)] },
      { name: 'Q2 key = sha256(commitment, 64-hex)', expect: ['JOIN'], rows: (v) => [r(`p01:inv:${sha256Hex(v.issuedCommitment.toString(16).padStart(64, '0'))}`, v.code)] },
      { name: 'Q3 key = sha256(commitment, 32 big-endian bytes)', expect: ['JOIN'], rows: (v) => [r(`p01:inv:${sha256Hex(be32(v.issuedCommitment))}`, v.code)] },
      { name: 'Q4 commitment as base64 of its 32 bytes', expect: ['JOIN'], rows: (v) => [r(`p01:note:sealed:${v.code}`, JSON.stringify({ commitment: be32(v.issuedCommitment).toString('base64') }))] },
      { name: 'Q5 commitment as base58 of its 32 bytes', expect: ['JOIN'], rows: (v) => [r(`p01:note:sealed:${v.code}`, JSON.stringify({ commitment: base58(be32(v.issuedCommitment)) }))] },
      { name: 'Q6 leaf as u32 little-endian hex (a PDA seed)', expect: ['JOIN'], rows: (v) => [r(`p01:note:x:${v.code}`, Buffer.from(Uint32Array.of(v.funded).buffer).toString('hex'))] },
      { name: 'Q9 leaf as the 32-hex prefix of sha256(<pool>:<leaf>)', expect: ['JOIN'], rows: (v) => [r(`p01:note:x:${sha256Hex(`${P}:${v.issued}`).slice(0, 32)}`, v.code)] },
      { name: 'Q10 leaf as the 12-hex prefix of sha256(<leaf>)', expect: ['JOIN'], rows: (v) => [r(`p01:note:x:${sha256Hex(String(v.issued)).slice(0, 12)}`, v.code)] },
      {
        name: 'Q12 the issued leaf deposit slot, in a row keyed by the code',
        expect: ['JOIN'],
        rows: (v) => [r(`p01:note:sealed:${sha256Hex(v.code)}`, JSON.stringify({ depositSlot: v.issuedSlot }))],
      },
      {
        name: 'Q13 the issued leaf deposit time, in a row keyed by the code',
        expect: ['JOIN'],
        rows: (v) => [r(`p01:note:x:${v.code}`, JSON.stringify({ depositedAt: v.issuedTime }))],
      },
      { name: 'Q14 sha256(<leaf>:<pool>), the arguments swapped', expect: ['JOIN'], rows: (v) => [r(`p01:note:x:${sha256Hex(`${v.issued}:${P}`)}`, v.code)] },
      { name: 'Q15 sha256(contrib:<pool>:<leaf>) beside the signature', expect: ['JOIN'], rows: (v) => [r(`p01:note:x:${sha256Hex(`contrib:${P}:${v.funded}`)}`, v.sig)] },
      { name: 'Q16 leaf as a JSON object key, code as its value', expect: ['JOIN'], rows: (v) => [r('p01:note:map', JSON.stringify({ [String(v.funded)]: v.code }))] },
      {
        name: 'Q17 a leaf row and a payment row holding the same epoch seconds',
        expect: ['LINKED'],
        rows: (v) => [r(`p01:note:contrib-reserved:${P}:${v.funded}:at`, '1789000123'), r(`p01:note:paid:${v.sig}:at`, '1789000123')],
      },
      { name: 'Q18 claim-minted = sha256(today’s value)', expect: ['JOIN'], rows: (v) => [r(`p01:note:claim-minted:${v.code}`, sha256Hex(`contrib:${P}:${v.funded}:payment:${v.sig}`))] },
      { name: 'Q19 claim-minted = the 16-hex prefix of that hash', expect: ['JOIN'], rows: (v) => [r(`p01:note:claim-minted:${v.code}`, sha256Hex(`contrib:${P}:${v.funded}:payment:${v.sig}`).slice(0, 16))] },
      { name: 'Q20 relay binding = sha256(<pool>:<leaf>) prefix', expect: ['JOIN'], rows: (v) => [r(`p01:relay:payment:${v.sig}:contribution`, sha256Hex(`${P}:${v.funded}`).slice(0, 32))] },
      {
        name: 'Q8 a leaf row and a payment row sharing a 9-digit random id',
        expect: ['JOIN'],
        rows: (v) => [r(`p01:note:contrib-ref:${P}:${v.funded}`, digits(v.rand('q8'), 9)), r(`p01:note:paid:${v.sig}:ref`, digits(v.rand('q8'), 9))],
      },
      {
        name: 'Q11 a leaf row and a code row sharing a 15-letter random id',
        expect: ['JOIN'],
        rows: (v) => [r(`p01:note:contrib-ref:${P}:${v.funded}`, letters(v.rand('q11'), 15)), r(`p01:note:y:${v.code}`, letters(v.rand('q11'), 15))],
      },
      {
        name: 'Q7 a leaf row and a payment row sharing one sequence number',
        expect: ['LINKED'],
        rows: (v) => [r(`p01:note:contrib-ref:${P}:${v.funded}`, '42'), r(`p01:note:paid:${v.sig}:ref`, '42')],
      },
      // The differential's own cases: nothing here has a spelling to list.
      {
        name: 'X1 a one-bit function of the leaf, in a row keyed by the code',
        expect: ['JOIN'],
        rows: (v) => [r(`p01:note:claim-minted:${v.code}`, v.funded >= 100 ? 'new' : 'old'), r(`p01:note:legend:${P}`, 'new old')],
      },
      {
        name: 'X2 a TTL that moves with the leaf, on a row keyed by the code',
        expect: ['JOIN'],
        rows: (v) => [withTtl(3600 + (v.issuedSlot % 97), `p01:note:sealed:${sha256Hex(v.code)}`, '1')],
      },
      {
        // The TTL is the same in every world. Only the instant it was set
        // moves, so only the absolute expiry in the row signature finds it
        // (sabotage I9 in web-run/logs/RED-0-webfix2/sabotage.log).
        name: 'X2b an absolute expiry that moves with the leaf, one TTL in every world, on a row keyed by the code',
        expect: ['JOIN'],
        rows: (v) => [ttlSetAt(T0 + (v.issued % 7) * 1000, 3600, `p01:note:sealed:${sha256Hex(v.code)}`, '1')],
      },
      { name: 'X3 one token that mixes the leaf and the signature', expect: ['JOIN'], rows: (v) => [r(`p01:note:x:${sha256Hex(`${v.issued}:${v.sig}`)}`, '1')] },
      { name: 'X4 the issued note’s nullifier preimage beside the code', expect: ['JOIN'], rows: (v) => [r(`p01:note:x:${v.code}`, v.issuedNullifier.toString())] },
      { name: 'X5 the recipient behind a salted hash, alone', expect: ['RECIPIENT'], rows: (v) => [r(`p01:note:who:${sha256Hex(`salt7:${v.recipient}`)}`, '1')] },
      { name: 'X6 the buyer’s network address, as a number, on a leaf row', expect: ['JOIN'], rows: (v) => [r(`p01:note:contrib-reserved:${P}:${v.funded}:by`, digits(sha256Hex(v.ip), 12))] },
      { name: 'X7 the claim code as a number, on a leaf row', expect: ['JOIN'], rows: (v) => [r(`p01:note:contrib-claim:${P}:${v.funded}`, digits(sha256Hex(v.code), 10))] },
      { name: 'X8 the signature as a word, on a leaf row', expect: ['JOIN'], rows: (v) => [r(`p01:note:issued:${P}:${v.issued}:ref`, letters(sha256Hex(v.sig), 12))] },
      {
        name: 'X10 ciphertext under a key the buyer does not hold, on a code row',
        expect: ['JOIN'],
        rows: (v) => [r(`p01:note:sealed:${sha256Hex(v.code)}`, JSON.stringify({ blob: v.otherSealed }))],
      },
      {
        // X10's blob also moves in length, which is now read for any blob;
        // this one moves only in content, so only reading it whole finds it
        // (sabotage S13).
        name: 'X10b ciphertext under another key, of one length in every world, on a code row',
        expect: ['JOIN'],
        rows: (v) => [r(`p01:note:sealed:${sha256Hex(v.code)}`, JSON.stringify({ blob: v.otherPadded }))],
      },
      // Round 3 (wp-logs/verify/RED-0-r3-detector-probe.log and
      // RED-0-r3-blob-length-probe.log): what the one exemption erased, a
      // short id shared inside longer values, and the buyer read at one point.
      {
        // Rests on the unpadded note's length moving with the leaf: 2088 in
        // base, 2084 in both leaf worlds (web-run/logs/RED-0-webfix1/probe/
        // probe2.log). If the note's JSON ever stops varying, this case reads
        // as missed; X11b holds by construction.
        name: 'X11 the buyer’s note sealed without the pad, on a code-keyed row (the stored reply before the pad)',
        expect: ['JOIN'],
        rows: (v) => [r(`p01:note:sealed:${sha256Hex(v.code)}`, JSON.stringify({ sealedNote: v.unpadded }))],
      },
      {
        name: 'X11b a blob the buyer opens whose length is a function of the leaf, on a code-keyed row',
        expect: ['JOIN'],
        rows: (v) => [r(`p01:note:sealed:${sha256Hex(v.code)}`, JSON.stringify({ sealedNote: v.lengthSealed }))],
      },
      {
        name: 'X12 one sealed note stored on a leaf-keyed row and on a code-keyed row',
        expect: ['LINKED'],
        rows: (v) => [
          r(`p01:note:issued:${P}:${v.issued}:note`, v.sealed),
          r(`p01:note:sealed:${sha256Hex(v.code)}`, JSON.stringify({ sealedNote: v.sealed })),
        ],
      },
      {
        name: 'Z3 a 15-letter id inside longer values, on a leaf row and a payment row',
        expect: ['LINKED'],
        rows: (v) => [r(`p01:note:contrib-ref:${P}:${v.funded}`, `ref=${ID15};n=1`), r(`p01:note:paid:${v.sig}:ref`, `ref=${ID15};n=2`)],
      },
      {
        name: 'Z3b the same id as a key segment of a leaf row and a payment row',
        expect: ['LINKED'],
        rows: (v) => [r(`p01:note:contrib-ref:${P}:${v.funded}:${ID15}`, '1'), r(`p01:note:paid:${v.sig}:${ID15}`, '2')],
      },
      {
        name: 'Z3c a sequence number inside JSON, on a leaf row and a payment row',
        expect: ['LINKED'],
        rows: (v) => [
          r(`p01:note:contrib-ref:${P}:${v.funded}`, JSON.stringify({ token: 'SOL', n: 4242 })),
          r(`p01:note:paid:${v.sig}:ref`, JSON.stringify({ token: 'SOL', n: 4242, k: 1 })),
        ],
      },
      {
        name: 'Z3d the 15-letter id in three rows, a leaf row and a payment row among them',
        expect: ['LINKED'],
        rows: (v) => [
          r(`p01:note:contrib-ref:${P}:${v.funded}`, `ref=${ID15};n=1`),
          r(`p01:note:paid:${v.sig}:ref`, `ref=${ID15};n=2`),
          r(`p01:note:heartbeat:${P}`, `ref=${ID15};n=3`),
        ],
      },
      { name: 'Y1 one hex digit of the claim code that the rand world shares, on a leaf row', expect: ['JOIN'], rows: (v) => [r(`p01:note:contrib-claim:${P}:${v.funded}`, yCode(v))] },
      { name: 'Y2 one hex digit of the signature that the payer world shares, on a leaf row', expect: ['JOIN'], rows: (v) => [r(`p01:note:issued:${P}:${v.issued}:ref`, ySig(v))] },
      {
        name: 'Y3 one hex digit of the recipient that the recipient world shares, on a leaf row',
        expect: ['JOIN', 'RECIPIENT'],
        rows: (v) => [r(`p01:note:issued:${P}:${v.issued}:hint`, yRecipient(v))],
      },
      { name: 'Y4 one hex digit of the network address that the net world shares, on a leaf row', expect: ['JOIN'], rows: (v) => [r(`p01:note:contrib-reserved:${P}:${v.funded}:by`, yIp(v))] },
      // Web fix 2: the clock a dump holds (web-run/logs/verify-RED-0-r1/
      // probe-hourStraddle.log, probe-ttlSameRequest.log). No world moves the
      // clock, so every one of these rows reads the same in every world, and
      // only what two rows SHARE of it can tie them.
      {
        name: 'E1 a leaf row and an IP-bucket row given one TTL in one request: one absolute expiry',
        expect: ['LINKED'],
        rows: (v) => [ttlSetAt(T0, 3600, reservedRow(v), '1'), ttlSetAt(T0, 3600, ipRow(v), '2')],
      },
      {
        name: 'E2 a leaf row and a code row given different TTLs in one request: one set instant',
        expect: ['LINKED'],
        rows: (v) => [ttlSetAt(T0, 3600, reservedRow(v), '1'), ttlSetAt(T0, 86_400, `p01:note:claim:${v.code}`, '2')],
      },
      {
        name: 'E3 a leaf row and an IP-bucket row given one TTL 250 ms apart, across a second boundary',
        expect: ['LINKED'],
        rows: (v) => [ttlSetAt(T0 + 444, 3600, reservedRow(v), '1'), ttlSetAt(T0 + 694, 3600, ipRow(v), '2')],
      },
      {
        name: 'E4 a leaf row holding its write time in epoch ms, and an IP-bucket row given a TTL at that instant',
        expect: ['LINKED'],
        rows: (v) => [r(`p01:note:issued:${P}:${v.issued}:at`, String(T0)), ttlSetAt(T0, 3600, ipRow(v), '2')],
      },
      {
        name: 'E5 a leaf row and a payment row holding one instant in two spellings (ISO, epoch seconds)',
        expect: ['LINKED'],
        rows: (v) => [
          r(`${reservedRow(v)}:when`, new Date(T0 - (T0 % 1000)).toISOString()),
          r(`p01:note:paid:${v.sig}:when`, String(Math.floor(T0 / 1000))),
        ],
      },
      {
        name: 'E6 a leaf row given an absolute expiry (no TTL constant) at the instant an IP-bucket row expires',
        expect: ['LINKED'],
        rows: (v) => [expiresAt(T0 + 3_600_000, reservedRow(v), '1'), ttlSetAt(T0, 3600, ipRow(v), '2')],
      },
      // Continued-run fix round 1: rows that exist in some worlds and not in
      // base. Until then only base's rows were read, so none of these was ever
      // examined (web-run/logs2/verify-RED-0-r1/probe-PM1.log: D1-D4 missed,
      // and the real issue-note route writing D1's row stayed green). Each
      // condition is on a value, so a cross world meets it as its heads do.
      {
        name: 'D1 the recipient on the issued leaf row, written only for leaves below 100 (absent in base)',
        expect: ['JOIN', 'RECIPIENT'],
        rows: (v) => (v.issued < 100 ? [r(`p01:note:issued:${P}:${v.issued}:to`, v.recipient)] : []),
      },
      {
        name: 'D2 the claim-minted join, written only when the funded leaf is above 250 (absent in base)',
        expect: ['JOIN'],
        rows: (v) => (v.funded > 250 ? [r(`p01:note:claim-minted:${v.code}`, `contrib:${P}:${v.funded}:payment:${v.sig}`)] : []),
      },
      {
        name: 'D3 the recipient on the issued leaf row, written only for a recipient other than base’s (absent in base)',
        expect: ['JOIN', 'RECIPIENT'],
        rows: (v) => (v.recipient !== views.base.recipient ? [r(`p01:note:issued:${P}:${v.issued}:to`, v.recipient)] : []),
      },
      {
        name: 'D4 the relay binding naming the funded leaf, written only for a payer other than base’s (absent in base)',
        expect: ['JOIN'],
        rows: (v) => (v.sig !== views.base.sig ? [r(`p01:relay:payment:${v.sig}:contribution`, `${P}:${v.funded}`)] : []),
      },
      {
        name: 'PM3 a legacy flag keyed by sha256(recipient), holding the leaf, written only for leaves below 100',
        expect: ['JOIN', 'RECIPIENT'],
        rows: (v) => (v.issued < 100 ? [r(`p01:note:legacy:${sha256Hex(v.recipient)}`, String(v.issued))] : []),
      },
      {
        // No spelling of the code is left to read: only a world that moves the
        // code under leaf's leaves finds it (sabotage R2).
        name: 'G1 the code behind a salted hash, on a row written only for leaves below 100',
        expect: ['JOIN'],
        rows: (v) => (v.issued < 100 ? [r(`p01:note:legacy:${sha256Hex(`salt7:${v.code}`)}`, '1')] : []),
      },
      {
        // Only the four cross worlds leaf/leaf2 x recipient/recipient2 hold it.
        name: 'G2 the recipient on the issued leaf row, written only for leaves below 100 and a recipient other than base’s',
        expect: ['JOIN', 'RECIPIENT'],
        rows: (v) =>
          v.issued < 100 && v.recipient !== views.base.recipient ? [r(`p01:note:issued:${P}:${v.issued}:to`, v.recipient)] : [],
      },
      {
        // RECIPIENT through a world that moves the recipient under leaf's
        // leaves: no spelling of the address is left (sabotage R3).
        name: 'G3 the recipient behind a salted hash, on a row written only for leaves below 100',
        expect: ['JOIN', 'RECIPIENT'],
        rows: (v) => (v.issued < 100 ? [r(`p01:note:who:${sha256Hex(`salt7:${v.recipient}`)}`, '1')] : []),
      },
      {
        // No world moves the recipient alone under another claim code, so only
        // the address's spellings are read here (sabotage R4; header).
        name: 'G4 the recipient on a row written only for a claim code other than base’s',
        expect: ['RECIPIENT'],
        rows: (v) => (v.code !== views.base.code ? [r(`p01:note:to:${sha256Hex(v.code).slice(0, 16)}`, v.recipient)] : []),
      },
      {
        name: 'G5 a leaf row and a payment row sharing one sequence number, written only for leaves below 100',
        expect: ['LINKED'],
        rows: (v) => (v.issued < 100 ? [r(`p01:note:contrib-ref:${P}:${v.funded}`, '42'), r(`p01:note:paid:${v.sig}:ref`, '42')] : []),
      },
      {
        name: 'G6 a leaf row and an IP-bucket row given one TTL in one request, written only for leaves below 100',
        expect: ['LINKED'],
        rows: (v) => (v.issued < 100 ? [ttlSetAt(T0, 3600, reservedRow(v), '1'), ttlSetAt(T0, 3600, ipRow(v), '2')] : []),
      },
      {
        // The belt (an identity this fixture does not vary) on a row base does
        // not hold: base's dump lacks the id only because it lacks the row
        // (sabotage R6).
        name: 'G7 a leaf row carrying an id no world moves, written only for leaves below 100',
        expect: ['JOIN'],
        rows: (v) => (v.issued < 100 ? [r(`p01:note:contrib-ref:${P}:${v.funded}`, UNMOVED)] : []),
      },
    ];

    const missed = planted
      .map((c) => ({
        name: c.name,
        got: findings(dumpsOf((n) => c.rows(views[n]))).map((f) => f.rule),
      }))
      .filter((c, i) => !planted[i].expect.every((rule) => c.got.includes(rule)));

    // Round-1 probe P10: a row stored as `undefined` reaches the detector as text.
    const undefinedKv = new RecordingKv();
    await undefinedKv.set(`p01:note:x:${views.base.funded}`, undefined);
    expect(undefinedKv.rows()[0].values).toEqual(['undefined']);

    /** The stored reply ISSUE-1 plans (`sealed:<sha256(code)>`), from each world's body. */
    const sealedRow = (v: View): Row =>
      r(
        `p01:note:sealed:${sha256Hex(v.code)}`,
        JSON.stringify({
          sealedNote: v.issueBody.sealedNote,
          denomination: v.issueBody.denomination,
          token: v.issueBody.token,
          merklePath: v.issueBody.merklePath,
          disclosure: v.issueBody.disclosure,
        }),
      );
    const neutral: Array<{ name: string; rows: (v: View) => Row[] }> = [
      { name: 'N1 issued counter', rows: (v) => [r(`p01:note:issued:${P}:${v.issued}`, '1')] },
      { name: 'N2 inventory set', rows: (v) => [r(`p01:note:inventory:${P}`, String(v.funded))] },
      { name: 'N3 paid gate', rows: (v) => [r(`p01:note:paid:${v.sig}`, '1')] },
      { name: 'N4 claim gate', rows: (v) => [r(`p01:note:claim:${v.code}`, '1')] },
      { name: 'N5 the stored reply ISSUE-1 plans', rows: (v) => [sealedRow(v)] },
      {
        name: 'N6 two reservation rows holding one epoch-ms',
        rows: (v) => [r(`p01:note:contrib-reserved:${P}:${v.funded}:at`, EPOCH_MS), r(`p01:note:contrib-reserved:${P}:${v.funded + 1}:at`, EPOCH_MS)],
      },
      { name: 'N7 a row stored as undefined', rows: (v) => [r(`p01:note:x:${v.funded}`, 'undefined')] },
      {
        // ISSUE-1 now writes the stored reply itself, so N5 is added only if
        // this run's rows do not already hold a row under its key.
        name: "N8 this run's rows less the ones G1 removes, with the stored reply",
        rows: (v) => {
          const kept = cycles[v.name].rows.filter((row) => !G1_REMOVES.has(kindOf(row.key, v)));
          const planned = sealedRow(v);
          return kept.some((row) => row.key === planned.key) ? kept : [...kept, planned];
        },
      },
      {
        name: 'N9 a leaf row and a payment row holding one round amount',
        rows: (v) => [r(`p01:note:issued:${P}:${v.issued}:amount`, '1000000000'), r(`p01:note:paid:${v.sig}:amount`, '1000000000')],
      },
      { name: 'N10 a timestamp on a leaf row', rows: (v) => [r(`p01:note:issued:${P}:${v.issued}:at`, ISO_SECOND)] },
      { name: 'N11 a leaf named by hash, with a counter', rows: (v) => [r(`p01:note:issued-ref:${sha256Hex(`${P}:${v.issued}`)}`, '1')] },
      { name: 'N12 a leaf glued to a word in a key, with a counter', rows: (v) => [r(`p01:note:leaf${v.funded}`, '1')] },
      {
        name: 'N13 a ciphertext-sized blob that happens to hold /211/',
        rows: (v) => [r(`p01:note:sealed:${sha256Hex(v.code)}`, JSON.stringify({ sealedNote: `${BLOB.slice(0, 1000)}/211/${BLOB.slice(1005)}` }))],
      },
      {
        name: 'N14 the buyer’s own sealed note, on a leaf-keyed row',
        rows: (v) => [r(`p01:note:issued:${P}:${v.issued}:note`, v.sealed || 'p01enc1:absent')],
      },
      {
        name: 'N15 four counters that all read 1',
        rows: (v) => [
          r(`p01:note:issued:${P}:${v.issued}`, '1'),
          r(`p01:note:claim:${v.code}`, '1'),
          r(`p01:note:paid:${v.sig}`, '1'),
          r(`p01:note:contrib-confirmed:${P}:${v.funded}`, '1'),
        ],
      },
      {
        name: 'N16 a leaf row and a payment row holding the same words the code writes',
        rows: (v) => [
          r(`p01:note:issued:${P}:${v.issued}:token`, JSON.stringify({ token: 'SOL', merklePath: 'none' })),
          r(`p01:note:paid:${v.sig}:token`, JSON.stringify({ token: 'SOL', merklePath: 'none' })),
        ],
      },
      {
        name: 'N17 a small count that three rows hold, a leaf row and a payment row among them',
        rows: (v) => [
          r(`p01:note:issued:${P}:${v.issued}:token`, JSON.stringify({ token: 'SOL', n: 2 })),
          r(`p01:note:paid:${v.sig}:token`, JSON.stringify({ token: 'SOL', n: 2 })),
          r(`p01:note:inventory:${P}:token`, JSON.stringify({ token: 'SOL', n: 2 })),
        ],
      },
      {
        // `samePad` must be a different blob of the real note's length, or
        // this case proves nothing; the check below the list says so.
        name: 'N18 two different notes sealed to the buyer, of one padded length, on a leaf-keyed row and a code-keyed row',
        rows: (v) => [
          r(`p01:note:issued:${P}:${v.issued}:note`, v.sealed),
          r(`p01:note:sealed:${sha256Hex(v.code)}`, JSON.stringify({ sealedNote: v.samePad })),
        ],
      },
      {
        name: 'N19 a leaf row and a rate-limit row keyed by one hour bucket',
        rows: (v) => [
          r(`p01:note:contrib-reserved:${P}:${v.funded}:hour`, '2026-09-16T11'),
          r(`wl:rl:${sha256Hex(v.ip).slice(0, 12)}:2026-09-16T11`, '1'),
        ],
      },
      {
        // The rate limiter's fix this file asks for (HOUR_TURN_JOIN_PINNED):
        // an expiry on the bucket's end is shared by every row of the bucket.
        name: 'EN1 a leaf row and an IP-bucket row that both expire at their hour bucket’s end (EXPIREAT)',
        rows: (v) => [expiresAt(HOUR_END, reservedRow(v), '1'), expiresAt(HOUR_END, ipRow(v), '2')],
      },
      {
        // Two requests of one purchase, 41 s apart as in this fixture's clock:
        // the anonymity-set question, not a shared value (see the header).
        name: 'EN2 a leaf row and an IP-bucket row given one TTL 41 s apart (two requests)',
        rows: (v) => [ttlSetAt(T0, 3600, reservedRow(v), '1'), ttlSetAt(T0 + 41_000, 3600, ipRow(v), '2')],
      },
      // Rows that exist in some worlds only, and still join nothing: each
      // moves with one side alone. Reading a world against worlds that move
      // more than one thing flags them (sabotage R5).
      { name: 'GN1 a leaf-keyed counter written only for leaves below 100', rows: (v) => (v.issued < 100 ? [r(`p01:note:issued:${P}:${v.issued}`, '1')] : []) },
      { name: 'GN2 a claim gate written only for a claim code other than base’s', rows: (v) => (v.code !== views.base.code ? [r(`p01:note:claim:${v.code}`, '1')] : []) },
      {
        name: 'GN3 an IP-bucket row written only for a network address other than base’s',
        rows: (v) => (v.ip !== views.base.ip ? [r(`wl:rl:${sha256Hex(v.ip).slice(0, 12)}:2026-09-16T11`, '1')] : []),
      },
      {
        name: 'GN4 a leaf named by its hash, with a counter, written only for leaves below 100',
        rows: (v) => (v.issued < 100 ? [r(`p01:note:issued-ref:${sha256Hex(`${P}:${v.issued}`)}`, '1')] : []),
      },
      {
        // Only leaf's worlds hold it, so no leaf neighbour of theirs holds its
        // shape and the hash cannot be seen to move (sabotage R8).
        name: 'GN5 a leaf named by its hash, written only when the funded leaf is above 250 (one leaf setting)',
        rows: (v) => (v.funded > 250 ? [r(`p01:note:big:${sha256Hex(`${P}:${v.funded}`)}`, '1')] : []),
      },
    ];
    for (const n of READ_WORLDS) {
      expect(views[n].samePad.length, `${n}: N18 needs a blob of the padded note's length`).toBe(views[n].sealed.length);
      expect(views[n].samePad, `${n}: N18 needs a DIFFERENT blob`).not.toBe(views[n].sealed);
    }
    const flagged = neutral
      .map((c) => ({
        name: c.name,
        got: findings(dumpsOf((n) => c.rows(views[n]))).map((f) => f.text),
      }))
      .filter((c) => c.got.length > 0);
    // The vocabulary rule rests on the production source having been read:
    // the words the routes write must be in it, and the planted id must not.
    for (const w of ['sealedNote', 'merklePath', 'disclosure', 'contrib', 'reserved', 'wl', 'rl']) {
      expect(sourceWords().has(w), `the production source was not read: "${w}" is missing`).toBe(true);
    }
    expect(sourceWords().has(ID15), 'the planted id is a word the code writes, so Z3 proves nothing').toBe(false);

    // One assertion for both halves, so a red names every case at once.
    expect(
      { missed: missed.map((c) => c.name), flagged: flagged.map((c) => c.name) },
      `planted joins the detector did not flag: ${missed.map((c) => c.name).join(' ; ')} || ` +
        `neutral rows the detector flagged: ${flagged
          .map((c) => `${c.name} (${c.got.join(' ; ')})`)
          .join(' ; ')}`,
    ).toEqual({ missed: [], flagged: [] });
  });

  it('every finding is a known leak, and the list is now empty (a new join goes red)', () => {
    const unknown = findings(cycleDumps())
      .map((f) => `${f.rule} ${f.kind}`)
      .filter((k) => !KNOWN_LEAKS.includes(k));
    expect(unknown, 'a KV row joins a leaf to the buyer and is not in KNOWN_LEAKS').toEqual([]);
  });

  it('at the hour turn, the findings are exactly the pinned expiry join (a new join, or its fix, goes red)', () => {
    const got = [...new Set(findings(cycleDumps('hourTurns')).map((f) => `${f.rule} ${f.kind}`))].sort();
    expect(
      got,
      'the hour-turn findings are not KNOWN_HOUR_TURN_LEAKS: a new join, or A fix landed ' +
        '(then set HOUR_TURN_JOIN_PINNED to false and empty KNOWN_HOUR_TURN_LEAKS; any fix that moves the ' +
        "rate-limit row's expiry a second or more from the reservation rows' reads the same here, and the " +
        "case on the rate limiter's rows then checks that it is the prescribed one)",
    ).toEqual([...KNOWN_HOUR_TURN_LEAKS].sort());
  });

  it('the rate limiter’s rows: today’s TTL while the hour-turn join is pinned, their own hour bucket’s end once it is not', () => {
    // The sibling above reads findings only, so it cannot tell the prescribed
    // fix from a smaller bucket: a rate-limit expiry rounded to the whole
    // minute is 50 s from the reservation rows' and ties nothing here, yet a
    // dump holder with few purchases still pairs them (probe B3 in
    // web-run/logs2/verify-RED-0-r1/probe-bucket.log). This case compares each
    // row with ITS OWN bucket's end, so an hour edge that is not that end
    // fails too (mutants M6F, M7F in web-run/logs2/RED-0-cr1/sabotage.log).
    const RATE_ROW = /^wl:rl:[0-9a-f]+:(\d{4}-\d{2}-\d{2}T\d{2})$/;
    const iso = (ms: number | null | undefined) => (typeof ms === 'number' ? new Date(ms).toISOString() : String(ms));
    const bucketEnd = (key: string) => Date.parse(`${RATE_ROW.exec(key)?.[1]}:00:00.000Z`) + 3_600_000;
    const rateRows = CLOCK_NAMES.flatMap((clock) =>
      (Object.keys(WORLDS) as WorldName[]).flatMap((n) =>
        runs[clock][n].rows.filter((row) => RATE_ROW.test(row.key)).map((row) => ({ clock, at: `${clock}/${n}`, row })),
      ),
    );
    expect(rateRows.length, 'no rate-limit row was read, so this case reads nothing').toBeGreaterThan(0);
    if (HOUR_TURN_JOIN_PINNED) {
      // Today's shape, exactly: `expire(key, 3600)` in the request that wrote
      // the row. Any other expiry means the rate limiter changed (a whole-minute
      // rounding puts some rows on their bucket's end by chance, mutant M6).
      const notToday = rateRows
        .filter(
          ({ clock, row }) =>
            row.ttlSeconds !== 3600 || !Object.values(CLOCKS[clock]).includes((row.expiresAtMs ?? Number.NaN) - 3_600_000),
        )
        .map(({ at, row }) => `${at} ${row.key} ttl ${row.ttlSeconds} expires ${iso(row.expiresAtMs)}`);
      expect(
        notToday,
        'pinned, yet the rate limiter no longer expires its rows 3600 s after the request: a fix landed, so unpin, ' +
          'and this case then checks that it is the prescribed one',
      ).toEqual([]);
      return;
    }
    const offEnd = rateRows
      .filter(({ row }) => row.expiresAtMs !== bucketEnd(row.key))
      .map(({ at, row }) => `${at} ${row.key} expires ${iso(row.expiresAtMs)}, its bucket ends ${iso(bucketEnd(row.key))}`);
    expect(
      offEnd,
      'the hour-turn join was unpinned, but these rate-limit rows do not expire at their own hour bucket’s end: ' +
        'the fix that landed is not the prescribed one (EXPIREAT at the end of the hour the key names)',
    ).toEqual([]);
  });

  it('no KV row joins a leaf to a payment, code or recipient after a full cycle', () => {
    // A plain `it` since web fix 2: an incomplete cycle is an error here,
    // never a clean dump.
    const broken = READ_WORLDS.some(
      (n) => cycles[n].error !== undefined || cycles[n].steps.issue?.status !== 200,
    );
    if (broken) throw new Error('harness did not complete the cycle in every world');
    const found = findings(cycleDumps());
    expect(
      found.map((f) => f.text),
      `${found.length} finding(s): KV rows link a leaf to the buyer after one purchase. Rows held: ` +
        cycles.base.rows.map((row) => preview(row.key)).join(', '),
    ).toEqual([]);
  });

  const hourTurnCase = HOUR_TURN_JOIN_PINNED ? it.fails : it;
  hourTurnCase('when the hour turns between reserve and confirm, no KV row joins a leaf to the buyer', () => {
    // A broken harness or a broken detector must not satisfy `it.fails`:
    // return without asserting, and the cases above carry the red.
    const turn = runs.hourTurns;
    const broken = READ_WORLDS.some((n) => turn[n].error !== undefined || turn[n].steps.issue?.status !== 200);
    if (broken) {
      if (HOUR_TURN_JOIN_PINNED) return;
      throw new Error('harness did not complete the hour-turn cycle in every world');
    }
    let found: Finding[];
    try {
      found = findings(cycleDumps('hourTurns'));
    } catch (e) {
      if (HOUR_TURN_JOIN_PINNED) return;
      throw e;
    }
    expect(
      found.map((f) => f.text),
      `${found.length} finding(s) when the hour turns between reserve and confirm. Rows held: ` +
        turn.base.rows
          .map((row) => `${preview(row.key)}${row.expiresAtMs ? ` (expires ${new Date(row.expiresAtMs).toISOString()})` : ''}`)
          .join(', '),
    ).toEqual([]);
  });
});
