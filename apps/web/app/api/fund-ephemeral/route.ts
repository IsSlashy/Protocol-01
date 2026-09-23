import { NextRequest, NextResponse } from 'next/server';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { sendWithFreshBlockhash } from '@/lib/privacy/pool/sendTx';
import { sharedTransaction } from '@/lib/privacy/coNaming';
import { purchasesCarried } from '@/lib/privacy/pool/settlementPolicy';

import { getStore, rateLimitExceeded } from '@/lib/waitlist/store';
import { clientIp } from '@/lib/net/clientIp';

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
 * per call. The guards below (ticket, cap, empty-target, no second grant to a
 * key whose first one never came back, a per-IP and a global hourly lamport
 * budget held in KV, and the per-instance ceiling) raise the effort and bound
 * the damage to the global budget per hour; none of them makes the endpoint safe to
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

/**
 * # 🚨 THE BOUND IS IN LAMPORTS, AND IT IS HELD IN KV (audit v1 F37)
 *
 * The grant count above bounded CALLS, not money: twelve capped grants per IP
 * per hour is 24 SOL per IP per hour, and the only lamport bound
 * (`spentThisInstance`) resets on every cold start. Measured by the audit probe
 * `r2-server/probes/p1-fund-ephemeral.probe.test.ts`. Two budgets now sit on
 * top of the count, both counted in KV so no instance and no restart resets
 * them, and both counted BEFORE the transfer is signed:
 *
 *   - per IP: 3 SOL = 12 units of 0.25 SOL per hour. WHICH JOBS ASK HERE: a
 *     shield carries value, so it goes through the relay and never asks this
 *     route (`ephemeralFunder.ts`, `valueLamports > 0`). The jobs that do ask
 *     are the DIRECT WITHDRAWAL (`unshieldFromPool`: valueLamports 0,
 *     neverExposeWallet; 1,030,290,360 measured, 1,400,000,000 in the heavy
 *     fixture) and the SUBSCRIBE (1,035,725,040 measured). Booked in units:
 *     5, 6 and 5. The heaviest withdrawal plus a subscribe is 11 units and
 *     fits one hour.
 *   - global: every caller together, per hour (10 SOL = 40 units by default).
 *     An attacker with many IPs drains at most this, whatever the per-IP
 *     bound says.
 *
 * ⚠️ WHAT AN HONEST USER MEETS, STATED:
 *   - Two withdrawals and a subscribe from one IP in one hour is 5 + 5 + 5 =
 *     15 units > 12, so the third job is refused with FUNDER_IP_BUDGET, and it
 *     fails outright: neverExposeWallet leaves no wallet fallback. It works
 *     again in the next clock hour.
 *   - The bucket is a UTC CLOCK hour (`rateLimitExceeded`,
 *     `lib/waitlist/store.ts`), not a rolling one, so a caller gets up to twice
 *     the budget across a :00 boundary (6 SOL per IP within minutes).
 *   - A many-IP caller that exhausts the global budget refuses EVERY honest
 *     withdrawal and subscribe (FUNDER_GLOBAL_BUDGET) for the rest of that
 *     clock hour. That is the price of bounding the drain; the operator can
 *     raise the global budget.
 * All three are pinned in `__tests__/api/closeV1L1FundEphemeral.test.ts`.
 *
 * `KvLike` offers `incr` and no `incrby`, so a grant of L lamports takes
 * ceil(L / unit) increments of the hourly counter, and it is served only if
 * EVERY increment it made read at or under the limit. The increments of the
 * requests that are served are distinct values at or under the limit, so the
 * units served in one hour never exceed it, however the requests interleave.
 * A refused request keeps the units it took: fail closed, and an over-budget
 * caller only burns its own bucket (the per-IP check runs before the global
 * one, so a caller over its own budget touches nobody else's).
 *
 * ⚠️ WHAT THIS DOES NOT DO. It bounds the drain, it does not stop it: the
 * ticket is in the bundle, so the global budget per hour is still what a
 * determined caller with many addresses takes. It is sized to the traffic this
 * deployment has (a few deposits a day) and overridable upward by the
 * operator, never downward to zero.
 */
