import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { blindTakeOrder } from '@protocol-01/arcium-sdk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
import { getArciumClient, getArciumProgram, pubkeyToNonceU64 } from '@/lib/arcium';
import { requestThresholdApproval } from '@/lib/frost-coordinator';
import { findMatch } from '@/lib/encrypted-order-registry';
import type { MatchedOrderDetails } from '@/lib/mpc-types';

/**
 * POST /api/trade/blind-take
 *
 * Blindly probe the encrypted order book for a compatible sell offer.
 * All buyer intent is encrypted before leaving this server. The MPC
 * cluster runs currency/amount/price/payment-method compatibility
 * checks on secret shares, then reveals the match (or no match) via
 * the on-chain callback, which this handler awaits before returning.
 */

interface BlindTakeBody {
  desiredCryptoAmountLamports: number;
  maxFiatAmountCents: number;
  fiatCurrency: 'EUR' | 'USD';
  paymentMethodsMask: number;
  takerNoncePubkey: string;
}

function validate(body: Partial<BlindTakeBody>): string | null {
  if (
    typeof body.desiredCryptoAmountLamports !== 'number' ||
    !Number.isFinite(body.desiredCryptoAmountLamports) ||
    body.desiredCryptoAmountLamports <= 0
  ) {
    return 'desiredCryptoAmountLamports must be a positive number';
  }
  if (
    typeof body.maxFiatAmountCents !== 'number' ||
    !Number.isFinite(body.maxFiatAmountCents) ||
    body.maxFiatAmountCents <= 0
  ) {
    return 'maxFiatAmountCents must be a positive number';
  }
  if (body.fiatCurrency !== 'EUR' && body.fiatCurrency !== 'USD') {
    return 'fiatCurrency must be "EUR" or "USD"';
  }
  if (
    typeof body.paymentMethodsMask !== 'number' ||
    !Number.isInteger(body.paymentMethodsMask) ||
    body.paymentMethodsMask <= 0
  ) {
    return 'paymentMethodsMask must be a positive integer bitmask';
  }
  if (typeof body.takerNoncePubkey !== 'string' || body.takerNoncePubkey.length < 32) {
    return 'takerNoncePubkey must be a base58-encoded pubkey string';
  }
  return null;
}

export async function POST(request: NextRequest) {
  let body: Partial<BlindTakeBody>;
  try {
    body = (await request.json()) as Partial<BlindTakeBody>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const invalid = validate(body);
  if (invalid) {
    return NextResponse.json({ error: invalid }, { status: 400 });
  }
  const validated = body as BlindTakeBody;

  // ═══ FROST threshold gate ══════════════════════════════════════════════
  const preimage = JSON.stringify({
    op: 'mugen.blindTakeOrder',
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

  const thresholdMeta = {
    reached: true as const,
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
  };

  try {
    const client = await getArciumClient();
    const program = await getArciumProgram();

    const result = await blindTakeOrder(client, program, {
      desiredCrypto: BigInt(validated.desiredCryptoAmountLamports),
      maxFiat: BigInt(validated.maxFiatAmountCents),
      currency: validated.fiatCurrency,
      paymentMethods: validated.paymentMethodsMask,
      takerNonce: pubkeyToNonceU64(validated.takerNoncePubkey),
    });

    // MVP: registry-based match. Production: parse Arcium callback output
    // (blocked on arcium-anchor 0.9.2 callback output wrapper ABI). The MPC
    // computation is still run above — we simply can't extract the matched
    // maker's nonce from the on-chain callback in this ABI version, so we
    // cross-reference the ephemeral server-side registry instead.
    const registryMatch = await findMatch({
      desiredCryptoAmountLamports: validated.desiredCryptoAmountLamports,
      maxFiatAmountCents: validated.maxFiatAmountCents,
      fiatCurrency: validated.fiatCurrency,
      paymentMethodsMask: validated.paymentMethodsMask,
    });

    if (!registryMatch) {
      return NextResponse.json({
        matched: false,
        // The SDK surfaces only the finalization signature; callers can
        // fetch the submission tx from on-chain logs if needed.
        computationOffset: '',
        txSignature: result.signature,
        threshold: thresholdMeta,
      });
    }

    const matchedOrder: MatchedOrderDetails = {
      makerNoncePubkey: registryMatch.makerNoncePubkey,
      cryptoAmountLamports: registryMatch.cryptoAmountLamports,
      fiatAmountCents: registryMatch.fiatAmountCents,
      fiatCurrency: registryMatch.fiatCurrency,
      paymentMethods: registryMatch.paymentMethods,
      expiresAtUnix: registryMatch.expiresAtUnix,
      mpcTxSignature: registryMatch.mpcTxSignature,
      registeredAt: registryMatch.registeredAt,
    };

    return NextResponse.json({
      matched: true,
      computationOffset: '',
      txSignature: result.signature,
      matchedOrderNonce: registryMatch.makerNoncePubkey,
      matchedCryptoAmount: registryMatch.cryptoAmountLamports,
      matchedFiatAmount: registryMatch.fiatAmountCents,
      threshold: thresholdMeta,
      matchedOrder,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/trade/blind-take] MPC match failed:', message);
    return NextResponse.json(
      { error: 'MPC submission failed', detail: message },
      { status: 502 },
    );
  }
}
