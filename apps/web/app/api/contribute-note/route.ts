import { NextRequest, NextResponse } from 'next/server';
import { Connection } from '@solana/web3.js';

import { getStore, rateLimitExceeded } from '@/lib/waitlist/store';
import { activeTreasurySeed } from '@/lib/privacy/treasurySeeds';
import {
  createCommitmentV3,
  deriveNoteMaterial,
  fetchPoolCommitments,
  getPoolsForTokenV3,
  pubkeyToField,
  type OnChainCommitment,
} from '@/lib/privacy/pool/denominatedPool';
import { deriveNoteBlinding } from '@/lib/privacy/pool/noteBlinding';
import { recordInventoryLeaf } from '@/app/api/issue-note/route';

/**
 * CONTRIBUTE A LEAF, COLLECT A DIFFERENT NOTE — the mechanism that makes the
 * treasury a mixer instead of a shop.
 *
 * ── THE FLOW, AND WHY IT HAS NO DRAIN ───────────────────────────────────────
 *
 *   1. the buyer pays the till; the float funds an ephemeral   (already built)
 *   2. that ephemeral deposits a commitment derived from the
 *      TREASURY's seed                                          <- `reserve`
 *   3. the confirmed deposit mints a claim code                 <- `confirm`
 *   4. the buyer redeems it at `issue-note` and receives an
 *      OLDER treasury note                                      (already built)
 *   5. they spend it at a merchant, or hand it on
 *
 * 🎯 THE DEPOSITOR NEVER LEARNS THE OPENING OF WHAT THEY DEPOSIT. That single
 * property is what removes the double-spend an exchange otherwise carries: in a
 * swap, whoever hands a note in still knows its opening and can spend it after
 * being paid, which is why `swap-note` has to be asynchronous and wait for a
 * relayed spend. Here there is no second copy, because there was never a first.
 * Nothing to race, nothing to convert, no relayer on the critical path.
 *
 * 🎯 AND THE MATURITY GATE IS THE MIXER. The leaf just contributed is far too
 * young for `issue-note` to hand over (`DEFAULT_MIN_AGE_SLOTS`), so the note the
 * buyer collects is NECESSARILY an older one, deposited for somebody else, with
 * a history that is not theirs. The gate was written to refuse a note minted at
 * the buyer's clock; here that refusal is the whole product.
 *
 * The count is unchanged — one leaf in, one leaf out — so the treasury never
 * pays a denomination and a fixed float serves indefinitely. It pays fees.
 *
 * ── WHAT THIS DOES NOT CLAIM ────────────────────────────────────────────────
 *
 * ⚠️ IT DOES NOT HIDE THE BUYER FROM US. The treasury derives every note it
 * issues, so against the issuer the anonymity set is one, and the issuer can
 * spend a note it has handed over until the holder does. That is the same
 * custody `issue-note` already discloses, unchanged by this route.
 *
 * ⚠️ AND THE CONTRIBUTED LEAF MUST BE FUNDED THROUGH THE DETOUR. If the buyer's
 * own wallet funds the depositing ephemeral, then whoever later collects THAT
 * leaf can be walked back to the buyer — the buyer is not exposed by their own
 * note, but they become the visible funder of somebody else's. The relayed
 * deposit path (`ephemeralFunder.ts`) is what puts the float there instead, and
 * this route does not enforce it: it verifies the leaf, not who paid for it.
 */

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const RATE_SALT = 'p01:contribute-note:v1';

const CONTRIBUTIONS_PER_IP_PER_HOUR = (() => {
  const raw = Number(process.env.P01_CONTRIBUTIONS_PER_IP_PER_HOUR);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
})();

/** A leaf handed to a contributor, so two of them never get the same index. */
const KV_RESERVED_PREFIX = 'p01:note:contrib-reserved:';
/** One key per confirmed leaf — `incr` on it is the one-claim-per-deposit rule. */
const KV_CONFIRMED_PREFIX = 'p01:note:contrib-confirmed:';
/** The claim code a confirmed contribution earned, so a retry returns the same one. */
const KV_CONTRIB_CLAIM_PREFIX = 'p01:note:contrib-claim:';

/**
 * How far past the tree's current height a reservation may look.
 *
 * Reservations are handed out ahead of the deposits that fill them, so the next
 * free index is not simply `leafCount` once a few are outstanding. This bounds
 * the walk: a deployment with this many unfilled reservations is not short of
 * indices, it is failing to complete deposits, and it should say so rather than
 * hand out a thousandth.
 */
