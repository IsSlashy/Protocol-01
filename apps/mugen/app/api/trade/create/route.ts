import { NextRequest, NextResponse } from 'next/server';
import { buildCreateOrderTx } from '@/lib/mugen-tx';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/trade/create — Build an unsigned createOrder transaction.
 *
 * The client signs it with their P01 wallet (extension or mobile).
 *
 * Body: {
 *   makerWallet: string,     — maker's public key (base58)
 *   tokenMint: string,       — SPL token mint address
 *   orderType: number,       — 0 = buy_crypto, 1 = sell_crypto
 *   cryptoAmount: string,    — amount in base units (as string for BigInt)
 *   fiatAmount: string,      — fiat price in cents (as string for BigInt)
 *   fiatCurrency: string,    — 3-char ISO code, e.g. "USD"
 *   paymentMethods: number,  — bitfield (1=bank, 2=revolut, 4=wise, 8=cash, 16=sepa, 32=zelle)
 *   minAmount?: string,      — minimum partial fill (base units, default 0)
 *   maxAmount?: string,      — maximum fill per trade (base units, default 0 = full)
 *   expiresIn?: number,      — expiry in seconds (default 86400 = 24h)
 * }
 *
 * Returns: { success, transaction (base64), orderAddress, nonce }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      makerWallet,
      tokenMint,
      orderType,
      cryptoAmount,
      fiatAmount,
      fiatCurrency,
      paymentMethods,
      minAmount,
      maxAmount,
      expiresIn,
    } = body;

    if (!makerWallet || !tokenMint || fiatCurrency === undefined) {
      return NextResponse.json({ error: 'Missing required fields: makerWallet, tokenMint, fiatCurrency' }, { status: 400 });
    }

    if (orderType !== 0 && orderType !== 1) {
      return NextResponse.json({ error: 'orderType must be 0 (buy_crypto) or 1 (sell_crypto)' }, { status: 400 });
    }

    if (!cryptoAmount || !fiatAmount) {
      return NextResponse.json({ error: 'cryptoAmount and fiatAmount are required' }, { status: 400 });
    }

    if (typeof fiatCurrency !== 'string' || fiatCurrency.length !== 3) {
      return NextResponse.json({ error: 'fiatCurrency must be a 3-character ISO code' }, { status: 400 });
    }

    if (!paymentMethods || paymentMethods <= 0) {
      return NextResponse.json({ error: 'paymentMethods bitfield must be > 0' }, { status: 400 });
    }

    const result = await buildCreateOrderTx({
      makerWallet,
      tokenMint,
      orderType,
      cryptoAmount: BigInt(cryptoAmount),
      fiatAmount: BigInt(fiatAmount),
      fiatCurrency,
      paymentMethods,
      minAmount: minAmount ? BigInt(minAmount) : undefined,
      maxAmount: maxAmount ? BigInt(maxAmount) : undefined,
      expiresIn: expiresIn ? BigInt(expiresIn) : undefined,
    });

    return NextResponse.json({
      success: true,
      transaction: result.transaction,
      orderAddress: result.orderAddress,
      nonce: result.nonce,
    });
  } catch (error: any) {
    console.error('[api/trade/create] Error:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