const BUDGET_UNIT_LAMPORTS = 250_000_000;
const PER_IP_LAMPORTS_PER_HOUR = 3_000_000_000;
const GLOBAL_LAMPORTS_PER_HOUR_DEFAULT = 10_000_000_000;
const BUDGET_IP_SALT = 'p01:fund-ephemeral:lamports:ip:v1';
const BUDGET_GLOBAL_SALT = 'p01:fund-ephemeral:lamports:global:v1';
/** The global bucket is one bucket; the name is fixed so every instance shares it. */
const BUDGET_GLOBAL_BUCKET = 'all-callers';

/** The global budget in lamports: the operator may raise it; 0 or garbage is the default, never off. */
function globalLamportsPerHour(): number {
  const raw = Number(process.env.P01_FUNDER_GLOBAL_LAMPORTS_PER_HOUR ?? '');
  return Number.isSafeInteger(raw) && raw >= BUDGET_UNIT_LAMPORTS ? raw : GLOBAL_LAMPORTS_PER_HOUR_DEFAULT;
}

/**
 * Take `units` from one hourly bucket. True when every increment stayed within
 * `limitUnits`, i.e. when this grant fits. Throws what the store throws.
 */
async function takeUnits(
  kv: NonNullable<ReturnType<typeof getStore>>,
  bucket: string,
  salt: string,
  units: number,
  limitUnits: number,
): Promise<boolean> {
  const over = await Promise.all(
    Array.from({ length: units }, () => rateLimitExceeded(kv, bucket, salt, limitUnits)),
  );
  return over.every((o) => !o);
}

/**
 * Has an earlier grant from this float to `target` left without coming back?
 *
 * The empty-target rule refuses a key that still HOLDS lamports. A key that
 * received a grant and forwarded it elsewhere is empty again, so that rule
 * alone funds it a second time. An honest key ends its job with a sweep back to
 * the float (the job's residue, or a Recover), so the newest transaction of an
 * honest key that was ever granted is that sweep.
 *
 *   'fresh'    no history at all, or a complete history with no grant in it;
 *   'swept'    the newest transaction moved lamports from `target` to the float;
 *   'unswept'  a grant from the float is in the history, and the newest
 *              transaction is not a sweep back to it;
 *   'unknown'  a transaction could not be read, or the history is longer than
 *              one page and no grant was found in it. Refused, never assumed.
 *
 * ⚠️ A NAMED LIMIT. This refuses the reuse of ONE key; an attacker generates a
 * fresh key per call for free. The lamport budgets are what bound the drain.
 */
const GRANT_HISTORY_PAGE = 25;
async function grantState(
  connection: Connection,
  target: PublicKey,
  float: string,
): Promise<'fresh' | 'swept' | 'unswept' | 'unknown'> {
  const t = target.toBase58();
  const sigs = await connection.getSignaturesForAddress(target, { limit: GRANT_HISTORY_PAGE });
  if (sigs.length === 0) return 'fresh';
  const deltaOf = async (signature: string) => {
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (!tx?.meta) return null;
    const keys = tx.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
    const at = (k: string) => {
      const i = keys.indexOf(k);
      return i < 0 ? 0 : (tx.meta!.postBalances[i] ?? 0) - (tx.meta!.preBalances[i] ?? 0);
    };
    return { target: at(t), float: at(float) };
  };
  const newest = await deltaOf(sigs[0].signature);
  if (!newest) return 'unknown';
  if (newest.target < 0 && newest.float > 0) return 'swept';
  for (const s of sigs) {
    const d = s.signature === sigs[0].signature ? newest : await deltaOf(s.signature);
    if (!d) return 'unknown';
    if (d.float < 0 && d.target > 0) return 'unswept';
  }
  return sigs.length < GRANT_HISTORY_PAGE ? 'fresh' : 'unknown';
}

