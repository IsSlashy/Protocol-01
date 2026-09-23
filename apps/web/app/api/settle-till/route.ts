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
  MIN_PURCHASE_CREDIT_LAMPORTS,
  decideSettlement,
  drawHoldUntil,
  floatRequiredForBatch,
  maxDeferralSecondsFromEnv,
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
  /**
   * The drawn maximum-deferral deadline for the current window, unix seconds
   * (audit v1 F38). Withheld from the public view like the hold.
   */
  forceAt: 'p01:settle:force-at',
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

/** How many of the till's newest signatures one scheduler tick reads. */
const TILL_SCAN_LIMIT = 100;
/**
 * How many an ANONYMOUS status read reads. Each signature read here costs one
 * `getTransaction`, and the status view needs no ticket, so an unauthenticated
 * caller must not be able to buy a hundred RPC calls with one request. The
 * status it shows is then computed on less history (a lower bound on the quiet
 * time, the balance for the count); only the scheduler's reading moves money.
 */
const TILL_SCAN_LIMIT_PUBLIC = 10;

/**
 * How long ago the till was last credited A PURCHASE, and how many purchases
 * it was credited since its last outflow.
 *
 * ⚠️ NEWEST FIRST, AND THE SORT ORDER IS THE TRAP. This is the one place in the
 * codebase where `getSignaturesForAddress`'s newest-first default is what we
 * want — `resolveFunderOfPayer` needed the OLDEST and read the newest, and
 * `verify/deposit-walk.mjs` reproduced that same bug in the tool written to
 * detect it. Stated here so the next reader does not "fix" it into consistency
 * with those two.
 *
 * 🚨 audit v1 F38. This used to read the NEWEST SIGNATURE OF ANY KIND, on the
 * belief that "between settlements every transaction on the till is an
 * incoming payment". It is not: anyone can list the till in a transaction that
 * fails, or that moves 0 lamports, for one network fee. One such transaction
 * per quiet window held settlement off for ever (audit probe
 * `r2-server/probes/p3-settle-till.probe.test.ts`, case b). So:
 *
 *   - a failed transaction is skipped (it moved nothing);
 *   - a successful one counts as a purchase only when it credited the till at
 *     least `MIN_PURCHASE_CREDIT_LAMPORTS`, and it counts as ONE, whatever it
 *     moved (case a: a credit of two notes' worth is one payer, not two);
 *   - the walk stops at the till's last outflow, the previous settlement:
 *     nothing older belongs to this batch.
 *
 * `secondsSinceLastPurchaseCredit` is `null` when the history or a transaction
 * in it cannot be read: the caller refuses, never assumes old. When one page is
 * read without finding either a purchase or the last outflow (a page of
 * someone's cheap transactions), the age of the oldest signature read is a
 * LOWER BOUND on the quiet time and is returned as such; the purchase count is
 * then `null` and the balance alone decides it, as before.
 *
 * 🚨 audit v1 F62, one hop later (close-v1 verify round 1). `/api/fund-ephemeral`
 * refuses to pay the till directly, but its grant to a fresh key K is allowed,
 * and K can pay the till two purchase-sized transfers: two "purchases" made of
 * the float's own lamports, free to whoever asked for the grant, and one real
 * buyer then settles as a batch of three (the n-1 attack, with the donation
 * free). So, on the scheduler's reading (`float` given), each purchase-sized
 * credit is checked: every account the transaction debited, other than the
 * till, has the page of its history BEFORE the payment read, and a credit whose
 * payer received lamports from the float there is not a purchase. A payer whose
 * history cannot be read is not counted either (unknown is not a purchase),
 * but its credit still resets the quiet period, since it may be a real buyer.
 * `floatFundedCredits` reports how many were set aside.
 *
 * ⚠️ WHAT THIS DOES NOT CATCH, AND THE BOUND. It walks ONE hop: K -> K2 ->
 * till, or more than `PAYER_HISTORY_PAGE` transactions between the grant and
 * the payment, passes it for one more network fee each. What bounds the
 * residual is the grant budget of `/api/fund-ephemeral` (audit v1 F37): 3 SOL
 * per IP per clock hour and 10 SOL per hour in total, i.e. at most 3 fake
 * purchase credits per IP-hour and 10 per hour overall, lamports that the
 * settlement returns to the float, so the attack costs the attacker only
 * network fees. The anonymous status read does not run the check (it would
 * make the unauthenticated view an RPC amplifier), so its count can be higher
 * than the scheduler's; only the scheduler's reading moves money.
 */
