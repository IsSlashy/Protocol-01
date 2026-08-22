import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';

import { getStore } from '@/lib/waitlist/store';

/**
 * mint-claim — create ONE claim code, redeemable for one note.
 *
 * WHY THIS IS SEPARATE FROM `/api/issue-note`
 * ───────────────────────────────────────────
 * Issuing a note gives away the denomination. `/api/issue-note` therefore
 * refuses without a claim code that was MINTED against a payment, and this is
 * the only thing that mints one. Two endpoints, two secrets, and the one the
 * browser holds cannot create value.
 *
 * ⛔ THE TICKET DOES NOT OPEN THIS DOOR. `P01_FUNDER_TICKET` ships in the
 * browser bundle by design — `ephemeralFunder.ts` says so in its own header —
 * so guarding minting with it would mean anyone who reads the bundle can mint
 * themselves unlimited notes. This takes `P01_CLAIM_MINT_SECRET`, which exists
 * only on the server, and refuses outright when it is unset. Unconfigured means
 * no minting, never "minting is open".
 *
 * WHERE A REAL PAYMENT PLUGS IN
 * ─────────────────────────────
 * This is a seam, not a payment integration, and it is not described as one. A
 * settled-payment webhook calls this with the mint secret and hands the code to
 * the buyer; the buyer redeems it at `/api/issue-note`. Until such a webhook
 * exists, an operator calls it by hand — which is exactly what makes the flow
 * testable end to end without pretending a card was charged.
 *
 * `reference` is stored with the claim so a mint can be traced back to whatever
 * authorised it. It is written, not verified: this endpoint cannot know what a
 * payment processor's receipt looks like, and inventing a check it cannot
 * perform would be worse than recording the string it was given.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 🚨 A PAID CLAIM DOES NOT EXPIRE. FOUNDER RULING, 2026-08-22.
 *
 * This used to be `{ ex: 24 * 60 * 60 }`, on the reasoning that "an unredeemed
 * claim cannot sit as a permanent bearer asset". That reasoning protected the
 * operator's inventory at the paying customer's expense, and the failure it
 * produced was not "the code stops working" but something worse:
 *
 *   1. `claim-minted:<code>` expires after a day.
 *   2. The customer redeems on day two. `incr` on `claim:<code>` returns 1,
 *      so the claim is CONSUMED.
 *   3. `minted` reads null, so the route answers 402 "this claim code was
 *      never issued against a payment".
 *   4. The release path is deliberately gated on `minted` (a code that was
 *      never minted is burned on first touch, which is what makes guessing
 *      cost something), so the claim is NOT given back.
 *
 * The customer paid, is told they never paid, and cannot retry. A bearer asset
 * somebody bought is not a liability to be timed out; it is the thing they
 * bought. The merchant may change their prices whenever they like, and that
 * changes nothing about an entitlement already sold.
 *
 * ⚠️ THE COST IS REAL AND IT IS OURS TO CARRY. An unredeemed claim means the
 * treasury must keep a note in stock for it, with no deadline. That is a debt
 * we owe, not a risk to push onto the person who already paid. If inventory
 * pressure ever needs managing, it is managed by minting against stock, never
 * by cancelling an entitlement somebody holds.
 */

function bad(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

export async function POST(request: NextRequest) {
  const secret = process.env.P01_CLAIM_MINT_SECRET;
  if (!secret || secret.length < 16) {
    return bad(503, 'no claim mint secret configured; refusing to mint');
  }
  if (request.headers.get('x-p01-claim-mint') !== secret) {
    return bad(401, 'bad or missing claim mint secret');
  }

  const kv = getStore();
  if (!kv) return bad(503, 'no durable store; a claim that is not recorded cannot be redeemed');

  let body: { reference?: unknown };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const reference = String(body.reference ?? 'manual').slice(0, 200);

  // 32 bytes of CSPRNG, base64url. Guessing one is not a threat model this
  // endpoint has to reason about, and a code short enough to type is a code
  // short enough to enumerate.
  const claimCode = randomBytes(32).toString('base64url');

  try {
    // ⛔ NO `ex`. See the block above CLAIM_TTL_SECONDS's removal: a TTL here
    // makes a paying customer's code answer "never issued against a payment"
    // and burns it on the way. The absence of an expiry option is the feature.
    await kv.set(`p01:note:claim-minted:${claimCode}`, reference);
  } catch (e) {
    return bad(503, `the claim could not be recorded: ${(e as Error).message}`);
  }

  return NextResponse.json({
    ok: true,
    claimCode,
    // Stated positively and returned to the caller, because the webhook that
    // hands this to a buyer is where a deadline would otherwise be invented.
    expires: false,
    reference,
    note:
      'Worth exactly one note. It is consumed on first redemption whether or not a note is ' +
      'delivered, so a failed issuance needs a new claim rather than a retry — that is what stops ' +
      'a guessed code being retried until it works.',
  });
}