/**
 * Every operator address this route knows, which the float must never pay.
 *
 * 🚨 audit v1 F62: a grant to the TILL is counted by the settler as purchases
 * (it reads the till's balance), so one call inflated the settlement floor with
 * the float's own lamports and let a batch of one real purchase settle as
 * three. The fee wallet and the float itself were already refused; the till
 * and the restock wallet join them. `P01_TILL_SECRET_KEY` is NOT read here: it
 * is confined to the settler (`topologyInvariants.test.ts`), and the declared
 * till address is the one buyers pay.
 *
 * ⚠️ THIS REFUSES THE DIRECT GRANT ONLY. A grant to a fresh key that then pays
 * the till itself is the same harm one hop later; the settler sets such
 * credits aside (`readTillHistory` in `/api/settle-till`), and its one-hop
 * limit and the bound on what gets past it are stated there.
 */
function operatorAddresses(funder: string): Map<string, string> {
  const out = new Map<string, string>([[funder, 'the float (P01_FUNDER_SECRET_KEY)']]);
  const add = (raw: string | undefined, label: string) => {
    const s = raw?.trim();
    if (!s) return;
    try {
      out.set(new PublicKey(s).toBase58(), label);
    } catch {
      /* unparseable: the readiness answer names it */
    }
  };
  add(process.env.P01_TILL_ADDRESS, 'the till (P01_TILL_ADDRESS)');
  add(process.env.P01_FEE_WALLET, 'the fee wallet (P01_FEE_WALLET)');
  add(process.env.P01_RESTOCK_WALLET_ADDRESS, 'the restock wallet (P01_RESTOCK_WALLET_ADDRESS)');
  return out;
}

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

/**
 * [flow-speed X6 2026-09-23] The last DEVNET answer the POST's genesis read got,
 * and for which exact RPC string (`P01_FUNDER_RPC ?? default`, the one the
 * Connection is built from). One public constant per instance, nothing from any
 * request: no IP, no ticket, no target.
 *
 * Only a devnet answer is kept. A mainnet answer (the 403 and its `{ genesis }`)
 * and a failed read (the fixed-words 502) are never kept, so each comes from a
 * live read every time. GET readiness does not use this: an operator's
 * diagnostic probes the chain live.
 *
 * ⚠️ THE RESIDUAL, NAMED. The guard is now "once per instance per URL per ten
 * minutes", not once per grant. An env change redeploys, so a changed URL is
 * read again; what is trusted for up to the TTL is a URL that stays the same
 * while the cluster behind it changes (an operator's own proxy or DNS name
 * repointed from devnet to mainnet without a redeploy). Default and Helius
 * devnet hosts cannot be anything but devnet. Saves one round trip on
 * `P01_FUNDER_RPC` for grants that follow each other on a warm instance, and
 * nothing on a cold one: never quote it as a per-flow saving.
 * Pinned by `__tests__/api/fundEphemeralGrantPath.test.ts`, "[X6]".
 */
const DEVNET_ANSWER_TTL_MS = 10 * 60_000;
let devnetAnswer: { rpc: string; at: number } | null = null;

function devnetAnswerHolds(rpc: string): boolean {
  return devnetAnswer !== null && devnetAnswer.rpc === rpc && Date.now() - devnetAnswer.at < DEVNET_ANSWER_TTL_MS;
}

/**
 * [flow-speed X7 2026-09-23] How the grant's confirmation is waited for.
 * `getSignatureStatuses([signature])` every 400 ms, the first at +400 ms; the
 * block height at 'confirmed', at most once a second, only while the status is
 * not yet 'confirmed' or 'finalized'. The wall-clock bound is a backstop for a
 * dead RPC and is never shorter than a blockhash's longest life.
 */
const GRANT_STATUS_POLL_MS = 400;
const GRANT_HEIGHT_EVERY_MS = 1_000;
const GRANT_CONFIRM_WALL_MS = 90_000;

