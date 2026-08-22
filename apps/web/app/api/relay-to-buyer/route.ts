/**
 * relay-to-buyer — break the edge between the wallet that holds the funds and
 * the identity that spends them.
 *
 * WHY THIS EXISTS
 * ───────────────
 * A subscription republishes, in cleartext, the commitment its deposit
 * published. MEASURED 2026-08-18 by `verify/p01-verify.mjs`: probe P4 walked
 * spend → deposit in one hop, and P9/P11 then named the wallet that had funded
 * that deposit's payer. So whoever paid for the deposit is reachable from the
 * subscription, and the only question is who that turns out to be.
 *
 * A direct transfer from the funding wallet to the spending identity would put
 * the funding wallet one hop from the deposit — the same leak with an extra
 * step. Routing it through the deployment does not: the walk ends here.
 *
 *     A --pays--> this deployment --relays--> B --shields--> pool --spends--> vault
 *
 * A and B never appear in a transaction together. What remains is correlation
 * by amount and timing, which this route cannot fix and does not claim to.
 *
 * ⛔ WHAT THIS IS NOT
 * It is not the funder paying for someone's note. `fundEphemeralForJob` refuses
 * that outright and is right to: a deployment that buys your note owns it.
 * Every lamport this route sends was received from the caller first, read from
 * the chain, and it refuses to send one more.
 */

import { NextRequest, NextResponse } from 'next/server';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { getStore, rateLimitExceeded, rateLimitRemaining } from '@/lib/waitlist/store';
import { namesBoth } from '@/lib/privacy/coNaming';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Devnet genesis. The same guard the funder and the issuer carry. */
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

/**
 * The most this will relay in one call.
 *
 * A 1 SOL shield needs about 2.009 SOL free while it runs, so this sits just
 * above it. Anything larger is refused rather than served, because the cap is
 * what bounds the damage if the ticket leaks before anyone notices the devnet
 * guard is the only other thing standing there.
 */
const MAX_RELAY_LAMPORTS = 2_500_000_000;

/** Namespaces this route's rate-limit buckets away from every other route's. */
const RATE_SALT = 'p01:relay-to-buyer:v1';

/** Relays per IP per hour. A buyer needs one; a faucet-hunter needs many. */
const RELAYS_PER_IP_PER_HOUR = 3;

/**
 * The most refundable rent this deployment will front on top of a payment.
 *
 * 🚨 THE CALLER PAYS THE VALUE, THE DEPLOYMENT PAYS THE RENT, and that split
 * is what keeps the residue honest. A deposit needs value plus proof-buffer
 * rent — 1,003,475,300 and 1,573,486,080 respectively for a 1 SOL note, so
 * about 0.57 SOL of rent. That rent comes back when the buffers close.
 *
 * If the caller paid all of it, the residue would be THEIR money and sweeping
 * it to the deployment would be taking it; sweeping it home would rebuild the
 * `ephemeral -> wallet` edge P9 walked on 2026-08-18. Fronting it here makes
 * the residue the deployment's own, so it can come back here with nobody owed
 * anything and no edge drawn.
 *
 * ⚠️ THIS BOUND CHANGED MEANING ON 2026-08-20 AND THE OLD READING IS NOW WRONG.
 *
 * Before, the buyer paid F. So F's own balance delta WAS `received`, F then
 * forwarded `required`, and F's net outlay per call was exactly
 * `required - received` — the number this constant bounds. Bounding the subsidy
 * bounded F's spending, and one constant did both jobs.
 *
 * After, the value lands at R and F is credited NOTHING by the buyer. F's cash
 * outflow per call is now the WHOLE of `required`, and the only thing bounding
 * it is MAX_RELAY_LAMPORTS (2.5 SOL). This constant survives with a narrower
 * meaning — HOW MUCH OF THIS JOB DID THE BUYER NOT PAY FOR, measured at R's
 * index — which is an accounting bound between R and F, not a bound on F's
 * balance.
 *
 * The operational consequence, stated because nothing in this repository
 * implements it: F drains by roughly one denomination per deposit until R
 * settles with it in batches. F needs a balance alarm and a settlement runbook.
 * The settlement must stay batched and unrelated to any single purchase, or the
 * clock rejoins what the topology separated.
 */
