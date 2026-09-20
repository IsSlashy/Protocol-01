import { after, NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { Connection, PublicKey } from '@solana/web3.js';

import { getStore, rateLimitExceeded, type KvLike } from '@/lib/waitlist/store';
import { clientIp, rateLimitAdvisories } from '@/lib/net/clientIp';
import { notePaidCodeKey, relayPaymentContributionKey } from '@/lib/privacy/paymentBinding';
import { activeTreasurySeed, treasurySeeds } from '@/lib/privacy/treasurySeeds';
import {
  createCommitmentV3,
  deriveNoteMaterial,
  fetchPoolCommitments,
  fetchSpentNullifierSet,
  isNullifierSpentInSet,
  getPoolsForTokenV3,
  pubkeyToField,
  type OnChainCommitment,
  type ShareableNote,
} from '@/lib/privacy/pool/denominatedPool';
import { deriveNoteBlinding } from '@/lib/privacy/pool/noteBlinding';
import { encryptNote, isNoteEncryptionAddress } from '@/lib/privacy/pool/noteCrypto';
import { installKvPoolHistory } from '@/lib/privacy/pool/kvPoolHistory';

/**
 * issue-note — hand a caller a shielded note THIS DEPLOYMENT deposited.
 *
 * WHY THIS EXISTS, AND WHY IT IS THE WHOLE PRODUCT
 * ───────────────────────────────────────────────
 * Spending a note republishes, in cleartext, the exact commitment its deposit
 * emitted. The program forces that — the C1 inputs hash binds the argument, C3
 * proves it is a leaf, the root must be the pool's — so no client change alters
 * it before the verifier is redeployed. The consequence is one hop:
 *
 *   subscription → commitment → the deposit that emitted it → its fee payer
 *
 * If that fee payer is the buyer, everything else is decoration: the spend can
 * be paid by a treasury, swept to a treasury and signed by a fresh ephemeral,
 * and the buyer is still one hop away through their own deposit.
 *
 * So the buyer must spend a note SOMEBODY ELSE deposited. Until now that meant
 * a two-wallet ritual — shield from A, seal to B, import into B, subscribe from
 * B — which is a runbook, not a product. A person will do exactly one thing:
 * click Subscribe. This endpoint is what makes the rest happen underneath.
 *
 * ⛔ WHAT THIS DOES NOT DO, AND MUST NEVER BE DESCRIBED AS DOING
 * ─────────────────────────────────────────────────────────────
 * It does not make the buyer anonymous to US. The note's secrets are
 * `HKDF(treasurySeed, poolPDA, counter)` — enumerable offline, forever, from a
 * seed this server holds. So `subscriber_commitment`, `license_commitment`, the
 * nullifier and the vault PDA of every subscription bought with an issued note
 * are each a pure function of a value we can regenerate, with no records kept
 * and no log written. **Against the issuer the anonymity set is one,
 * unconditionally and permanently**, and it stays one after any redeploy.
 *
 * It also does not transfer exclusive ownership. Holding the seed means this
 * deployment can spend an issued note itself, at any time, until the recipient
 * spends it first. On devnet with the operator's own SOL that is a recovery
 * path; anywhere else it is custody, and it must be stated as custody.
 *
 * What it DOES buy is precise and worth having: a chain observer who is not the
 * issuer and not the merchant cannot get from the subscription to the buyer,
 * because the deposit names us.
 *
 * 🚨 IT GIVES AWAY MONEY, LIKE THE FUNDER, BUT WORSE
 * ──────────────────────────────────────────────────
 * A grant from `/api/fund-ephemeral` is rent that comes back. A note is the
 * denomination itself and does not. The bounds here are: a finite, explicitly
 * configured inventory that can only shrink; an atomic per-leaf claim so one
 * note is never issued twice; a durable per-IP rate limit; and the devnet
 * genesis guard. None of that is an anti-abuse story for real value — the
 * inventory bound is what makes the worst case a known number rather than a
 * balance.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// [CACHE-1] The pool history this route walks is shared by every isolate
// through one KV row per pool that holds public chain data only
// (`lib/privacy/pool/kvPoolHistory.test.ts`).
installKvPoolHistory();

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const RATE_SALT = 'p01:issue-note:v1';
/** Deliberately tighter than the funder's: this hands over value, not rent. */
const ISSUES_PER_IP_PER_HOUR = (() => {
  // Overridable, because three per hour is right for a deployment handing out
  // real value and wrong for one machine testing the flow — where every failed
  // attempt, including one caused by a bug in this route, spends the quota and
  // locks the operator out for the rest of the hour. It happened.
  //
  // Deliberately a floor of 1 and no upper bound check: an operator raising this
  // is making a decision about their own treasury, and a silently clamped limit
  // would be worse than a high one they chose.
  const raw = Number(process.env.P01_ISSUE_LIMIT_PER_HOUR ?? '');
  return Number.isInteger(raw) && raw >= 1 ? raw : 3;
})();

/**
 * The reply a redeemed claim can be handed again, byte for byte.
 *
 * 🚨 NO LEAF INDEX AND NO COMMITMENT, and the absence is the point. Both used
 * to travel beside the blob that already carries them for the buyer alone, so
 * the reply — and any copy of the row that stores it — named the note. The
 * clients never needed them: `shieldClient.ts` (`requestIssuedNote`) falls
 * back to the opened note's own index, and `poolImportNote` recomputes the
 * commitment from the secrets. Measured rather than listed by
 * `__tests__/api/issue-note.node.test.ts` "does not move when the leaf moves",
 * which runs the same request against two different leaves and compares the
 * bytes.
 */
interface SealedReply {
  sealedNote: string;
  denomination: number;
  token: 'SOL' | 'USDC';
  merklePath: 'rebuilt' | 'none';
  disclosure: string;
}

/** Where a redeemed claim's reply is kept: the hash of the code, never the code. */
function sealedReplyKey(claimCode: string): string {
  return `p01:note:sealed:${createHash('sha256').update(claimCode).digest('hex')}`;
}

/**
 * Every sealed note's plaintext is padded to a multiple of this many bytes.
 *
 * 🚨 THE LENGTH OF THE BLOB WAS A FUNCTION OF THE LEAF. The note is JSON, so
 * its byte count follows the digits of `leafIndex` and of the commitment its
 * deposit published, and the sealed reply carried that count, with no key, to
 * a capture of the response or a copy of the stored reply. Measured on this
 * route before the pad, 2026-09-18: a note at a two-digit leaf was 399 bytes
 * sealed to 2088 characters, one at a three-digit leaf 402 bytes sealed to
 * 2092. The padding is spaces, which are JSON whitespace, so every reader that
 * parses the note reads the same note. The longest note measured (a USDC note
 * at the largest u32 index) is 485 bytes; a longer one pads to the next
 * multiple rather than being refused.
 * Pinned by `__tests__/api/issue-note.node.test.ts` "is the same length
 * whichever note is sealed in it".
 */
const SEALED_NOTE_BYTES = 1024;

function paddedNote(note: ShareableNote): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(note));
  const size = Math.max(1, Math.ceil(json.length / SEALED_NOTE_BYTES)) * SEALED_NOTE_BYTES;
  const out = new Uint8Array(size).fill(0x20);
  out.set(json);
  return out;
}

/**
 * Delete the rows that name a claim code and the payment that bought it.
 *
 * 🚨 WHAT A COPY OF THE STORE JOINED. `claim-minted:<code>` holds
 * `payment:<sig>`, the shape contribute-note and claim-for-payment write
 * since KV-1: the code, and the signature of the payment that bought it,
 * which resolves publicly to the wallet that made it. A claim sold before
 * KV-1 still holds `contrib:<pool>:<leaf>:payment:<sig>`, which names the
 * leaf that payment funded as well, and `/api/mint-claim` stores a digest
 * with no payment in it. So the signature is read from either payment shape,
 * unanchored, and the code's own row goes whatever it holds. `paid:<sig>:code`
 * and the relay's binding say the same thing from the other side. Once the
 * code has been redeemed, nothing reads any of the three again. Each shape
 * has its own case in `__tests__/api/issue-note.node.test.ts` ("the rows
 * that name a code and a payment together"), which also checks the shapes
 * against the writers' source.
 *
 * ⛔ `p01:note:paid:<sig>` STAYS, and so does `p01:note:claim:<code>`: those
 * are the gates that stop one payment buying two notes. Pinned by
 * `__tests__/api/issue-note.node.test.ts` "are deleted at redemption, and the
 * payment gate is kept", and read at rest by
 * `__tests__/lib/kvRowsAtRest.test.ts`.
 *
 * ⚠️ IT COSTS THE BUYER NOTHING because it runs after the response. `after()`
 * throws outside a request scope (next/dist/server/after/after.js), which is
 * every caller that is not the running server, so the fallback does the same
 * work inline rather than letting the deletions quietly not happen.
 */
async function forgetTheCodeToPaymentTrail(
  kv: KvLike,
  claimCode: string,
  minted: string,
): Promise<void> {
  const signature = /payment:([1-9A-HJ-NP-Za-km-z]{32,90})/.exec(minted)?.[1];
  const sweep = async () => {
    const keys = [`p01:note:claim-minted:${claimCode}`];
    if (signature) keys.push(notePaidCodeKey(signature), relayPaymentContributionKey(signature));
    for (const key of keys) {
      try {
        await kv.del(key);
      } catch {
        // Best effort. A row that survives stays readable in a dump, which is
        // the state this removes; it is never a failed sale.
      }
    }
  };
  try {
    after(sweep);
  } catch {
    await sweep();
  }
}

