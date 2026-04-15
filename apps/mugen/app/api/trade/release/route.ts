import { NextRequest, NextResponse } from 'next/server';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { buildReleaseEscrowTx } from '@/lib/mugen-tx';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

/**
 * POST /api/trade/release — Build an unsigned releaseEscrow transaction.
 *
 * Body: { escrowAddress, sellerWallet }
 * Returns: { success, transaction (base64) }
 *
 * Reads the escrow account on-chain to determine the taker (buyer) and
 * token mint, then derives the buyer's associated token account.
 */
export async function POST(request: NextRequest) {
  try {
    const { escrowAddress, sellerWallet } = await request.json();

    if (!escrowAddress || !sellerWallet) {
      return NextResponse.json(
        { error: 'Missing required fields: escrowAddress, sellerWallet' },
        { status: 400 },
      );
    }

    // Read escrow to get taker + token_mint for ATA derivation
    const connection = new Connection(RPC_URL, 'confirmed');
    const escrowPubkey = new PublicKey(escrowAddress);
    const escrowInfo = await connection.getAccountInfo(escrowPubkey);

    if (!escrowInfo) {
      return NextResponse.json({ error: 'Escrow account not found' }, { status: 404 });
    }

    const data = Buffer.from(escrowInfo.data);
    let offset = 8; // skip discriminator
    /* order */ offset += 32;
    /* maker */ offset += 32;
    const taker = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
    const tokenMint = new PublicKey(data.subarray(offset, offset + 32));

    // Derive buyer's associated token account
    const buyerTokenAccount = await getAssociatedTokenAddress(tokenMint, taker);

    const transaction = await buildReleaseEscrowTx({
      escrowAddress,
      sellerWallet,
      buyerTokenAccount: buyerTokenAccount.toBase58(),
    });

    return NextResponse.json({
      success: true,
      transaction,
    });
  } catch (error: any) {
    console.error('[api/trade/release] Error:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