/*
 * ⚠️ RECALIBRATED 2026-08-21, AND THE OLD VALUE WAS THE WHOLE OF AN EXPLOIT.
 *
 * This constant is the ONLY bound on what one call can take out of F. Both of
 * its inputs are chosen by the caller — `buyerPubkey` is where the lamports go
 * and `requiredLamports` is how many — and the ticket that gates the route is
 * `NEXT_PUBLIC_P01_FUNDER_TICKET`, i.e. it ships inside the browser bundle. So
 * the guarantee is not "only our client calls this"; it is exactly this number.
 *
 * At 1_500_000_000 the arithmetic was: pay R anything at all, ask for
 * `received + 1.5 SOL`, and F sends 1.5 SOL more than was paid, to an address
 * the caller names. Three times per IP per hour.
 *
 * DERIVED, not chosen. The subsidy F legitimately fronts is the non-value half
 * of a shield's pre-fund:
 *
 *   non-value part of the measured
 *   1 SOL run                       570,486,080   `denominatedPool.ts`
 *   jitter rounds the sum UP to a
 *   whole 0.01 SOL                  < 10,000,000  `prefundAmount.ts:43,81`
 *   ...and adds up to four more     + 40,000,000  `prefundAmount.ts:51,82`
 *   ------------------------------------------
 *   worst honest subsidy            < 620,486,080
 *
 * ⚠️ 570,486,080, NOT the 570,010,780 the estimator's constant carries. That
 * constant sits 475,300 below the run it was measured from, because the split
 * it came with mislabelled 475,300 lamports of buffer rent as value. Deriving a
 * REFUSAL from the smaller number would refuse honest deposits on a larger
 * proof, so the bound is taken from the larger.
 *
 * 650,000,000 leaves ~0.03 SOL of headroom above the worst honest draw and
 * refuses everything beyond it. It bounds the loss; it does not eliminate it,
 * because nothing here can verify that the ephemeral this funds will actually
 * deposit and sweep the rent home. On a devnet-only route with a public ticket
 * that residual is accepted and written down rather than implied away.
 */
const MAX_RENT_SUBSIDY_LAMPORTS = 650_000_000;

/**
 * The least the fee wallet must actually have been credited, in basis points of
 * what landed at the till.
 *
 * 🚨 THE FEE HAD NO ON-CHAIN CHECK AT ALL. `feeWallet` appeared only in the
 * refusals above and never in the read below, so the 1% was enforced by the
 * client and nowhere else — and the client is not a trust boundary here, for
 * the same reason the cap above is not: the ticket is in the bundle. Anyone
 * POSTing this route with a payment that omits the second transfer got the
 * identical service for free, with no symptom anywhere.
 *
 * WHY 99 AND NOT 100. The client charges 1% of the DENOMINATION
 * (`ephemeralFunder.ts`, `OPERATOR_FEE_BPS = 100n`), while what lands at the
 * till is the denomination plus the protocol's own 0.3%
 * (`shieldEphemeral.ts:293`). So an honest fee is 0.01 / 1.003 = 99.70 bps of
 * `received`, and the client's integer division can shave one atom below that.
 * 99 bps sits under the honest floor with room to spare and still catches an
 * omitted fee, a halved fee, or a fee sent to some other address.
 */
const MIN_OPERATOR_FEE_BPS_OF_RECEIVED = 99n;
const FEE_BPS_DENOMINATOR = 10_000n;

/** What this transaction costs to send. Deducted from the subsidy, not the payment. */
const FEE_LAMPORTS = 5_000;

function bad(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

function funderKeypair(): Keypair | null {
  const raw = process.env.P01_FUNDER_SECRET_KEY?.trim();
  if (!raw) return null;
  try {
    return Keypair.fromSecretKey(
      raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw) as number[]) : bs58.decode(raw),
    );
  } catch {
    return null;
  }
}

/**
 * # 🚨 INVARIANT — A SETTLEMENT MUST CARRY MORE THAN ONE PURCHASE
 *
 * The till collects from buyers and the float pays for their deposits, and the
 * only thing that ever moves value from one to the other is an operator
 * settling R into F. **That transfer carries forward every address the till
 * names.** An auditor who walks
 * `deposit -> its ephemeral -> the float -> the float's history -> the till ->
 * the till's history` arrives at the set of everyone who has paid the till, and
 * the buyer is hidden inside that set or is not hidden at all.
 *
 * So a settlement of ONE purchase identifies that purchase's buyer exactly.
 * A set of one is not a set. Two rules, and both are load-bearing:
 *
 *   - **at least N purchases**, so the set has width;
 *   - **at a moment unrelated to any of them**, because a transfer that follows
 *     a deposit by ninety seconds re-pairs them by the clock even when the
 *     amounts do not, and the clock is public.
 *
 * ⚠️ THIS PROPERTY HOLDS BY OPERATOR DISCIPLINE, NOT BY CONSTRUCTION. The till's
 * spending key is held off chain, deliberately — a till this deployment could
 * spend would be a second float, and the whole R != F split would collapse. So
 * nothing here can refuse a bad settlement. What CAN be done is detect one:
 * `verify/deposit-walk.mjs` reads the till's history and reports how many
 * addresses a settlement would carry forward.
 *
 * 🚨 IT HAS ALREADY BEEN VIOLATED ONCE, on 2026-08-22, by the author of this
 * comment: a single deposit was settled by hand minutes later, creating
 * `float -> till -> buyer` for leaf 72. Measured, not hypothetical.
 */
