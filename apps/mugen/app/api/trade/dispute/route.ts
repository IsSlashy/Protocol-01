import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import {
  Connection,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import { getRelayerKeypair } from '@/lib/arcium';
import {
  buildDisputeEscrowIx,
  getTakerKeypair,
  readMugenEscrow,
  ESCROW_AWAITING_PAYMENT,
  ESCROW_PAYMENT_CONFIRMED,
} from '@/lib/mugen-escrow';

/**
 * POST /api/trade/dispute
 *
 * Body: { escrowPDA: string, as: 'taker' | 'maker', reason: number }
 *
 * Opens a dispute on the escrow. The program only accepts disputes from
 * AWAITING_PAYMENT or PAYMENT_CONFIRMED. Reason is a u8 code the resolver
 * interprets off-chain (1=fiat_not_sent, 2=fiat_amount_mismatch, etc.).
 */

const DEVNET_RPC =
  process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

interface DisputeBody {
  escrowPDA: string;
  as: 'taker' | 'maker';
  reason: number;
}

function validate(body: Partial<DisputeBody>): string | null {
  if (typeof body.escrowPDA !== 'string' || body.escrowPDA.length < 32) {
    return 'escrowPDA must be a base58-encoded pubkey string';
  }
  if (body.as !== 'taker' && body.as !== 'maker') {
    return "as must be 'taker' or 'maker'";
  }
  if (
    typeof body.reason !== 'number' ||
    !Number.isInteger(body.reason) ||
    body.reason < 0 ||
    body.reason > 255
  ) {
    return 'reason must be an integer in [0, 255]';
  }
  try {
    new PublicKey(body.escrowPDA);
  } catch {
    return 'escrowPDA is not a valid base58 Solana pubkey';
  }
  return null;
}

export async function POST(request: NextRequest) {
  let body: Partial<DisputeBody>;
  try {
    body = (await request.json()) as Partial<DisputeBody>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const invalid = validate(body);
  if (invalid) {
    return NextResponse.json({ error: invalid }, { status: 400 });
  }
  const validated = body as DisputeBody;

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

    if (
      escrow.status !== ESCROW_AWAITING_PAYMENT &&
      escrow.status !== ESCROW_PAYMENT_CONFIRMED
    ) {
      return NextResponse.json(
        {
          error:
            `Escrow is not disputable in current state (status=${escrow.status})`,
        },
        { status: 409 },
      );
    }

    const signer =
      validated.as === 'taker' ? getTakerKeypair() : getRelayerKeypair();

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

    const ix = buildDisputeEscrowIx({
      disputer: signer.publicKey,
      escrowPDA,
      reason: validated.reason,
    });

    const relayer = getRelayerKeypair();
    const tx = new Transaction().add(ix);
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
    console.error('[api/trade/dispute] error:', message);
    return NextResponse.json(
      { error: 'Internal error', detail: message },
      { status: 500 },
    );
  }
}