const MAX_RESERVATION_LOOKAHEAD = 64;

function bad(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

/** The treasury's pool seed, 32 bytes as 64 hex characters. */
/**
 * \u26d4 ONE PARSER, IMPORTED. This file used to carry its own copy that tested
 * `/^[0-9a-fA-F]{64}$/` against the whole variable, so the day
 * `P01_TREASURY_POOL_SEED` became a comma-separated LIST it decided this
 * deployment held no treasury at all — a 503 on the buyer's own shield, from a
 * treasury holding sixty leaves. See `lib/privacy/treasurySeeds.ts`.
 */
const treasurySeed = activeTreasurySeed;

/** The denomination this deployment deals in. Mirrors `issue-note`'s reader. */
function inventoryDenomination(): number {
  const raw = Number(process.env.P01_TREASURY_NOTE_DENOMINATION);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.1;
}

/** 32 hex characters — inside `issue-note`'s claim-code alphabet by construction. */
function mintCode(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * The commitment the treasury will own at `leafIndex`.
 *
 * ⛔ THE SECRETS NEVER LEAVE THIS FUNCTION. Only the commitment is returned, and
 * a commitment is public the instant it is deposited — it is the leaf. Handing
 * the opening to the depositor would hand them the note, which is precisely the
 * thing this flow exists not to do.
 */
function treasuryCommitmentFor(
  seed: Uint8Array,
  poolPDA: Parameters<typeof deriveNoteMaterial>[1],
  tokenMint: Parameters<typeof pubkeyToField>[0],
  leafIndex: number,
): bigint {
  const { secret, nullifierPreimage } = deriveNoteMaterial(seed, poolPDA, leafIndex);
  return createCommitmentV3(
    nullifierPreimage,
    secret,
    deriveNoteBlinding(seed, poolPDA, leafIndex),
    pubkeyToField(tokenMint),
  );
}

export async function GET() {
  const seed = treasurySeed();
  return NextResponse.json({
    ok: true,
    accepting: Boolean(seed) && Boolean(getStore()),
    denomination: inventoryDenomination(),
    note:
      'Contribute a leaf the treasury owns, collect a different and older note. The note you ' +
      'deposit is never yours: you cannot spend it, and there is nothing to double-spend. The ' +
      'note you collect was deposited for somebody else, which is what makes it unlinkable to you.',
  });
}

export async function POST(request: NextRequest) {
  const ticket = process.env.P01_FUNDER_TICKET;
  const seed = treasurySeed();
  if (!seed) return bad(503, 'this deployment holds no treasury and cannot take a contribution');
  if (!ticket) return bad(503, 'no ticket configured; refusing to act anonymously');
  if (request.headers.get('x-p01-funder-ticket') !== ticket) {
    return bad(401, 'bad or missing ticket');
  }

  let body: { action?: unknown; token?: unknown; leafIndex?: unknown; commitment?: unknown };
  try {
    body = await request.json();
  } catch {
    return bad(400, 'body must be JSON');
  }
  const action = String(body.action ?? '');
  if (action !== 'reserve' && action !== 'confirm') {
    return bad(400, "action must be 'reserve' or 'confirm'");
  }

  const token = body.token === 'USDC' ? 'USDC' : 'SOL';
  const denomination = inventoryDenomination();
  const pool = getPoolsForTokenV3(token).find((p) => p.denomination === denomination);
  if (!pool) return bad(503, `no ${denomination} ${token} pool is configured`);
  // The contribution is a DEPOSIT. A pool closed to deposits cannot take one,
  // and finding that out after the buyer has paid the till is the expensive way.
  if (pool.deposits !== 'open') {
    return bad(503, `the ${denomination} ${token} pool is closed to deposits`, {
      hint: 'Contributions are deposits. Nothing can be contributed to a closed pool.',
    });
  }
  const poolKey = pool.poolPDA.toBase58();

  const kv = getStore();
  if (!kv) return bad(503, 'no durable store is configured; refusing to act untracked');
  try {
    if (await rateLimitExceeded(kv, clientIp(request), RATE_SALT, CONTRIBUTIONS_PER_IP_PER_HOUR)) {
      return bad(429, 'too many contributions from this address in the last hour', {
        limit: CONTRIBUTIONS_PER_IP_PER_HOUR,
      });
    }
  } catch (e) {
    return bad(503, `the rate limiter could not be read: ${(e as Error).message}`);
  }

  const connection = new Connection(
    process.env.P01_FUNDER_RPC ?? 'https://api.devnet.solana.com',
    'confirmed',
  );
  let genesis: string;
  try {
    genesis = await connection.getGenesisHash();
  } catch (e) {
    return bad(502, `the configured RPC could not be reached: ${(e as Error).message}`);
  }
  if (genesis !== DEVNET_GENESIS) {
    return bad(403, 'this deployment is devnet-only and the configured RPC is not devnet', { genesis });
  }

  let commitments: Map<string, OnChainCommitment>;
  try {
    commitments = await fetchPoolCommitments(connection, pool.poolPDA);
  } catch (e) {
    return bad(502, `the pool's history could not be read: ${(e as Error).message}`);
  }
  let maxLeafOnTree = -1;
  for (const c of commitments.values()) if (c.leafIndex > maxLeafOnTree) maxLeafOnTree = c.leafIndex;

  // ── reserve ───────────────────────────────────────────────────────────────
  if (action === 'reserve') {
    /**
     * Walk forward from the first index the tree does not hold, claiming the
     * first one nobody else has reserved.
     *
     * ⛔ `incr` IS THE WHOLE CONCURRENCY ARGUMENT, exactly as it is for a note
     * claim: only the caller that creates the key sees 1. Two buyers arriving
     * together therefore take two different leaves. Reading-then-writing would
     * let both take the same one, and the second deposit would fail on chain
     * after the buyer had already paid the till.
     */
    /**
     * 🚨 A RESERVATION THAT NEVER LANDED MUST NOT BLOCK THE POOL FOREVER.
     * MEASURED 2026-08-31: three failed attempts reserved leaves 99, 100 and 101
     * while the tree stood at 100, and every later deposit was refused by the
     * client's own guard — "the pool advanced past this reservation (reserved
     * leaf 101, tree is at 100)". Nothing was wrong with the pool. The markers
     * had drifted ahead of it because nothing ever released them, and the buyer
     * could not shield AT ALL.
     *
     * The tree is the authority. A marker on an index the tree has not reached
     * describes an attempt that died, so it is cleared and the index reused. The
     * marker still does its real job -- two buyers arriving together cannot take
     * the same index, because only one `incr` returns 1 -- and it now expires
     * instead of accumulating.
     */
    let reserved: number | null = null;
    const start = maxLeafOnTree + 1;
    for (let leafIndex = start; leafIndex < start + MAX_RESERVATION_LOOKAHEAD; leafIndex += 1) {
      let taken: number;
      try {
        taken = await kv.incr(`${KV_RESERVED_PREFIX}${poolKey}:${leafIndex}`);
        if (taken !== 1 && leafIndex === start) {
          // The tree has not reached this index, so whatever reserved it never
          // deposited. Reclaim it rather than walking past and drifting further.
          await kv.del(`${KV_RESERVED_PREFIX}${poolKey}:${leafIndex}`);
          taken = await kv.incr(`${KV_RESERVED_PREFIX}${poolKey}:${leafIndex}`);
        }
        // Self-healing: an abandoned marker stops mattering after an hour even
        // if the branch above never runs.
        if (taken === 1) {
          await kv.expire?.(`${KV_RESERVED_PREFIX}${poolKey}:${leafIndex}`, 3600);
        }
      } catch (e) {
        return bad(503, `the reservation could not be written: ${(e as Error).message}`);
      }
      if (taken === 1) {
        reserved = leafIndex;
        break;
      }
    }
    if (reserved === null) {
      return bad(503, 'every lookahead leaf is already reserved', {
        lookahead: MAX_RESERVATION_LOOKAHEAD,
        highestOnTree: maxLeafOnTree,
        hint:
          'Reservations are handed out ahead of the deposits that fill them. This many unfilled ' +
          'means deposits are not completing, not that the tree is full.',
      });
    }

    const commitment = treasuryCommitmentFor(seed, pool.poolPDA, pool.tokenMint, reserved);
    return NextResponse.json({
      ok: true,
      leafIndex: reserved,
      commitment: commitment.toString(),
      denomination,
      token,
      disclosure:
        'This commitment belongs to the treasury, not to you. Depositing it gives you no note ' +
        'and nothing to spend — that is deliberate, and it is why nobody can be paid twice for ' +
        'one deposit. Confirm the deposit to receive a claim on a different, older note.',
    });
  }

  // ── confirm ───────────────────────────────────────────────────────────────
  const leafIndex = Number(body.leafIndex);
  if (!Number.isInteger(leafIndex) || leafIndex < 0) {
    return bad(400, 'leafIndex must be a non-negative integer');
  }

  /**
   * 🚨 THE COMMITMENT IS RECOMPUTED FROM THE TREASURY SEED, NEVER TAKEN FROM
   * THE CALLER. Trusting `body.commitment` would let anyone name a leaf that
   * happens to exist — somebody else's deposit, or one of ours from months ago
   * — and be paid a claim for it. The only thing that earns a claim is OUR
   * commitment appearing at the index we reserved.
   */
  const expected = treasuryCommitmentFor(seed, pool.poolPDA, pool.tokenMint, leafIndex);
  const onChain = commitments.get(expected.toString());
  if (!onChain) {
    return bad(409, 'that contribution is not on the tree', {
      leafIndex,
      highestOnTree: maxLeafOnTree,
      hint:
        leafIndex > maxLeafOnTree
          ? 'The deposit has not landed yet. Confirm once the transaction is finalized.'
          : 'No commitment derived from this treasury sits at that index.',
    });
  }
  if (onChain.leafIndex !== leafIndex) {
    return bad(409, 'that contribution sits at a different leaf than claimed', {
      claimed: leafIndex,
      found: onChain.leafIndex,
    });
  }

  /**
   * ONE CLAIM PER DEPOSIT, and `incr` decides it. Without this a caller could
   * confirm the same leaf repeatedly and mint a claim each time — one deposit
   * paying for the whole inventory.
   */
  let confirmations: number;
  try {
    confirmations = await kv.incr(`${KV_CONFIRMED_PREFIX}${poolKey}:${leafIndex}`);
  } catch (e) {
    return bad(503, `the confirmation could not be written: ${(e as Error).message}`);
  }
  if (confirmations !== 1) {
    // A retry is ordinary — a lost response, a reloaded page — so hand back the
    // SAME code rather than refusing. Minting a second one would pay twice.
    let existing: string | null = null;
    try {
      existing = await kv.get<string>(`${KV_CONTRIB_CLAIM_PREFIX}${poolKey}:${leafIndex}`);
    } catch {
      /* falls through to the refusal below */
    }
    if (existing) {
      return NextResponse.json({ ok: true, claimCode: existing, leafIndex, replayed: true });
    }
    return bad(409, 'this contribution was already confirmed', {
      leafIndex,
      hint: 'Its claim code was issued once and cannot be reissued from here.',
    });
  }

  const claimCode = mintCode();
  try {
    // Recorded BEFORE the claim is minted: a crash between the two leaves the
    // buyer without a code, which they can recover, rather than leaving the
    // treasury short a leaf it paid for and cannot issue.
    await kv.set(`${KV_CONTRIB_CLAIM_PREFIX}${poolKey}:${leafIndex}`, claimCode);
    /**
     * The leaf becomes issuable stock.
     *
     * ⛔ LEGITIMATE HERE AND NOWHERE ELSE IN THIS DIRECTION: this leaf's opening
     * IS derived from the treasury seed — that is the whole point of the flow —
     * so `issue-note` can recompute it. A leaf whose secrets belonged to the
     * depositor would derive to a different commitment and answer 500 to a
     * paying buyer. See `recordInventoryLeaf`'s contract.
     */
    await recordInventoryLeaf(poolKey, leafIndex);
    // The value `issue-note` reads to decide the code was MINTED rather than
    // guessed. It tests `if (!minted)`, so an empty string would burn the
    // buyer's claim without releasing it — hence a real reference.
    await kv.set(`p01:note:claim-minted:${claimCode}`, `contrib:${poolKey}:${leafIndex}`);
  } catch (e) {
    return bad(503, `the claim could not be minted: ${(e as Error).message}`);
  }

  return NextResponse.json({
    ok: true,
    claimCode,
    leafIndex,
    denomination,
    token,
    disclosure:
      'Redeem this claim at /api/issue-note. What you receive will be a DIFFERENT note from the ' +
      'one you funded, and necessarily an older one: the maturity gate refuses to issue a leaf ' +
      'deposited moments ago, so the note you collect carries somebody else\'s history rather ' +
      'than your clock. It does not hide you from this deployment, which derives every note it ' +
      'issues and can spend one until you do.',
  });
}