/** The three addresses one relayed deposit touches. */
interface PaymentAddresses {
  /** F, the float: funds the ephemeral, receives the residue, is paid by nobody. */
  funder: string;
  /** R, the till: the address buyers pay, and the one this route measures. */
  till: string;
  /**
   * # 🚨 INVARIANT — NOTHING THE FEE SINK PAYS MAY FUND THIS PROTOCOL
   *
   * The 1% rides inside the transaction the buyer signs, so the sink appears in
   * an account-key list beside a buyer's own address once per purchase:
   * `getSignaturesForAddress` on it **enumerates every customer this deployment
   * has ever served**. That is survivable only while nothing it touches leads
   * back in.
   *
   * The moment it funds an ephemeral, or the float, probe P11 walks
   * `fee sink -> ephemeral -> subscription` and lands on a buyer — and because
   * the sink names ALL of them, one such transfer exposes the whole customer
   * list at once, not one buyer.
   *
   * ⚠️ THE PROHIBITION IS NARROWER THAN "NEVER SPEND", AND SAYING IT WIDER MAKES
   * IT EASIER TO IGNORE. An operator sweeping revenue to a cold wallet that
   * never touches this protocol reveals the OPERATOR, not the buyers, and that
   * is a business fact rather than a leak. What must never happen is the sink
   * funding anything that ends up paying for a deposit or a spend.
   *
   * ⚠️ HOLDS BY DISCIPLINE ON THE SPENDING SIDE — the key is the operator's and
   * nothing here can refuse a transfer. What this deployment CAN do, and does in
   * the readiness answer below, is notice afterwards: if the sink and the float
   * have ever shared a transaction, it says so and stops serving.
   */
  feeWallet: string;
}

/**
 * Three distinct, parseable addresses — or every reason there are not.
 *
 * 🚨 WHY ALL THREE ARE CHECKED IN ONE PLACE, AND WHY IT IS SHARED WITH THE GET.
 *
 * MEASURED 2026-08-18: a subscription passed every probe but P11, and the walk
 * was two hops with no cryptography. The spend's fee payer had been funded by
 * F, and F's own history held a transfer SIGNED BY THE BUYER, one second
 * earlier, for exactly the note's amount. Neither transfer named both ends. The
 * address standing between them named both.
 *
 * The cure is topological: the address that COLLECTS from buyers must never be
 * the address that FUNDS ephemerals. That was written into an env template, a
 * readiness report and three file headers on 2026-08-19 — and wired nowhere, so
 * this route still read the payment off F's index. Prose is not a mechanism.
 * This function is the mechanism, and both the readiness answer and the refusal
 * come out of it so they can never disagree.
 *
 * The fee wallet joins them because the fee rides INSIDE the buyer's own
 * transaction:
 *   - fee wallet == F puts F in a transaction the buyer signed, which is the
 *     2026-08-18 walk with its middle step deleted;
 *   - fee wallet == R is worse than either, because it corrupts the read rather
 *     than blocking it. web3.js merges an identical pubkey into ONE account
 *     index, so the till's delta would read value + fee, `subsidy = required -
 *     received` merely shrinks, and the operator collects no fee at all while
 *     believing they do. Nothing errors.
 */
function paymentAddresses(
  funderPubkey: string,
): { ok: true; addresses: PaymentAddresses } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const rawTill = process.env.P01_TILL_ADDRESS?.trim() ?? '';
  const rawFee = process.env.P01_FEE_WALLET?.trim() ?? '';

  let till = '';
  let feeWallet = '';
  if (!rawTill) {
    reasons.push(
      'P01_TILL_ADDRESS is unset, so this deployment has no address for buyers to pay that is ' +
        'not the float. That identity is the leak measured on 2026-08-18.',
    );
  } else {
    try {
      till = new PublicKey(rawTill).toBase58();
    } catch {
      reasons.push('P01_TILL_ADDRESS is not a public key, so no payment to it could be read.');
    }
  }
  if (!rawFee) {
    reasons.push('P01_FEE_WALLET is unset, so the operator fee has nowhere to go.');
  } else {
    try {
      feeWallet = new PublicKey(rawFee).toBase58();
    } catch {
      reasons.push('P01_FEE_WALLET is not a public key.');
    }
  }

  if (till && till === funderPubkey) {
    reasons.push(
      'P01_TILL_ADDRESS IS the funder, so every buyer who pays it is one transaction from the ' +
        'address that funds their own subscription and probe P11 walks it in two hops.',
    );
  }
  if (feeWallet && feeWallet === funderPubkey) {
    reasons.push(
      'P01_FEE_WALLET IS the funder, so the float would appear inside the transaction the buyer ' +
        'signs.',
    );
  }
  if (feeWallet && till && feeWallet === till) {
    reasons.push(
      'P01_FEE_WALLET is the same address as the till (P01_TILL_ADDRESS). They would share one ' +
        'account index, this route would read value + fee as the payment, and the fee would never ' +
        'be collected — with no symptom anywhere.',
    );
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, addresses: { funder: funderPubkey, till, feeWallet } };
}