/**
 * [flow-speed X7 2026-09-23] Wait for the grant at 'confirmed', by polling.
 *
 * WHY. `connection.confirmTransaction` subscribes over a WebSocket, and a
 * serverless instance can miss the notice; web3.js then waits for the block
 * height to pass the blockhash's last valid height (up to ~20 s at 165 ms
 * slots), or the platform kills the function first. The same two HTTP reads
 * web3.js itself makes are used instead, on the SAME connection, so no new
 * party and no new method: `getSignatureStatuses` (the route's catch already
 * sent it) and `getBlockHeight`.
 *
 * THE OUTCOMES DO NOT MOVE, and each is a fund-safety rule:
 *   - only 'confirmed' or 'finalized' ends the wait; 'processed', with or
 *     without an err, keeps polling (a dropped fork must not serve a grant);
 *   - `known: false` ("could not be confirmed") is answered only after the
 *     block height was SEEN past `lastValidBlockHeight`, at 'confirmed', and then
 *     ONE more status read: the first transfer can no longer land, so a retry
 *     cannot fund the same key twice; and one that landed in the last valid
 *     slot is still served rather than stranded;
 *   - a failed or throttled read is never taken for expiry: polling goes on;
 *   - no read's error escapes or is kept: web3.js words them with the
 *     signature in them ("NO CHAIN ERROR LEAVES THIS HANDLER" above).
 * The wall-clock backstop (a dead RPC) also ends with one more status read.
 */
async function awaitGrantConfirmation(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
): Promise<{ known: true; err: unknown } | { known: false }> {
  const final = (status: { confirmationStatus?: string; err: unknown } | null) =>
    status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
      ? { known: true as const, err: status.err ?? null }
      : null;
  const readStatus = async () => {
    try {
      return (await connection.getSignatureStatuses([signature])).value[0] ?? null;
    } catch {
      return null; // names the signature; goes nowhere, and is not expiry
    }
  };
  const startedAt = Date.now();
  let heightReadAt = Number.NEGATIVE_INFINITY;
  for (;;) {
    await new Promise((r) => setTimeout(r, GRANT_STATUS_POLL_MS));
    const seen = final(await readStatus());
    if (seen) return seen;
    let expired = false;
    const now = Date.now();
    if (now - heightReadAt >= GRANT_HEIGHT_EVERY_MS) {
      heightReadAt = now;
      try {
        expired = (await connection.getBlockHeight('confirmed')) > lastValidBlockHeight;
      } catch {
        // Unread is not expired: keep polling. The error names nothing kept.
      }
    }
    if (expired || Date.now() - startedAt >= GRANT_CONFIRM_WALL_MS) {
      return final(await readStatus()) ?? { known: false };
    }
  }
}

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
 * The operator's 1% sink, as configured. `null` when unset or unparseable.
 *
 * ⛔ IT IS A SINK, AND THIS ROUTE IS WHERE THAT WOULD BE VIOLATED FIRST.
 *
 * The fee rides inside the transaction the buyer signs, so this address is
 * CO-NAMED WITH EVERY BUYER: `getSignaturesForAddress` on it enumerates every
 * customer this deployment has served. That is survivable only while nothing it
 * touches leads onward. The moment the float funds it — or it funds an
 * ephemeral — probe P11 walks fee wallet -> ephemeral -> subscription and lands
 * back on a buyer, and the R != F split is undone by an accounting convenience
 * that nobody would think of as a privacy change.
 *
 * So the POST below refuses to fund it, and readiness refuses a deployment where
 * it collides with the float or the till.
 */
function feeWalletAddress(): string | null {
  const raw = process.env.P01_FEE_WALLET?.trim();
  if (!raw) return null;
  try {
    return new PublicKey(raw).toBase58();
  } catch {
    return null;
  }
}

/**
 * How many purchases a till-to-float settlement carried, from its amount.
 *
 * One purchase pays the till the note's VALUE — the denomination plus the
 * protocol's own 0.3% — which for the 1 SOL pool is 1,003,000,000 lamports
 * (`lib/privacy/pool/shieldEphemeral.ts:293`). A note-in exchange pays the
 * denomination MINUS the 0.5 percent withdrawal fee, 995,000,000, and the
 * amount does not say which kind it carried. A settlement of k purchases
 * therefore moves about k credits of one size or the other, less the fee it
 * pays itself.
 *
 * ⚠️ ROUNDED, AND DELIBERATELY GENEROUS AT THE BOUNDARY. The point is to
 * separate one from more-than-one, not to audit the operator's arithmetic:
 * anything at least one and a half notes wide counts as more than one, so a
 * batch that also swept some dust is not called a violation. The arithmetic
 * is `purchasesCarried` in `settlementPolicy.ts`, the same module that counts
 * the till for the settler, so the two cannot disagree about what a purchase
 * is worth.
 *
 * `null` means the transaction could not be read, which the caller reports as
 * unknown rather than as clean.
 */