/** How many of a payer's transactions before its payment are read (F62). */
const PAYER_HISTORY_PAGE = 10;
/** How many debited accounts of one credit are checked (F62). */
const PAYER_SOURCES_CHECKED = 3;
/** How many credits one tick checks; older ones are counted unchecked (F62). */
const PAYER_CHECKS_PER_TICK = 20;

/**
 * Did `source` receive lamports from the float in the page of its history just
 * before `paymentSignature`? 'unknown' when that page cannot be read.
 */
async function floatFundedBefore(
  conn: Connection,
  source: string,
  float: string,
  paymentSignature: string,
): Promise<'yes' | 'no' | 'unknown'> {
  try {
    const sigs = await conn.getSignaturesForAddress(new PublicKey(source), {
      before: paymentSignature,
      limit: PAYER_HISTORY_PAGE,
    });
    for (const s of sigs) {
      if (s.err) continue;
      const tx = await conn.getTransaction(s.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (!tx?.meta) return 'unknown';
      if (tx.meta.err) continue;
      const meta = tx.meta;
      const keys = tx.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
      const d = (k: string) => {
        const i = keys.indexOf(k);
        return i < 0 ? 0 : (meta.postBalances[i] ?? 0) - (meta.preBalances[i] ?? 0);
      };
      if (d(float) < 0 && d(source) > 0) return 'yes';
    }
    return 'no';
  } catch {
    return 'unknown';
  }
}

async function readTillHistory(
  conn: Connection,
  till: PublicKey,
  nowSeconds: number,
  limit: number = TILL_SCAN_LIMIT,
  float: PublicKey | null = null,
): Promise<{
  secondsSinceLastPurchaseCredit: number | null;
  purchaseCredits: number | null;
  floatFundedCredits: number;
}> {
  const unknown = { secondsSinceLastPurchaseCredit: null, purchaseCredits: null, floatFundedCredits: 0 };
  try {
    const sigs = await conn.getSignaturesForAddress(till, { limit });
    if (sigs.length === 0) return unknown;
    const tillKey = till.toBase58();
    const floatKey = float?.toBase58() ?? null;
    let since: number | null = null;
    let credits = 0;
    let checked = 0;
    let floatFunded = 0;
    let reachedOutflow = false;
    let oldest: number | null = null;
    for (const s of sigs) {
      if (typeof s.blockTime !== 'number') return unknown;
      oldest = s.blockTime;
      if (s.err) continue;
      const tx = await conn.getTransaction(s.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (!tx?.meta) return unknown;
      if (tx.meta.err) continue;
      const keys = tx.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
      const i = keys.indexOf(tillKey);
      const delta = i < 0 ? 0 : (tx.meta.postBalances[i] ?? 0) - (tx.meta.preBalances[i] ?? 0);
      if (delta < 0) {
        reachedOutflow = true;
        break;
      }
      if (delta >= MIN_PURCHASE_CREDIT_LAMPORTS) {
        // F62: a credit paid with the float's own lamports is not a purchase.
        let verdict: 'yes' | 'no' | 'unknown' = 'no';
        if (floatKey && checked < PAYER_CHECKS_PER_TICK) {
          checked += 1;
          const meta = tx.meta;
          const sources = keys
            .filter((k, j) => k !== tillKey && (meta.postBalances[j] ?? 0) - (meta.preBalances[j] ?? 0) < 0)
            .slice(0, PAYER_SOURCES_CHECKED);
          for (const source of sources) {
            const v = await floatFundedBefore(conn, source, floatKey, s.signature);
            if (v === 'yes') {
              verdict = 'yes';
              break;
            }
            if (v === 'unknown') verdict = 'unknown';
          }
        }
        if (verdict === 'yes') {
          floatFunded += 1;
          continue;
        }
        if (verdict === 'no') credits += 1;
        // A clock skew that makes the last payment look like it is in the
        // future must not read as "very old" once subtracted. Clamp at zero.
        if (since === null) since = Math.max(0, nowSeconds - s.blockTime);
      }
    }
    const complete = reachedOutflow || sigs.length < limit;
    if (since === null && oldest !== null) since = Math.max(0, nowSeconds - oldest);
    return {
      secondsSinceLastPurchaseCredit: since,
      purchaseCredits: complete ? credits : null,
      floatFundedCredits: floatFunded,
    };
  } catch {
    return unknown;
  }
}

/** Read one stored unix-seconds deadline, or `null`. */
async function readDeadline(kv: KvLike | null, key: string): Promise<number | null> {
  if (!kv) return null;
  try {
    const n = Number(await kv.get<number | string>(key));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Everything the decision needs, read from the chain in one place. */
async function observe(
  conn: Connection,
  p: Principals,
  nowSeconds: number,
  kv: KvLike | null,
  scanLimit: number = TILL_SCAN_LIMIT,
) {
  const [tillLamports, floatLamports] = await Promise.all([
    conn.getBalance(p.till.publicKey),
    conn.getBalance(p.funder.publicKey),
  ]);
  // F62: only the scheduler's reading checks payers (see `readTillHistory`).
  const history = await readTillHistory(
    conn,
    p.till.publicKey,
    nowSeconds,
    scanLimit,
    scanLimit === TILL_SCAN_LIMIT ? p.funder.publicKey : null,
  );
  const holdUntilSeconds = await readDeadline(kv, K.hold);
  const forceAtSeconds = await readDeadline(kv, K.forceAt);
  return {
    tillLamports,
    floatLamports,
    secondsSinceLastTillCredit: history.secondsSinceLastPurchaseCredit,
    purchaseCredits: history.purchaseCredits,
    floatFundedCredits: history.floatFundedCredits,
    holdUntilSeconds,
    forceAtSeconds,
  };
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

/**
 * What an unauthenticated caller is told while a hold is running. Fixed words.
 *
 * 🚨 `decideSettlement` WRITES THE HOLD INTO ITS `reason`, as an ISO instant
 * ("Eligible, holding until 2026-09-20T13:16:53.000Z …"). The public view left
 * `holdUntilSeconds` out and then served that sentence, so anyone could read,
 * to the second and hours ahead, which hourly tick sends the till → float
 * settlement. The test that guarded it searched the body for the unix digits
 * only, which the ISO spelling does not contain, so it was green throughout
 * (sweep 2 round 1, server lens).
 *
 * ⛔ DO NOT "FIX" THIS BY DECIDING THE PUBLIC VIEW WITH NO HOLD. The verdict
 * would then read `settle`, with "Settling N purchase(s)", on a tick that
 * settles nothing: a false public status. The verdict stays `holding-off` —
 * that a hold is running is not the secret, WHEN it ends is — and only the
 * sentence changes.
 *
 * Held by `lib/privacy/pool/settleTillRoute.test.ts`, "is byte-identical
 * whatever hold is stored, while a hold is running": two worlds that differ in
 * the stored hold alone must produce the same anonymous body, so a future field
 * that spells the hold some other way turns it red too.
 */
const PUBLIC_HOLDING_REASON =
  'Eligible. A randomised hold is running, so the delay between the last purchase and the ' +
  'settlement is not a constant an observer can subtract. When it ends is not published.';

/** The decision as the public may see it: the same verdict, no drawn instant. */
function publicDecision(d: SettlementDecision): SettlementDecision {
  return d.verdict === 'holding-off' ? { ...d, reason: PUBLIC_HOLDING_REASON } : d;
}

/**
 * The status shape, shared by the public view and the scheduler's.
 *
 * ⚠️ IT DOES NOT REDACT ANYTHING ITSELF. The unauthenticated caller must be
 * handed `publicDecision(d)`, never `d`; the scheduler gets the full reason and
 * `holdUntilSeconds` on purpose, so the operator can read the tick.
 */
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
  const obs = await observe(conn, p, nowSeconds, kv, authorised ? TILL_SCAN_LIMIT : TILL_SCAN_LIMIT_PUBLIC);
  let decision = decideSettlement({ ...obs, nowSeconds, config: cfg });

  if (!authorised) {
    // 🚨 THE DRAWN HOLD IS WITHHELD FROM THE PUBLIC VIEW, ON PURPOSE. Publishing
    // "the settlement fires at 04:17" hands an observer the exact transaction to
    // watch and undoes the randomisation it describes. Balances are already
    // public on chain; the future timestamp is not, and it is the only field
    // here that is genuinely secret. That includes the sentence in
    // `decision.reason`, which spells it out: see `PUBLIC_HOLDING_REASON`.
    return NextResponse.json(
      statusBody(p, [], publicDecision(decision), {
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

  /**
   * The hard maximum deferral (audit v1 F38), drawn the first tick the batch
   * floor is met, like the hold and for the same reason: drawn once, stored,
   * and spread so the forced settlement is not "exactly three days after the
   * floor", a constant an observer could subtract.
   */
  const batchMet =
    decision.purchases >= cfg.minPurchases &&
    (floorMet || decision.verdict === 'holding-off');
  if (kv && batchMet && obs.forceAtSeconds === null) {
    try {
      const forceAt = drawHoldUntil(nowSeconds + maxDeferralSecondsFromEnv(), cfg);
      await kv.set(K.forceAt, forceAt, {
        ex: maxDeferralSecondsFromEnv() + cfg.holdSpreadSeconds + 7 * 86400,
      });
      obs.forceAtSeconds = forceAt;
      decision = decideSettlement({ ...obs, nowSeconds, config: cfg });
    } catch {
      // No deadline this window: the quiet period still decides, as before.
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
        // F62: credits set aside because their payer was funded by the float.
        floatFundedCredits: obs.floatFundedCredits,
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
  } catch (e) {
    return bad(503, `the settlement lock could not be taken: ${(e as Error).message}`);
  }
  /**
   * 🚨 THE TTL IS PART OF THE LOCK (audit v1 F39). `incr` and `expire` are two
   * calls, and a lock whose `expire` failed had no TTL at all: every later tick
   * read "a settlement is already in flight" for ever. So a lock this tick took
   * but could not give a TTL is deleted and the tick stands down; and a tick
   * that finds the lock held re-applies the TTL, so a key already wedged by an
   * earlier failure expires at most one lock lifetime after the next tick.
   */
  if (lock === 1) {
    try {
      await kv.expire(K.lock, LOCK_TTL_SECONDS);
    } catch {
      try {
        await kv.del(K.lock);
      } catch {
        /* the next tick re-applies the TTL below */
      }
      return bad(503, 'the settlement lock could not be given a TTL, so it was released; nothing was sent');
    }
  }
  if (lock !== 1) {
    try {
      await kv.expire(K.lock, LOCK_TTL_SECONDS);
    } catch {
      /* best effort: the next tick tries again */
    }
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
      // The window is over; the next one draws a fresh hold and deadline.
      await kv.del(K.hold);
      await kv.del(K.forceAt);
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
