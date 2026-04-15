import { NextRequest, NextResponse } from 'next/server';
import { Connection, PublicKey } from '@solana/web3.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import {
  ESCROW_AWAITING_PAYMENT,
  ESCROW_PAYMENT_CONFIRMED,
  ESCROW_RELEASED,
  ESCROW_DISPUTED,
  ESCROW_REFUNDED,
  ESCROW_EXPIRED,
  readMugenEscrow,
} from '@/lib/mugen-escrow';

/**
 * GET /api/trade/escrow-status?escrowPDA=...
 *
 * Reads a MugenEscrow account from Solana devnet and returns its decoded
 * lifecycle state. Distinct from the legacy /api/trade/status route — this
 * one is scoped to what the TradeLifecycleCard needs and uses the shared
 * readMugenEscrow decoder in lib/mugen-escrow.ts.
 *
 * Responses:
 *   200 { status, statusCode, ... }
 *   400 on missing query param / bad base58
 *   404 when the escrow account is missing
 *   500 on any other error
 */

const DEVNET_RPC =
  process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

type EscrowStatusLabel =
  | 'awaiting_payment'
  | 'payment_confirmed'
  | 'released'
  | 'disputed'
  | 'resolved'
  | 'expired'
  | 'unknown';

function labelFromCode(code: number): EscrowStatusLabel {
  switch (code) {
    case ESCROW_AWAITING_PAYMENT:
      return 'awaiting_payment';
    case ESCROW_PAYMENT_CONFIRMED:
      return 'payment_confirmed';
    case ESCROW_RELEASED:
      return 'released';
    case ESCROW_DISPUTED:
      return 'disputed';
    case ESCROW_REFUNDED:
      return 'resolved';
    case ESCROW_EXPIRED:
      return 'expired';
    default:
      return 'unknown';
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const escrowPDA = searchParams.get('escrowPDA');

  if (!escrowPDA) {
    return NextResponse.json(
      { error: 'Missing escrowPDA query param' },
      { status: 400 },
    );
  }

  let pda: PublicKey;
  try {
    pda = new PublicKey(escrowPDA);
  } catch {
    return NextResponse.json(
      { error: 'escrowPDA is not a valid base58 Solana pubkey' },
      { status: 400 },
    );
  }

  try {
    const connection = new Connection(DEVNET_RPC, 'confirmed');
    const escrow = await readMugenEscrow(connection, pda);

    if (!escrow) {
      return NextResponse.json(
        { error: 'Escrow account not found', exists: false },
        { status: 404 },
      );
    }

    const status = labelFromCode(escrow.status);
    const nowSec = Math.floor(Date.now() / 1000);
    // Surface a derived "expired" flag even when the on-chain status is still
    // awaiting_payment — the program only flips to EXPIRED lazily.
    const derivedExpired =
      status === 'awaiting_payment' &&
      escrow.expiresAt > 0 &&
      nowSec >= escrow.expiresAt;

    return NextResponse.json({
      exists: true,
      status: derivedExpired ? 'expired' : status,
      statusCode: escrow.status,
      maker: escrow.maker.toBase58(),
      taker: escrow.taker.toBase58(),
      cryptoAmount: escrow.cryptoAmount.toString(),
      fiatAmount: escrow.fiatAmount.toString(),
      expiresAt: escrow.expiresAt,
      paymentConfirmedAt: escrow.paymentConfirmedAt,
      vault: escrow.vault.toBase58(),
      tokenMint: escrow.tokenMint.toBase58(),
      disputeReason: escrow.disputeReason,
      disputeInitiator: escrow.disputeInitiator.toBase58(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/trade/escrow-status] error:', message);
    return NextResponse.json(
      { error: 'Internal error', detail: message },
      { status: 500 },
    );
  }
}
