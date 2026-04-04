import { NextRequest, NextResponse } from 'next/server';
import { buildConfirmPaymentTx } from '@/lib/mugen-tx';

/**
 * POST /api/trade/confirm — Build an unsigned confirmPayment transaction.
 *
 * Body: { escrowAddress, buyerWallet }
 */
export async function POST(request: NextRequest) {
  try {
    const { escrowAddress, buyerWallet } = await request.json();

    if (!escrowAddress || !buyerWallet) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const transaction = await buildConfirmPaymentTx({ escrowAddress, buyerWallet });

    return NextResponse.json({
      success: true,
      transaction,
    });
  } catch (error: any) {
    console.error('[api/trade/confirm] Error:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
