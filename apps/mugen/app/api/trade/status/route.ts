import { NextRequest, NextResponse } from 'next/server';
import { Connection, PublicKey } from '@solana/web3.js';

/**
 * GET /api/trade/status?escrowAddress=...
 *
 * Reads a MugenEscrow account (312 bytes) from Solana devnet and returns
 * its parsed fields as JSON.
 *
 * Escrow layout (after 8-byte Anchor discriminator):
 *   order(32) + maker(32) + taker(32) + token_mint(32) + crypto_amount(u64)
 *   + fiat_amount(u64) + escrow_vault(32) + maker_attestation(32)
 *   + taker_attestation(32) + stealth_recipient(32) + payment_method(u16)
 *   + status(u8) + created_at(i64) + expires_at(i64) + payment_confirmed_at(i64)
 *   + dispute_initiator(32) + dispute_reason(u8) + bump(u8) + vault_bump(u8)
 */

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

const NATIVE_SOL = 'So11111111111111111111111111111111111111112';
const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const DEVNET_USDT = 'EJwZgeZrdC8TXTQbQBoL6bfuAnFUQQRb18wrLowMGerG';

const TOKEN_NAMES: Record<string, string> = {
  [NATIVE_SOL]: 'SOL',
  [DEVNET_USDC]: 'USDC',
  [DEVNET_USDT]: 'USDT',
};

const STATUS_LABELS: Record<number, string> = {
  0: 'awaiting_payment',
  1: 'payment_confirmed',
  2: 'released',
  3: 'disputed',
  4: 'refunded',
  5: 'expired',
};

const PAYMENT_METHODS: Record<number, string> = {
  1: 'bank',
  2: 'revolut',
  4: 'wise',
  8: 'cash',
  16: 'sepa',
  32: 'zelle',
};

function parsePaymentMethod(value: number): string {
  return PAYMENT_METHODS[value] || `method_${value}`;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const escrowAddress = searchParams.get('escrowAddress');

  if (!escrowAddress) {
    return NextResponse.json({ error: 'Missing escrowAddress query param' }, { status: 400 });
  }

  try {
    const escrowPubkey = new PublicKey(escrowAddress);
    const connection = new Connection(RPC_URL, 'confirmed');
    const accountInfo = await connection.getAccountInfo(escrowPubkey);

    if (!accountInfo) {
      return NextResponse.json({ error: 'Escrow account not found', exists: false }, { status: 404 });
    }

    const data = Buffer.from(accountInfo.data);

    // Minimum expected size: 8 (disc) + 304 (fields) = 312
    if (data.length < 312) {
      return NextResponse.json({ error: `Unexpected account size: ${data.length} (expected 312)` }, { status: 400 });
    }

    let offset = 8; // skip Anchor discriminator

    const order = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
    const maker = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
    const taker = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
    const tokenMintKey = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
    const cryptoAmountRaw = Number(data.readBigUInt64LE(offset)); offset += 8;
    const fiatAmountRaw = Number(data.readBigUInt64LE(offset)); offset += 8;
    const escrowVault = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
    const makerAttestation = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
    const takerAttestation = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
    const stealthRecipient = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
    const paymentMethodRaw = data.readUInt16LE(offset); offset += 2;
    const statusRaw = data.readUInt8(offset); offset += 1;
    const createdAt = Number(data.readBigInt64LE(offset)); offset += 8;
    const expiresAt = Number(data.readBigInt64LE(offset)); offset += 8;
    const paymentConfirmedAt = Number(data.readBigInt64LE(offset)); offset += 8;
    const disputeInitiator = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
    const disputeReason = data.readUInt8(offset); offset += 1;
    const bump = data.readUInt8(offset); offset += 1;
    const vaultBump = data.readUInt8(offset);

    const token = TOKEN_NAMES[tokenMintKey] || 'Unknown';
    const decimals = token === 'SOL' ? 9 : 6;

    return NextResponse.json({
      exists: true,
      escrow: {
        address: escrowAddress,
        order,
        maker,
        taker,
        tokenMint: tokenMintKey,
        token,
        cryptoAmount: cryptoAmountRaw / (10 ** decimals),
        cryptoAmountRaw,
        fiatAmount: fiatAmountRaw / 100,
        fiatAmountRaw,
        escrowVault,
        makerAttestation,
        takerAttestation,
        stealthRecipient,
        paymentMethod: parsePaymentMethod(paymentMethodRaw),
        paymentMethodRaw,
        status: STATUS_LABELS[statusRaw] || `unknown_${statusRaw}`,
        statusRaw,
        createdAt,
        expiresAt,
        paymentConfirmedAt,
        disputeInitiator,
        disputeReason,
        bump,
        vaultBump,
      },
    });
  } catch (error: any) {
    console.error('[api/trade/status] Error:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
