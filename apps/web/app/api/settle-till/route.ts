/**
 * settle-till — move the till's takings back to the float, in batches, on a
 * clock unrelated to any purchase.
 *
 * WHY THIS EXISTS
 * ───────────────
 * `relay-to-buyer` splits the address buyers pay (R, the till) from the address
 * that funds their deposits (F, the float), which is what stops an auditor
 * walking `deposit -> ephemeral -> float -> a transfer the buyer signed`. The
 * cost of that split is that F pays a whole denomination out of pocket per
 * deposit and is credited nothing. F drains, and at 7.6 SOL it drains after six
 * deposits.
 *
 * Until now the remedy was a sentence in a comment — "F needs a balance alarm
 * and a settlement runbook" — and a runbook is a person remembering. On
 * 2026-08-22 the person was the author and the memory failed in the worst
 * available way: one purchase settled by hand ninety minutes later, drawing
 * `float -> till -> buyer` for leaf 72.
 *
 * 🚨 THIS ROUTE NEEDS THE TILL'S SPENDING KEY, AND THAT IS A REAL CHANGE
 * ─────────────────────────────────────────────────────────────────────
 * `relay-to-buyer` states — and `topologyInvariants.test.ts` pinned — that the
 * till's key is held off chain deliberately, "a till this deployment could
 * spend would be a second float and the R != F split would collapse". That
 * sentence was half right, and the half that is wrong is why this route can
 * exist:
 *
 *   - WRONG about the property. R != F is a statement about what appears in
 *     transactions, and an observer cannot see who holds a key. The split
 *     survives the key coming online; nothing about the chain changes.
 *   - RIGHT about the risk, which is behavioural, not cryptographic. A
 *     deployment able to spend R might spend it AS a float — fund an ephemeral
 *     straight from the address buyers paid — and that single code path would
 *     rebuild `buyer -> R -> ephemeral -> deposit`, the exact two-hop walk of
 *     2026-08-18 with the middle step relabelled.
 *
 * So the key comes online and the behavioural risk is refused by construction,
 * in three places that are each tested:
 *   1. `P01_TILL_SECRET_KEY` is read in THIS FILE AND NOWHERE ELSE. A test
 *      greps the repository to keep it that way, because the guarantee is not
 *      "we would not do that" but "there is one place that could".
 *   2. This route has exactly one destination — the float, derived from
 *      `P01_FUNDER_SECRET_KEY` — and it is never taken from the request. There
 *      is no parameter that moves the money anywhere else.
 *   3. It refuses outright if the till key and the float key are the same
 *      keypair, or if the till key does not match `P01_TILL_ADDRESS`. A
 *      deployment that collapsed R into F settles nothing rather than settling
 *      into itself.
 *
 * ⚠️ THE BLAST RADIUS DID GROW AND PRETENDING OTHERWISE WOULD BE THE LIE. A
 * compromise of this deployment previously reached the float; it now also
 * reaches whatever the till holds, which is bounded by the batch floor times
 * one denomination. That is a cost, it is bounded, and it buys the invariant
 * being enforced by a machine instead of remembered by a person — a trade the
 * leaf-72 incident already priced.
 *
 * ⛔ WHAT THIS DOES NOT DO. It does not decide the privacy floor and it cannot
 * be argued into a smaller one at runtime: when the float is too small to reach
 * the floor it reports `float-too-small-for-batch-floor` and settles nothing.
 * The deployment stops serving deposits. That is the correct failure — a stopped
 * relay is restarted with a transfer, and a named buyer stays named.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

import { getStore, type KvLike } from '@/lib/waitlist/store';
import { sendReportEmail } from '@/lib/waitlist/email';
import {
  ONE_PURCHASE_LAMPORTS,
  PREFUND_WORST_CASE_LAMPORTS,
  decideSettlement,
  drawHoldUntil,
  floatRequiredForBatch,
  settlementConfigFromEnv,
  type SettlementDecision,
} from '@/lib/privacy/pool/settlementPolicy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The same guard the funder, the issuer and the relay carry. */
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

