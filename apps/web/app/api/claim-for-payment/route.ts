import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';

import { getStore, rateLimitExceeded } from '@/lib/waitlist/store';

/**
 * claim-for-payment — turn a settled on-chain payment into ONE claim code.
 *
 * WHY THIS EXISTS. `/api/mint-claim` says of itself: "This is a seam, not a
 * payment integration... Until such a webhook exists, an operator calls it by
 * hand." This is that webhook, for the only payment rail this deployment
 * actually has: SOL sent to the till.
 *
 * WHAT IT BUYS, AND IT IS THE POINT OF THE INVENTORY DESIGN. The buyer pays,
 * then receives a note the TREASURY deposited long before they arrived. There
 * is no deposit of theirs anywhere on chain, so the 48-50 second join measured
 * on 2026-08-28 — between a buyer paying the till and their own leaf being
 * inserted — does not exist for them. What is left is payment -> spend, and
 * unlike the other gap that one is under the buyer's control: they can wait.
 *
 * ⛔ IT DOES NOT MAKE THE PAYMENT PRIVATE. Paying the till names the payer, as
 * it always did. This moves the join; it does not delete it.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RATE_SALT = 'p01:claim-for-payment:v1';
const CLAIMS_PER_IP_PER_HOUR = 12;

/**
 * What a note costs, in lamports.
 *
 * ⚠️ A FLOOR, NOT AN EQUALITY. Paying MORE must never be refused: this route
 * runs after the money has moved, so a 400 on an overpayment leaves the buyer
 * out of pocket with nothing. Underpayment is refused WITHOUT consuming the
 * payment, so they can top up and present the new transaction.
 */
function priceLamports(): number {
  const raw = Number(process.env.P01_NOTE_PRICE_LAMPORTS ?? '');
  if (Number.isInteger(raw) && raw > 0) return raw;
  const denom = Number(process.env.P01_TREASURY_NOTE_DENOMINATION ?? '1');
  return Math.round((Number.isFinite(denom) && denom > 0 ? denom : 1) * 1e9);
}

function tillAddress(): string | null {
  const t = process.env.P01_TILL_ADDRESS;
  if (!t) return null;
  try {
    return new PublicKey(t).toBase58();
  } catch {
    return null;
  }
}