/**
 * ⛔ NO TEXT FROM THE STORE OR THE CHAIN IN ANY ANSWER, whichever call failed.
 *
 * The production store client words a failed request as
 * `${error}, command was: ${JSON.stringify(request body)}`
 * (node_modules/@upstash/redis/nodejs.js:226): the command, its key and its
 * value, and with auto-pipelining the commands of every other request batched
 * into the same one. Passed on, that text handed a buyer the sealed note a
 * failed write carried, and the retry that answer asked for then handed a
 * second one for the same code; it named a leaf's key when its claim failed;
 * and it gave one buyer another's claim code, which redeems (verifier probe P1-P3,
 * web-run/logs/verify-ISSUE-1-r1/probe-upstash.log). A chain error names what
 * it was asked about. So every refusal says what failed in words fixed here,
 * and nothing else, and none of that text is logged either. Pinned by
 * `__tests__/api/issue-note.node.test.ts` "every answer this route gives",
 * which fails each store and chain call in turn with a text that names its
 * arguments (red: web-run/logs/ISSUE-1-webfix2/sandbox-upstash/wp-logs/
 * ISSUE-1-red.log).
 */
function bad(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

/**
 * 🚨 AN EXHAUSTION REFUSAL IS A DATED READING OF THE INVENTORY.
 *
 * The refusals below the walk used to carry their counts — `spentLeaves`,
 * `heldByOthers`, `tooYoung`, `waitSlots`, `notOurs` — and each of them goes
 * through `release()`, which hands the claim code back. So a buyer holding ONE
 * minted code could ask again, and again, and read the inventory each time: a
 * rise in `spentLeaves` dates the spend of an issued note to the poll window,
 * and joined with the public spends of that window it sorts them into issued
 * notes and self-deposited ones. `heldByOthers` is the size of the issued-note
 * set, and `waitSlots` is the next maturity time. The same words without the
 * numbers still date the first spend after exhaustion, because the branch that
 * answers changes with it — so the public answer is ONE answer for every
 * exhaustion, status included.
 *
 * Nothing in this app reads those counts: they are diagnostics for whoever runs
 * the deployment, and they are answered to a caller who proves they are that
 * person (`asksAsOperator`). This is the rule the GET already follows: READY-1
 * keeps the wait time out of the readiness answer.
 *
 * Pinned by `__tests__/api/issue-note.node.test.ts` "what a paying caller is
 * told when no note comes out", which runs five worlds that differ only in the
 * state of the inventory and requires one answer, plus the operator's view of
 * the same five, which must differ.
 */
const EXHAUSTED_ERROR = 'no note could be handed over for this claim';
/**
 * ⚠️ WHAT THIS PROMISES HAD TO BECOME TRUE (gate r1, RED 7e).
 *
 * It used to say "asking again with the SAME code costs nothing". The CODE
 * costs nothing — it is released on every exhausted path and is still worth a
 * note. But every POST is charged against `ISSUES_PER_IP_PER_HOUR` (3 by
 * default) below, so a buyer who has paid and follows that sentence is answered
 * 429 on the fourth attempt and locked out for the hour. The hint now says both
 * halves, because the second one is the one that decides what the buyer does
 * next.
 */
const EXHAUSTED_HINT =
  'Your claim code was NOT used up: it is still worth a note and the same code succeeds once ' +
  'the deployment has one to give. Leave a few minutes between attempts — this deployment ' +
  'limits how often one network may ask, and spending that allowance on retries is what would ' +
  'cost you. Which state the inventory is in is answered to whoever runs the deployment ' +
  '(repeat the request with the admin password), because an inventory state that can be read ' +
  'over and over dates the notes that are spent.';

/**
 * Whether this request carries the operator's password.
 *
 * ⛔ AN UNSET PASSWORD IS NOT A MATCH. Comparing `undefined` with a missing
 * header would make every caller an operator on a deployment that never set
 * one, which is the shape this whole rule exists to refuse.
 *
 * The comparison is over sha256 digests, of equal length whatever the inputs,
 * so a wrong password cannot be lengthened into a timing answer. The digests
 * are of the password only: neither is logged, returned, or stored.
 */
function asksAsOperator(request: NextRequest): boolean {
  const expected = process.env.ADMIN_PASSWORD ?? '';
  const given = request.headers.get('x-admin-password') ?? '';
  if (expected === '' || given === '') return false;
  const a = createHash('sha256').update(expected).digest('hex');
  const b = createHash('sha256').update(given).digest('hex');
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length && i < b.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * How old a deposit must be before its note may be handed to anybody.
 *
 * 🚨 THE RULE THAT STOPS A NOTE CARRYING ITS BUYER'S CLOCK.
 *
 * MEASURED 2026-08-18, spend `4zWERbE1NPaR…`. The buyer paid at 05:31:35 and
 * the depositing ephemeral was funded at 05:31:36. One second. So the walk
 * spend → commitment (cleartext, byte 160) → the deposit that emitted it → the
 * ephemeral that paid for it → its funder → "the transfer one second before"
 * lands on the buyer, deterministically, with nothing to guess.
 *
 * ⛔ A CROWD DOES NOT FIX THIS AND WAITING AFTERWARDS DOES NOT EITHER. A
 * thousand buyers an hour still leave one transfer in that second, and a
 * maturity delay imposed AFTER the purchase moves the spend while leaving the
 * deposit's timestamp exactly where it was. The join is written at deposit
 * time and it is permanent.
 *
 * What breaks it is refusing to issue a YOUNG note: a deployment that can only
 * hand out notes deposited long ago cannot mint one to order, so the deposit
 * carries no information about who asked. That turns the walk back into "which
 * of the buyers in this window", which is the guess a crowd actually dilutes.
 *
 * ~1 hour at 400ms/slot. Overridable so a test deployment can lower it — and
 * lowering it is a privacy decision, not a tuning knob: at 0 this route is the
 * mint-to-order shape the measurement above condemns.
 */
const DEFAULT_MIN_AGE_SLOTS = 9_000;

function minAgeSlots(): number {
  const raw = process.env.P01_TREASURY_NOTE_MIN_AGE_SLOTS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MIN_AGE_SLOTS;
  const n = Number(raw);
  // A malformed value must not silently become 0 — that is the one value that
  // turns the rule off, and it is the shape this exists to refuse.
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MIN_AGE_SLOTS;
  return Math.floor(n);
}

/** The treasury's pool seed, 32 bytes as 64 hex characters. */
/**
 * Every seed this treasury holds, in order.
 *
 * \U0001f6a8 IT IS A LIST BECAUSE ONE SEED WAS NOT ENOUGH, and the cost of
 * pretending otherwise was ten notes. MEASURED 2026-08-31: the restock derived
 * its seed from a wallet signature and an ORIGIN, this route read a fixed hex,
 * and nobody had copied one into the other. Ten deposits landed at leaves 83-92
 * — 10 SOL — owned by a seed this route did not have. Nothing failed while it
 * happened; each deposit returned a signature and cost 1.003 SOL, because the
 * mismatch is only visible from the issuing side.
 *
 * The single-seed shape made that unrecoverable EXCEPT by switching, which
 * orphans whatever the current seed owns — trading one silent loss for another.
 * A treasury that can hold several seeds simply owns both sets.
 *
 * `P01_TREASURY_POOL_SEED` takes one hex seed or several separated by commas.
 * ⛔ ORDER MATTERS AND THE FIRST IS THE ACTIVE ONE: it is the seed a leaf is
 * derived under when the treasury deposits something new. The rest are read-only
 * in practice — they open what they already own.
 *
 * \u26a0 A malformed entry is DROPPED, not defaulted. A typo in one of several
 * seeds must not silently become a treasury that owns nothing, and it must not
 * take the others down with it.
 */
// ⛔ The parser lives in lib/privacy/treasurySeeds.ts and is imported by every
// route that reads it. It used to be copied into four files and moved in one,
// which is how contribute-note and swap-note came to report an empty treasury
// the moment this variable became a list.

/** The seed new notes are created under. The first configured one. */
const treasurySeed = activeTreasurySeed;

/**
 * The leaf indices this deployment deposited and is willing to give away.
 *
 * EXPLICIT, not discovered. The server could scan the pool and claim every leaf
 * whose commitment its seed reproduces — but a derivation bug, a wrong pool or a
 * seed reused across environments would then quietly hand out notes nobody meant
 * to give, and the failure would look like success. A list an operator typed is
 * a list an operator can be asked about.
 */
/**
 * The denomination the treasury's inventory actually sits in.
 *
 * 🚨 LEAF INDICES ARE ONLY MEANINGFUL INSIDE ONE POOL. Every pool has its own
 * tree, so leaf 34 of the 1 SOL pool and leaf 34 of the 0.1 SOL pool are
 * different notes — and asking for the wrong one produces "the configured
 * inventory does not match the chain", which is correct and reads like a
 * derivation bug.
 *
 * The client used to hard-code what it asked for, so a treasury that deposited
 * into any other pool was simply unreachable. Publishing it here lets the
 * client ask for what exists instead of guessing.
 */
function inventoryDenomination(): number {
  const raw = Number(process.env.P01_TREASURY_NOTE_DENOMINATION ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : 0.1;
}

/**
 * ⚠️ A RANGE IS AUTHORISATION, NOT DISCOVERY, and the distinction is the whole
 * reason this is not a scan.
 *
 * `83-200` means "I deposited into this range and I am willing to give those
 * away". It is still a bound an operator typed and can be asked about; what it
 * removes is the config change after every restock, which is the step that
 * would otherwise be forgotten and leave a stocked pool reporting empty.
 *
 * ⛔ It is NOT a licence to hand out anything in the range. Every leaf still has
 * to reproduce from the seed, exist on the tree at that index, be unspent, and
 * clear the maturity gate — so a wrong pool or a reused seed still fails loudly
 * rather than quietly giving notes away.
 *
 * The 512 cap is a typo guard: `0-99999999` would otherwise build an array big
 * enough to take the route down, and the failure would be a timeout rather than
 * a message.
 */
const MAX_INVENTORY_LEAVES = 512;

/**
 * The leaves an operator CONFIGURED, from `P01_TREASURY_NOTE_LEAVES`.
 *
 * This is the seed of the inventory and it can only be changed by a human
 * editing an environment variable and redeploying. That is fine for a starting
 * stock and it is fatal for a stock that is supposed to refill, which is why
 * `inventoryLeaves` below unions it with a set this process can WRITE.
 */
function seededInventoryLeaves(): number[] {
  const out: number[] = [];
  for (const piece of (process.env.P01_TREASURY_NOTE_LEAVES ?? '').split(',')) {
    const s = piece.trim();
    // 🚨 THE EMPTY-STRING FILTER IS LOAD-BEARING, and it was missing.
    // `''.split(',')` is `['']`, and `Number('')` is 0 — an integer, and >= 0.
    // So an UNSET variable produced an inventory of exactly one leaf, index 0,
    // and the readiness check reported it as configured. Found by curling the
    // built route rather than by any test, which is the argument for curling
    // the built route.
    if (s.length === 0) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(s);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi < lo) continue;
      for (let i = lo; i <= hi && out.length < MAX_INVENTORY_LEAVES; i += 1) out.push(i);
      continue;
    }
    const n = Number(s);
    if (Number.isInteger(n) && n >= 0 && out.length < MAX_INVENTORY_LEAVES) out.push(n);
  }
  // A leaf listed twice would be tried twice and could be reported as two
  // slots of stock that are one note.
  return [...new Set(out)];
}

/**
 * The KV set of leaves this deployment ACQUIRED at runtime, per pool.
 *
 * 🚨 WHY THIS HAD TO EXIST BEFORE A NOTE COULD EVER COME BACK IN. The inventory
 * was a synchronous read of one environment variable, so there was nowhere for
 * an incoming leaf to be recorded: a route cannot write its own env, and the
 * documented procedure was a human copying leaf indices into TWO places (a
 * Vercel variable and a GitHub secret) and redeploying. Until a deposited leaf
 * could enter that list without a person, "the stock refills itself" was false
 * by construction, and so was any exchange that hands one note in and takes
 * another out.
 *
 * ⚠️ ADDITIVE, NEVER AUTHORITATIVE. The seeded list still decides the starting
 * stock and an empty KV changes nothing, so a deployment that has never taken a
 * note in behaves exactly as before. That is deliberate: this is the money path,
 * and a new store should not be able to make notes appear.
 */
const KV_INVENTORY_PREFIX = 'p01:note:inventory:';

async function acquiredInventoryLeaves(poolKey: string): Promise<number[]> {
  const kv = getStore();
  if (!kv) return [];
  try {
    const members = await kv.smembers(KV_INVENTORY_PREFIX + poolKey);
    const out: number[] = [];
    for (const m of members) {
      const n = Number(m);
      if (Number.isInteger(n) && n >= 0) out.push(n);
    }
    return out;
  } catch {
    // A KV that cannot be read yields NO extra stock rather than an error. The
    // seeded list still serves, which is the same behaviour this route had
    // before the set existed.
    return [];
  }
}

/**
 * Record a leaf this deployment now owns, so it can be issued later.
 *
 * 🚨 ONLY LEAVES WHOSE OPENING THIS TREASURY *DERIVES*. Issuance does not
 * store note secrets — it recomputes them with `deriveNoteMaterial(seed, pool,
 * leafIndex)` and `deriveNoteBlinding(...)` and checks the result against the
 * chain. So a leaf whose secrets belong to somebody else derives to a
 * commitment that is NOT the one on the tree at that index, and the loop below
 * answers 500 'the configured inventory does not match the chain' — to a
 * buyer, on a paid request, having already marked the leaf issued.
 *
 * ⛔ A NOTE HANDED IN BY A USER IS THEREFORE NOT INVENTORY, however well it is
 * verified. The note-in exchange never records one: the holder SPENDS it (a
 * circuit-7 withdrawal to the till, claimed at `claim-for-payment`) and is
 * issued an existing treasury leaf, so nothing of theirs ever enters the
 * issuable set. Pointing an incoming leaf at this function would look correct
 * and break issuance for everyone.
 *
 * ⛔ AND THE CALLER MUST STILL HAVE VERIFIED THE NOTE — that the commitment is
 * a leaf of this pool, that its nullifier is unspent, and that its denomination
 * matches. This function is bookkeeping; it establishes nothing.
 */
export async function recordInventoryLeaf(poolKey: string, leafIndex: number): Promise<boolean> {
  const kv = getStore();
  if (!kv) return false;
  if (!Number.isInteger(leafIndex) || leafIndex < 0) return false;
  try {
    await kv.sadd(KV_INVENTORY_PREFIX + poolKey, String(leafIndex));
    return true;
  } catch {
    return false;
  }
}

/**
 * Everything this deployment may hand out for `poolKey`: what was configured,
 * plus what it has taken in.
 *
 * Called with no pool for the readiness check, where only the configured half
 * is meaningful — a GET has no pool to scope the acquired set to.
 */
/**
 * How far past the tree's height to look for leaves this treasury can open.
 *
 * Each step is a Poseidon derivation and a map lookup, no RPC, so a few hundred
 * costs nothing next to the two chain reads the route already makes.
 */
const DISCOVERY_LOOKAHEAD = 64;

/**
 * The leaves this treasury can actually OPEN, read off the tree.
 *
 * \U0001f6a8 THE BUG THIS FIXES, MEASURED 2026-08-31. The treasury owned six
 * leaves in the 1 SOL pool -- 18, 19, 20, 21, 25, 26 -- and
 * `P01_TREASURY_NOTE_LEAVES` named exactly one of them. Five notes it had
 * deposited and could derive were invisible to this route, which reported an
 * inventory of one while sitting on six. Nothing was wrong with the notes; the
 * LIST was wrong, and a list maintained by a human in two places (a Vercel
 * variable and a GitHub secret, with no sync check) drifts by default.
 *
 * The treasury does not need to be told what it owns. It derives every note it
 * ever deposited from its own seed, so it can ask the tree directly: for each
 * index, is MY commitment sitting there? A leaf that answers yes is stock by
 * definition -- the same derivation `issue-note` uses to hand it over.
 *
 * \u26a0 ADDITIVE, NEVER SUBTRACTIVE, like the KV set beside it. A configured
 * leaf stays configured even if a chain read fails or returns nothing, so a
 * flaky RPC can never make stock vanish. Discovery only ever ADDS.
 *
 * \u26d4 AND IT CANNOT INVENT ONE. A leaf is discovered only when the commitment
 * derived from THIS seed at THAT index is the commitment on the tree at that
 * index -- which is precisely the check the issuance loop makes before sealing.
 * Notes deposited under a different seed are not found, and must not be: this
 * route could not open them.
 */
function discoverOwnedLeaves(
  seed: Uint8Array,
  pool: { poolPDA: PublicKey; tokenMint: PublicKey },
  commitments: Map<string, OnChainCommitment>,
): number[] {
  let maxLeaf = -1;
  for (const c of commitments.values()) if (c.leafIndex > maxLeaf) maxLeaf = c.leafIndex;
  // An EMPTY map is not an empty tree, it is far more likely an RPC that
  // answered with nothing. Discovering from it would find nothing anyway, but
  // the bound is stated so a future edit cannot read it as "scan everything".
  if (maxLeaf < 0) return [];

  const mintField = pubkeyToField(pool.tokenMint);
  const found: number[] = [];
  const ceiling = Math.min(maxLeaf + DISCOVERY_LOOKAHEAD, MAX_INVENTORY_LEAVES * 4);
  for (let leafIndex = 0; leafIndex <= ceiling; leafIndex += 1) {
    const { secret, nullifierPreimage } = deriveNoteMaterial(seed, pool.poolPDA, leafIndex);
    const commitment = createCommitmentV3(
      nullifierPreimage,
      secret,
      deriveNoteBlinding(seed, pool.poolPDA, leafIndex),
      mintField,
    );
    const onChain = commitments.get(commitment.toString());
    if (onChain && onChain.leafIndex === leafIndex) found.push(leafIndex);
  }
  return found;
}

async function inventoryLeaves(
  poolKey?: string,
  discovered?: number[],
): Promise<number[]> {
  const seeded = seededInventoryLeaves();
  if (!poolKey) return seeded;
  const acquired = await acquiredInventoryLeaves(poolKey);
  // ⛔ NOT CUT HERE ANY MORE. The union used to be sliced to 512 before a single
  // gate ran, with the DISCOVERED leaves last, so a growing deployment's mature
  // stock was dropped unexamined while the buyer was told the stock was too
  // young. The pure gates in POST now see every candidate and the 512 cap falls
  // on the ELIGIBLE ones (`__tests__/api/issue-note.node.test.ts` "an inventory
  // larger than the walk"). The seeded half keeps its own typo guard above, and
  // discovery its ceiling.
  return [...new Set([...seeded, ...acquired, ...(discovered ?? [])])];
}

/**
 * [READY-1] "Can a note be handed over RIGHT NOW?", answered on a fixed clock.
 *
 * `configured` says this deployment is set up to sell. It says nothing about
 * whether the stock holds a note old enough, unspent and unsold, and the pool
 * panel read nothing else: a buyer paid the till against stock that was all
 * too young, and a deployment that could not answer sent them to a deposit of
 * their own without asking (map-A defect 6).
 *
 * ⛔ ONE SAMPLE PER 10-MINUTE UTC BUCKET, NEVER REFRESHED BY A SALE. A flag
 * recomputed on every issuance would tell anyone polling this GET the minute a
 * note left stock, and so time a purchase against the note it bought. So:
 *   - a GET in a bucket with no sample answers null and hands ONE sample to
 *     `after()`, so the reply waits for no chain read;
 *   - the sample runs the sale's own gates read-only (on the tree, ours, age,
 *     spent, claimed) and writes `{ bucket, issuableNow }` with no expiry,
 *     keeping a sample another instance already wrote for that bucket;
 *   - every later GET of the bucket serves that sample; an older bucket's
 *     sample is never served (null until the new one lands);
 *   - POST never touches the row.
 * Pinned by `__tests__/api/issue-note.test.ts` "READY-1" ("no snapshot gives
 * null, with no RPC on the request path", "the value is stable inside a bucket
 * across an issuance", "one sample per bucket", "the sample row holds its
 * bucket and a yes or no").
 *
 * ⚠️ THE SAMPLE IS TAKEN WHEN THE BUCKET'S FIRST GET ARRIVES, not at the
 * bucket's edge, so a caller who is alone in asking picks that moment inside
 * the bucket. It still gets one sample per bucket, and the row names no leaf,
 * no count and no wait. What a copy of the store shows is the last bucket in
 * which somebody asked, and whether stock was issuable then.
 */
const READINESS_BUCKET_MS = 10 * 60 * 1000;
const KV_READINESS_PREFIX = 'p01:note:readiness:';

interface ReadinessSample {
  bucket: number;
  issuableNow: boolean;
}

/** A stored sample, or null for anything that is not exactly one. */
function readinessSampleOf(raw: unknown): ReadinessSample | null {
  if (!raw || typeof raw !== 'object') return null;
  const { bucket, issuableNow } = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(bucket) || typeof issuableNow !== 'boolean') return null;
  return { bucket: bucket as number, issuableNow };
}

