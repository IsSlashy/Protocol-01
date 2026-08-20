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
 *     A --pays--> R (the till)          R and F settle in BATCHES, on a
 *                     ┆                 schedule unrelated to any purchase
 *     F (the float) --relays--> B --shields--> pool --spends--> vault
 *
 * 🚨 R AND F ARE TWO ADDRESSES AND THIS ROUTE IS WHERE THAT IS ENFORCED ON THE
 * SERVER. An earlier version of this diagram said "this deployment" as if it
 * were one address, and the code matched: it looked the payment up by the
 * FUNDER's balance delta, so the only payment it would accept was one that had
 * named F. That silently undid R != F — the client could pay the till and the
 * relay would answer "that transaction did not pay this deployment". Measured
 * 2026-08-18: F standing between the buyer's payment and the ephemeral it
 * financed is the two-hop walk probe P11 runs.
 *
 * If R and F settle once per purchase, the split buys nothing: an auditor reads
 * F's history, lands on R, and R's history is every buyer. Batches, delayed,
 * never per purchase.
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
import { getStore, rateLimitExceeded } from '@/lib/waitlist/store';

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
 * 🚨 THE CALLER PAYS THE VALUE TO R, THE DEPLOYMENT PAYS THE RENT FROM F, and
 * that split is what keeps the residue honest. A deposit needs value plus
 * proof-buffer rent — 1,003,475,300 and 1,573,486,080 respectively for a 1 SOL
 * note, so about 0.57 SOL of rent. That rent comes back when the buffers close,
 * and it comes back to F, which is the address that lent it.
 *
 * If the caller paid all of it, the residue would be THEIR money and sweeping
 * it to the deployment would be taking it; sweeping it home would rebuild the
 * `ephemeral -> wallet` edge P9 walked on 2026-08-18. Fronting it here makes
 * the residue the deployment's own, so it can come back here with nobody owed
 * anything and no edge drawn.
 *
 * ⚠️ THE SPLIT NOW READS ACROSS TWO ADDRESSES, AND THAT COSTS F REAL MONEY PER
 * PURCHASE. The value lands at R and the rent leaves F, so F is down roughly one
 * denomination per deposit until R settles with it. Ten 1 SOL deposits drain 10
 * SOL out of F. Nothing in this repository performs that settlement; it is an
 * operator runbook item, batched and delayed, and F needs a balance alarm in
 * front of it — a drained F fails at `sendRawTransaction` and the client falls
 * back to the wallet, which is the silent degradation the whole funder header is
 * written about.
 */
const MAX_RENT_SUBSIDY_LAMPORTS = 1_500_000_000;

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
 * R, the till — the address the buyer's payment must have credited.
 *
 * ⚠️ DELIBERATELY DUPLICATED from `app/api/fund-ephemeral/route.ts`. There is no
 * shared module both routes may import inside this change's boundary, so this is
 * a copy and the copy is a hazard worth naming: if the two ever drift — a
 * different variable name, a different trim, a different parse — the client pays
 * a till this route does not recognise, and the buyer gets a 400 saying the
 * transaction did not pay this deployment AFTER their money has already moved.
 * The cure is one shared `lib/privacy/deploymentAddresses.ts`; until then, edit
 * both.
 *
 * Public key only, and the deployment holds no secret for it on purpose: a
 * deployment that cannot spend from the till cannot accidentally make the till
 * pay for a job.
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
 * The operator fee wallet. Read here only to REFUSE the collisions that would
 * corrupt the balance-delta read below — this route never sends it anything.
 *
 * Same duplication hazard as `tillAddress`, same cure.
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

