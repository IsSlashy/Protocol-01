import { NextRequest, NextResponse } from 'next/server';
import {
  getBufferWalletPubkey,
  registerPendingRoute,
} from '@/lib/treasury-buffer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/treasury/register-route
 *
 * Called when a user begins an on-ramp purchase (e.g. MoonPay). The client
 * pre-registers the expected payout so the backend knows to expect an
 * incoming deposit and to forward it (after a randomized delay) to the
 * final stealth recipient.
 *
 * Request body:
 *   {
 *     fiatAmount: number;             // in major units, e.g. 100 for 100 EUR
 *     fiatCurrency: 'EUR' | 'USD';
 *     destStealthAddress: string;     // base58 pubkey of final recipient
 *     expectedSolAmount: number;      // lamports we expect the on-ramp to send
 *     sourceFrom?: 'moonpay' | 'manual'; // defaults to 'moonpay'
 *   }
 *
 * Response:
 *   {
 *     id: string;                 // route id (also used for status polling)
 *     bufferAddress: string;      // where the on-ramp should send SOL
 *     scheduledPayoutAt: number;  // ms epoch of planned forwarding
 *   }
 */

interface RegisterBody {
  fiatAmount: number;
  fiatCurrency: 'EUR' | 'USD';
  destStealthAddress: string;
  expectedSolAmount: number;
  sourceFrom?: 'moonpay' | 'manual';
}

function validate(body: Partial<RegisterBody>): string | null {
  if (typeof body.fiatAmount !== 'number' || body.fiatAmount <= 0) {
    return 'fiatAmount must be a positive number';
  }
  if (body.fiatCurrency !== 'EUR' && body.fiatCurrency !== 'USD') {
    return "fiatCurrency must be 'EUR' or 'USD'";
  }
  if (
    typeof body.destStealthAddress !== 'string' ||
    body.destStealthAddress.length < 32
  ) {
    return 'destStealthAddress must be a base58 pubkey string';
  }
  if (
    typeof body.expectedSolAmount !== 'number' ||
    body.expectedSolAmount <= 0
  ) {
    return 'expectedSolAmount must be a positive lamport amount';
  }
  if (
    body.sourceFrom !== undefined &&
    body.sourceFrom !== 'moonpay' &&
    body.sourceFrom !== 'manual'
  ) {
    return "sourceFrom must be 'moonpay' or 'manual'";
  }
  return null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // NOTE: funding poll + payouts run on the Vercel cron
  // /api/cron/treasury-buffer-tick (see vercel.json). No per-request
  // bootstrap here — that pattern relied on setInterval which doesn't
  // survive Fluid Compute.

  let body: Partial<RegisterBody>;
  try {
    body = (await request.json()) as Partial<RegisterBody>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const err = validate(body);
  if (err) {
    return NextResponse.json({ error: err }, { status: 400 });
  }

  try {
    const entry = await registerPendingRoute({
      sourceFrom: body.sourceFrom ?? 'moonpay',
      fiatAmount: body.fiatAmount as number,
      fiatCurrency: body.fiatCurrency as 'EUR' | 'USD',
      destStealthAddress: body.destStealthAddress as string,
      expectedSolAmount: body.expectedSolAmount as number,
    });
    return NextResponse.json({
      id: entry.id,
      bufferAddress: getBufferWalletPubkey().toBase58(),
      scheduledPayoutAt: entry.scheduledPayoutAt,
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message ?? 'registration failed' },
      { status: 400 },
    );
  }
}