/** The bucket this instance has a sample in flight for, so repeated GETs hand over one. */
let samplingBucket: number | null = null;

/**
 * Whether a POST now would hand a note over: the sale's reads and gates, in
 * the sale's order, with nothing claimed and nothing written.
 *
 * `null` when that cannot be told: a read failed, the RPC is not devnet, or
 * the history came back without a leaf that could have been the answer. That
 * is never guessed as "no", for the reason the sale gives for its own 502.
 */
async function sampleIssuableNow(
  kv: KvLike,
  pool: { poolPDA: PublicKey; tokenMint: PublicKey },
): Promise<boolean | null> {
  const allSeeds = treasurySeeds();
  const activeSeed = allSeeds[0];
  if (!activeSeed) return null;
  const connection = new Connection(
    process.env.P01_FUNDER_RPC ?? 'https://api.devnet.solana.com',
    'confirmed',
  );
  let commitments: Map<string, OnChainCommitment>;
  let spent: ReadonlySet<string>;
  let currentSlot: number;
  try {
    // Devnet only, like the sale: no walk against another cluster.
    if ((await connection.getGenesisHash()) !== DEVNET_GENESIS) return null;
    commitments = await fetchPoolCommitments(connection, pool.poolPDA);
    spent = await fetchSpentNullifierSet(connection, pool.poolPDA);
    currentSlot = await connection.getSlot('finalized');
  } catch {
    return null;
  }
  const poolKey = pool.poolPDA.toBase58();
  const seedForLeaf = new Map<number, Uint8Array>();
  const discovered: number[] = [];
  for (const candidate of allSeeds) {
    for (const leafIndex of discoverOwnedLeaves(candidate, pool, commitments)) {
      if (seedForLeaf.has(leafIndex)) continue;
      seedForLeaf.set(leafIndex, candidate);
      discovered.push(leafIndex);
    }
  }
  const leaves = await inventoryLeaves(poolKey, discovered);
  const minAge = minAgeSlots();
  let maxLeafOnTree = -1;
  const onTreeAt = new Set<number>();
  for (const e of commitments.values()) {
    onTreeAt.add(e.leafIndex);
    if (e.leafIndex > maxLeafOnTree) maxLeafOnTree = e.leafIndex;
  }
  let unread = 0;
  let claimReads = 0;
  for (const leafIndex of leaves) {
    const leafSeed = seedForLeaf.get(leafIndex) ?? activeSeed;
    const { secret, nullifierPreimage } = deriveNoteMaterial(leafSeed, pool.poolPDA, leafIndex);
    const commitment = createCommitmentV3(
      nullifierPreimage,
      secret,
      deriveNoteBlinding(leafSeed, pool.poolPDA, leafIndex),
      pubkeyToField(pool.tokenMint),
    );
    const onChain = commitments.get(commitment.toString());
    // Not deposited yet, or not read back: the sale's two gates, in its order.
    if (!onChain && maxLeafOnTree >= 0 && leafIndex > maxLeafOnTree) continue;
    if (!onTreeAt.has(leafIndex)) {
      unread += 1;
      continue;
    }
    if (!onChain || onChain.leafIndex !== leafIndex) continue;
    // An unknown slot is too young, as in the sale.
    if (onChain.depositSlot === null || currentSlot - onChain.depositSlot < minAge) continue;
    if (isNullifierSpentInSet(spent, pool.poolPDA, nullifierPreimage, secret)) continue;
    // The sale's walk stops at the same number of claims.
    if (claimReads >= MAX_INVENTORY_LEAVES) return false;
    claimReads += 1;
    let claimed: unknown;
    try {
      // READ, never `incr`: the sample takes nothing out of stock.
      claimed = await kv.get(`p01:note:issued:${poolKey}:${leafIndex}`);
    } catch {
      return null;
    }
    if (claimed === null || claimed === undefined) return true;
  }
  return unread > 0 ? null : false;
}

