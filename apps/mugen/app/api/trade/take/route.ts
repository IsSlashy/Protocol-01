import { NextRequest, NextResponse } from 'next/server';
import { buildTakeOrderTx } from '@/lib/mugen-tx';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/trade/take — Build an unsigned takeOrder transaction.
 *
 * The client signs it with their P01 wallet (extension or mobile).
 *
 * Body: { orderAddress, takerWallet, tokenMint, sellerTokenAccount, paymentMethod }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { orderAddress, takerWallet, tokenMint, sellerTokenAccount, paymentMethod } = body;

    if (!orderAddress || !takerWallet || !tokenMint) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const result = await buildTakeOrderTx({
      orderAddress,
      takerWallet,
      tokenMint: tokenMint,
      sellerTokenAccount: sellerTokenAccount || takerWallet,
      paymentMethod: paymentMethod || 1,
    });

    return NextResponse.json({
      success: true,
      transaction: result.transaction,
      escrowAddress: result.escrowAddress,
    });
  } catch (error: any) {
    console.error('[api/trade/take] Error:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
