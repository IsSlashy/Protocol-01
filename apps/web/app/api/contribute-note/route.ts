import { NextRequest, NextResponse } from 'next/server';
import { Connection, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';

import { getStore, rateLimitExceeded } from '@/lib/waitlist/store';
import { clientIp } from '@/lib/net/clientIp';
import { activeTreasurySeed } from '@/lib/privacy/treasurySeeds';
import { claimChallenge } from '@/lib/privacy/claimChallenge';
import {
  contribConfirmedKey,
  contribReservedKey,
  contributionBinding,
  counterValue,
  inventoryDenomination,
  notePaidCodeKey,
  notePaidKey,
  relayPaymentContributionKey,
} from '@/lib/privacy/paymentBinding';
import {
  createCommitmentV3,
  deriveNoteMaterial,
  fetchPoolCommitments,
  getPoolsForTokenV3,
  pubkeyToField,
  type OnChainCommitment,
} from '@/lib/privacy/pool/denominatedPool';
import { deriveNoteBlinding } from '@/lib/privacy/pool/noteBlinding';
import { installKvPoolHistory } from '@/lib/privacy/pool/kvPoolHistory';
import { recordInventoryLeaf } from '@/app/api/issue-note/route';

// [CACHE-1] The pool history this route walks is shared by every isolate
// through one KV row per pool that holds public chain data only
// (`lib/privacy/pool/kvPoolHistory.test.ts`).
installKvPoolHistory();

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
 * being paid, which is why a note is only ever taken in by SPENDING it first (a
 * circuit-7 withdrawal to the till, claimed at `claim-for-payment`). Here there
 * is no second copy, because there was never a first. Nothing to race, nothing
 * to convert, no relayer on the critical path.
 *
 * ── CONFIRM IS BOUND TO THE PAYMENT (a deliberate break, 2026-09-02) ────────
 *
 * `confirm` now REQUIRES `paymentSignature` and `proof`, and refuses without
 * them. Before, any caller naming a confirmed leaf was handed its claim code:
 * leaf indices are public and the ticket ships in the bundle, so the first
 * stranger to read the tree could collect the note somebody else paid for.
 *
 * Now a confirm has to prove it is the payer (the wallet that paid the till
 * signs `claimChallenge(paymentSignature)`, verified against the fee payer of
 * that transaction), and the leaf it names has to be the one the relay funded
 * WITH that payment (`p01:relay:payment:<sig>:contribution`, written by
 * `/api/relay-to-buyer` only after the lamports moved). The mint itself is
 * gated on `p01:note:paid:<sig>`, the same counter `/api/claim-for-payment`
 * uses, so a deposit that failed and was claimed there, and a confirm of the
 * same payment, can never both mint: whichever runs first pays, the other
 * replays its code. Headless callers sign with their keypair
 * (`scripts/contributeAndCollect.mts`).
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

// The KV keys (reserved, confirmed, claim, paid) live in
// `lib/privacy/paymentBinding.ts`, shared with relay-to-buyer and
// claim-for-payment: one format, one file.

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

/**
 * How long a reservation at the tree's edge is treated as LIVE before it can
 * be reclaimed. A contribution proves, uploads and confirms well inside this
 * window (measured 2026-09-02: 4 to 13 minutes end to end under devnet rate
 * limits). Before this gate existed, the reclaim below fired on every second
 * reservation inside the hour, because `start` is one past the tree by
 * definition and so "the tree has not reached it" was always true: two live
 * contributors were handed the same leaf (pinned 2026-09-02).
 */
const RECLAIM_AFTER_MS = 20 * 60 * 1000;

function bad(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
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
 *
 * Exported for `/api/claim-for-payment`, which asks the same question from the
 * other side: has the deposit this payment funded landed, in which case the
 * claim must be collected here and not there.
 */
export function treasuryCommitmentFor(
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

  let body: {
    action?: unknown;
    token?: unknown;
    leafIndex?: unknown;
    commitment?: unknown;
    paymentSignature?: unknown;
    proof?: unknown;
  };
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
  } catch {
    // ⛔ THE REFUSAL CARRIES NO TEXT FROM THE STORE. The store words a failure
    // as `${error}, command was: ${JSON.stringify(commands)}` and with
    // auto-pipelining that list holds the commands of every other request
    // batched into the same round trip: another route's claim code, a payment
    // signature, another caller's limiter bucket. This route runs on the
    // buyer's paid path, so the body reaches a paying caller. Fixed words,
    // whatever failed — the same posture as `/api/fund-ephemeral`. Pinned by
    // `__tests__/api/contribute-note.test.ts` "a limiter that fails says so
    // without passing on what the store carried", which runs the same failure
    // with two different batches and requires one answer.
    return bad(503, 'the rate limiter could not be read');
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
      const markerKey = contribReservedKey(poolKey, leafIndex);
      const reservedAtKey = markerKey + ':at';
      try {
        taken = await kv.incr(markerKey);
        if (taken !== 1 && leafIndex === start) {
          // The tree has not reached this index. Either the holder is still
          // proving and uploading (a LIVE attempt, which must keep its leaf), or
          // the attempt died. Only the marker's age tells the two apart: a
          // marker older than the proving window, or one written before ages
          // were recorded, is reclaimed; a fresh one is walked past.
          const at = Number((await kv.get(reservedAtKey)) ?? 0);
          if (!at || Date.now() - at > RECLAIM_AFTER_MS) {
            await kv.del(markerKey);
            await kv.del(reservedAtKey);
            taken = await kv.incr(markerKey);
          }
        }
        // Self-healing: an abandoned marker stops mattering after an hour even
        // if the branch above never runs.
        if (taken === 1) {
          await kv.set(reservedAtKey, Date.now(), { ex: 3600 });
          await kv.expire?.(markerKey, 3600);
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
  const paymentSignature =
    typeof body.paymentSignature === 'string' ? body.paymentSignature.trim() : '';
  const proof = typeof body.proof === 'string' ? body.proof.trim() : '';
  if (!paymentSignature) {
    return bad(400, 'paymentSignature is required: the transaction that paid the till for this deposit');
  }
  if (!proof) {
    return bad(400, 'proof is required: sign claimChallenge(paymentSignature) with the wallet that paid');
  }

  /**
   * WHO PAID. `keys[0]` of the payment is its fee payer, the wallet on the
   * relayed deposit path, and the proof must verify under it: the tree, the
   * leaf index and the ticket are all public, so without this the first
   * stranger to read the chain could collect the note somebody else paid for.
   */
  let payer: string;
  try {
    const tx = await connection.getTransaction(paymentSignature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (!tx?.meta) return bad(404, 'that payment is not on chain yet; confirm it and retry');
    if (tx.meta.err) return bad(400, 'that payment failed on chain, so it paid nothing');
    const first = tx.transaction.message.getAccountKeys().staticAccountKeys[0];
    if (!first) return bad(400, 'that payment names no fee payer');
    payer = first.toBase58();
  } catch (e) {
    return bad(502, `the payment could not be read: ${(e as Error).message}`);
  }
  try {
    // Buffer, not TextEncoder: tweetnacl checks `instanceof Uint8Array`, and
    // under jsdom TextEncoder returns one from another realm. See
    // claim-for-payment, which verifies the same challenge the same way.
    const ok = nacl.sign.detached.verify(
      new Uint8Array(Buffer.from(claimChallenge(paymentSignature), 'utf8')),
      new Uint8Array(Buffer.from(proof, 'base64')),
      new PublicKey(payer).toBytes(),
    );
    if (!ok) return bad(401, 'that proof was not signed by the wallet that made this payment');
  } catch {
    return bad(400, 'proof must be base64 of a 64-byte ed25519 signature');
  }

  /**
   * ⛔ WHAT THIS PAYMENT ALREADY EARNED, ANSWERED BEFORE THE BINDING IS READ.
   *
   * The payer has just proved who they are, and what they are owed depends on
   * their PAYMENT alone — so it is decided here, above the binding, because
   * the binding is not permanent: `issue-note` deletes it at redemption along
   * with the code row (`forgetTheCodeToPaymentTrail`). In the old order a
   * payer replaying their own confirm was told 'that payment did not fund this
   * leaf' about a payment that had funded exactly that leaf. Money spent, no
   * note, and a refusal that reads as an accusation.
   *
   * `get`, never `incr`: reading must not consume the gate. Pinned by
   * `__tests__/api/contribute-note.test.ts` "replays the code when the binding
   * is gone" and "refuses a payment whose code has been redeemed".
   */
  const paidKey = notePaidKey(paymentSignature);
  let earnedCode: string | null = null;
  let alreadyRedeemed = false;
  try {
    // The counter first, and the code row only once the gate is taken: a code
    // is written only after `incr(paidKey)`, so a counter at 0 means no code.
    // A purchase pays one GET here; replays and refusals pay two. Pinned by
    // "a first confirm reads the payment counter, never the code row".
    if (counterValue(await kv.get(paidKey)) >= 1) {
      earnedCode = await kv.get<string>(notePaidCodeKey(paymentSignature));
      alreadyRedeemed = !earnedCode;
    }
  } catch (e) {
    return bad(503, `the payment record could not be read: ${(e as Error).message}`);
  }

  /**
   * The commitment this treasury owns at that index, and whether the tree
   * holds it. Derived once, because the replay below needs the same answer the
   * first confirm does: it is pure CPU over the history already fetched and
   * has no side effect, so hoisting it moves no refusal.
   */
  const expected = treasuryCommitmentFor(seed, pool.poolPDA, pool.tokenMint, leafIndex);
  const onChain = commitments.get(expected.toString());

  if (earnedCode) {
    if (onChain?.leafIndex === leafIndex) {
      // The leaf IS on the tree and IS the treasury's, so it is stock whichever
      // route minted the code. Recorded here because the fallback could not:
      // the deposit had not landed when it ran.
      try {
        await recordInventoryLeaf(poolKey, leafIndex);
      } catch {
        /* issue-note also discovers treasury leaves by derivation; the code is what matters here */
      }
    }
    return NextResponse.json({
      ok: true,
      claimCode: earnedCode,
      leafIndex,
      denomination,
      token,
      replayed: true,
    });
  }
  if (alreadyRedeemed) {
    // The gate is taken and the code row is gone, which is what redemption
    // leaves behind. Nothing is owed and nothing may be minted: a second code
    // would sell this payment twice.
    return bad(409, 'this payment has already been redeemed', {
      hint: 'Its claim code was collected at /api/issue-note, and a note already issued is not issued again.',
    });
  }

  /**
   * THE LEAF THIS PAYMENT FUNDED, as the relay recorded it after the lamports
   * moved. A payer can only confirm the reservation their own payment funded:
   * naming somebody else's leaf, however well it verifies on the tree, earns
   * nothing here.
   */
  let binding: string | null;
  try {
    binding = await kv.get<string>(relayPaymentContributionKey(paymentSignature));
  } catch (e) {
    return bad(503, `the relay record could not be read: ${(e as Error).message}`);
  }
  if (binding !== contributionBinding(poolKey, leafIndex)) {
    return bad(400, 'that payment did not fund this leaf', {
      leafIndex,
      hint: binding
        ? 'The relay recorded a different contribution for this payment.'
        : 'The relay recorded no contribution for this payment; a deposit relayed without ' +
          'one cannot be confirmed.',
    });
  }

  /**
   * 🚨 THE COMMITMENT IS RECOMPUTED FROM THE TREASURY SEED, NEVER TAKEN FROM
   * THE CALLER. Trusting `body.commitment` would let anyone name a leaf that
   * happens to exist — somebody else's deposit, or one of ours from months ago
   * — and be paid a claim for it. The only thing that earns a claim is OUR
   * commitment appearing at the index we reserved.
   */
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
   * ONE CLAIM PER PAYMENT, and `incr` on `p01:note:paid:<sig>` decides it.
   *
   * The gate is SHARED with `/api/claim-for-payment`, which is the fallback
   * for a deposit that had not landed when the client gave up. Whichever of
   * the two runs first mints; the other hands back the same code. A retry is
   * ordinary (a lost response, a reloaded page), so it gets the code rather
   * than a refusal, and minting a second one would pay twice.
   *
   * Taken only now, after every refusal above: a gate consumed by a 409 would
   * leave the payment claimed with no code behind it, which is the one state
   * neither route can repair.
   */
  let paid: number;
  try {
    paid = await kv.incr(paidKey);
  } catch (e) {
    return bad(503, `the payment could not be claimed: ${(e as Error).message}`);
  }
  if (paid !== 1) {
    // A concurrent request took the gate between the read above and this
    // increment. If it has written the code, hand that back; if it has not
    // written it yet, refusing is right, because minting a second one is the
    // double-sale this counter exists to stop.
    let existing: string | null = null;
    try {
      existing = await kv.get<string>(notePaidCodeKey(paymentSignature));
    } catch {
      /* falls through to the refusal below */
    }
    if (!existing) {
      return bad(409, 'this payment has already been redeemed', {
        hint: 'If its claim code was issued and not yet used, ask again with the same payment.',
      });
    }
    // The leaf IS on the tree (checked above) and IS the treasury's, so it is
    // stock whichever route minted the code. Recorded here because the
    // fallback could not: the deposit had not landed when it ran.
    try {
      await recordInventoryLeaf(poolKey, leafIndex);
    } catch {
      /* issue-note also discovers treasury leaves by derivation; the code is what matters here */
    }
    return NextResponse.json({
      ok: true,
      claimCode: existing,
      leafIndex,
      denomination,
      token,
      replayed: true,
    });
  }

  /**
   * ONE CLAIM PER DEPOSIT as well. A leaf already confirmed under a DIFFERENT
   * payment (the loser of a reservation race) must not be handed the winner's
   * code. The paid gate is given back so that payment stays claimable where it
   * belongs; nothing was minted for it here.
   */
  let confirmations: number;
  try {
    confirmations = await kv.incr(contribConfirmedKey(poolKey, leafIndex));
  } catch (e) {
    return bad(503, `the confirmation could not be written: ${(e as Error).message}`);
  }
  if (confirmations !== 1) {
    try {
      await kv.del(paidKey);
    } catch {
      /* best effort; the refusal below is accurate either way */
    }
    return bad(409, 'this contribution was already confirmed under a different payment', {
      leafIndex,
      hint: 'Its claim code was issued once, to the payment that funded it.',
    });
  }

  const claimCode = mintCode();
  try {
    /**
     * Under the PAYMENT, and under nothing else.
     *
     * ⛔ THE LEAF CARRIED THE CODE TOO until KV-1 (`contrib-claim:<pool>:
     * <leaf>`), and nothing ever read it: this route replays off
     * `paid:<sig>:code` and so does the fallback at `/api/claim-for-payment`.
     * A row no code needs is a row only a dump can use, and that one paired a
     * leaf this buyer's money funded with the code they redeem it for. Pinned
     * by `__tests__/api/contribute-note.test.ts` "writes no leaf-to-code row",
     * and measured across worlds by `__tests__/lib/kvRowsAtRest.test.ts`.
     */
    await kv.set(notePaidCodeKey(paymentSignature), claimCode);
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
    /**
     * The value `issue-note` reads to decide the code was MINTED rather than
     * guessed. It tests `if (!minted)`, so an empty string would burn the
     * buyer's claim without releasing it — and the PAYMENT alone says what it
     * needs to say.
     *
     * ⛔ IT NAMED THE LEAF UNTIL KV-1: the code, the leaf this buyer's payment
     * funded and the signature that resolves publicly to their wallet, in one
     * row, under a key that is the code. One dump joined all three.
     * `issue-note` parses the signature back out of this value to sweep the
     * trail at redemption, so the `payment:<sig>` shape is load-bearing.
     */
    await kv.set(`p01:note:claim-minted:${claimCode}`, `payment:${paymentSignature}`);
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