async function settlementPurchaseCount(
  connection: Connection,
  signature: string,
  till: string,
): Promise<number | null> {
  try {
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (!tx?.meta) return null;
    const keys = tx.transaction.message
      .getAccountKeys()
      .staticAccountKeys.map((k) => k.toBase58());
    const i = keys.indexOf(till);
    if (i < 0) return null;
    const moved = Math.abs((tx.meta.postBalances[i] ?? 0) - (tx.meta.preBalances[i] ?? 0));
    return purchasesCarried(moved);
  } catch {
    return null;
  }
}
function bad(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

/** The one answer to a chain READ that failed before anything was sent. Fixed
 *  words: the RPC's own text names the account it was asked about. */
const RPC_UNREADABLE = 'the configured RPC could not be read; nothing was sent';

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
  // The fee sink, on the same readiness surface as the till and for the same
  // reason: an operator can read this before a demo, whereas the probe reads it
  // only after the transactions exist.
  const feeWallet = feeWalletAddress();
  const rawFeeWallet = process.env.P01_FEE_WALLET?.trim();
  if (!rawFeeWallet) {
    reasons.push(
      'P01_FEE_WALLET is unset, so the 1% has nowhere to go and a relayed deposit will refuse ' +
        'before the buyer signs.',
    );
  } else if (!feeWallet) {
    reasons.push('P01_FEE_WALLET is not a public key.');
  } else if (feeWallet === funder.publicKey.toBase58()) {
    reasons.push(
      'P01_FEE_WALLET IS this funder. The fee rides inside the transaction the buyer signs, so ' +
        'this puts the float in a buyer-signed transaction — the 2026-08-18 walk with its middle ' +
        'step deleted.',
    );
  } else if (till && feeWallet === till) {
    reasons.push(
      'P01_FEE_WALLET is the same address as the till. They share one account index, so the relay ' +
        'reads value + fee as the payment and the fee is never collected — with no symptom.',
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
      // 🚨 THE EDGE IS REQUIRED, SO ITS EXISTENCE IS NOT THE QUESTION.
      //
      // This used to report ANY transaction naming both as the per-purchase
      // settlement — but settling R into F is the ONLY way the float is ever
      // replenished, so a compliant batch names both too. It fired on the right
      // behaviour, never cleared (the transaction stays in both histories), and
      // told the operator to settle in batches, which is the act that trips it.
      // MEASURED 2026-08-22: one settlement put this endpoint into ready:false
      // permanently, with advice that causes the condition it reports.
      //
      // What separates the two is the AMOUNT. A settlement carrying one
      // purchase moves about one note's value; a batch of k moves about k of
      // them. k = 1 identifies that buyer exactly and is the only case this can
      // call wrong with certainty — so it is the only case that blocks. Larger
      // k is reported, not judged: this file has no business inventing a
      // security parameter, and the honest number is the one it prints.
      const shared = await sharedTransaction(connection, funder.publicKey.toBase58(), till);
      if (shared.signature) {
        const purchases = await settlementPurchaseCount(connection, shared.signature, till);
        if (purchases === 1) {
          reasons.push(
            `The till settled into this funder carrying ONE purchase (${shared.signature}). ` +
              'That transfer names both addresses, so an auditor reads the funder history, ' +
              'lands on the till, and the till names exactly one buyer — that buyer. A set of ' +
              'one is not a set. Settle several purchases at once, at a moment unrelated to ' +
              'any of them.',
          );
        } else if (purchases === null) {
          reasons.push(
            `The till and this funder share a transaction (${shared.signature}) whose amount ` +
              'could not be read, so how many purchases it carried is unknown. Unknown is ' +
              'not clean.',
          );
        }
      } else if (!shared.complete) {
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
  } catch {
    // A limiter that errors is a limiter that is not limiting. Same posture as
    // an absent one: refuse. Serving here would make every KV outage a window
    // in which the treasury is unbounded.
    //
    // ⛔ AND THE REFUSAL CARRIES NO TEXT FROM THE STORE. The client shows this
    // error on screen (`The funder refused: ${body.error}`,
    // lib/privacy/pool/ephemeralFunder.ts), and the store words a failure as
    // `${error}, command was: ${JSON.stringify(commands)}` — with
    // auto-pipelining, the commands of every other request batched into the
    // same one: another route's claim code, a payment signature, another
    // caller's limiter bucket. Fixed words, whatever failed. Pinned by
    // `__tests__/api/fund-ephemeral.test.ts` "says the limiter failed WITHOUT
    // passing on what the store said", which runs the same failure with two
    // different batches and requires one answer.
    return bad(503, 'the rate limiter could not be read');
  }

  const rpc = process.env.P01_FUNDER_RPC ?? 'https://api.devnet.solana.com';
  const connection = new Connection(rpc, 'confirmed');

  // Devnet guard, checked against the chain rather than against the URL string.
  // An env var pointing at a mainnet RPC named "devnet" would otherwise spend
  // real money, and this endpoint has no anti-abuse story that survives that.
  //
  // ⛔ NO CHAIN ERROR LEAVES THIS HANDLER, HERE OR BELOW. What leaves a handler
  // is logged by the framework (`console.error(err)`), and web3.js words its
  // failures with the identifier in them: `failed to get balance of account
  // <ephemeral>`, `Signature <funding signature> has expired`. That line sits
  // in the runtime log beside the platform's record of this request, which
  // holds the caller's IP and the second — an exact join from an IP to the key
  // that signs a spend. So each chain call is caught, the answer is fixed
  // words, and the error's text goes nowhere. Pinned by
  // `__tests__/api/fundEphemeralChainErrors.test.ts`.
  //
  // [flow-speed X6 2026-09-23] Read once per instance and RPC URL, for
  // DEVNET_ANSWER_TTL_MS; see `devnetAnswer`. A miss reads live, exactly as
  // before, with the same fixed words and the same 403.
  if (!devnetAnswerHolds(rpc)) {
    let genesis: string;
    try {
      genesis = await connection.getGenesisHash();
    } catch {
      return bad(502, RPC_UNREADABLE);
    }
    if (genesis !== DEVNET_GENESIS) {
      return bad(403, 'this funder is devnet-only and the configured RPC is not devnet', { genesis });
    }
    devnetAnswer = { rpc, at: Date.now() };
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

  // ⛔ AND THE FEE SINK NEVER RECEIVES FROM THE FLOAT. See `feeWalletAddress`:
  // that address is co-named with every buyer, so a single transfer from here
  // gives an auditor fee wallet -> float -> ephemeral -> spend and lands them
  // back on a customer. It is not a plausible request — but neither was paying
  // the till instead of the float, and that shipped.
  const feeWallet = feeWalletAddress();
  if (feeWallet && target.toBase58() === feeWallet) {
    return bad(
      400,
      'refusing to fund the fee wallet (P01_FEE_WALLET): it is co-named with every buyer, so it ' +
        'must only ever receive.',
    );
  }
  if (feeWallet && feeWallet === funder.publicKey.toBase58()) {
    return bad(
      503,
      'this deployment is misconfigured: the fee wallet (P01_FEE_WALLET) is the funder, so the ' +
        'float would appear inside every transaction a buyer signs.',
    );
  }
  // ⛔ NOR ANY OTHER OPERATOR ADDRESS (audit v1 F62). See `operatorAddresses`.
  const operator = operatorAddresses(funder.publicKey.toBase58()).get(target.toBase58());
  if (operator) {
    return bad(400, `refusing to fund ${operator}: the float only ever pays a fresh ephemeral`);
  }

  // The target must be empty. A fresh ephemeral always is, so this costs a
  // legitimate caller nothing — and it stops the endpoint being used to top up
  // an address that already holds a balance. It does NOT stop an attacker
  // generating unlimited fresh keys; see the faucet note in the header.
  let existing: number;
  try {
    existing = await connection.getBalance(target, 'confirmed');
  } catch {
    // web3.js names the account in this error. Fixed words, nothing logged.
    return bad(502, RPC_UNREADABLE);
  }
  if (existing > 0) {
    return bad(409, 'target already holds lamports; this endpoint only funds a fresh ephemeral', {
      balance: existing,
    });
  }

  // ── A key whose earlier grant never came back is not funded again (F37) ──
  let prior: Awaited<ReturnType<typeof grantState>>;
  try {
    prior = await grantState(connection, target, funder.publicKey.toBase58());
  } catch {
    // web3.js names the account in this error. Fixed words, nothing logged.
    return bad(502, RPC_UNREADABLE);
  }
  if (prior === 'unswept' || prior === 'unknown') {
    return bad(
      409,
      prior === 'unswept'
        ? 'this key already received a grant that never came back to the float; it is not funded again'
        : 'this key has a history that could not be shown free of an unreturned grant; it is not funded',
      { code: 'FUNDER_UNSWEPT_GRANT' },
    );
  }

  // ── The lamport budgets, taken last so a refusal above costs nobody's (F37) ──
  const units = Math.ceil(lamports / BUDGET_UNIT_LAMPORTS);
  try {
    const ipFits = await takeUnits(
      kv,
      clientIp(request),
      BUDGET_IP_SALT,
      units,
      Math.floor(PER_IP_LAMPORTS_PER_HOUR / BUDGET_UNIT_LAMPORTS),
    );
    if (!ipFits) {
      return bad(429, 'this address has used its funding budget for the hour', {
        code: 'FUNDER_IP_BUDGET',
        budgetLamports: PER_IP_LAMPORTS_PER_HOUR,
      });
    }
    const globalFits = await takeUnits(
      kv,
      BUDGET_GLOBAL_BUCKET,
      BUDGET_GLOBAL_SALT,
      units,
      Math.floor(globalLamportsPerHour() / BUDGET_UNIT_LAMPORTS),
    );
    if (!globalFits) {
      return bad(429, 'this deployment has used its funding budget for the hour', {
        code: 'FUNDER_GLOBAL_BUDGET',
      });
    }
  } catch {
    // Same posture and same fixed words as the grant limiter above.
    return bad(503, 'the rate limiter could not be read');
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
  let lastValidBlockHeight: number;
  try {
    ({ signature, lastValidBlockHeight } = await sendWithFreshBlockhash(
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

  // The send succeeded, so from here the lamports MAY be on the wire whatever
  // the confirmation says. Two consequences, both measured missing before
  // (scratchpad/web-run/logs8/r1-logs/probe-next-start-fund-ephemeral.log):
  //
  //  - a confirmation that THROWS (an expired blockhash, a missed websocket
  //    notice on serverless) carries the funding signature in its message. It
  //    is caught, and the signature is asked for once more by status: a
  //    transfer that landed is served as the grant it is, because refusing it
  //    strands the lamports and sends the retry into the 409 above;
  //  - an outcome nobody could read still counts against the instance ceiling.
  //    A ceiling that counts only what it saw confirmed undercounts exactly
  //    when the RPC is failing.
  //
  // [flow-speed X7 2026-09-23] Polled, not subscribed: see
  // `awaitGrantConfirmation`. Same commitment, same outcomes; only the
  // blockhash's last valid height is needed here.
  let confirmedErr: unknown = null;
  let outcomeKnown = true;
  const outcome = await awaitGrantConfirmation(connection, signature, lastValidBlockHeight);
  if (outcome.known) {
    confirmedErr = outcome.err;
  } else {
    outcomeKnown = false;
  }
  if (!outcomeKnown) {
    spentThisInstance += lamports;
    return bad(502, 'the funding transaction could not be confirmed');
  }
  if (confirmedErr) {
    return bad(502, `funding transaction failed: ${JSON.stringify(confirmedErr)}`);
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
