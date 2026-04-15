import { NextResponse } from 'next/server';
import { getRelayerKeypair } from '@/lib/arcium';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/debug/relayer-pubkey
 *
 * Returns the relayer's Solana pubkey. Used by the private-trade UI to
 * pre-fill the "taker wallet" field when claiming a blind-take match.
 *
 * MVP: server-side relayer signs for both sides in the simulated escrow
 * leg. Production path: the connected user's wallet signs directly.
 */
export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'disabled in production' }, { status: 404 });
  }
  try {
    const kp = getRelayerKeypair();
    return NextResponse.json({ pubkey: kp.publicKey.toBase58() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/debug/relayer-pubkey] failed:', message);
    return NextResponse.json(
      { error: 'Relayer keypair unavailable', detail: message },
      { status: 500 },
    );
  }
}