/**
 * What this relay will serve, so the client does not have to guess.
 *
 * 🚨 THE DEFECT THIS CLOSES IS "THE BUYER PAYS FIRST AND IS REFUSED AFTER".
 * Everything this route can refuse — a job over the cap, a rent subsidy over the
 * cap, a till that is unset — used to be discovered only by POSTing a receipt,
 * which is to say only after a full denomination had already left the buyer's
 * wallet for an address this deployment holds no spending key for. MEASURED
 * FROM SOURCE the same day: the cap binds at a denomination of about 1.92 SOL,
 * so the 10, 100, 500 and 1000 SOL pools took the money and delivered nothing,
 * 100% of the time.
 *
 * The ceilings are reported rather than duplicated in the client for the reason
 * every duplicated constant is eventually wrong: an operator lowering the cap
 * here would not lower the copy there, and every buyer between the two numbers
 * would be refused after paying.
 *
 * Deliberately NOT ticket-gated: all three addresses are public the instant they
 * pay for anything, and a client that cannot read them cannot pay safely. It
 * returns addresses and ceilings only — never the funder's key, never the
 * ticket.
 *
 * `ready: false` with reasons is the honest answer to a broken configuration. A
 * `till: null` a client might pay past is not.
 */
export async function GET(request: NextRequest) {
  const funder = funderKeypair();
  const reasons: string[] = [];
  let addresses: PaymentAddresses | null = null;

  if (!funder) {
    reasons.push('This deployment has no usable funder key, so nothing can fund an ephemeral.');
  } else {
    const resolved = paymentAddresses(funder.publicKey.toBase58());
    if (resolved.ok) addresses = resolved.addresses;
    else reasons.push(...resolved.reasons);
  }

  // ── What the float can actually cover ────────────────────────────────────
  //
  // 🚨 THE FLOAT NOW PAYS THE WHOLE JOB AND IS CREDITED NOTHING, and the only
  // pre-payment signal a client has is this answer. Before the R != F split the
  // buyer's lamports landed on F itself, so F's balance was topped up by the
  // very call that spent it; now the value goes to the till and F drains by one
  // pre-fund per deposit until the operator settles R into F in batches —
  // which nothing in this repository does.
  //
  // MEASURED 2026-08-21: the devnet authority held 1.4558 SOL while one 1 SOL
  // deposit needs 1.5735. Without this figure the buyer pays the till first and
  // discovers the shortfall from a 502 afterwards.
  //
  // ⚠️ `null` MEANS UNKNOWN, AND UNKNOWN IS NOT A REFUSAL. An RPC hiccup must
  // not delete the only private path — that mistake has been made here before.
  // A client refuses on a balance it can SEE is too small and proceeds on a
  // balance it cannot read, where the persisted payment receipt is what makes
  // the retry cost nothing.
  // ── Has the fee sink ever paid the float? ───────────────────────────────
  //
  // ⛔ THE ONE PART OF THE SINK INVARIANT A MACHINE CAN CHECK. The prohibition
  // is on the SPENDING side and the key is the operator's, so nothing here can
  // refuse the transfer. But the consequence stays visible forever: a
  // transaction naming both the sink and the float is exactly the edge that
  // turns a customer list into a walk, and two signature listings find it
  // without decoding anything — the method probe P11 uses, and the method an
  // auditor would use against this deployment.
  //
  // Reported as NOT READY rather than as a warning, because a deployment in
  // this state produces deposits that look private and are not, which is the
  // one outcome a buyer cannot detect and cannot undo.
  //
  // ⚠️ `null` is "could not establish" and is NOT a violation. A truncated
  // listing has read less than the question needs, and refusing on that would
  // let one slow endpoint delete the only private path.
  let sinkFundedFloat: boolean | null = null;
  if (funder && addresses) {
    try {
      const rpc = process.env.P01_FUNDER_RPC ?? 'https://api.devnet.solana.com';
      sinkFundedFloat = await namesBoth(
        new Connection(rpc, 'confirmed'),
        addresses.feeWallet,
        addresses.funder,
      );
    } catch {
      sinkFundedFloat = null;
    }
  }
  if (sinkFundedFloat === true) {
    reasons.push(
      'The fee wallet and the float have shared a transaction. The fee wallet is co-named with ' +
        'every buyer this deployment has served, so an edge from it to the float lets an auditor ' +
        'walk from any deposit to that whole customer list. Move the fee sink to a fresh address ' +
        'and never let it fund anything inside this protocol.',
    );
  }

  let funderLamports: number | null = null;
  if (funder) {
    try {
      const rpc = process.env.P01_FUNDER_RPC ?? 'https://api.devnet.solana.com';
      funderLamports = await new Connection(rpc, 'confirmed').getBalance(
        funder.publicKey,
        'confirmed',
      );
    } catch {
      funderLamports = null;
    }
  }
  if (!process.env.P01_FUNDER_TICKET) {
    reasons.push('P01_FUNDER_TICKET is unset: the POST refuses to relay anonymously.');
  }
  if (getStore() === null) {
    reasons.push(
      'No durable KV store is reachable, so the POST fails closed rather than relay one payment ' +
        'twice.',
    );
  }

  // Reported even when NOT ready, because a client that can see the till is
  // still better off than one that guesses — but `ready` is what it must act on.
  const till = addresses?.till ?? tillIfParseable();
  const feeWallet = addresses?.feeWallet ?? feeWalletIfParseable();

  // ── How many relays this caller has left, WITHOUT spending one ──────────
  //
  // 🚨 THE LIMIT WAS ENFORCED AFTER THE BUYER HAD PAID. `RELAYS_PER_IP_PER_HOUR`
  // is checked inside the POST, which runs once the wallet has already sent the
  // denomination and the fee to the till. The bucket is per IP, and a group
  // test — several people on one office wifi, one conference network, one VPN —
  // is by definition one IP. The fourth tester signed away a full denomination
  // and got a 429 for it, recoverable only through the stored receipt and only
  // an hour later.
  //
  // That is the same "pay first, be refused after" shape this whole endpoint was
  // written to close, left open on the one axis nobody had measured. Reporting
  // the remaining budget lets the client refuse BEFORE the signature.
  //
  // ⚠️ `null` is UNKNOWN, not zero — same rule as the float balance. A store
  // that cannot be read must not delete the only private path.
  const ip =
    request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for') ?? 'unknown';
  let relaysRemaining: number | null = null;
  const store = getStore();
  if (store) {
    try {
      relaysRemaining = await rateLimitRemaining(store, ip, RATE_SALT, RELAYS_PER_IP_PER_HOUR);
    } catch {
      relaysRemaining = null;
    }
  }

  return NextResponse.json({
    ok: true,
    funder: funder?.publicKey.toBase58() ?? null,
    relaysRemaining,
    relaysPerHour: RELAYS_PER_IP_PER_HOUR,
    till,
    feeWallet,
    maxRelayLamports: MAX_RELAY_LAMPORTS,
    maxRentSubsidyLamports: MAX_RENT_SUBSIDY_LAMPORTS,
    // Reported, never folded into `ready`: whether the float can cover THIS job
    // is a question only the client can ask, because only the client knows the
    // job. Folding it in would make readiness mean two different things.
    funderLamports,
    relayFeeLamports: FEE_LAMPORTS,
    // `null` = could not establish. Reported so a reader can tell "clean" from
    // "unread", which is the distinction this whole file is built around.
    sinkFundedFloat,
    ready: reasons.length === 0,
    reasons,
  });
}