/**
 * The request path of the readiness answer: ONE KV read, and no chain.
 * The sample, when this bucket has none, is scheduled here and runs after the
 * reply (see "[READY-1]" above).
 */
async function readIssuableNow(kv: KvLike): Promise<boolean | null> {
  const pool = getPoolsForTokenV3('SOL').find((p) => p.denomination === inventoryDenomination());
  if (!pool) return null;
  const key = KV_READINESS_PREFIX + pool.poolPDA.toBase58();
  const bucket = Math.floor(Date.now() / READINESS_BUCKET_MS);
  let sample: ReadinessSample | null = null;
  try {
    sample = readinessSampleOf(await kv.get(key));
  } catch {
    // Unreadable is no sample: null, and a sample is asked for below.
  }
  if (sample && sample.bucket === bucket) return sample.issuableNow;
  if (samplingBucket === bucket) return null;
  const task = async () => {
    try {
      // One sample per bucket: keep one another instance already wrote.
      if (readinessSampleOf(await kv.get(key))?.bucket === bucket) return;
      const issuableNow = await sampleIssuableNow(kv, pool);
      if (issuableNow === null) return;
      if (readinessSampleOf(await kv.get(key))?.bucket === bucket) return;
      await kv.set(key, { bucket, issuableNow });
    } catch {
      // No sample this time; the next GET of the bucket asks again.
    } finally {
      if (samplingBucket === bucket) samplingBucket = null;
    }
  };
  try {
    after(task);
    samplingBucket = bucket;
  } catch {
    // Outside a request scope `after()` throws: nothing is sampled, and the
    // answer stays null ("outside a request scope, a GET samples nothing").
  }
  return null;
}

export async function GET() {
  // Readiness, in the shape /api/fund-ephemeral uses: every way this is switched
  // off is silent at the point of use, so it has to be answerable in advance.
  const seed = treasurySeed();
  // No pool here to scope the acquired set to, and the readiness question is
  // about CONFIGURATION anyway: a deployment with an empty seeded list has
  // nothing to start from, whatever it may take in later.
  const leaves = await inventoryLeaves();
  const kv = getStore();
  const reasons: string[] = [];
  if (!seed) reasons.push('P01_TREASURY_POOL_SEED holds no well-formed 64-hex seed (one, or several comma-separated).');
  if (leaves.length === 0) reasons.push('P01_TREASURY_NOTE_LEAVES lists no leaf indices.');
  if (!process.env.P01_FUNDER_TICKET) reasons.push('P01_FUNDER_TICKET is unset.');
  if (!kv) reasons.push('No durable KV store, so issued notes cannot be tracked and this refuses.');
  // [READY-1] One KV read, no chain: see readIssuableNow.
  const issuableNow = reasons.length === 0 && kv ? await readIssuableNow(kv) : null;
  return NextResponse.json({
    ok: true,
    configured: reasons.length === 0,
    inventorySize: leaves.length,
    // true, false, or null (not known this bucket): one sample per 10-minute
    // bucket, never a wait time (`__tests__/api/issue-note.test.ts` "READY-1").
    issuableNow,
    // The client asks for THIS, rather than assuming. Leaf indices only mean
    // something inside one pool.
    denomination: inventoryDenomination(),
    token: 'SOL',
    reasons,
    // Never folded into `configured` (__tests__/lib/rateLimitKey.test.ts).
    advisories: rateLimitAdvisories(),
    note:
      'inventorySize counts what was CONFIGURED, not what is still unissued — reading the ' +
      'remaining count would require the KV lookups an issuance does, and an endpoint that ' +
      'reports a number it did not check is how a demo discovers an empty inventory on stage.',
  });
}

