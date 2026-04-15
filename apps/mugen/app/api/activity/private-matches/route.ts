import { NextResponse } from 'next/server';
import { Connection, PublicKey } from '@solana/web3.js';

/**
 * GET /api/activity/private-matches
 *
 * Queries Solana devnet for every MugenReputation PDA owned by p01_mugen.
 * Each PDA = one past private match receipt (created by claim-match via
 * mugen.init_reputation with a commitment-bound seed).
 *
 * Returns basic metadata + the first 16 bytes of the commitment so the UI
 * can render a live "private matches on devnet" feed without exposing the
 * full match terms (which stay in the MPC state + registry).
 */

const P01_MUGEN_PROGRAM_ID = new PublicKey(
  'EURLevwgmunRQU5piF7QLB1ithMPfxYFXp6jp6eGEAJN',
);
const DEVNET_RPC =
  process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

// Anchor account discriminator for `MugenReputation` = sha256("account:MugenReputation")[0..8]
const REPUTATION_DISCRIMINATOR = Buffer.from([
  155, 28, 49, 207, 127, 207, 182, 66,
]);

// Account layout (from programs/p01_mugen/src/state/mod.rs):
//   disc(8) + commitment(32) + trades_completed(u32) + trades_disputed(u32)
//   + total_volume(u64) + avg_payment_time(u32) + positive(u32) + negative(u32)
//   + first_trade_at(i64) + last_trade_at(i64) + bump(u8)
// LEN = 85 bytes total
const REPUTATION_LEN = 85;

interface MatchReceipt {
  pda: string;
  commitmentPrefix: string; // first 8 bytes hex
  tradesCompleted: number;
  totalVolume: string;
  lamports: number;
  firstTradeAt: number;
  lastTradeAt: number;
}

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const connection = new Connection(DEVNET_RPC, 'confirmed');

    // getProgramAccounts with discriminator memcmp filter + expected size.
    const accounts = await connection.getProgramAccounts(P01_MUGEN_PROGRAM_ID, {
      commitment: 'confirmed',
      dataSlice: { offset: 0, length: REPUTATION_LEN },
      filters: [
        { dataSize: REPUTATION_LEN },
        {
          memcmp: {
            offset: 0,
            bytes: REPUTATION_DISCRIMINATOR.toString('base64'),
            encoding: 'base64',
          },
        },
      ],
    });

    const receipts: MatchReceipt[] = accounts.map(({ pubkey, account }) => {
      const data = account.data as Buffer;
      // Skip discriminator (8 bytes)
      const commitment = data.subarray(8, 8 + 32);
      const tradesCompleted = data.readUInt32LE(8 + 32);
      const totalVolume = data.readBigUInt64LE(8 + 32 + 4 + 4);
      const firstTradeAt = Number(
        data.readBigInt64LE(8 + 32 + 4 + 4 + 8 + 4 + 4 + 4),
      );
      const lastTradeAt = Number(
        data.readBigInt64LE(8 + 32 + 4 + 4 + 8 + 4 + 4 + 4 + 8),
      );
      return {
        pda: pubkey.toBase58(),
        commitmentPrefix: commitment.subarray(0, 8).toString('hex'),
        tradesCompleted,
        totalVolume: totalVolume.toString(),
        lamports: account.lamports,
        firstTradeAt,
        lastTradeAt,
      };
    });

    // Newest-first by lastTradeAt (falls back to address order when 0)
    receipts.sort((a, b) => b.lastTradeAt - a.lastTradeAt);

    return NextResponse.json({
      count: receipts.length,
      programId: P01_MUGEN_PROGRAM_ID.toBase58(),
      rpc: DEVNET_RPC,
      receipts: receipts.slice(0, 25),
      fetchedAt: Date.now(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/activity/private-matches] failed:', message);
    return NextResponse.json(
      { error: 'Failed to fetch private matches', detail: message },
      { status: 500 },
    );
  }
}
