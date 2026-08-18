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

export async function POST(request: NextRequest) {
  const ticket = process.env.P01_FUNDER_TICKET;
  if (!ticket) return bad(503, 'no ticket configured; refusing to relay anonymously');
  if (request.headers.get('x-p01-funder-ticket') !== ticket) {
    return bad(401, 'bad or missing ticket');
  }

  const funder = funderKeypair();
  if (!funder) return bad(503, 'this deployment has no funder key');

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

  // What the caller actually paid, read from the chain. Never from the request:
  // an amount the caller states is an amount the caller chooses.
  let received = 0;
  try {
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (!tx?.meta) return bad(404, 'that payment is not on chain yet; confirm it and retry');
    const keys = tx.transaction.message
      .getAccountKeys()
      .staticAccountKeys.map((k) => k.toBase58());
    const idx = keys.indexOf(funder.publicKey.toBase58());
    if (idx < 0) return bad(400, 'that transaction did not pay this deployment');
    received = (tx.meta.postBalances[idx] ?? 0) - (tx.meta.preBalances[idx] ?? 0);
  } catch (e) {
    return bad(502, `the payment could not be read: ${(e as Error).message}`);
  }

  if (received <= 0) return bad(400, 'that transaction paid this deployment nothing');
  if (received > MAX_RELAY_LAMPORTS) {
    return bad(400, 'that payment is larger than this relay forwards in one call', {
      received,
      cap: MAX_RELAY_LAMPORTS,
    });
  }

  // The buyer must be empty. A fresh identity always is, and a reused one is a
  // buyer whose deposits can be tied to each other by their shared address.
  try {
    const existing = await connection.getBalance(buyer, 'confirmed');
    if (existing > 0) {
      return bad(409, 'this buyer identity already holds lamports; use a fresh one', { existing });
    }
  } catch (e) {
    return bad(502, `the buyer balance could not be read: ${(e as Error).message}`);
  }

  // What the ephemeral needs in total. The caller states it because only the
  // caller knows the job; the deployment bounds how much of it it will front.
  const required = Number(body.requiredLamports ?? received);
  if (!Number.isFinite(required) || required <= 0) {
    return bad(400, 'requiredLamports must be a positive number');
  }
  if (required > MAX_RELAY_LAMPORTS) {
    return bad(400, 'that job needs more than this relay funds in one call', {
      required,
      cap: MAX_RELAY_LAMPORTS,
    });
  }

  const subsidy = required - received;
  if (subsidy > MAX_RENT_SUBSIDY_LAMPORTS) {
    return bad(402, 'that payment does not cover the value this job moves', {
      received,
      required,
      subsidy,
      maxSubsidy: MAX_RENT_SUBSIDY_LAMPORTS,
      hint:
        'This deployment fronts the refundable rent and no more. Pay the note value and ask ' +
        'again; nothing was sent.',
    });
  }

  const forward = required;
  if (forward <= FEE_LAMPORTS) return bad(400, 'that job asks for less than the relay fee');

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
    return bad(502, `the relay could not be sent: ${(e as Error).message}`);
  }

  return NextResponse.json({
    ok: true,
    signature: sig,
    lamports: forward,
    buyer: buyer.toBase58(),
    disclosure:
      'Your payment reached this deployment and this deployment funded the identity that ' +
      'will deposit. Those are two transactions and they do not name each other. What still ' +
      'ties them is the amount and the minutes between them, which this does not hide.',
  });
}
