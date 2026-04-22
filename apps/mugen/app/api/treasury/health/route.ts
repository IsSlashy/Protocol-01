/**
 * GET /api/treasury/health
 *
 * Lightweight liveness probe for the Treasury Buffer. Mobile clients call
 * this on the Buy screen mount so they can show "buffer offline — direct
 * stealth payout" BEFORE the user taps Buy, instead of letting them register
 * a route that never forwards.
 *
 * Returns the buffer wallet balance, last runner tick timestamp, last payout
 * timestamp, and a per-status queue depth. `healthy: false` means at least
 * one of: balance below floor, runner tick stale, runner never ticked.
 */
import { Connection } from '@solana/web3.js';
import { NextResponse } from 'next/server';
import { getTreasuryHealth } from '@/lib/treasury-buffer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function resolveRpcUrl(): string {
  return process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
}

export async function GET(): Promise<NextResponse> {
  try {
    const connection = new Connection(resolveRpcUrl(), 'confirmed');
    const health = await getTreasuryHealth(connection);
    return NextResponse.json(health);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        healthy: false,
        reason: `health probe failed: ${message}`,
      },
      { status: 500 },
    );
  }
}
