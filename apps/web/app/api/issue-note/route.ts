import { NextRequest, NextResponse } from 'next/server';
import { Connection, PublicKey } from '@solana/web3.js';

import { getStore, rateLimitExceeded } from '@/lib/waitlist/store';
import {
  buildMerkleProofFromLeavesV3,
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

function bad(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

function clientIp(req: NextRequest): string {
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return 'unknown';
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
function treasurySeed(): Uint8Array | null {
  const hex = process.env.P01_TREASURY_POOL_SEED;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

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

function inventoryLeaves(): number[] {
  return (process.env.P01_TREASURY_NOTE_LEAVES ?? '')
    .split(',')
    .map((s) => s.trim())
    // 🚨 THE EMPTY-STRING FILTER IS LOAD-BEARING, and it was missing.
    // `''.split(',')` is `['']`, and `Number('')` is 0 — which is an integer
    // and is >= 0. So an UNSET variable produced an inventory of exactly one
    // leaf, index 0, and the readiness check reported it as configured. Found
    // by curling the built route rather than by any test, which is the argument
    // for curling the built route.
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n >= 0);
}

export async function GET() {
  // Readiness, in the shape /api/fund-ephemeral uses: every way this is switched
  // off is silent at the point of use, so it has to be answerable in advance.
  const seed = treasurySeed();
  const leaves = inventoryLeaves();
  const kv = getStore();
  const reasons: string[] = [];
  if (!seed) reasons.push('P01_TREASURY_POOL_SEED is unset or not 64 hex characters.');
  if (leaves.length === 0) reasons.push('P01_TREASURY_NOTE_LEAVES lists no leaf indices.');
  if (!process.env.P01_FUNDER_TICKET) reasons.push('P01_FUNDER_TICKET is unset.');
  if (!kv) reasons.push('No durable KV store, so issued notes cannot be tracked and this refuses.');
  return NextResponse.json({
    ok: true,
    configured: reasons.length === 0,
    inventorySize: leaves.length,
    // The client asks for THIS, rather than assuming. Leaf indices only mean
    // something inside one pool.
    denomination: inventoryDenomination(),
    token: 'SOL',
    reasons,
    note:
      'inventorySize counts what was CONFIGURED, not what is still unissued — reading the ' +
      'remaining count would require the KV lookups an issuance does, and an endpoint that ' +
      'reports a number it did not check is how a demo discovers an empty inventory on stage.',
  });
}

export async function POST(request: NextRequest) {
  const ticket = process.env.P01_FUNDER_TICKET;
  const seed = treasurySeed();
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
  } catch (e) {
    return bad(503, `the rate limiter could not be read: ${(e as Error).message}`);
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
  } catch (e) {
    return bad(502, `the configured RPC could not be reached: ${(e as Error).message}`);
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
  } catch (e) {
    return bad(503, `the claim could not be read: ${(e as Error).message}`);
  }
  if (claimed !== 1) {
    return bad(409, 'this claim code has already been used', {
      hint: 'A claim is worth one note. If a note was not received, recover it rather than reissuing — the first one is spendable.',
    });
  }
  // A claim must have been MINTED, not merely typed. `incr` above created the
  // key if it was absent, so the existence check has to be separate — and it
  // has to come after the claim, or two callers race on an unminted code.
  let minted: string | null = null;
  try {
    minted = await kv.get<string>(`p01:note:claim-minted:${claimCode}`);
  } catch {
    // Treated as unminted below: an unreadable store must not authorise value.
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

  const leaves = inventoryLeaves();
  if (leaves.length === 0) return release(bad(503, 'this deployment has no note inventory configured'));

  // The pool's leaves, once, for both the on-chain check below and the Merkle
  // path. Building the path HERE rather than leaving the recipient to rebuild
  // it is the difference between a subscription that starts immediately and one
  // that walks the pool's whole history first.
  let commitments: Map<string, OnChainCommitment>;
  try {
    commitments = await fetchPoolCommitments(connection, pool.poolPDA);
  } catch (e) {
    return release(bad(502, `the pool's history could not be read: ${(e as Error).message}`));
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
   * from being handed it was the `:to` marker refusing a different recipient —
   * protection by accident, from a mechanism written for something else.
   *
   * `fetchSpentNullifierSet` reads addresses only, never bodies, and names no
   * note; `isNullifierSpentInSet` then decides locally with no further RPC.
   */
  let spent: ReadonlySet<string>;
  try {
    spent = await fetchSpentNullifierSet(connection, pool.poolPDA);
  } catch (e) {
    // ⛔ Refuse rather than issue blind. An unread spent-set is not an empty
    // one, and the failure mode of guessing is handing over spent money.
    return release(bad(502, `the pool's spent notes could not be read: ${(e as Error).message}`));
  }

  // The clock the maturity rule is measured against. Read once, after the
  // history, so a note cannot look older than it is because the slot was
  // sampled late. `finalized` for the same reason the blockhash is: a
  // confirmed slot can be rolled back, and a rolled-back clock reads as extra
  // age, which is the direction that would issue a note too young.
  let currentSlot: number;
  try {
    currentSlot = await connection.getSlot('finalized');
  } catch (e) {
    // ⛔ Refuse rather than issue blind. An unknown clock is not an old note.
    return release(bad(502, `the chain's slot could not be read: ${(e as Error).message}`));
  }
  const minAge = minAgeSlots();

  const poolKey = pool.poolPDA.toBase58();
  /**
   * Leaves that exist and are spoken for, but not by this caller.
   *
   * Without this the walk ends at the same "the note inventory is empty" as a
   * genuinely unstocked deployment, and those two need opposite reactions:
   * one is "deposit more notes", the other is "you are asking from the wrong
   * address". MEASURED 2026-08-18: the wrong message sent us looking at stock
   * levels while the real cause was a reloaded page presenting a fresh note
   * address, and it cost a single-use claim code to find out.
   */
  let heldByOthers = 0;
  /** Configured leaves whose note has already been spent on chain. */
  let spentLeaves = 0;
  /** Configured leaves whose deposit is too recent to hand out yet. */
  let tooYoung = 0;
  /** How long the closest of those still has to wait, in slots. */
  let shortestWait = Number.POSITIVE_INFINITY;
  for (const leafIndex of leaves) {
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
    const { secret, nullifierPreimage } = deriveNoteMaterial(seed, pool.poolPDA, leafIndex);
    const noteBlinding = deriveNoteBlinding(seed, pool.poolPDA, leafIndex);
    const commitment = createCommitmentV3(
      nullifierPreimage,
      secret,
      noteBlinding,
      pubkeyToField(pool.tokenMint),
    );

    // Looked up once, here: the age gate below needs it and so does the
    // configuration check further down.
    const onChain = commitments.get(commitment.toString());
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
    } catch (e) {
      return release(bad(503, `the inventory could not be claimed: ${(e as Error).message}`));
    }
    if (claim !== 1) {
      // 🚨 IDEMPOTENT FOR THE SAME RECIPIENT, and it has to be.
      //
      // The leaf used to be consumed outright the first time it was handed out,
      // before the client could confirm it had opened the note. So any failure
      // after this point — a bad field in the blob, a lost tab, a reload —
      // destroyed the inventory as well as the claim, and the retry got "the
      // note inventory is empty". MEASURED: it happened on the first live run,
      // and again on the second.
      //
      // In production that is a paying customer's note burned by a transient
      // error. Re-sealing the SAME note to the SAME address gives them what
      // they already paid for, because it IS the same note: one commitment, one
      // nullifier, spendable exactly once by whoever holds the secrets.
      //
      // ⛔ A DIFFERENT address is refused. Two people holding one note is a race
      // where the loser paid for nothing, and no amount of convenience is worth
      // manufacturing that.
      let previous: string | null = null;
      try {
        previous = await kv.get<string>(`${claimKey}:to`);
      } catch {
        // Unreadable: treat as claimed by someone else and move on.
      }
      if (previous !== recipientAddress) {
        heldByOthers += 1;
        continue;
      }
    } else {
      // Record who it went to, so the branch above can recognise a retry. Best
      // effort: a lost write costs an inventory slot, never a double issue.
      try {
        await kv.set(`${claimKey}:to`, recipientAddress);
      } catch {
        /* the leaf stays claimed, which is the safe direction */
      }
    }


    // The note must actually BE on the tree, at the leaf we think it is. A
    // mismatch means the seed, the pool or the index is wrong, and issuing it
    // would hand someone a blob that cannot be spent — money that looks
    // received and is not. Refuse the whole request rather than move on: a
    // configuration error must not be silently absorbed by trying the next leaf.

    if (!onChain || onChain.leafIndex !== leafIndex) {
      return release(bad(500, 'the configured inventory does not match the chain', {
        leafIndex,
        found: onChain?.leafIndex ?? null,
        hint:
          'P01_TREASURY_POOL_SEED, the pool, or P01_TREASURY_NOTE_LEAVES is wrong. The leaf has ' +
          'been marked issued to stop a retry loop from consuming the whole inventory.',
      }));
    }

    let merkle: Pick<ShareableNote, 'merkle_root' | 'merkle_path_elements' | 'merkle_path_indices'> = {};
    try {
      let maxIdx = -1;
      for (const e of commitments.values()) if (e.leafIndex > maxIdx) maxIdx = e.leafIndex;
      const leavesByIndex: bigint[] = maxIdx >= 0 ? new Array<bigint>(maxIdx + 1).fill(0n) : [];
      for (const e of commitments.values()) leavesByIndex[e.leafIndex] = e.commitment;
      const built = buildMerkleProofFromLeavesV3({ leavesByIndex, targetLeafIndex: leafIndex });
      merkle = {
        merkle_root: built.root.toString(),
        merkle_path_elements: built.pathElements.map((e) => e.toString()),
        merkle_path_indices: built.pathIndices,
      };
    } catch {
      // Ship the note without a path rather than with a wrong one. The
      // recipient rebuilds from history: slower, always correct.
    }

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
      ...merkle,
    };

    const sealedNote = encryptNote(
      recipientAddress,
      new TextEncoder().encode(JSON.stringify(shareable)),
    );

    return NextResponse.json({
      ok: true,
      sealedNote,
      leafIndex,
      commitment: commitment.toString(),
      denomination,
      token,
      merklePath: merkle.merkle_root ? 'rebuilt' : 'none',
      // Said in the response, not only in a doc, because whatever renders this
      // will be the last thing between the claim and a user believing it.
      disclosure:
        'This note was deposited by this deployment, so a chain observer who follows the ' +
        'subscription back to its deposit lands on us rather than on you. It does NOT hide you ' +
        'from us: the note derives from a seed this server holds, so we can identify every ' +
        'subscription bought with it, and we can spend it ourselves until you do.',
    });
  }

  // Said separately from "empty", because the two need opposite reactions from
  // whoever runs the deployment: one means deposit more notes, the other means
  // the notes are there and gone. Both used to read as "empty".
  if (spentLeaves > 0) {
    return release(bad(503, 'every note in this deployment\'s inventory has already been spent', {
      configured: leaves.length,
      spentLeaves,
      heldByOthers,
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
    return release(bad(503, 'the notes in stock are too recently deposited to be issued', {
      configured: leaves.length,
      tooYoung,
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

  if (heldByOthers > 0) {
    return release(bad(503, 'every note in stock is already issued to a different address', {
      configured: leaves.length,
      heldByOthers,
      recipientAddress,
      hint:
        'A note is re-issued only to the address it was first sealed to, so this reads as empty ' +
        'from where you are asking. If you expected to own one of these, you are presenting a ' +
        'different note address than the one that received it — derive from the same wallet. ' +
        'Otherwise the deployment needs more notes: deposit from the treasury and extend ' +
        'P01_TREASURY_NOTE_LEAVES.',
    }));
  }

  return release(bad(503, 'the note inventory is empty', {
    configured: leaves.length,
    hint: 'Deposit more notes from the treasury wallet and extend P01_TREASURY_NOTE_LEAVES.',
  }));
}
