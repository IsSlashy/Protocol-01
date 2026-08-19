import { NextRequest, NextResponse } from 'next/server';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { sendWithFreshBlockhash } from '@/lib/privacy/pool/sendTx';

import { getStore, rateLimitExceeded } from '@/lib/waitlist/store';

/**
 * fund-ephemeral — pay the rent and fees for one pool job, so the user's wallet
 * never appears on chain.
 *
 * WHY THIS ENDPOINT EXISTS
 * ────────────────────────
 * A pool spend is signed by a fresh ephemeral key, which is good. But an
 * ephemeral key cannot pay a fee from nothing, so something funds it, and on
 * Solana that something is a public `SystemProgram::transfer`. The client also
 * sweeps the residue back when the job ends. Today both ends point at the user's
 * wallet, which brackets the whole operation with its name on it: measured on
 * `verify/fixtures/v3-subscribe`, three RPC calls take a stranger from the
 * subscription to the buyer's wallet. That is the cheapest attack on this
 * protocol and it is not cryptographic.
 *
 * Moving both ends here replaces one wallet-per-user with one treasury shared by
 * every user of this deployment.
 *
 * ⛔ IT DOES NOT CLOSE PROBE P6, AND AN EARLIER VERSION OF THIS HEADER IMPLIED
 * IT DID. P6 fails on ANY named counterparty (`verify/p01-verify.mjs:1219-1237`),
 * so the two edges and the measure of 2 survive this endpoint entirely; only the
 * address inside them changes. The anonymity set of the financial channel goes
 * from "one" to "everyone this endpoint has funded CONCURRENTLY" — which on a
 * single-user deployment is still one, buying log2(1) = zero bits, while
 * `getSignaturesForAddress` on the treasury enumerates every job it ever paid
 * for. Say "the wallet is no longer accountKeys[0]". Do not say "unlinkable".
 *
 * ⛔ WHAT THIS ENDPOINT MUST NEVER DO — AND WHY IT IS SHAPED THIS WAY
 * ──────────────────────────────────────────────────────────────────
 * It never receives proof bytes, and it never signs a pool instruction. That is
 * not tidiness, it is the security boundary. A third party holding verified C1
 * and C3 buffers can already steal the whole note: `retailer` is an unconstrained
 * `AccountInfo` (`subscribe_private_stark.rs:82`), `rate` and `interval_slots`
 * are free arguments bound to no proof, and `claim_period` is permissionless with
 * `retailer` not a signer (`claim_period.rs:47-62`). Set `rate > amount` and the
 * vault is exhausted at slot zero, so one `claim_period` call empties it to an
 * attacker-chosen retailer. There is no `cancel`. So: the ephemeral key stays in
 * the browser (derived by HKDF from the user's own seed), the client uploads its
 * own chunks and calls subscribe itself, and this endpoint only ever moves
 * lamports to an address it is handed.
 *
 * 🚨 THIS IS A FAUCET, AND EVERY FAUCET CAN BE DRAINED
 * ────────────────────────────────────────────────────
 * An attacker who calls this with a fresh keypair each time and never runs the
 * job keeps the lamports. Cost to them: zero. Cost to the treasury: up to the cap
 * per call. The guards below (ticket, cap, empty-target, per-instance budget)
 * raise the effort and bound the damage; none of them makes the endpoint safe to
 * expose without a ticket. Before this is worth anything beyond devnet it needs a
 * real anti-abuse story — payment, proof of work, or an allowlist. That work is
 * NOT done, and the devnet guard below is what keeps the gap from mattering yet.
 */

// Node runtime: this route signs with a secret key and talks to an RPC.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The largest legitimate request, with headroom.
 *
 * Measured job shapes on devnet: a subscribe pre-funds 1,035,725,040 lamports
 * (two proof buffers' rent + the vault's + the nullifier record's + a fee
 * budget) and a shield 1,573,486,080. The cap sits above the larger of the two
 * and below anything that would matter, so a client bug asking for 100 SOL is
 * refused rather than served.
 */