/** KV keys. Namespaced like every other durable counter in this app. */
const K = {
  /** The drawn hold deadline for the current window, unix seconds. */
  hold: 'p01:settle:hold-until',
  /** Held while a settlement is in flight, so two cron ticks cannot both send. */
  lock: 'p01:settle:lock',
  /** The last settlement, for the status endpoint. */
  last: 'p01:settle:last',
  /** Set while a float alarm has already been emailed, so it does not repeat. */
  alarmed: 'p01:settle:alarm-sent',
};

/** Long enough to outlive a send, short enough that a crash self-heals. */
const LOCK_TTL_SECONDS = 300;
/** One alarm per this many seconds, so a low float does not mail every tick. */
const ALARM_COOLDOWN_SECONDS = 6 * 3600;

function bad(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

/**
 * Is this the scheduler?
 *
 * TWO SECRETS ARE ACCEPTED, AND THE SECOND ONE IS NOT A WORKAROUND.
 *
 * ⛔ THE SCHEDULER CANNOT BE VERCEL'S. Measured 2026-08-22 by deploying it:
 * "Hobby accounts are limited to daily cron jobs. This cron expression
 * (17 * * * *) would run more than once per day." Hobby also caps the account
 * at two cron jobs and both are spoken for by the waitlist. A DAILY tick would
 * technically run, and it would quietly gut the policy: the randomised hold has
 * to land on some tick, so at one tick a day the hold is not a hold and the
 * settlement fires at the same hour every time — a constant an observer reads
 * off the schedule, which is the thing the hold exists to prevent. Better an
 * external scheduler that ticks hourly than an on-platform one that makes the
 * jitter decorative.
 *
 * So the tick comes from `.github/workflows/settle-till.yml`, and it holds
 * `P01_SETTLE_TRIGGER_SECRET` — scoped to THIS ROUTE — rather than `CRON_SECRET`,
 * which opens every cron route in the app. Handing a third party the key to all
 * of them to schedule one of them is the trade nobody would make deliberately.
 * `CRON_SECRET` still works, so moving to a Pro plan is a line in `vercel.json`
 * and nothing else.
 *
 * `timingSafeEqual` with the length check in front, because a comparison that
 * returns early on the first wrong byte leaks the secret one byte at a time to
 * a caller who can time it. Both candidates are checked with no early exit on
 * the first match, so which secret was used is not timeable either.
 */
function matches(bearer: string, secret: string | undefined): boolean {
  if (!secret) return false;
  const a = Buffer.from(bearer);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isCronCall(req: NextRequest): boolean {
  const authz = req.headers.get('authorization');
  const bearer = authz?.startsWith('Bearer ') ? authz.slice(7) : null;
  if (!bearer) return false;
  const viaPlatform = matches(bearer, process.env.CRON_SECRET);
  const viaTrigger = matches(bearer, process.env.P01_SETTLE_TRIGGER_SECRET);
  return viaPlatform || viaTrigger;
}

function keypairFrom(raw: string | undefined): Keypair | null {
  const s = raw?.trim();
  if (!s) return null;
  try {
    return Keypair.fromSecretKey(
      s.startsWith('[') ? Uint8Array.from(JSON.parse(s) as number[]) : bs58.decode(s),
    );
  } catch {
    return null;
  }
}

/**
 * 🚨 THE ONLY READ OF `P01_TILL_SECRET_KEY` IN THE REPOSITORY.
 *
 * `settleTillKeyIsConfinedToThisRoute` in the test file greps for the name and
 * fails if it appears in any other source file. Keep it that way: the argument
 * that the till cannot become a second float is exactly the argument that only
 * one function can spend it, and that argument is checkable rather than
 * promised.
 */
function tillKeypair(): Keypair | null {
  return keypairFrom(process.env.P01_TILL_SECRET_KEY);
}

function funderKeypair(): Keypair | null {
  return keypairFrom(process.env.P01_FUNDER_SECRET_KEY);
}

interface Principals {
  till: Keypair;
  funder: Keypair;
}

/**
 * The two keypairs, or every reason there is not a safe pair of them.
 *
 * ⚠️ RETURNS ALL REASONS, NOT THE FIRST. An operator fixing one variable at a
 * time against a route that reports one problem at a time redeploys once per
 * problem, and the 2026-08-21 evening was spent doing exactly that.
 */
function principals(): { ok: true; p: Principals } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const till = tillKeypair();
  const funder = funderKeypair();

  if (!till) {
    reasons.push(
      'P01_TILL_SECRET_KEY is unset or unparseable, so nothing can move the till\'s takings back ' +
        'to the float and the float drains until deposits stop.',
    );
  }
  if (!funder) {
    reasons.push('P01_FUNDER_SECRET_KEY is unset or unparseable, so there is no float to settle into.');
  }

  if (till && funder) {
    const t = till.publicKey.toBase58();
    const f = funder.publicKey.toBase58();
    // ⛔ R == F IS THE COLLAPSE ITSELF. Settling into itself is a no-op that
    // would report success forever while the float never refills, and a
    // deployment in that state has already lost the property this route
    // protects. Refuse loudly rather than move zero lamports quietly.
    if (t === f) {
      reasons.push(
        'The till key and the float key are the SAME keypair. R == F means every buyer paid the ' +
          'address that funds their own deposit, which is the two-hop walk measured on 2026-08-18. ' +
          'Settling is meaningless here and the deployment must be reconfigured, not settled.',
      );
    }
    // The declared till is what `relay-to-buyer` tells buyers to pay. A key that
    // does not match it would sweep an address nobody is paying — succeeding,
    // reporting a settlement, and leaving the real till untouched.
    const declared = process.env.P01_TILL_ADDRESS?.trim() ?? '';
    if (!declared) {
      reasons.push('P01_TILL_ADDRESS is unset, so there is nothing to check the till key against.');
    } else {
      let declaredOk = '';
      try {
        declaredOk = new PublicKey(declared).toBase58();
      } catch {
        reasons.push('P01_TILL_ADDRESS is not a public key.');
      }
      if (declaredOk && declaredOk !== t) {
        reasons.push(
          `P01_TILL_SECRET_KEY derives ${t}, but buyers are told to pay ${declaredOk}. Sweeping ` +
            'the wrong address would report success while the real till kept filling.',
        );
      }
    }
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, p: { till: till as Keypair, funder: funder as Keypair } };
}

function connection(): Connection {
  return new Connection(process.env.P01_FUNDER_RPC ?? 'https://api.devnet.solana.com', 'confirmed');
}

/**
 * How long ago the till was last credited, in seconds.
 *
 * ⚠️ THE MOST RECENT SIGNATURE, AND THE SORT ORDER IS THE TRAP. This is the
 * one place in the codebase where `getSignaturesForAddress`'s newest-first
 * default is what we want — `resolveFunderOfPayer` needed the OLDEST and read
 * the newest, and `verify/deposit-walk.mjs` reproduced that same bug in the
 * tool written to detect it. Stated here so the next reader does not "fix" it
 * into consistency with those two.
 *
 * Between settlements every transaction on the till is an incoming payment, so
 * the newest transaction IS the newest credit. Returns `null` when the history
 * or its clock cannot be read, and the caller treats that as a refusal.
 */
async function secondsSinceLastTillCredit(
  conn: Connection,
  till: PublicKey,
  nowSeconds: number,
): Promise<number | null> {
  try {
    const sigs = await conn.getSignaturesForAddress(till, { limit: 1 });
    const t = sigs[0]?.blockTime;
    if (typeof t !== 'number') return null;
    // A clock skew that makes the last payment look like it is in the future
    // must not read as "very old" once subtracted. Clamp at zero.
    return Math.max(0, nowSeconds - t);
  } catch {
    return null;
  }
}

/** Everything the decision needs, read from the chain in one place. */
async function observe(conn: Connection, p: Principals, nowSeconds: number, kv: KvLike | null) {
  const [tillLamports, floatLamports] = await Promise.all([
    conn.getBalance(p.till.publicKey),
    conn.getBalance(p.funder.publicKey),
  ]);
  const since = await secondsSinceLastTillCredit(conn, p.till.publicKey, nowSeconds);
  let holdUntilSeconds: number | null = null;
  if (kv) {
    try {
      const raw = await kv.get<number | string>(K.hold);
      const n = Number(raw);
      holdUntilSeconds = Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      holdUntilSeconds = null;
    }
  }
  return { tillLamports, floatLamports, secondsSinceLastTillCredit: since, holdUntilSeconds };
}

/**
 * Email the operator when the float can no longer serve many deposits.
 *
 * ⚠️ DEDUPED, BECAUSE AN ALARM THAT FIRES HOURLY IS AN ALARM THAT GETS FILTERED.
 * One mail per cooldown, cleared as soon as the float recovers, so the next
 * genuine drop mails again immediately.
 */
async function maybeAlarm(
  kv: KvLike | null,
  d: SettlementDecision,
  floatAddress: string,
  floatLamports: number,
): Promise<'sent' | 'suppressed' | 'not-needed' | 'unconfigured'> {
  const to = process.env.REPORT_EMAIL_TO;
  if (!d.floatAlarm) {
    if (kv) {
      // Recovered: clear the flag so the NEXT drop is not swallowed by a
      // cooldown that outlived the condition it was throttling.
      try {
        await kv.del(K.alarmed);
      } catch {
        /* best effort */
      }
    }
    return 'not-needed';
  }
  if (!to) return 'unconfigured';
  if (kv) {
    try {
      const n = await kv.incr(K.alarmed);
      if (n === 1) await kv.expire(K.alarmed, ALARM_COOLDOWN_SECONDS);
      if (n !== 1) return 'suppressed';
    } catch {
      // An unreadable store must not silence an alarm. Falling through mails
      // it, which is the direction that fails loud.
    }
  }
  const need = floatRequiredForBatch(settlementConfigFromEnv().minPurchases);
  const text = [
    `Float ${floatAddress}`,
    `balance            ${(floatLamports / 1e9).toFixed(4)} SOL`,
    `deposits remaining ${d.depositsRemaining}`,
    `till holds         ${d.purchases} purchase(s)`,
    `settlement verdict ${d.verdict}`,
    '',
    d.reason,
    '',
    `To reach the batch floor without stopping, the float needs ${(need / 1e9).toFixed(4)} SOL.`,
    d.floatShortfallLamports > 0
      ? `Short by ${(d.floatShortfallLamports / 1e9).toFixed(4)} SOL.`
      : 'No shortfall: the float can reach the floor from here.',
    '',
    'Do not lower P01_SETTLE_MIN_PURCHASES to clear this. A settlement carrying one purchase',
    'names that buyer permanently; the SOL is recoverable where the name is not.',
  ].join('\n');
  const sent = await sendReportEmail({
    to,
    subject: `[Protocol 01] float low — ${d.depositsRemaining} deposit(s) left`,
    html: `<pre style="font:13px/1.5 ui-monospace,monospace">${text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')}</pre>`,
    text,
  });
  return sent ? 'sent' : 'unconfigured';
}

/** The public, side-effect-free view. Never includes the drawn hold. */
function statusBody(
  p: Principals | null,
  reasons: string[],
  d: SettlementDecision | null,
  extra: Record<string, unknown> = {},
) {
  const cfg = settlementConfigFromEnv();
  return {
    ok: true,
    configured: reasons.length === 0,
    reasons,
    till: p?.till.publicKey.toBase58() ?? null,
    float: p?.funder.publicKey.toBase58() ?? null,
    policy: {
      minPurchases: cfg.minPurchases,
      minQuietSeconds: cfg.minQuietSeconds,
      alarmBelowDeposits: cfg.alarmBelowDeposits,
      onePurchaseLamports: ONE_PURCHASE_LAMPORTS,
      prefundWorstCaseLamports: PREFUND_WORST_CASE_LAMPORTS,
      floatRequiredForFloorLamports: floatRequiredForBatch(cfg.minPurchases),
    },
    verdict: d?.verdict ?? null,
    purchasesHeld: d?.purchases ?? null,
    depositsRemaining: d?.depositsRemaining ?? null,
    floatAlarm: d?.floatAlarm ?? null,
    floatShortfallLamports: d?.floatShortfallLamports ?? null,
    reason: d?.reason ?? null,
    ...extra,
  };
}

export async function GET(req: NextRequest) {
  const authorised = isCronCall(req);
  const guard = principals();
  const kv = getStore();

  if (!guard.ok) {
    // Reported at 200 on the unauthenticated read — it is a status endpoint and
    // "not configured" is a status, the shape `/api/issue-note` and
    // `/api/relay-to-buyer` already use. The cron path below still refuses.
    if (!authorised) return NextResponse.json(statusBody(null, guard.reasons, null));
    return bad(503, 'this deployment cannot settle', { reasons: guard.reasons });
  }
  const p = guard.p;

  const conn = connection();
  let genesis: string;
  try {
    genesis = await conn.getGenesisHash();
  } catch (e) {
    const msg = `the configured RPC could not be reached: ${(e as Error).message}`;
    return authorised ? bad(502, msg) : NextResponse.json(statusBody(p, [msg], null));
  }
  // Checked against the chain, not the URL string — the same reason the funder
  // and the issuer do it. An env var pointing at mainnet and named devnet would
  // move real money.
  if (genesis !== DEVNET_GENESIS) {
    const msg = 'this settler is devnet-only and the configured RPC is not devnet';
    return authorised ? bad(403, msg, { genesis }) : NextResponse.json(statusBody(p, [msg], null));
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const cfg = settlementConfigFromEnv();
  const obs = await observe(conn, p, nowSeconds, kv);
  let decision = decideSettlement({ ...obs, nowSeconds, config: cfg });

  if (!authorised) {
    // 🚨 THE DRAWN HOLD IS WITHHELD FROM THE PUBLIC VIEW, ON PURPOSE. Publishing
    // "the settlement fires at 04:17" hands an observer the exact transaction to
    // watch and undoes the randomisation it describes. Balances are already
    // public on chain; the future timestamp is not, and it is the only field
    // here that is genuinely secret.
    return NextResponse.json(
      statusBody(p, [], decision, {
        tillLamports: obs.tillLamports,
        floatLamports: obs.floatLamports,
        lastCreditSecondsAgo: obs.secondsSinceLastTillCredit,
      }),
    );
  }

  // ── From here on the caller is the scheduler and side effects are allowed ──

  const alarm = await maybeAlarm(kv, decision, p.funder.publicKey.toBase58(), obs.floatLamports);

  /**
   * Draw the hold the FIRST tick the batch floor is met, before deciding.
   *
   * 🚨 IT CANNOT BE DRAWN ONLY ON THE "TOO SOON" PATH, WHICH IS WHERE IT WANTS
   * TO GO. Purchases arrive slowly, so by the time the third one lands the
   * first two may already be a day old — the quiet period is satisfied on the
   * very tick the floor is reached, the decision says settle, and the hold
   * never happens. The settlement then lands at "the first cron tick after the
   * floor was met", which is a constant an observer reads off the schedule.
   *
   * ⚠️ DRAWN ONCE AND STORED. Redrawing every tick resamples hourly and the
   * minimum of many samples arrives quickly — that is the constant again,
   * wearing a different hat.
   *
   * Anchored at the end of the quiet period, not at now, so the spread lands
   * AFTER the floor rather than being eaten by it.
   */
  const floorMet = decision.verdict === 'settle' || decision.verdict === 'too-soon-after-purchase';
  if (kv && floorMet && obs.holdUntilSeconds === null) {
    try {
      const quietEndsAt =
        nowSeconds + Math.max(0, cfg.minQuietSeconds - (obs.secondsSinceLastTillCredit ?? 0));
      const until = drawHoldUntil(quietEndsAt, cfg);
      // TTL well past the widest window, so a hold from an abandoned batch
      // cannot wedge settlement shut forever.
      await kv.set(K.hold, until, {
        ex: cfg.minQuietSeconds + cfg.holdSpreadSeconds + 7 * 86400,
      });
      obs.holdUntilSeconds = until;
      decision = decideSettlement({ ...obs, nowSeconds, config: cfg });
    } catch {
      // A hold that could not be stored means no jitter this window. The quiet
      // period still applies, so the floor is never breached — and losing the
      // jitter must not stop settlement forever.
    }
  }

  if (decision.verdict !== 'settle') {
    return NextResponse.json(
      statusBody(p, [], decision, {
        settled: false,
        alarm,
        tillLamports: obs.tillLamports,
        floatLamports: obs.floatLamports,
        lastCreditSecondsAgo: obs.secondsSinceLastTillCredit,
        holdUntilSeconds: obs.holdUntilSeconds,
      }),
    );
  }

  // ── Settle ────────────────────────────────────────────────────────────────

  if (!kv) {
    // ⛔ No durable store, no lock, and no lock means two overlapping cron ticks
    // can each build a full sweep. The second lands after the first and moves
    // whatever arrived in between — which is a settlement of one purchase, the
    // exact thing this route exists to prevent, produced by the route itself.
    return bad(503, 'no durable store, so a settlement cannot be locked against a concurrent one');
  }
  let lock: number;
  try {
    lock = await kv.incr(K.lock);
    if (lock === 1) await kv.expire(K.lock, LOCK_TTL_SECONDS);
  } catch (e) {
    return bad(503, `the settlement lock could not be taken: ${(e as Error).message}`);
  }
  if (lock !== 1) {
    return NextResponse.json(
      statusBody(p, [], decision, { settled: false, alarm, note: 'a settlement is already in flight' }),
    );
  }

  const releaseLock = async () => {
    try {
      await kv.del(K.lock);
    } catch {
      /* the TTL clears it */
    }
  };

  try {
    /**
     * ⚠️ THE AMOUNT IS THE ONE DECIDED, NOT THE BALANCE AT SEND TIME.
     *
     * A payment landing between the decision and the send would otherwise be
     * swept along with it — and that buyer's payment would sit SECONDS before
     * the settlement, which is precisely the adjacency the quiet period exists
     * to break. Their money is not lost: it stays in the till and opens the
     * next batch. The batch is one purchase smaller and one buyer safer.
     */
    const decided = decision.amountLamports;
    const balanceNow = await conn.getBalance(p.till.publicKey);
    if (balanceNow < decided) {
      // Only possible if something else spent the till. Refuse rather than
      // sweep a different amount than the one the policy approved.
      await releaseLock();
      return bad(409, 'the till balance fell between the decision and the send; settling nothing', {
        decided,
        balanceNow,
      });
    }

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('finalized');
    const build = (lamports: number) => {
      const tx = new Transaction({
        feePayer: p.till.publicKey,
        blockhash,
        lastValidBlockHeight,
      }).add(
        SystemProgram.transfer({
          fromPubkey: p.till.publicKey,
          // 🚨 THE DESTINATION IS THE FLOAT KEYPAIR'S OWN PUBLIC KEY AND THERE IS
          // NO OTHER SOURCE FOR IT. Not a body field, not a query parameter, not
          // an env address that could drift from the key that signs for it.
          toPubkey: p.funder.publicKey,
          lamports,
        }),
      );
      return tx;
    };

    // The fee comes out of the till, so the transfer has to be the balance minus
    // it. Asked rather than assumed: 5000 is the base fee today and a hardcoded
    // one would strand dust or fail outright the day it moves.
    let fee = 5000;
    try {
      const probe = build(1).compileMessage();
      const got = await conn.getFeeForMessage(probe, 'confirmed');
      if (typeof got.value === 'number' && got.value > 0) fee = got.value;
    } catch {
      /* keep the default */
    }

    const lamports = decided - fee;
    if (lamports <= 0) {
      await releaseLock();
      return bad(409, 'the till holds less than the network fee; settling nothing', { decided, fee });
    }

    const tx = build(lamports);
    const signature = await conn.sendTransaction(tx, [p.till], {
      // Retried by us, not blindly by the RPC: a preflight failure here is
      // information, not noise.
      skipPreflight: false,
      maxRetries: 3,
    });
    await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');

    const record = {
      signature,
      lamports,
      purchases: decision.purchases,
      atSeconds: nowSeconds,
      quietSeconds: obs.secondsSinceLastTillCredit,
    };
    try {
      await kv.set(K.last, record);
      // The window is over; the next one draws a fresh hold.
      await kv.del(K.hold);
    } catch {
      /* the settlement landed; bookkeeping is best effort */
    }
    await releaseLock();

    return NextResponse.json(
      statusBody(p, [], decision, {
        settled: true,
        alarm,
        signature,
        lamports,
        purchases: decision.purchases,
        floatLamportsBefore: obs.floatLamports,
      }),
    );
  } catch (e) {
    await releaseLock();
    return bad(502, `the settlement could not be sent: ${(e as Error).message}`);
  }
}