function bad(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

/** The message the paying wallet must sign to collect the note it bought. */
export function claimChallenge(signature: string): string {
  return `Protocol 01 - collect the note I paid for.\nPayment: ${signature}`;
}

export async function GET() {
  const reasons: string[] = [];
  if (!tillAddress()) reasons.push('P01_TILL_ADDRESS is unset or not a public key.');
  if (!getStore()) reasons.push('No durable KV store, so one payment could mint many claims.');
  if (!process.env.P01_FUNDER_RPC) reasons.push('P01_FUNDER_RPC is unset; payments cannot be read.');
  return NextResponse.json({
    ok: true,
    configured: reasons.length === 0,
    till: tillAddress(),
    priceLamports: priceLamports(),
    reasons,
  });
}

export async function POST(request: NextRequest) {
  const till = tillAddress();
  if (!till) return bad(503, 'this deployment has no till configured; refusing to sell notes');

  // 🚨 FAILS CLOSED. Without a durable store one payment could mint an unbounded
  // number of claims, which is the whole inventory given away.
  const kv = getStore();
  if (!kv) return bad(503, 'no durable store; a claim that cannot be recorded must not be minted');

  const ip =
    request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for') ?? 'unknown';
  try {
    if (await rateLimitExceeded(kv, ip, RATE_SALT, CLAIMS_PER_IP_PER_HOUR)) {
      return bad(429, 'too many claim requests from this address in the last hour');
    }
  } catch (e) {
    return bad(503, `the rate limiter could not be read: ${(e as Error).message}`);
  }

  let body: { signature?: unknown; proof?: unknown };
  try {
    body = await request.json();
  } catch {
    return bad(400, 'send { signature, proof }');
  }
  const signature = typeof body.signature === 'string' ? body.signature.trim() : '';
  const proof = typeof body.proof === 'string' ? body.proof.trim() : '';
  if (!signature) return bad(400, 'signature is required: the transaction that paid the till');
  if (!proof) return bad(400, 'proof is required: sign the challenge with the paying wallet');

  const connection = new Connection(
    process.env.P01_FUNDER_RPC ?? 'https://api.devnet.solana.com',
    'confirmed',
  );

  let payer: string;
  let received: number;
  try {
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (!tx?.meta) return bad(404, 'that payment is not on chain yet; confirm it and retry');
    if (tx.meta.err) return bad(400, 'that transaction failed on chain, so it paid nothing');

    const keys = tx.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
    const idx = keys.indexOf(till);
    if (idx < 0) {
      return bad(400, 'that transaction did not name the address this deployment collects at', {
        till,
      });
    }
    // 🚨 READ AT THE TILL'S INDEX, NEVER FROM THE REQUEST. An amount the caller
    // states is an amount the caller chooses — the 2026-08-18 leak expressed as
    // an array index.
    received = (tx.meta.postBalances[idx] ?? 0) - (tx.meta.preBalances[idx] ?? 0);
    payer = keys[0];
  } catch (e) {
    return bad(502, `the payment could not be read: ${(e as Error).message}`);
  }

  const price = priceLamports();
  if (received < price) {
    return bad(402, 'that transaction paid the till less than a note costs', {
      received,
      priceLamports: price,
    });
  }

  // ⛔ THE SIGNATURE IS PUBLIC, SO IT CANNOT BE THE CREDENTIAL. Every payment to
  // the till is visible to anyone reading the chain. Without this check the
  // first stranger to spot one would collect the note it bought. The claim goes
  // only to a caller who can sign as the wallet that paid.
  try {
    // ⚠️ Buffer, not TextEncoder. tweetnacl checks `instanceof Uint8Array`, and
    // under a jsdom test environment TextEncoder returns one from a different
    // realm — which throws "unexpected type" on a proof that is perfectly
    // valid. This route is `runtime = 'nodejs'`, so Buffer is always here.
    const ok = nacl.sign.detached.verify(
      new Uint8Array(Buffer.from(claimChallenge(signature), 'utf8')),
      new Uint8Array(Buffer.from(proof, 'base64')),
      new PublicKey(payer).toBytes(),
    );
    if (!ok) return bad(401, 'that proof was not signed by the wallet that made this payment');
  } catch {
    return bad(400, 'proof must be base64 of a 64-byte ed25519 signature');
  }

  // ── One payment, one claim, and the SAME claim on a retry ────────────────
  //
  // 🚨 IDEMPOTENT ON PURPOSE. A buyer who lost the response has already paid.
  // Minting a second code sells one payment twice; refusing outright keeps
  // their money and gives them nothing. Returning the code they already bought
  // is the only answer that is neither.
  const paidKey = `p01:note:paid:${signature}`;
  let claimCode: string;
  try {
    const first = await kv.incr(paidKey);
    if (first === 1) {
      claimCode = randomBytes(32).toString('base64url');
      await kv.set(`${paidKey}:code`, claimCode);
      // The claim itself, in the shape /api/issue-note redeems. No expiry — see
      // the founder ruling in mint-claim: a bearer asset somebody bought is not
      // a liability to be timed out.
      await kv.set(`p01:note:claim-minted:${claimCode}`, `payment:${signature}`);
    } else {
      const existing = await kv.get<string>(`${paidKey}:code`);
      if (!existing) {
        // Claimed but unreadable. Refusing is right: minting a second code here
        // is the double-sale this counter exists to stop.
        return bad(503, 'this payment was already claimed but its code could not be read');
      }
      claimCode = existing;
    }
  } catch (e) {
    return bad(503, `the claim could not be recorded: ${(e as Error).message}`);
  }

  return NextResponse.json({
    ok: true,
    claimCode,
    payer,
    received,
    priceLamports: price,
    expires: false,
    note:
      'Redeem this at /api/issue-note. The note you receive was deposited by the treasury long ' +
      'before you paid, so no deposit of yours exists on chain. Your payment to the till is still ' +
      'public and names you — waiting before you spend is what dilutes the link between them.',
  });
}