const MAX_LAMPORTS_PER_REQUEST = 2_000_000_000;

/**
 * Ceiling for one server instance's lifetime. Serverless instances are recycled,
 * so this is a blast-radius bound on a single runaway loop, NOT a daily budget —
 * saying otherwise would be the kind of guard that reads stronger than it is.
 *
 * 🚨 AND IT IS WEAKER THAN IT LOOKS, WHICH IS WHY THE KV LIMITER BELOW EXISTS.
 * `spentThisInstance` is a module-scope `let` inside a serverless function: it
 * resets on every cold start, and nothing stops an attacker from arriving on a
 * fresh isolate every time. So this bounds ONE runaway loop within ONE warm
 * instance and bounds the treasury not at all. The only durable bound is the
 * per-IP counter in KV.
 */
const MAX_LAMPORTS_PER_INSTANCE = 20_000_000_000;
let spentThisInstance = 0;

/**
 * Grants allowed per IP per hour.
 *
 * A legitimate user makes ONE call per pool job. Twelve is generous for a person
 * retrying a flaky devnet and small enough that the worst hour costs the
 * treasury a bounded amount rather than its balance. It is not a defence against
 * a distributed caller and is not described as one — see the faucet note above.
 */
const GRANTS_PER_IP_PER_HOUR = 12;

/** Domain separator so this counter can never collide with the waitlist's. */
const RATE_SALT = 'p01:fund-ephemeral:v1';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

/**
 * R, THE TILL — the address buyers pay. Declared here so this deployment can
 * refuse to be the shape that leaked.
 *
 * 🚨 WHAT IT IS FOR, MEASURED RATHER THAN ARGUED.
 *
 * On 2026-08-18 a subscription passed every probe but P11, and the walk was two
 * hops: the spend's fee payer was funded by this funder, and this funder's own
 * history held a transfer SIGNED BY THE BUYER, one second before it financed the
 * depositing ephemeral, for exactly the note's amount. Neither transfer named
 * both ends. The funder standing between them named both.
 *
 * The cure is topological, not cryptographic: the address that COLLECTS money
 * from buyers (R) must never be the address that FUNDS ephemerals (F). They may
 * settle with each other — in batches, on a schedule, never one transfer per
 * purchase, or the clock rejoins what the topology separated.
 *
 * Only the PUBLIC key is configured here, deliberately. This route never needs
 * to spend from the till, and a deployment that cannot spend from an address
 * cannot accidentally make it pay for a job. Declaring it buys exactly one
 * thing: the ability to REFUSE when R and F are the same address, which is a
 * misconfiguration no amount of client-side care can survive.
 */
function tillAddress(): string | null {
  const raw = process.env.P01_TILL_ADDRESS?.trim();
  if (!raw) return null;
  try {
    return new PublicKey(raw).toBase58();
  } catch {
    return null;
  }
}

/**
 * Does any one transaction name both addresses?
 *
 * The same two-call join the client guard and probe P11 use, restated here
 * because this is where an operator can be told BEFORE a buyer is exposed rather
 * than after. A transaction naming two addresses is returned by
 * `getSignaturesForAddress` for each, so intersecting two pages answers it
 * without decoding a single instruction.
 *
 * `null` = could not establish, which readiness reports as a reason rather than
 * as an all-clear.
 */
async function namesBoth(
  connection: Connection,
  a: string,
  b: string,
  limit = 1000,
): Promise<boolean | null> {
  try {
    const [left, right] = await Promise.all([
      connection.getSignaturesForAddress(new PublicKey(a), { limit }),
      connection.getSignaturesForAddress(new PublicKey(b), { limit }),
    ]);
    const seen = new Set(left.map((x) => x.signature));
    for (const x of right) if (seen.has(x.signature)) return true;
    if (left.length >= limit || right.length >= limit) return null;
    return false;
  } catch {
    return null;
  }
}