export async function POST(request: NextRequest) {
  const ticket = process.env.P01_FUNDER_TICKET;
  const allSeeds = treasurySeeds();
  const seed = allSeeds[0] ?? null;
  if (!seed) return bad(503, 'this deployment issues no notes');
  if (!ticket) return bad(503, 'no ticket configured; refusing to hand out notes anonymously');
  if (request.headers.get('x-p01-funder-ticket') !== ticket) {
    return bad(401, 'bad or missing ticket');
  }

  let body: { recipientAddress?: unknown; token?: unknown; denomination?: unknown };
  try {
    body = await request.json();
  } catch {
    return bad(400, 'body must be JSON');
  }

  // Read once, from the headers, before anything is consumed: it only decides
  // how an exhaustion is WORDED (`exhausted`), never what the route does.
  const operator = asksAsOperator(request);

  const recipientAddress = String(body.recipientAddress ?? '');
  if (!isNoteEncryptionAddress(recipientAddress)) {
    return bad(400, 'recipientAddress is not a p01pq: note address');
  }
  const token = body.token === 'USDC' ? 'USDC' : 'SOL';
  const denomination = Number(body.denomination);
  if (!Number.isFinite(denomination) || denomination <= 0) {
    return bad(400, 'denomination must be a positive number');
  }
  const pool = getPoolsForTokenV3(token).find((p) => p.denomination === denomination);
  if (!pool) return bad(400, `no ${denomination} ${token} pool is configured`);
  // Refuse a request for a pool this treasury did not deposit into, BEFORE the
  // claim is consumed. Without this the leaf indices would be looked up in the
  // wrong tree and fail on the on-chain check — after the claim was spent, for a
  // reason that reads like a derivation bug rather than a mismatched pool.
  if (denomination !== inventoryDenomination()) {
    return bad(400, `this deployment issues ${inventoryDenomination()} ${token} notes`, {
      denomination: inventoryDenomination(),
    });
  }

  // Same posture as the funder: no durable counter, no handing over value. Here
  // it is doubly load-bearing, because the claim that stops a note being issued
  // twice is a KV increment.
  const kv = getStore();
  if (!kv) return bad(503, 'no durable store is configured; refusing to issue notes untracked');
  try {
    if (await rateLimitExceeded(kv, clientIp(request), RATE_SALT, ISSUES_PER_IP_PER_HOUR)) {
      return bad(429, 'too many note requests from this address in the last hour', {
        limit: ISSUES_PER_IP_PER_HOUR,
      });
    }
  } catch {
    return bad(503, 'the rate limiter could not be read');
  }

  const connection = new Connection(
    process.env.P01_FUNDER_RPC ?? 'https://api.devnet.solana.com',
    'confirmed',
  );
  // Checked against the chain rather than the URL string, for the same reason
  // the funder does: an env var pointing at mainnet and named "devnet" would
  // give away real money.
  let genesis: string;
  try {
    genesis = await connection.getGenesisHash();
  } catch {
    return bad(502, 'the configured RPC could not be reached');
  }
  if (genesis !== DEVNET_GENESIS) {
    return bad(403, 'this issuer is devnet-only and the configured RPC is not devnet', { genesis });
  }

  // ── The payment gate ─────────────────────────────────────────────────────
  //
  // A note IS the denomination. Handing one over is handing over money, so it
  // happens against a claim that something was paid for — not against a ticket
  // that ships in the browser bundle.
  //
  // The shape is deliberately dumb and auditable: a claim code exists in KV, was
  // put there by whatever took the payment, and is consumed here ATOMICALLY. It
  // is not a payment integration and does not pretend to be one — it is the
  // seam a payment integration plugs into, and the thing that stops the endpoint
  // being a faucet in the meantime.
  //
  // ⛔ NO "SKIP IF UNSET". A gate that is optional is a gate that is off in
  // production on the day it matters, because the env var that enables it is the
  // one nobody set. Unconfigured means REFUSE, and the operator turns it on by
  // minting claims rather than by removing a check.
  const claimCode = String((body as { claimCode?: unknown }).claimCode ?? '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(claimCode)) {
    return bad(402, 'a paid claim code is required to receive a note', {
      hint: 'Notes are the denomination itself. One is issued per claim, and a claim is created when a payment settles.',
    });
  }
  let claimed: number;
  try {
    // `incr` is the whole concurrency argument: exactly one caller sees 1, so a
    // claim cannot be spent twice even if two requests arrive together. Reading
    // then writing would let both pass and hand out two notes for one payment.
    claimed = await kv.incr(`p01:note:claim:${claimCode}`);
  } catch {
    return bad(503, 'the claim could not be read');
  }
  const sealedKey = sealedReplyKey(claimCode);
  if (claimed !== 1) {
    /**
     * 🚨 A RETRY IS NOT A SECOND SALE, and this is where a lost answer used to
     * become a lost note. The claim is consumed by `incr` before the chain is
     * read, so a response that never arrived — a dropped connection, a closed
     * tab — left the buyer with 409 forever and the leaf claimed for nobody.
     *
     * The reply of the call that worked is kept under the hash of the code, so
     * the same code returns the same bytes and no second leaf leaves stock
     * (`__tests__/api/issue-note.node.test.ts` "the same code, retried").
     *
     * ⛔ A code with no stored reply is still refused. That is the guessing
     * case and the concurrent-redemption case, and both must stay 409.
     */
    let stored: SealedReply | null = null;
    try {
      stored = await kv.get<SealedReply>(sealedKey);
    } catch {
      // Unreadable: answered as already used below, which is what this request
      // received before any reply was stored.
    }
    if (stored && typeof stored.sealedNote === 'string') {
      return NextResponse.json({ ok: true, ...stored, replayed: true });
    }
    return bad(409, 'this claim code has already been used', {
      hint: 'A claim is worth one note. If a note was not received, ask again with the SAME code: the reply of the call that worked is kept.',
    });
  }
  // A claim must have been MINTED, not merely typed. `incr` above created the
  // key if it was absent, so the existence check has to be separate — and it
  // has to come after the claim, or two callers race on an unminted code.
  //
  // The reply an earlier attempt may have stored for this code is read in
  // the same breath, and decided on below the release helper (`earlier`).
  const earlierRead = kv.get<SealedReply>(sealedKey).then(
    (stored) => ({ stored }),
    () => null,
  );
  let minted: string | null = null;
  try {
    minted = await kv.get<string>(`p01:note:claim-minted:${claimCode}`);
  } catch {
    /**
     * ⛔ UNREADABLE IS NOT UNMINTED, so the code goes back. The 402 below
     * burns a code on purpose, because its answer is a verdict: this code was
     * never sold. A read that failed is no verdict, and answering it with the
     * 402 burned a code somebody had paid for on a store blip and told them
     * they never paid. Nothing is issued either way: a code nobody could check
     * authorises no value. Giving it back opens no guessing oracle. This answer
     * is the same for a paid code and a guessed one, and a guess is still read
     * exactly once before it is burned
     * (`__tests__/api/issue-note.node.test.ts` "a claim row the store could
     * not read"; red: web-run/logs/ISSUE-1-webfix3/sandbox-minted/wp-logs/
     * ISSUE-1-red.log).
     */
    try {
      await kv.del(`p01:note:claim:${claimCode}`);
    } catch {
      // Best effort, as in `release` below: a failed release costs this buyer
      // their retry, and no note moved either way.
    }
    return bad(503, 'the claim could not be checked; retry with the same code');
  }
  if (!minted) {
    return bad(402, 'this claim code was never issued against a payment', {
      hint: 'The code is now consumed either way, so a guessed code cannot be retried.',
    });
  }
  /**
   * Give a PAID claim back when this request hands no note over.
   *
   * 🚨 The claim is consumed above, before the chain is read, and that is
   * right: `incr` is the whole concurrency argument. What was wrong is that it
   * stayed consumed through every refusal below — and most of those refusals
   * are not errors at all, they are ordinary operational states. The stock is
   * too young. The RPC blinked. Every note is held by another address because
   * the buyer reloaded the page. In each case the customer paid, received
   * nothing, and cannot ask again.
   *
   * One of them says the quiet part in its own body: the all-spent refusal
   * ends with 'Nothing was charged.', which stopped being true the moment
   * `incr` returned.
   *
   * ⛔ GATED ON `minted`, AND THAT GATE IS THE WHOLE ANTI-ABUSE PROPERTY.
   * A code that was never minted is never released — it is burned on first
   * touch, exactly as the 402 above promises, so guessing still costs one
   * attempt per code. Only a claim this deployment actually sold comes back.
   * Placed after the `minted` check so it cannot be called before that is
   * known.
   *
   * ⚠️ EVERY `return bad(...)` BELOW THIS POINT MUST GO THROUGH HERE, and a
   * test scans this file to keep it that way. The failure mode is invisible:
   * the refusal reads as correct and the payment is simply gone.
   */
  const release = async (res: NextResponse) => {
    try {
      await kv.del(`p01:note:claim:${claimCode}`);
    } catch {
      // Best effort. A failed release costs this buyer their retry, which is
      // the behaviour being fixed — but throwing here would replace an
      // accurate error with a misleading one, and no note moved either way.
    }
    return res;
  };

  /**
   * The one answer every exhaustion gives a caller who is not the operator
   * (see EXHAUSTED_ERROR above). Same status, same bytes, whatever the walk
   * found — so a code that comes back cannot be re-polled into a reading of the
   * inventory. The operator, who proved it with the password, still gets the
   * exhaustion that actually happened, counts and all.
   */
  /**
   * ⚠️ IT EQUALIZES THE BYTES, NOT THE WORK — A DISCLOSED RESIDUAL, FOR THE
   * FOUNDER (gate r1, RED 7f).
   *
   * Two worlds that answer identically can still take different numbers of
   * store round trips to get here: the walk takes the atomic claim (`kv.incr`)
   * on a candidate that turns out to be spoken for, and skips to the next leaf
   * BEFORE that line when the candidate is spent or too young. So the latency
   * still moves with the inventory state, and a re-poller holding one released
   * claim code can read a transition the byte-equal answer hides.
   *
   * ⛔ NOT PATCHED HERE, BECAUSE THE OBVIOUS FIX IS WORSE: equalizing the work
   * means taking the claim on every candidate in every world, which consumes
   * inventory to answer a refusal. A constant-time walk or a fixed delay is a
   * decision about latency on a paid path. Measured and pinned by
   * `__tests__/api/issue-note.node.test.ts`, "equalizes the BYTES of the refusal
   * and not the WORK behind it — residual, measured", which fails the day it is
   * closed.
   */
  const exhausted = (status: number, error: string, extra: Record<string, unknown> = {}) =>
    operator ? bad(status, error, extra) : bad(503, EXHAUSTED_ERROR, { hint: EXHAUSTED_HINT });

  /**
   * 🚨 A REPLY ALREADY STORED FOR THIS CODE IS THE NOTE, EVEN ON A FIRST CLAIM.
   *
   * A reply write can land while its answer, and then its read-back, are
   * lost. The route cannot tell that from a write that never landed, so it
   * gives the code back and answers 503 "retry with the same code", and the
   * reply sits in the store all the same. A retry that sold again handed over
   * a second note, and a retry overlapping it replayed the first: one paid
   * code, two notes (verifier web-run r3 probe P-DOUBLE,
   * web-run/logs/verify-ISSUE-1-r3/probe-double.log). So a first claim
   * replays a stored reply exactly as a retry of a spent claim does, and the
   * code stays spent, because this answer delivers the note.
   *
   * ⛔ AN UNREADABLE REPLY IS NOT AN ABSENT ONE. Selling while it cannot be
   * read is the same double, so the code goes back and nothing leaves stock.
   *
   * Pinned by `__tests__/api/issue-note.node.test.ts` "gives one note for one
   * code when the write landed but could not be read back, however the
   * retries overlap" and "does not sell again while the reply an earlier
   * attempt stored cannot be read" (red: web-run/logs/ISSUE-1-webfix4/
   * sandbox-double/wp-logs/ISSUE-1-red.log). The read shares the claim
   * row's round trip, so a sale waits for no extra one
   * (web-run/logs/ISSUE-1-webfix4/probe-real-client-after.log, P0).
   */
  const earlier = await earlierRead;
  if (!earlier) return release(bad(503, 'the claim could not be checked; retry with the same code'));
  if (earlier.stored && typeof earlier.stored.sealedNote === 'string') {
    await forgetTheCodeToPaymentTrail(kv, claimCode, minted);
    return NextResponse.json({ ok: true, ...earlier.stored, replayed: true });
  }

  // The pool's leaves, once, for the discovery below and the on-chain checks
  // further down. No Merkle path is built from them any more: see "the sealed
  // note" in `__tests__/api/issue-note.node.test.ts`.
  //
  // ⚠ READ BEFORE THE INVENTORY IS DECIDED, and that ordering moved. The
  // inventory used to be a pure read of configuration, so "no inventory" could
  // be answered without touching the chain. It cannot be any more: the treasury
  // now DISCOVERS what it owns by asking the tree, and a leaf it can open is
  // stock whether or not a human wrote it down. The cost is that an unreadable
  // pool answers 502 where it once answered 503 — which is the honest order,
  // since "we cannot see the tree" is not "we have nothing".
  let commitments: Map<string, OnChainCommitment>;
  try {
    commitments = await fetchPoolCommitments(connection, pool.poolPDA);
  } catch {
    return release(bad(502, 'the pool\'s history could not be read'));
  }

  /**
   * \u26d4 EVERY SEED, AND WHICH ONE OPENS WHICH LEAF.
   *
   * A leaf is derived under exactly one seed, so the loop below has to know
   * which — deriving under the wrong one produces a commitment that is on no
   * tree and answers 500 to a paying buyer. The map is the answer, built once
   * here rather than re-derived per candidate leaf.
   */
  const seedForLeaf = new Map<number, Uint8Array>();
  const discovered: number[] = [];
  for (const candidate of allSeeds) {
    for (const leafIndex of discoverOwnedLeaves(candidate, pool, commitments)) {
      if (seedForLeaf.has(leafIndex)) continue;
      seedForLeaf.set(leafIndex, candidate);
      discovered.push(leafIndex);
    }
  }
  const leaves = await inventoryLeaves(pool.poolPDA.toBase58(), discovered);
  if (leaves.length === 0) {
    return release(bad(503, 'this deployment has no note inventory', {
      discovered: discovered.length,
      hint:
        'Nothing is configured and the treasury seed opens no leaf on this pool. Either it has ' +
        'never deposited, or it is deriving from a different seed than the one that did — the ' +
        'derivation takes a wallet signature AND an origin, so the same wallet on a different ' +
        'origin is a different treasury.',
    }));
  }

  /**
   * 🚨 WHICH INVENTORY NOTES ARE ALREADY SPENT.
   *
   * A commitment stays on the tree forever, so "it is on the tree at the index
   * we expect" says nothing about whether the note behind it still exists. The
   * check below used to be the ONLY on-chain check, which means a leaf whose
   * note had been spent still read as good inventory and would have been
   * sealed and handed to a paying customer — money that looks received and is
   * not, discovered only when their subscription fails on a nullifier
   * collision after ~150 uploads and ~1 SOL of buffer rent.
   *
   * MEASURED 2026-08-18: leaf 26 was the whole inventory and a subscription
   * spent it. Nothing in this route noticed. What prevented the next buyer
   * from being handed it was a recipient marker that is gone (map-A defect 3) —
   * protection by accident, from a mechanism written for something else.
   *
   * `fetchSpentNullifierSet` reads addresses only, never bodies, and names no
   * note; `isNullifierSpentInSet` then decides locally with no further RPC.
   */
  let spent: ReadonlySet<string>;
  try {
    spent = await fetchSpentNullifierSet(connection, pool.poolPDA);
  } catch {
    // ⛔ Refuse rather than issue blind. An unread spent-set is not an empty
    // one, and the failure mode of guessing is handing over spent money.
    return release(bad(502, 'the pool\'s spent notes could not be read'));
  }

  // The clock the maturity rule is measured against. Read once, after the
  // history, so a note cannot look older than it is because the slot was
  // sampled late. `finalized` for the same reason the blockhash is: a
  // confirmed slot can be rolled back, and a rolled-back clock reads as extra
  // age, which is the direction that would issue a note too young.
  let currentSlot: number;
  try {
    currentSlot = await connection.getSlot('finalized');
  } catch {
    // ⛔ Refuse rather than issue blind. An unknown clock is not an old note.
    return release(bad(502, 'the chain\'s slot could not be read'));
  }
  const minAge = minAgeSlots();

  const poolKey = pool.poolPDA.toBase58();
  /**
   * Leaves that exist and have already left stock.
   *
   * Without this the walk ends at the same "the note inventory is empty" as a
   * genuinely unstocked deployment, and those two need opposite reactions:
   * one is "deposit more notes", the other is "the stock is sold, and a lost
   * answer comes back with the same claim code".
   *
   * ⛔ IT NO LONGER DEPENDS ON WHO IS ASKING. The per-leaf counter alone says a
   * leaf is gone, so nothing stores the address it went to (map-A defect 3).
   */
  // The highest leaf the tree actually holds. Needed to tell a leaf that is
  // NOT DEPOSITED YET from one whose commitment does not match — see the gate
  // inside the loop. Computed once: the map is already in memory.
  let maxLeafOnTree = -1;
  for (const e of commitments.values()) if (e.leafIndex > maxLeafOnTree) maxLeafOnTree = e.leafIndex;
  /** Authorised leaves the treasury has not deposited into yet. */
  let notYetDeposited = 0;
  let heldByOthers = 0;
  /** Configured leaves whose note has already been spent on chain. */
  let spentLeaves = 0;
  /** Configured leaves whose deposit is too recent to hand out yet. */
  let tooYoung = 0;
  /**
   * Configured indices the tree has reached but whose commitment is NOT ours.
   * The index belongs to somebody else's deposit, so the entry is stale, not a
   * seed error. MEASURED 2026-09-03: a live buyer paid 995,000,000 lamports to
   * the till, the exchange handed them a claim, and this route answered 500
   * because the shuffle drew index 103, which that same buyer had shielded
   * minutes earlier. One stale entry in a list of 318 refused a paid customer.
   */
  let notOurs = 0;
  /**
   * Inventory indices, configured or acquired, the history read did not bring
   * back, although the tree has reached them (or the read came back with
   * nothing at all).
   */
  let missingFromHistory = 0;
  /** How long the closest of those still has to wait, in slots. */
  let shortestWait = Number.POSITIVE_INFINITY;
  // Which indices the read returned, from the entries themselves: an index
  // holding somebody else's deposit is ON the tree, an absent one is unknown.
  const onTreeAt = new Set<number>();
  for (const e of commitments.values()) onTreeAt.add(e.leafIndex);
  // 🚨 SERVED IN RANDOM ORDER, AND IT WAS SERVED IN LIST ORDER.
  //
  // The loop used to walk `leaves` as configured, so the first buyer always
  // got the first leaf, the second the second, and so on. An analyst watching
  // the inventory be spent sees them go in order, infers the rule, and can then
  // map the Nth payment at the till to the Nth leaf — which hands back exactly
  // the buyer-to-note link this whole route exists to break.
  //
  // A shuffle costs nothing and removes that. It does NOT hide which leaves are
  // inventory, and it is not meant to: what it removes is the ORDER, which is
  // the part correlated with the buyer's clock.
  //
  // ⚠️ Math.random is right here and a CSPRNG would be theatre: this picks
  // between notes the operator already knows all of, and it protects against a
  // chain analyst reading public order, not against someone predicting a draw.
  const served = [...leaves];
  for (let i = served.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [served[i], served[j]] = [served[j], served[i]];
  }
  /**
   * 🚨 THE WALK CAP COUNTS CLAIMS, NOT CANDIDATES (map-A defect 5), AND THE
   * WALK IS LAZY.
   *
   * The cap used to cut the shuffled union to 512 before any gate ran, so a
   * mature note past the cut was never examined. It now bounds only the
   * `incr` round trips below; a candidate the pure gates skip does not count.
   * One case per gate in `__tests__/api/issue-note.node.test.ts` "an inventory
   * larger than the walk": "issues a candidate past the 512th" (too young; its
   * control counts all 600) and, with the free leaf as the 600th candidate,
   * "issues a free note behind 599 spent ones", "... behind 599 leaves the
   * history read did not bring back" and "... behind 599 leaves not deposited
   * yet". Counting any of those candidates stops the walk at 512 (reds:
   * web-run/logs/ISSUE-2-webfix2/sandbox-V1, -V13 and -V14).
   *
   * ⚠️ The gates run one candidate at a time and the walk stops at the first
   * note issued. Gating the whole union first made every sale pay a spent
   * check (a PDA derivation) per mature candidate: 1,239.6 ms median for one
   * happy-path POST at a union of 2,048 (wp-logs/ISSUE-2-fix1/
   * bench-before-fix1.log). Pinned by the same file's "stops at the first note
   * it can issue". A refusal still comes after a full walk (or the cap), so its
   * counts are unchanged.
   */
  let claimAttempts = 0;
  for (const leafIndex of served) {
    if (claimAttempts >= MAX_INVENTORY_LEAVES) break;
    // 🚨 EVERY REASON TO SKIP THIS LEAF IS DECIDED BEFORE THE CLAIM IS
    // TAKEN, AND THAT ORDER IS LOAD-BEARING.
    //
    // The claim below is consumed by `incr` and records who it went to. A leaf
    // skipped AFTER that point is a leaf marked as issued to a caller who was
    // never given it — harmless for a spent note, which is dead either way, and
    // actively destructive for a note that is merely TOO YOUNG: it is alive and
    // will be perfectly good in a few minutes, and binding it to whoever
    // happened to ask first takes it out of stock for everyone else. An
    // operator polling while a fresh batch matures would consume their whole
    // inventory without receiving one note, and a reloaded page presenting a
    // different note address would bind it to an address nobody holds — the
    // exact shape documented under `heldByOthers`.
    //
    // Nothing here has a side effect: the derivation is pure and the spent set
    // and the pool history were both read before the loop. So the race the
    // claim exists to stop is untouched — two callers still serialise on
    // `incr`, they just both do their arithmetic first.
    // ⚠️ ARGUMENT ORDER IS (nullifierPreimage, secret, blinding, tokenMintField)
    // and both of the first two are bigints, so getting them the wrong way round
    // type-checks and silently produces a commitment that is on no tree. The
    // on-chain check below is what caught it while writing this; do not remove
    // that check on the grounds that the derivation is "obviously" right.
    // Mirrors `poolNotes.ts:175` exactly, which is the derivation the rest of
    // the app finds notes with.
    // The seed that OPENS this leaf, which is not always the active one: a
    // treasury may hold several, and a leaf belongs to exactly one of them.
    // Falls back to the active seed for a leaf that came from configuration
    // rather than from discovery — the on-chain check below is what catches a
    // wrong guess, and it refuses rather than issuing an unspendable note.
    const leafSeed = seedForLeaf.get(leafIndex) ?? seed;
    const { secret, nullifierPreimage } = deriveNoteMaterial(leafSeed, pool.poolPDA, leafIndex);
    const noteBlinding = deriveNoteBlinding(leafSeed, pool.poolPDA, leafIndex);
    const commitment = createCommitmentV3(
      nullifierPreimage,
      secret,
      noteBlinding,
      pubkeyToField(pool.tokenMint),
    );

    // Looked up once, here: the age gate below needs it and so does the
    // configuration check further down.
    const onChain = commitments.get(commitment.toString());
    // 🚨 NOT DEPOSITED YET IS NOT A MISCONFIGURATION, and telling them apart is
    // what makes a RANGE authorisation usable at all.
    //
    // `P01_TREASURY_NOTE_LEAVES=83-200` says "I will give away anything I
    // deposit in here". Leaves past the end of the tree are simply future
    // stock. Falling through to the check below would answer 500 'the
    // configured inventory does not match the chain' AND mark the leaf issued —
    // burning a slot that would have been perfectly good once deposited.
    //
    // ⛔ This must run BEFORE the claim is taken, beside the age and spent
    // gates, for exactly the reason recorded there: a leaf skipped after the
    // claim is consumed anyway.
    //
    // A leaf INSIDE the tree whose commitment still does not match is a real
    // configuration error and keeps its 500. That is the property the explicit
    // list was written to protect and it is untouched.
    // ⛔ `maxLeafOnTree >= 0` IS THE SAFETY HALF. An EMPTY commitment map is not
    // an empty tree — it is far more likely an RPC that answered with nothing.
    // Without this clause every leaf would look like future stock and the route
    // would report a calm 'inventory is empty' for what is actually a broken
    // read: a loud failure turned quiet, which is the trade this repository
    // keeps paying for.
    if (!onChain && maxLeafOnTree >= 0 && leafIndex > maxLeafOnTree) {
      notYetDeposited += 1;
      continue;
    }
    // 🚨 AN INDEX THE READ DID NOT RETURN IS UNKNOWN, NOT SOMEBODY ELSE'S (map-A
    // defect 4). The tree is append-only, so every index up to its top exists;
    // one missing from the map means the history walk came back short. It used
    // to fall through to the claim, be counted as `notOurs` and stay claimed for
    // ever, so a short read burned a note that was perfectly good — and an
    // EMPTY read burned every configured one while answering 'the seed is
    // wrong'. Skipped here, before the claim, and refused with 502 below when
    // nothing was issued (`__tests__/api/issue-note.node.test.ts` "a leaf the
    // history read did not bring back"; `__tests__/api/issue-note.test.ts` "an
    // EMPTY commitment map still fails LOUD"). It holds for an ACQUIRED leaf,
    // the refill set, as much as for a configured one: the same describe's "is
    // never claimed when it was ACQUIRED rather than configured" (red:
    // web-run/logs/ISSUE-2-webfix2/sandbox-V5).
    if (!onTreeAt.has(leafIndex)) {
      missingFromHistory += 1;
      continue;
    }
    // 🚨 AGE, BEFORE ANYTHING IS SEALED. See DEFAULT_MIN_AGE_SLOTS: a note
    // young enough to have been minted for this caller carries their clock, and
    // no amount of crowd or later delay takes it back off. Skip to the next
    // leaf rather than refuse the request — young stock beside old stock is a
    // stocked deployment, exactly like a spent leaf beside a good one.
    //
    // ⛔ AN UNKNOWN SLOT IS TREATED AS TOO YOUNG. `depositSlot` is null when the
    // insert transaction carried no slot, and "we could not tell how old it is"
    // must not resolve to "old enough". Same direction as every other unknown
    // on this path.
    if (onChain && onChain.leafIndex === leafIndex) {
      const age = onChain.depositSlot === null ? -1 : currentSlot - onChain.depositSlot;
      if (age < minAge) {
        tooYoung += 1;
        if (age >= 0) shortestWait = Math.min(shortestWait, minAge - age);
        continue;
      }
    }
    // Spent notes are inventory that no longer exists. Skip to the next leaf
    // rather than refuse the request: an exhausted leaf beside a good one is a
    // stocked deployment, and a caller must not be turned away because the
    // FIRST configured index happens to be used up.
    if (isNullifierSpentInSet(spent, pool.poolPDA, nullifierPreimage, secret)) {
      spentLeaves += 1;
      continue;
    }
    claimAttempts += 1;

    // ATOMIC CLAIM, before any SIDE EFFECT. `incr` returns 1 only for the caller
    // that created the key, so exactly one concurrent request can win a leaf.
    // Two callers handed the same note means the second one's subscription
    // fails on a nullifier collision after ~150 uploads and ~1 SOL of buffer
    // rent, so this must stay ahead of everything that hands anything over.
    //
    // ⚠️ It used to say "before any work", and the work above used to sit below
    // it. That is no longer true and the difference matters: the derivation and
    // the two gates above are pure reads, so running them first serialises
    // nothing differently, while claiming first meant a leaf skipped for being
    // too young was consumed anyway. See the block at the top of this loop.
    const claimKey = `p01:note:issued:${poolKey}:${leafIndex}`;
    let claim: number;
    try {
      claim = await kv.incr(claimKey);
    } catch {
      return release(bad(503, 'the inventory could not be claimed'));
    }
    if (claim !== 1) {
      /**
       * 🚨 SPOKEN FOR, WHOEVER IS ASKING — and it used to depend on who.
       *
       * The branch here re-sealed the SAME leaf when a stored `:to` row named
       * this recipient. A true retry of one claim code never reached it: the
       * claim counter refuses that far above, and the reply of the call that
       * worked is replayed from `sealedReplyKey`. So the only caller who ever
       * got here had paid a SECOND time, and was charged a claim for the note
       * they already held while a note they could have been given sat in
       * stock (map-A defect 1).
       *
       * ⛔ AND THE ROW IT READ WAS THE LEAK. `issued:<pool>:<leaf>:to` was a
       * permanent leaf → recipient table: a copy of the store named who
       * received a given note and grouped every note one buyer had ever been
       * handed (map-A defect 3). Nothing writes it now, and
       * `scripts/scrubIssuedTo.mts` deletes what an earlier deployment left.
       *
       * Pinned by `__tests__/api/issue-note.node.test.ts` ("a second paid code
       * never gets a note the address already holds"). That nothing writes the
       * `:to` row, under any spelling, is pinned by the same file's "what the
       * reply and the store hold does not move when the leaf moves, and does
       * not name the recipient", which compares every row across worlds.
       */
      heldByOthers += 1;
      continue;
    }

    // The note must actually BE on the tree, at the leaf we think it is. A
    // mismatch means issuing it would hand someone a blob that cannot be spent:
    // money that looks received and is not. Never issue on a mismatch.
    //
    // 🚨 BUT A MISMATCH IS TWO DIFFERENT FAULTS, AND THIS USED TO CONFLATE THEM.
    //
    // If the seed or the pool is wrong, EVERY candidate mismatches, and refusing
    // the request is right: a configuration error must not be absorbed silently.
    // If ONE configured index is stale -- the tree reached it, but the leaf is
    // somebody else's deposit -- the rest of the inventory is fine, and refusing
    // charges a paying customer for a typo in an env var. That is what happened
    // on 2026-09-03 (see `notOurs`).
    //
    // So: skip the stale index, keep it claimed so no later caller draws it
    // again, and let the loop try the next note. The refusal is decided AFTER
    // the loop, where "how many were stale" is known: all of them means the
    // configuration is wrong, some of them means the list needs pruning.
    if (!onChain || onChain.leafIndex !== leafIndex) {
      notOurs += 1;
      continue;
    }

    // 🚨 NO ROOT AND NO PATH IN THE BLOB (LEAK-LEDGER B11). A root built here is
    // the tree at ONE moment, and a spend that proves against it dates the
    // deposit of the note it spends (map-C). The recipient rebuilds against the
    // pool's current root instead, and so does an old cached client, because
    // its rebuild branch is taken whenever the fields are absent. Pinned by
    // `__tests__/api/issue-note.node.test.ts` "the sealed note carries no root
    // and no path".
    const shareable: ShareableNote = {
      version: 1,
      pool: poolKey,
      secret: secret.toString(),
      nullifier_preimage: nullifierPreimage.toString(),
      // The wire key stays `deposit_epoch` and carries the blinding. Renaming it
      // silently drops the stored Merkle path on every consumer.
      deposit_epoch: noteBlinding.toString(),
      // 🚨 THE FIELD, NOT THE ADDRESS. `PublicKey.toString()` is base58, and the
      // native-SOL mint is `11111111111111111111111111111111` — thirty-two
      // characters that are ALL DIGITS. So `BigInt(note.token_mint)` on the
      // import side parsed it as a decimal number instead of failing, produced a
      // value nothing else agrees with, and the note was rejected with
      // "commitment does not match its secrets" — a message about the secrets,
      // for a bug in a field that is not secret.
      //
      // The commitment above is computed from `pubkeyToField(...)`, which is 0
      // for native SOL, so the note WAS the right leaf on chain and still could
      // not be opened. Any mint whose base58 contains a letter would have thrown
      // a SyntaxError and been found immediately; this one is the single value
      // that fails silently.
      token_mint: pubkeyToField(pool.tokenMint).toString(),
      commitment: commitment.toString(),
      leafIndex,
      token,
      denominationHuman: denomination,
    };

    /**
     * ⛔ EVERYTHING BEFORE THE SEAL IS REVERSIBLE, AND THIS IS WHERE THAT ENDS.
     *
     * A throw here used to leave the route with the leaf claimed and the claim
     * spent, and the buyer holding neither — a paying customer's note burned
     * by an error that handed nothing over. Nothing HAS been handed over yet,
     * so both go back: `__tests__/api/issue-note.node.test.ts` "gives back the
     * leaf AND the claim when the sealing fails".
     */
    let sealedNote: string;
    try {
      sealedNote = encryptNote(recipientAddress, paddedNote(shareable));
    } catch {
      try {
        await kv.del(claimKey);
      } catch {
        // The leaf stays claimed, which is the safe direction: a note nobody
        // can be given beats one given twice.
      }
      return release(bad(503, 'the note could not be sealed'));
    }

    const reply: SealedReply = {
      sealedNote,
      denomination,
      token,
      merklePath: 'none',
      // Said in the response, not only in a doc, because whatever renders this
      // will be the last thing between the claim and a user believing it.
      disclosure:
        'This note was deposited by this deployment, so a chain observer who follows the ' +
        'subscription back to its deposit lands on us rather than on you. It does NOT hide you ' +
        'from us: the note derives from a seed this server holds, so we can identify every ' +
        'subscription bought with it, and we can spend it ourselves until you do.',
    };

    /**
     * 🚨 THE LAST SIDE EFFECT, AND THE ONE A RETRY DEPENDS ON.
     *
     * ⛔ NO TTL, for the reason `__tests__/api/claim-does-not-expire.test.ts`
     * records for the claim itself: a lifetime here would make the retry work
     * for a day and then tell somebody who paid that they never did.
     *
     * ⚠️ AND A LEAF IS NEVER RELEASED ONCE THIS WRITE HAS BEEN ATTEMPTED. A
     * store that failed to answer may still have taken the write, so the reply
     * may be reachable; two buyers holding one note is worse than one buyer
     * retrying. The CODE goes back instead, which costs nobody anything
     * (`__tests__/api/issue-note.node.test.ts` "keeps the leaf but releases the
     * code when the reply cannot be stored"). If the write did land, the
     * retry finds the reply and replays it (`earlier`, above), so the code
     * going back never buys a second note.
     *
     * ⛔ AND THE 503 CARRIES NOTHING OF THE FAILURE. The store's error names
     * the write, value included, and that value is this note: passed on, it
     * handed the buyer the note the answer says was not delivered, and the
     * retry then a second one (see `bad`; the same test, "one paid code left
     * the buyer holding more than one note").
     */
    try {
      await kv.set(sealedKey, reply);
    } catch {
      let stored: SealedReply | null = null;
      try {
        stored = await kv.get<SealedReply>(sealedKey);
      } catch {
        // Unreadable too, so the write cannot be shown to have landed.
      }
      if (!stored || typeof stored.sealedNote !== 'string') {
        return release(bad(503, 'the note was not delivered; retry with the same code'));
      }
    }

    await forgetTheCodeToPaymentTrail(kv, claimCode, minted);
    return NextResponse.json({ ok: true, ...reply });
  }

  // Said before every other exhaustion, because while the read is short every
  // count below is a count of what could be SEEN: a note may be sitting at an
  // index that did not come back. Counts only, never an index. Pinned by
  // `__tests__/api/issue-note.node.test.ts` "answers that the history is
  // incomplete, instead of blaming the seed" (exact key set, and a body
  // byte-identical whichever index is missing). The order is pinned beside
  // each exhaustion it can meet, one case each: "even beside a note that is
  // already spent", "... only too young", "... when another configured leaf
  // is somebody else's", "... already held" and, for the "empty" answer,
  // "even beside a leaf not deposited yet". In
  // web-run/logs/ISSUE-2-webfix1/resume/ordering-final.log every slot and
  // guard mutant goes red but E1, a guard giving way to the 500 below, which
  // no test can tell apart: the 500 needs every configured leaf in `notOurs`,
  // and a missing leaf is never counted there.
  if (missingFromHistory > 0) {
    return release(exhausted(502, 'the pool\'s history came back incomplete, so the inventory could not be checked', {
      configured: leaves.length,
      missingFromHistory,
      spentLeaves,
      tooYoung,
      heldByOthers,
      notOurs,
      hint:
        'Some configured leaves sit below the top of the tree but were not in the history the RPC ' +
        'returned. They were not claimed, so nothing left stock. Retry; if it persists, the pool ' +
        'history walk is short, not the seed. Nothing was charged.',
    }));
  }

  // Said separately from "empty", because the two need opposite reactions from
  // whoever runs the deployment: one means deposit more notes, the other means
  // the notes are there and gone. Both used to read as "empty".
  if (spentLeaves > 0) {
    return release(exhausted(503, 'every note in this deployment\'s inventory has already been spent', {
      configured: leaves.length,
      spentLeaves,
      heldByOthers,
      notOurs,
      hint:
        'A commitment stays on the tree after its note is spent, so the inventory still looks ' +
        'present on chain. Deposit fresh notes from the treasury wallet and extend ' +
        'P01_TREASURY_NOTE_LEAVES with the new leaf indices. Nothing was charged.',
    }));
  }

  // Said before "empty" and before "held by others", because it is the one
  // exhaustion a caller can simply outwait — and because reading it as "empty"
  // would send an operator depositing MORE young notes, which is the opposite
  // of what this rule wants. The wait is reported in slots and minutes so the
  // answer is a time, not a mystery.
  if (tooYoung > 0) {
    const waitSlots = Number.isFinite(shortestWait) ? shortestWait : null;
    return release(exhausted(503, 'the notes in stock are too recently deposited to be issued', {
      configured: leaves.length,
      tooYoung,
      notOurs,
      minAgeSlots: minAge,
      waitSlots,
      waitMinutesApprox: waitSlots === null ? null : Math.ceil((waitSlots * 0.4) / 60),
      hint:
        'A note deposited moments before it is handed over carries the clock of whoever bought it: the walk ' +
        'spend -> commitment -> deposit -> its funder lands on whoever paid just before, and no ' +
        'crowd dilutes a one-second window. Wait for the stock to age, or deposit a batch well ' +
        'ahead of when it will be sold. P01_TREASURY_NOTE_MIN_AGE_SLOTS sets the threshold; ' +
        'lowering it is a privacy decision, not a tuning knob.',
    }));
  }

  // Said before every other exhaustion, because it is the only one that means
  // the deployment is misconfigured rather than out of stock. `notOurs` counts
  // configured indices the tree has reached whose commitment is not ours.
  if (notOurs > 0 && notOurs === leaves.length) {
    return release(exhausted(500, 'the configured inventory does not match the chain', {
      configured: leaves.length,
      notOurs,
      hint:
        'Not one configured leaf derives to a commitment this pool holds at that index, so the ' +
        'seed or the pool is wrong, not the list. Check P01_TREASURY_POOL_SEED and the pool ' +
        'address before touching P01_TREASURY_NOTE_LEAVES. Nothing was charged.',
    }));
  }
  if (notOurs > 0 && spentLeaves === 0 && tooYoung === 0 && heldByOthers === 0) {
    return release(exhausted(503, 'the configured inventory names leaves this deployment does not own', {
      configured: leaves.length,
      notOurs,
      hint:
        'These indices are on the tree but hold somebody else\'s deposit, so they were skipped ' +
        'and marked issued. Prune them from P01_TREASURY_NOTE_LEAVES and deposit fresh notes. ' +
        'Nothing was charged.',
    }));
  }

  if (heldByOthers > 0) {
    // ⛔ THE REFUSAL NAMES NO ADDRESS. It used to echo `recipientAddress` back,
    // which put the buyer's note address into a response body and into
    // whatever logged it. Pinned by `__tests__/api/issue-note.test.ts` "is
    // refused to a different address WITHOUT the refusal naming one", which
    // asserts the refusal to two different askers is byte-identical.
    return release(exhausted(503, 'every note in stock is already issued', {
      configured: leaves.length,
      heldByOthers,
      hint:
        'A note leaves stock once and is never handed out twice, so a stocked pool can still ' +
        'have nothing left to give. If a claim of yours was redeemed and the answer was lost, ' +
        'ask again with the SAME code — the reply is kept. Otherwise the deployment needs more ' +
        'notes: deposit from the treasury and extend P01_TREASURY_NOTE_LEAVES.',
    }));
  }

  return release(exhausted(503, 'the note inventory is empty', {
    configured: leaves.length,
    notOurs,
    hint: 'Deposit more notes from the treasury wallet and extend P01_TREASURY_NOTE_LEAVES.',
  }));
}