/** The configured till, or null. Only for the report — never for a decision. */
function tillIfParseable(): string | null {
  const raw = process.env.P01_TILL_ADDRESS?.trim();
  if (!raw) return null;
  try {
    return new PublicKey(raw).toBase58();
  } catch {
    return null;
  }
}

/** The configured fee wallet, or null. Same caveat. */
function feeWalletIfParseable(): string | null {
  const raw = process.env.P01_FEE_WALLET?.trim();
  if (!raw) return null;
  try {
    return new PublicKey(raw).toBase58();
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const ticket = process.env.P01_FUNDER_TICKET;
  if (!ticket) return bad(503, 'no ticket configured; refusing to relay anonymously');
  if (request.headers.get('x-p01-funder-ticket') !== ticket) {
    return bad(401, 'bad or missing ticket');
  }

  const funder = funderKeypair();
  if (!funder) return bad(503, 'this deployment has no funder key');

  // ── The configuration check, and it is here for its ORDER as much as its
  // condition ───────────────────────────────────────────────────────────────
  //
  // 🚨 `kv.incr` below is ONE-SHOT PER PAYMENT SIGNATURE: a claim taken and not
  // released answers 409 "already relayed" forever. By the time this route runs
  // the buyer's lamports have already moved, so an operator's env mistake must
  // not consume the claim — fixing the env afterwards would not make the buyer
  // whole. The hourly rate-limit bucket is protected for the same reason: a
  // deployment that is misconfigured for an hour must not also spend the
  // allowance of everyone who tried it.
  //
  // So: refuse before the claim, before the limiter, before the chain is read.
  const configured = paymentAddresses(funder.publicKey.toBase58());
  if (!configured.ok) {
    return bad(503, configured.reasons.join(' '), { ready: false, reasons: configured.reasons });
  }
  const { till, feeWallet } = configured.addresses;

  let body: { paymentSignature?: string; buyerPubkey?: string; requiredLamports?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return bad(400, 'body must be JSON');
  }

  let buyer: PublicKey;
  try {
    buyer = new PublicKey(String(body.buyerPubkey ?? ''));
  } catch {
    return bad(400, 'buyerPubkey is not a public key');
  }
  if (buyer.equals(funder.publicKey)) return bad(400, 'refusing to relay to the funder');
  // ⛔ THE FEE WALLET IS A PURE SINK, AND THIS IS THE LINE THAT MAKES IT ONE.
  // It is co-named with EVERY buyer — the fee rides in the transaction they
  // sign, so its history is a global index of this deployment's customers. That
  // is survivable only while nothing it touches leads onward: the moment the
  // float pays it, an auditor walks fee wallet -> float -> ephemeral -> spend
  // and lands back on a buyer, which is probe P11's exact route. It receives; it
  // never sends and is never sent to from here.
  //
  // The till is refused for the mirror reason: F paying R once per relay is the
  // per-purchase settlement the R != F split exists to prevent, and it would
  // rejoin by the clock what the topology separated.
  if (buyer.toBase58() === feeWallet) {
    return bad(400, 'refusing to fund the fee wallet: it is a sink and must never pay for a job');
  }
  if (buyer.toBase58() === till) {
    return bad(400, 'refusing to relay to the till: the float must not settle with it per payment');
  }

  const signature = String(body.paymentSignature ?? '');
  if (!signature) return bad(400, 'paymentSignature is required');

  // A durable store or nothing. Without it the same payment can be relayed
  // repeatedly, draining the funder with the caller's own receipt.
  const kv = getStore();
  if (!kv) return bad(503, 'no durable store is configured; refusing to relay untracked');

  const ip =
    request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for') ?? 'unknown';
  try {
    if (await rateLimitExceeded(kv, ip, RATE_SALT, RELAYS_PER_IP_PER_HOUR)) {
      return bad(429, 'too many relays from this address in the last hour', {
        limit: RELAYS_PER_IP_PER_HOUR,
      });
    }
  } catch (e) {
    return bad(503, `the rate limiter could not be read: ${(e as Error).message}`);
  }

  const rpc = process.env.P01_FUNDER_RPC ?? 'https://api.devnet.solana.com';
  const connection = new Connection(rpc, 'confirmed');

  // ⛔ Devnet only, checked against the chain rather than a variable, because
  // every other protection here is a devnet-shaped compromise.
  try {
    const genesis = await connection.getGenesisHash();
    if (genesis !== DEVNET_GENESIS) {
      return bad(403, 'this relay is devnet-only and the configured RPC is not devnet', { genesis });
    }
  } catch (e) {
    return bad(502, `the configured RPC could not be reached: ${(e as Error).message}`);
  }

  // ONE RELAY PER PAYMENT, claimed before the chain is read. `incr` returns 1
  // only for the caller that created the key, so two simultaneous requests
  // carrying the same receipt cannot both be served.
  const claimKey = `p01:relay:payment:${signature}`;
  let claim: number;
  try {
    claim = await kv.incr(claimKey);
  } catch (e) {
    return bad(503, `the payment could not be claimed: ${(e as Error).message}`);
  }
  if (claim !== 1) return bad(409, 'this payment has already been relayed');
  /**
   * Give the payment back when this request hands nothing over.
   *
   * 🚨 THE BUG THIS EXISTS FOR, AND IT FIRES ON THE MOST ORDINARY
   * CONDITION IN THE FLOW.
   *
   * The claim above is taken BEFORE the chain is read, which is right — two
   * simultaneous requests carrying the same receipt must not both be served.
   * But every refusal below it used to keep the claim, and the buyer's
   * lamports are already on chain by then.
   *
   * The worst of them says so out loud: a payment the RPC has not caught up
   * with yet returns 404 'confirm it and retry', and the retry hits 409 'this
   * payment has already been relayed'. Forever. The buyer paid, this
   * deployment kept the money, and the endpoint that was supposed to forward
   * it is permanently shut to them — for a propagation delay.
   *
   * So: the claim is released on every path that does not deliver, and held
   * only once lamports have actually moved. Releasing is safe against the
   * race it guards — the window reopens only after this request has decided
   * to send nothing, so there is no moment where two requests can both be
   * mid-transfer.
   *
   * ⚠️ EVERY `return bad(...)` BELOW THIS POINT MUST GO THROUGH HERE.
   * `relayClaimReleased` in the test suite scans this file and fails if a new
   * one is added bare, because the failure mode is invisible: the request
   * looks correctly refused and the money is simply gone.
   */
  const release = async (res: NextResponse) => {
    try {
      await kv.del(claimKey);
    } catch {
      // Best effort. A failed release costs this buyer their retry, which is
      // the behaviour we are fixing — but a throw here would replace an
      // accurate error with a misleading one, and the money has not moved
      // either way.
    }
    return res;
  };

  // ── What the caller actually paid, read at the TILL'S index ──────────────
  //
  // 🚨 THIS LINE IS THE MECHANISM. It used to read `funder.publicKey`'s delta,
  // which meant the ONLY payment this route would accept was one that had named
  // F — so a client correctly paying the till got 400 "that transaction did not
  // pay this deployment", after the money had moved, and a client paying F was
  // served happily. That is the 2026-08-18 leak, expressed as an array index.
  //
  // Never read from the request: an amount the caller states is an amount the
  // caller chooses.
  //
  // The 1% fee cannot bleed into this figure. Two transfers to two DISTINCT
  // pubkeys occupy two distinct entries in `staticAccountKeys`, and
  // `pre/postBalances` are positionally aligned with that array — the only way
  // the two could merge is key equality, which `paymentAddresses` refuses
  // outright above, before this request took its claim.
  let received = 0;
  let feeReceived = 0;
  try {
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (!tx?.meta) return release(bad(404, 'that payment is not on chain yet; confirm it and retry'));
    const keys = tx.transaction.message
      .getAccountKeys()
      .staticAccountKeys.map((k) => k.toBase58());
    const idx = keys.indexOf(till);
    if (idx < 0) {
      // Naming the address, because an operator reading a log has to be able to
      // tell "paid the wrong address" from "paid nothing".
      return release(
        bad(400, 'that transaction did not name the address this deployment collects at', { till }),
      );
    }
    received = (tx.meta.postBalances[idx] ?? 0) - (tx.meta.preBalances[idx] ?? 0);

    // The operator's cut, read the same way and out of the SAME transaction —
    // which is the only place it can be read, because the whole point of the
    // fee riding inside the buyer's own transfer is that there is no second
    // transaction to approve and therefore none to check separately.
    //
    // A missing index is a fee of zero, not an error: "paid a different
    // address" and "paid nothing" must land on the same refusal, since both
    // mean this deployment was not paid. The two pubkeys cannot merge into one
    // index — `paymentAddresses` refused `feeWallet === till` before this
    // request took its claim.
    const feeIdx = keys.indexOf(feeWallet);
    feeReceived =
      feeIdx < 0 ? 0 : (tx.meta.postBalances[feeIdx] ?? 0) - (tx.meta.preBalances[feeIdx] ?? 0);
  } catch (e) {
    return release(bad(502, `the payment could not be read: ${(e as Error).message}`));
  }

  if (received <= 0) {
    return release(bad(400, 'that transaction paid the till nothing', { till, received }));
  }
  if (received > MAX_RELAY_LAMPORTS) {
    return release(bad(400, 'that payment is larger than this relay forwards in one call', {
      received,
      cap: MAX_RELAY_LAMPORTS,
    }));
  }

  // ⛔ THE FEE IS CHECKED HERE OR IT IS NOT CHECKED ANYWHERE.
  //
  // Refused BEFORE the buyer-balance read and before anything is sent, so an
  // underpaying caller costs this deployment one `getTransaction` and no
  // lamports. The claim is released, so a caller who genuinely botched the fee
  // can build a correct payment and try again — the receipt they lose is one
  // they were never going to be served on.
  const minFee = Number(
    (BigInt(Math.max(0, received)) * MIN_OPERATOR_FEE_BPS_OF_RECEIVED) / FEE_BPS_DENOMINATOR,
  );
  if (feeReceived < minFee) {
    return release(
      bad(402, 'that transaction did not pay the operator fee', {
        received,
        feeReceived,
        minFee,
        feeWallet,
        hint:
          'The fee rides in the same transaction as the payment: one transfer to the till and ' +
          'one to the fee wallet. Nothing was sent and the payment can be rebuilt.',
      }),
    );
  }

  // The buyer must be empty. A fresh identity always is, and a reused one is a
  // buyer whose deposits can be tied to each other by their shared address.
  try {
    const existing = await connection.getBalance(buyer, 'confirmed');
    if (existing > 0) {
      return release(bad(409, 'this buyer identity already holds lamports; use a fresh one', { existing }));
    }
  } catch (e) {
    return release(bad(502, `the buyer balance could not be read: ${(e as Error).message}`));
  }

  // What the ephemeral needs in total. The caller states it because only the
  // caller knows the job; the deployment bounds how much of it it will front.
  const required = Number(body.requiredLamports ?? received);
  if (!Number.isFinite(required) || required <= 0) {
    return release(bad(400, 'requiredLamports must be a positive number'));
  }
  if (required > MAX_RELAY_LAMPORTS) {
    return release(bad(400, 'that job needs more than this relay funds in one call', {
      required,
      cap: MAX_RELAY_LAMPORTS,
    }));
  }

  const subsidy = required - received;
  if (subsidy > MAX_RENT_SUBSIDY_LAMPORTS) {
    return release(bad(402, 'that payment does not cover the value this job moves', {
      received,
      required,
      subsidy,
      maxSubsidy: MAX_RENT_SUBSIDY_LAMPORTS,
      hint:
        'This deployment fronts the refundable rent and no more. Pay the note value and ask ' +
        'again; nothing was sent.',
    }));
  }

  const forward = required;
  if (forward <= FEE_LAMPORTS) return release(bad(400, 'that job asks for less than the relay fee'));

  // ── THE SEND AND THE CONFIRMATION ARE TWO DIFFERENT FACTS ────────────────
  //
  // 🚨 THIS SPLIT IS A DOUBLE-SPEND FIX, NOT TIDINESS. One `try` used to span
  // both, so a confirmation timeout — the single most ordinary event on devnet —
  // reached the `catch` and RELEASED the claim. `sendRawTransaction` had already
  // returned a signature by then: the transaction was on the wire and the
  // lamports were on their way. The buyer's retry, or a second tab, then
  // forwarded the SAME payment again out of the float. Measured cost: one full
  // pre-fund per event, 1,573,486,080 lamports on the 1 SOL pool, with a receipt
  // that looks entirely legitimate.
  //
  // So the release covers only what happens BEFORE the signature exists.
  let sig: string;
  let blockhash: string;
  let lastValidBlockHeight: number;
  try {
    ({ blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized'));
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: funder.publicKey,
        toPubkey: buyer,
        lamports: forward,
      }),
    );
    tx.recentBlockhash = blockhash;
    tx.feePayer = funder.publicKey;
    tx.sign(funder);
    sig = await connection.sendRawTransaction(tx.serialize());
  } catch (e) {
    // Nothing left this process. The buyer must be able to retry with the same
    // receipt, or a propagation blip shuts them out of their own money forever.
    return release(bad(502, `the relay could not be sent: ${(e as Error).message}`));
  }

  // From here the claim is CORRECTLY HELD WHATEVER HAPPENS. A signature exists,
  // so the transfer may land at any moment; a second request carrying this
  // receipt must never be served.
  try {
    const conf = await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    if (conf.value.err) {
      // Landed and FAILED, which is the one after-send outcome that moved
      // nothing: the transfer errored, so only the float's own fee was spent and
      // the payment is still relayable. This is a decision about the CHAIN's
      // answer, not about a timeout, so it is safe to give the claim back.
      return release(
        bad(502, `the relay transaction failed on chain: ${JSON.stringify(conf.value.err)}`, {
          signature: sig,
        }),
      );
    }
  } catch (e) {
    // ⛔ NO RELEASE HERE, EVER. The answer is missing; the money is not. The
    // signature is the only way anyone can find out what actually happened, so
    // it is reported rather than swallowed behind a 502.
    return NextResponse.json(
      {
        ok: true,
        sent: true,
        confirmed: false,
        signature: sig,
        lamports: forward,
        buyer: buyer.toBase58(),
        funder: funder.publicKey.toBase58(),
        till,
        warning:
          `The relay was sent but not confirmed within the window (${(e as Error).message}). The ` +
          'lamports are already on the wire, so this payment stays claimed and will not be ' +
          'forwarded twice. Check the signature before retrying anything.',
      },
      { status: 202 },
    );
  }

  // Lamports have moved. From here the claim is CORRECTLY held: a second
  // request carrying this receipt must not be served, and there is nothing to
  // give back.
  return NextResponse.json({
    ok: true,
    sent: true,
    confirmed: true,
    signature: sig,
    lamports: forward,
    buyer: buyer.toBase58(),
    // The client sweeps the ephemeral's residue back to whoever fronted the
    // rent, and it must learn that address from the party that actually sent
    // rather than assume it. The till is echoed so a client can check it paid
    // the same address this route measured.
    funder: funder.publicKey.toBase58(),
    till,
    disclosure:
      'Your payment reached this deployment at an address that funds nothing, and a different ' +
      'address funded the identity that will deposit. Those are two transactions and they do ' +
      'not name each other. What still ties them is the amount and the minutes between them, ' +
      'which this does not hide.',
  });
}
