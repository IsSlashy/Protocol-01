import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import {
  Connection,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import { getRelayerKeypair } from '@/lib/arcium';
import {
  ESCROW_AWAITING_PAYMENT,
  ESCROW_PAYMENT_CONFIRMED,
  buildConfirmPaymentIx,
  getTakerKeypair,
  readMugenEscrow,
} from '@/lib/mugen-escrow';

/**
 * POST /api/trade/confirm-payment
 *
 * Body: { escrowPDA: string, as: 'taker' | 'maker' }
 *
 * Builds the p01_mugen.confirm_payment instruction and server-signs with the
 * appropriate keypair. Server-side signing is consistent with the existing
 * claim-match flow (relayer = seller, takerKeypair = buyer).
 */

const DEVNET_RPC =
  process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

interface ConfirmBody {
  escrowPDA: string;
  as: 'taker' | 'maker';
}

function validate(body: Partial<ConfirmBody>): string | null {
  if (typeof body.escrowPDA !== 'string' || body.escrowPDA.length < 32) {
    return 'escrowPDA must be a base58-encoded pubkey string';
  }
  if (body.as !== 'taker' && body.as !== 'maker') {
    return "as must be 'taker' or 'maker'";
  }
  try {
    new PublicKey(body.escrowPDA);
  } catch {
    return 'escrowPDA is not a valid base58 Solana pubkey';
  }
  return null;
}

export async function POST(request: NextRequest) {
  let body: Partial<ConfirmBody>;
  try {
    body = (await request.json()) as Partial<ConfirmBody>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const invalid = validate(body);
  if (invalid) {
    return NextResponse.json({ error: invalid }, { status: 400 });
  }
  const validated = body as ConfirmBody;

  try {
    const connection = new Connection(DEVNET_RPC, 'confirmed');
    const escrowPDA = new PublicKey(validated.escrowPDA);

    const escrow = await readMugenEscrow(connection, escrowPDA);
    if (!escrow) {
      return NextResponse.json(
        { error: 'Escrow account not found' },
        { status: 404 },
      );
    }

    if (escrow.status === ESCROW_PAYMENT_CONFIRMED) {
      return NextResponse.json(
        {
          ok: true,
          alreadyConfirmed: true,
          note: 'Payment was already confirmed on-chain.',
        },
      );
    }
    if (escrow.status !== ESCROW_AWAITING_PAYMENT) {
      return NextResponse.json(
        {
          error: `Escrow is not awaiting payment (status=${escrow.status})`,
        },
        { status: 409 },
      );
    }

    const signer =
      validated.as === 'taker' ? getTakerKeypair() : getRelayerKeypair();

    // Sanity check — the program requires the signer to be maker OR taker.
    if (
      !signer.publicKey.equals(escrow.maker) &&
      !signer.publicKey.equals(escrow.taker)
    ) {
      return NextResponse.json(
        {
          error:
            `Server-side ${validated.as} keypair (${signer.publicKey.toBase58()}) ` +
            `is not a participant in this escrow.`,
        },
        { status: 403 },
      );
    }

    const ix = buildConfirmPaymentIx({
      buyer: signer.publicKey,
      escrowPDA,
    });

    const tx = new Transaction().add(ix);
    // Fee payer is always the relayer — the taker keypair is funded from
    // the relayer; keep that invariant.
    const relayer = getRelayerKeypair();
    tx.feePayer = relayer.publicKey;
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;

    if (signer.publicKey.equals(relayer.publicKey)) {
      tx.sign(relayer);
    } else {
      tx.sign(relayer, signer);
    }

    const txSignature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await connection.confirmTransaction(txSignature, 'confirmed');

    return NextResponse.json({ ok: true, txSignature });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();
    // Friendly mapping for "already confirmed" on-chain errors.
    if (
      lower.includes('escrownotawaitingpayment') ||
      lower.includes('escrow is not in awaiting_payment')
    ) {
      return NextResponse.json(
        {
          ok: true,
          alreadyConfirmed: true,
          note: 'Payment was already confirmed on-chain.',
        },
      );
    }
    console.error('[api/trade/confirm-payment] error:', message);
    return NextResponse.json(
      { error: 'Internal error', detail: message },
      { status: 500 },
    );
  }
}