/** First hop of the forwarding chain; falls back to a stable sentinel. Same
 *  shape as the waitlist route's, deliberately — one definition of "who is
 *  calling" across every rate-limited endpoint. */
function clientIp(req: NextRequest): string {
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return 'unknown';
}

function bad(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

/**
 * Who the funder is, without spending anything.
 *
 * WHY THIS EXISTS. `recoverFloat.ts` has to decide where a stranded
 * ephemeral's residue may go, and the only safe rule is a fixed two-element
 * allowlist: the user's wallet, or this deployment's funder. Without the
 * funder's address it must refuse every ephemeral it cannot attribute, which
 * turns a recovery into a deferral. Until now the address appeared ONLY in a
 * successful POST body (`sweepTo` below) — that is, only after money had
 * already been spent, and never for the crashed job that needs recovering.
 *
 * Deliberately NOT ticket-gated and deliberately NOT a `NEXT_PUBLIC_` build
 * value. Not gated, because the funder's address is public the instant it pays
 * for anything and every grant already hands it back; gating it would protect
 * nothing and would break recovery for a user whose ticket the operator has
 * since rotated. Not a build value, because `NEXT_PUBLIC_` is inlined at build
 * time — the lesson `ephemeralFunder.ts` records — so a deployment that turned
 * its funder on without redeploying would serve a client that cannot name it.
 *
 * It returns the address, and — with `?readiness=1` — whether this deployment
 * would actually serve. Never a ticket, never a secret.
 *
 * 🚨 WHY READINESS IS WORTH AN ENDPOINT
 * ─────────────────────────────────────
 * Every way this funder fails is SILENT AT THE POINT OF USE. The client catches
 * the failure, falls back to the user's wallet, and the operation succeeds —
 * with the wallet on chain, which is the one outcome the funder exists to
 * prevent. There are three independent ways to be switched off and none of them
 * announces itself:
 *
 *   1. `NEXT_PUBLIC_P01_FUNDER_TICKET` is inlined at BUILD time, so a
 *      deployment that set it without redeploying serves a bundle where
 *      `funderConfigured()` is false and the endpoint is never called at all.
 *   2. No KV backend means no durable rate limiter, and the POST below refuses
 *      rather than run as an unmetered faucet.
 *   3. An empty or drained funder key fails at `sendRawTransaction`.
 *
 * Any of those turns a demo into a public wallet transfer, discovered by
 * whoever opens an explorer afterwards. This makes them answerable in one
 * request, BEFORE it matters.
 *
 * `ready` is the conjunction, so the honest answer is one boolean and the
 * reasons are there to act on. It deliberately does NOT check the browser
 * bundle's ticket — no server can see what a past build inlined — so a `ready:
 * true` deployment can still be one that never calls this endpoint. That gap is
 * named in `blindSpot` rather than papered over.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.P01_FUNDER_SECRET_KEY;
  if (!secret) return NextResponse.json({ ok: true, configured: false, funder: null });

  let funder: Keypair;
  try {
    funder = Keypair.fromSecretKey(bs58.decode(secret));
  } catch {
    // A misconfigured key is "no usable funder", and saying so is better than a
    // 500: the caller's next move (refuse to attribute a sweep) is the same.
    return NextResponse.json({ ok: true, configured: false, funder: null });
  }

  const base = {
    ok: true,
    configured: true,
    funder: funder.publicKey.toBase58(),
    // Public by construction and useful to every caller: the verify harness can
    // assert R != F without being handed the operator's config out of band.
    till: tillAddress(),
  };
  if (request.nextUrl.searchParams.get('readiness') !== '1') {
    return NextResponse.json(base);
  }

  const reasons: string[] = [];

  // ── The trap that only shows up in the verify report, after the demo ─────
  //
  // If the address that DEPOSITS the notes is this same funder, then the
  // deposit side and the spend side of every subscription share one party, and
  // probe P8 correctly reports "one treasury behind both ends". That is the
  // probe working, and it is fatal to the claim being demonstrated — the whole
  // point of a third-party depositor is that the two ends do not meet.
  //
  // It is invisible until someone runs the tool, which is usually after the
  // transaction exists. Pass `?depositor=<pubkey>` and it is answerable first.
  const depositor = request.nextUrl.searchParams.get('depositor');
  if (depositor) {
    if (depositor === funder.publicKey.toBase58()) {
      reasons.push(
        'The depositor you named IS this funder. Every subscription would then have one ' +
          'treasury on both ends and probe P8 would report exactly that. Deposit the notes from ' +
          'a different key.',
      );
    }
  }

  // ── R versus F, the configuration that decides whether any of this works ──
  //
  // Checked here because every other place it could be checked is too late: the
  // client sees it only while a buyer is waiting, and the probe sees it only
  // after the transaction exists. This is the one surface an operator can read
  // before a demo.
  const till = tillAddress();
  if (!till) {
    reasons.push(
      'P01_TILL_ADDRESS is unset, so this deployment cannot tell whether the address buyers ' +
        'pay is the same one that funds spends. That identity is the leak measured on ' +
        '2026-08-18: two transfers, neither naming both ends, joined by a funder whose own ' +
        'history names both.',
    );
  } else if (till === funder.publicKey.toBase58()) {
    reasons.push(
      'P01_TILL_ADDRESS IS this funder. Every buyer who pays it is then one transaction away ' +
        'from the address that funds their own subscription, so probe P11 walks buyer -> till ' +
        '-> ephemeral -> spend in two hops. Use a separate key for the till and settle between ' +
        'them in batches, never per purchase.',
    );
  }
  if (!process.env.P01_FUNDER_TICKET) {
    reasons.push('P01_FUNDER_TICKET is unset: the POST refuses to run as an open faucet.');
  }
  const limiter = getStore() !== null;
  if (!limiter) {
    reasons.push(
      'No durable KV rate limiter is reachable, so the POST fails closed. Provision ' +
        'KV_REST_API_URL + KV_REST_API_TOKEN (or the UPSTASH_ pair) or the funder will never serve.',
    );
  }

  let balance: number | null = null;
  let cluster: 'devnet' | 'other' | 'unreachable' = 'unreachable';
  try {
    const connection = new Connection(
      process.env.P01_FUNDER_RPC ?? 'https://api.devnet.solana.com',
      'confirmed',
    );
    cluster = (await connection.getGenesisHash()) === DEVNET_GENESIS ? 'devnet' : 'other';
    balance = await connection.getBalance(funder.publicKey, 'confirmed');
    // Distinct addresses are necessary and not sufficient: R and F are also
    // separate if R pays F once per purchase, which is the same leak wearing a
    // second address. A transaction naming both is proof that has already
    // happened. Only reachable when the RPC answered — an unreachable chain is
    // already a reason above.
    if (till && till !== funder.publicKey.toBase58()) {
      const joined = await namesBoth(connection, funder.publicKey.toBase58(), till);
      if (joined === true) {
        reasons.push(
          'A transaction names BOTH the till and this funder. They are separate addresses that ' +
            'have paid each other, which is the per-purchase settlement this split exists to ' +
            'stop: an auditor reads the funder history and lands on the till, then on its ' +
            'buyers. Settle in batches, on a schedule unrelated to any single purchase.',
        );
      } else if (joined === null) {
        reasons.push(
          'Could not establish whether any transaction names both the till and this funder — a ' +
            'signature page filled or the read failed. An absence read off a truncated history ' +
            'is not an absence.',
        );
      }
    }
  } catch (e) {
    reasons.push(`The configured RPC could not be reached: ${(e as Error).message}`);
  }
  if (cluster === 'other') {
    reasons.push('The configured RPC is not devnet, and this funder is devnet-only.');
  }
  // One grant at the cap, plus fees. Below this the next request can fail
  // mid-flight, which is the worst moment to discover it.
  if (balance !== null && balance < MAX_LAMPORTS_PER_REQUEST) {
    reasons.push(
      `The funder holds ${balance} lamports, less than one capped grant ` +
        `(${MAX_LAMPORTS_PER_REQUEST}). A job larger than the balance fails after the client has ` +
        'already committed to it.',
    );
  }

  return NextResponse.json({
    ...base,
    readiness: {
      ready: reasons.length === 0,
      reasons,
      limiter,
      balance,
      cluster,
      spentThisInstance,
      blindSpot:
        'This cannot see whether the deployed BROWSER BUNDLE carries ' +
        'NEXT_PUBLIC_P01_FUNDER_TICKET — that value is inlined at build time. A ready deployment ' +
        'serving a stale bundle never calls this endpoint at all, and every job silently falls ' +
        'back to the wallet. Confirm on a real run that the result says the funder paid.',
    },
  });
}

export async function POST(request: NextRequest) {
  const ticket = process.env.P01_FUNDER_TICKET;
  const secret = process.env.P01_FUNDER_SECRET_KEY;

  // Unconfigured is a distinct answer from refused. A deployment that simply has
  // no funder should say so, or the client cannot tell "turned off here" from
  // "your request was rejected" and will show the user the wrong thing.
  if (!secret) return bad(503, 'no funder configured on this deployment');
  if (!ticket) return bad(503, 'no funder ticket configured; refusing to run as an open faucet');

  if (request.headers.get('x-p01-funder-ticket') !== ticket) {
    return bad(401, 'bad or missing funder ticket');
  }

  let body: { ephemeralPubkey?: unknown; lamports?: unknown };
  try {
    body = await request.json();
  } catch {
    return bad(400, 'body must be JSON');
  }

  let target: PublicKey;
  try {
    target = new PublicKey(String(body.ephemeralPubkey ?? ''));
  } catch {
    return bad(400, 'ephemeralPubkey is not a valid public key');
  }

  const lamports = Number(body.lamports);
  if (!Number.isSafeInteger(lamports) || lamports <= 0) {
    return bad(400, 'lamports must be a positive integer');
  }
  if (lamports > MAX_LAMPORTS_PER_REQUEST) {
    return bad(400, 'lamports exceeds the per-request cap', { cap: MAX_LAMPORTS_PER_REQUEST });
  }
  if (spentThisInstance + lamports > MAX_LAMPORTS_PER_INSTANCE) {
    return bad(429, 'this instance has reached its funding ceiling');
  }

  // ── The only durable bound on this faucet ────────────────────────────────
  //
  // FAIL CLOSED, DELIBERATELY. Without a KV backend there is no counter that
  // survives a cold start, and this endpoint signs transfers out of a treasury
  // with a public ticket. An unmetered faucet that spends is worse than one
  // that refuses, and the refusal is not silent: the client reports
  // `funderFallbackReason` and falls back to the wallet, which is the honest
  // outcome — the user pays publicly and is TOLD they did.
  //
  // This is also the answer to "is KV configured in the deployment that runs
  // the funder?" — the endpoint no longer has to know. If it is not, the funder
  // does not serve, and turning it on is a deliberate operator act rather than
  // an assumption this file makes on their behalf.
  const kv = getStore();
  if (!kv) {
    return bad(503, 'no durable rate limiter is configured; refusing to run as an unmetered faucet');
  }
  try {
    if (await rateLimitExceeded(kv, clientIp(request), RATE_SALT, GRANTS_PER_IP_PER_HOUR)) {
      return bad(429, 'too many funding requests from this address in the last hour', {
        limit: GRANTS_PER_IP_PER_HOUR,
      });
    }
  } catch (e) {
    // A limiter that errors is a limiter that is not limiting. Same posture as
    // an absent one: refuse. Serving here would make every KV outage a window
    // in which the treasury is unbounded.
    return bad(503, `the rate limiter could not be read: ${(e as Error).message}`);
  }

  const rpc = process.env.P01_FUNDER_RPC ?? 'https://api.devnet.solana.com';
  const connection = new Connection(rpc, 'confirmed');

  // Devnet guard, checked against the chain rather than against the URL string.
  // An env var pointing at a mainnet RPC named "devnet" would otherwise spend
  // real money, and this endpoint has no anti-abuse story that survives that.
  const genesis = await connection.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) {
    return bad(403, 'this funder is devnet-only and the configured RPC is not devnet', { genesis });
  }

  let funder: Keypair;
  try {
    funder = Keypair.fromSecretKey(bs58.decode(secret));
  } catch {
    return bad(503, 'funder secret key is not valid base58');
  }
  if (target.equals(funder.publicKey)) return bad(400, 'refusing to fund the funder');

  // ── The one misconfiguration no client can survive ────────────────────────
  //
  // If the till and the float are the same address, then every buyer who paid
  // for their note is one transaction away from the address funding the spend,
  // and the subscription is walkable in two hops no matter how careful the
  // browser was. Serving here would spend treasury money to produce a result
  // that is worse than not running at all — it looks private and is not.
  //
  // O(1) and exact: no RPC, no page to truncate, nothing to get wrong. The
  // deeper question (do they settle per purchase?) needs the chain and lives in
  // the readiness report above, where an operator reads it before a demo rather
  // than a buyer discovers it afterwards.
  const till = tillAddress();
  if (till && till === funder.publicKey.toBase58()) {
    return bad(
      503,
      'this deployment is misconfigured: the till (P01_TILL_ADDRESS) is the funder, so paying ' +
        'for a note and paying for the subscription would name the same address. Refusing ' +
        'rather than producing a subscription that looks private and is not.',
    );
  }

  // The target must be empty. A fresh ephemeral always is, so this costs a
  // legitimate caller nothing — and it stops the endpoint being used to top up
  // an address that already holds a balance. It does NOT stop an attacker
  // generating unlimited fresh keys; see the faucet note in the header.
  const existing = await connection.getBalance(target, 'confirmed');
  if (existing > 0) {
    return bad(409, 'target already holds lamports; this endpoint only funds a fresh ephemeral', {
      balance: existing,
    });
  }

  // 🚨 THIS IS THE SEND THAT FAILED WITH "Blockhash not found" ON 2026-08-19,
  // and it is the FIRST on-chain step of a deposit — so the whole flow died
  // before it began, with an empty log and a message that reads like a program
  // bug. It is not: a `confirmed` blockhash is unknown to the sibling node that
  // runs preflight behind a load balancer. See `sendWithFreshBlockhash`.
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: target, lamports }),
  );

  let signature: string;
  let blockhash: string;
  let lastValidBlockHeight: number;
  try {
    ({ signature, blockhash, lastValidBlockHeight } = await sendWithFreshBlockhash(
      connection,
      tx,
      (t) => {
        t.sign(funder);
        return t;
      },
      funder.publicKey,
    ));
  } catch (e) {
    return bad(502, `funding transaction was rejected: ${(e as Error).message}`);
  }

  const conf = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (conf.value.err) {
    return bad(502, `funding transaction failed: ${JSON.stringify(conf.value.err)}`);
  }

  // Counted only after confirmation, so a rejected send does not eat the budget.
  spentThisInstance += lamports;

  return NextResponse.json({
    ok: true,
    signature,
    lamports,
    funder: funder.publicKey.toBase58(),
    // The client shows this to the user. The point of the endpoint is that the
    // sweep goes back HERE and not to their wallet, so they should be able to
    // see where their residue is going before they start.
    sweepTo: funder.publicKey.toBase58(),
  });
}