export async function POST(request: NextRequest) {
  const ticket = process.env.P01_FUNDER_TICKET;
  if (!ticket) return bad(503, 'no ticket configured; refusing to relay anonymously');
  if (request.headers.get('x-p01-funder-ticket') !== ticket) {
    return bad(401, 'bad or missing ticket');
  }

  const funder = funderKeypair();
  if (!funder) return bad(503, 'this deployment has no funder key');

  // ── R != F, checked before anything else costs the buyer something ────────
  //
  // 🚨 DELIBERATELY ABOVE THE RATE LIMITER AND FAR ABOVE THE ONE-SHOT CLAIM.
  // These are pure environment reads — no RPC, no store — and an operator's
  // misconfiguration must not burn the buyer's single claim on this payment
  // (`kv.incr` below is one-shot: a burned claim answers 409 forever) or eat
  // their hourly allowance. Placed here, fixing the env and retrying works.
  //
  // ⛔ FAIL CLOSED. Falling through to the old behaviour — accepting a payment
  // that named F — is the shape measured on 2026-08-18, and it would be invisible
  // because the relay would still succeed.
  const till = tillAddress();
  const feeWallet = feeWalletAddress();
  const funderBase58 = funder.publicKey.toBase58();
  if (!till) {
    return bad(
      503,
      'this deployment cannot verify payments: P01_TILL_ADDRESS is unset or is not a public key, ' +
        'so there is no collection address to read the payment from. Refusing rather than ' +
        'falling back to the funder, which is the linkage this split exists to remove.',
    );
  }
  if (till === funderBase58) {
    return bad(
      503,
      'this deployment is misconfigured: the till (P01_TILL_ADDRESS) is the funder, so a buyer ' +
        'who pays it is one transaction from the address that funds their own spend.',
    );
  }
  if (feeWallet === funderBase58) {
    return bad(
      503,
      "this deployment is misconfigured: the operator fee wallet (P01_FEE_WALLET) is the funder, " +
        "so the buyer's payment transaction names the address that funds their spend.",
    );
  }
  if (feeWallet && feeWallet === till) {
    // The collision that corrupts the read below rather than blocking it: two
    // credits to one pubkey are ONE account index in web3.js, so `received`
    // would be value + fee, the subsidy would shrink, and nothing would error.
    return bad(
      503,
      'this deployment is misconfigured: the operator fee wallet (P01_FEE_WALLET) is the till, ' +
        'so the fee and the payment land on one account and this route would over-read what was ' +
        'paid.',
    );
  }

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

  // What the caller actually paid, read from the chain. Never from the request:
  // an amount the caller states is an amount the caller chooses.
  //
  // 🚨 READ AT THE TILL'S INDEX, NOT THE FUNDER'S — THIS IS WHERE R != F WAS
  // SILENTLY UNDONE. Until 2026-08-20 this indexed on `funder.publicKey`, so the
  // only payment the relay would accept was one that had named F, and the R != F
  // split asserted everywhere else could not actually be used. An auditor walked
  // it in two RPC calls.
  //
  // ✅ WHY THE 1% OPERATOR FEE IN THE SAME TRANSACTION CANNOT DISTURB THIS:
  //   (a) two `SystemProgram.transfer`s to two distinct pubkeys occupy two
  //       distinct entries in `message.getAccountKeys().staticAccountKeys`;
  //   (b) `meta.preBalances` / `meta.postBalances` are positionally aligned with
  //       that same array, so a credit at the fee wallet's index cannot appear in
  //       the till's delta;
  //   (c) both debits AND the network fee land on account index 0, the buyer's
  //       wallet as fee payer — the till is credit-only in this transaction;
  //   (d) the ONLY way the two could merge is key equality, because web3.js
  //       dedupes an identical pubkey into one account index. That case is
  //       refused above, and again in the client, and again in fund-ephemeral.
  let received = 0;
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
    // Names the till, so an operator reading this in a log can tell a client
    // paying the wrong address from a client paying nothing.
    if (idx < 0) {
      return release(bad(400, `that transaction did not pay this deployment's collection address`, {
        till,
      }));
    }
    received = (tx.meta.postBalances[idx] ?? 0) - (tx.meta.preBalances[idx] ?? 0);
  } catch (e) {
    return release(bad(502, `the payment could not be read: ${(e as Error).message}`));
  }

  if (received <= 0) return release(bad(400, 'that transaction paid this deployment nothing'));
  if (received > MAX_RELAY_LAMPORTS) {
    return release(bad(400, 'that payment is larger than this relay forwards in one call', {
      received,
      cap: MAX_RELAY_LAMPORTS,
    }));
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

  let sig: string;
  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
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
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      'confirmed',
    );
  } catch (e) {
    return release(bad(502, `the relay could not be sent: ${(e as Error).message}`));
  }

  // Lamports have moved. From here the claim is CORRECTLY held: a second
  // request carrying this receipt must not be served, and there is nothing to
  // give back.
  return NextResponse.json({
    ok: true,
    signature: sig,
    lamports: forward,
    buyer: buyer.toBase58(),
    till,
    disclosure:
      'Your payment reached this deployment\'s collection address, and a different address — the ' +
      'one that funds jobs — paid the identity that will deposit. Those are two transactions ' +
      'between two addresses, and neither names both ends. What still ties them is the amount ' +
      'and the minutes between them, which this does not hide.',
  });
}
