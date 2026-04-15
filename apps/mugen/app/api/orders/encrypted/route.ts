// Requires env MUGEN_RELAYER_KEYPAIR (JSON file path) — see lib/arcium.ts
import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { submitEncryptedOffer } from '@protocol-01/arcium-sdk';
import { getArciumClient, getArciumProgram, pubkeyToNonceU64 } from '@/lib/arcium';
import { requestThresholdApproval } from '@/lib/frost-coordinator';
import { registerEncryptedOrder } from '@/lib/encrypted-order-registry';
import { scheduleDecoys } from '@/lib/noise-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/orders/encrypted
 *
 * Submit an encrypted P2P offer into Arcium MPC persistent state.
 * The terms (amounts, currency, payment methods) are encrypted before
 * leaving this server; the on-chain program never sees plaintext.
 */

interface EncryptedOfferBody {
  orderType: 'sell' | 'buy';
  cryptoAmountLamports: number;
  fiatAmountCents: number;
  fiatCurrency: 'EUR' | 'USD';
  paymentMethods: number;
  expiresAtUnix: number;
  makerNoncePubkey: string;
  /** Layer 3: fire N indistinguishable decoys after a successful submit. */
  boostPrivacy?: boolean;
}

function validate(body: Partial<EncryptedOfferBody>): string | null {
  if (body.orderType !== 'sell' && body.orderType !== 'buy') {
    return 'orderType must be "sell" or "buy"';
  }
  if (
    typeof body.cryptoAmountLamports !== 'number' ||
    !Number.isFinite(body.cryptoAmountLamports) ||
    body.cryptoAmountLamports <= 0
  ) {
    return 'cryptoAmountLamports must be a positive number';
  }
  if (
    typeof body.fiatAmountCents !== 'number' ||
    !Number.isFinite(body.fiatAmountCents) ||
    body.fiatAmountCents <= 0
  ) {
    return 'fiatAmountCents must be a positive number';
  }
  if (body.fiatCurrency !== 'EUR' && body.fiatCurrency !== 'USD') {
    return 'fiatCurrency must be "EUR" or "USD"';
  }
  if (
    typeof body.paymentMethods !== 'number' ||
    !Number.isInteger(body.paymentMethods) ||
    body.paymentMethods <= 0
  ) {
    return 'paymentMethods must be a positive integer bitmask';
  }
  if (
    typeof body.expiresAtUnix !== 'number' ||
    !Number.isInteger(body.expiresAtUnix) ||
    body.expiresAtUnix <= 0
  ) {
    return 'expiresAtUnix must be a positive integer';
  }
  const maxExpiresAtUnix = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
  if (body.expiresAtUnix > maxExpiresAtUnix) {
    return 'expiresAtUnix must be at most 30 days in the future';
  }
  if (typeof body.makerNoncePubkey !== 'string' || body.makerNoncePubkey.length < 32) {
    return 'makerNoncePubkey must be a base58-encoded pubkey string';
  }
  return null;
}

export async function POST(request: NextRequest) {
  // NOTE: noise-engine dispatch is driven by the Vercel cron
  // /api/cron/noise-tick (see vercel.json). No per-request bootstrap here —
  // that pattern relied on setInterval which doesn't survive Fluid Compute.

  let body: Partial<EncryptedOfferBody>;
  try {
    body = (await request.json()) as Partial<EncryptedOfferBody>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const invalid = validate(body);
  if (invalid) {
    return NextResponse.json({ error: invalid }, { status: 400 });
  }

  const validated = body as EncryptedOfferBody;

  // ═══ FROST threshold gate ══════════════════════════════════════════════
  // Compute a deterministic preimage hash of the validated request; the
  // distributed signers co-sign this hash, gating the relayer's MPC submit.
  const preimage = JSON.stringify({
    op: 'mugen.submitEncryptedOffer',
    payload: validated,
    ts: Date.now(),
  });
  const txHashHex = createHash('sha256').update(preimage).digest('hex');

  let approval;
  try {
    approval = await requestThresholdApproval(txHashHex);
  } catch (err) {
    return NextResponse.json(
      {
        error: 'FROST coordinator unreachable',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }

  if (!approval.thresholdReached) {
    return NextResponse.json(
      {
        error: 'Threshold approval not reached',
        detail: `Got ${approval.signatures.length} of ${approval.totalSigners} signers, need ${approval.threshold}`,
        signers: approval.signatures.map((s) => ({ region: s.region, port: s.port })),
        threshold: {
          reached: false,
          signaturesCount: approval.signatures.length,
          threshold: approval.threshold,
          totalSigners: approval.totalSigners,
        },
      },
      { status: 409 },
    );
  }

  try {
    const client = await getArciumClient();
    const program = await getArciumProgram();

    const receipt = await submitEncryptedOffer(client, program, {
      cryptoAmount: BigInt(validated.cryptoAmountLamports),
      fiatAmount: BigInt(validated.fiatAmountCents),
      currency: validated.fiatCurrency,
      paymentMethods: validated.paymentMethods,
      makerNonce: pubkeyToNonceU64(validated.makerNoncePubkey),
    });

    // MVP: ephemeral server-side registry of encrypted orders.
    // Production path = parse the Arcium MPC callback output to extract the
    // matched maker's nonce directly from chain, no server state needed.
    // Blocked on arcium-anchor 0.9.2 callback output wrapper ABI.
    try {
      await registerEncryptedOrder({
        makerNoncePubkey: validated.makerNoncePubkey,
        makerWallet: null,
        orderType: validated.orderType,
        cryptoAmountLamports: validated.cryptoAmountLamports,
        fiatAmountCents: validated.fiatAmountCents,
        fiatCurrency: validated.fiatCurrency,
        paymentMethods: validated.paymentMethods,
        expiresAtUnix: validated.expiresAtUnix,
        computationOffset: receipt.computationOffset.toString(),
        mpcTxSignature: receipt.signature,
        registeredAt: Math.floor(Date.now() / 1000),
      });
    } catch (regErr) {
      // Non-blocking — a duplicate nonce should not break the happy path.
      console.warn(
        '[api/orders/encrypted] registry registration failed:',
        regErr instanceof Error ? regErr.message : String(regErr),
      );
    }

    // Layer 3: if the caller opted in, schedule indistinguishable decoys
    // in the next 30s window. Failures here MUST NOT affect the real submit.
    let decoysScheduled = 0;
    if (validated.boostPrivacy) {
      try {
        const created = await scheduleDecoys(3);
        decoysScheduled = created.length;
      } catch (noiseErr) {
        // eslint-disable-next-line no-console
        console.warn(
          '[api/orders/encrypted] scheduleDecoys failed:',
          noiseErr instanceof Error ? noiseErr.message : String(noiseErr),
        );
      }
    }

    return NextResponse.json({
      ok: true,
      computationOffset: receipt.computationOffset.toString(),
      txSignature: receipt.signature,
      decoysScheduled,
      threshold: {
        reached: true,
        signaturesCount: approval.signatures.length,
        threshold: approval.threshold,
        totalSigners: approval.totalSigners,
        txHashHex,
        signers: approval.signatures.map((s) => ({
          region: s.region,
          port: s.port,
          signerPubkey: s.signerPubkey,
          signedAt: s.signedAt,
        })),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error('[api/orders/encrypted] MPC submission failed:', message);
    console.error('[api/orders/encrypted] stack:', stack);
    if (err instanceof Error && err.cause) {
      console.error('[api/orders/encrypted] cause:', err.cause);
    }
    return NextResponse.json(
      { error: 'MPC submission failed', detail: message },
      { status: 502 },
    );
  }
}
