// Requires env MUGEN_RELAYER_KEYPAIR (JSON file path) — see lib/arcium.ts
import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { cancelEncryptedOffer } from '@protocol-01/arcium-sdk';
import { getArciumClient, getArciumProgram, pubkeyToNonceU64 } from '@/lib/arcium';
import { requestThresholdApproval } from '@/lib/frost-coordinator';
import {
  getByMakerNonce,
  removeByMakerNonce,
} from '@/lib/encrypted-order-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/orders/cancel-encrypted
 *
 * Cancel a previously-submitted encrypted P2P offer. The maker proves
 * ownership by providing the same nonce pubkey used at submission time.
 * The relayer signature is gated by a 2-of-3 FROST quorum, then the
 * cancellation is pushed to Arcium MPC (circuit CANCEL_OFFER).
 */

interface CancelEncryptedBody {
  makerNoncePubkey: string;
}

function validate(body: Partial<CancelEncryptedBody>): string | null {
  if (
    typeof body.makerNoncePubkey !== 'string' ||
    body.makerNoncePubkey.length < 32
  ) {
    return 'makerNoncePubkey must be a base58-encoded pubkey string';
  }
  return null;
}

export async function POST(request: NextRequest) {
  let body: Partial<CancelEncryptedBody>;
  try {
    body = (await request.json()) as Partial<CancelEncryptedBody>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const invalid = validate(body);
  if (invalid) {
    return NextResponse.json({ error: invalid }, { status: 400 });
  }
  const validated = body as CancelEncryptedBody;

  const entry = await getByMakerNonce(validated.makerNoncePubkey);
  if (!entry) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  }

  // ═══ FROST threshold gate ══════════════════════════════════════════════
  const preimage = JSON.stringify({
    op: 'mugen.cancelEncryptedOffer',
    payload: { makerNoncePubkey: validated.makerNoncePubkey },
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

    const txSignature = await cancelEncryptedOffer(
      client,
      program,
      pubkeyToNonceU64(validated.makerNoncePubkey),
    );

    // Best-effort removal — even if registry drops fail, MPC already cancelled.
    await removeByMakerNonce(validated.makerNoncePubkey);

    return NextResponse.json({
      ok: true,
      txSignature,
      threshold: thresholdMeta,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error('[api/orders/cancel-encrypted] MPC cancel failed:', message);
    console.error('[api/orders/cancel-encrypted] stack:', stack);
    if (err instanceof Error && err.cause) {
      console.error('[api/orders/cancel-encrypted] cause:', err.cause);
    }
    return NextResponse.json(
      { error: 'MPC submission failed', detail: message },
      { status: 502 },
    );
  }
}
