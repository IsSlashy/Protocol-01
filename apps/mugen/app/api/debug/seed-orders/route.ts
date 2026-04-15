import { NextResponse } from 'next/server';
import { Keypair } from '@solana/web3.js';
import {
  registerEncryptedOrder,
  listActive,
  clearRegistry,
  type EncryptedOrderEntry,
} from '@/lib/encrypted-order-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/debug/seed-orders — list active registry entries for debugging. */
export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Disabled in production' }, { status: 403 });
  }
  const entries = await listActive();
  return NextResponse.json({ count: entries.length, entries });
}

/** DELETE /api/debug/seed-orders — wipe the registry (dev-only). */
export async function DELETE() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Disabled in production' }, { status: 403 });
  }
  const before = (await listActive()).length;
  await clearRegistry();
  return NextResponse.json({ ok: true, cleared: before });
}

/**
 * POST /api/debug/seed-orders
 *
 * Dev-only helper: seeds the ephemeral encrypted-order registry with three
 * sample sell offers so a subsequent blind take is guaranteed to match.
 *
 * MVP: ephemeral server-side registry of encrypted orders.
 * Production path = parse the Arcium MPC callback output to extract the
 * matched maker's nonce directly from chain, no server state needed.
 * Blocked on arcium-anchor 0.9.2 callback output wrapper ABI.
 *
 * Guarded by NODE_ENV !== 'production'.
 */
export async function POST() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { error: 'Seeder disabled in production' },
      { status: 403 },
    );
  }

  const nowUnix = Math.floor(Date.now() / 1000);
  const expiry = nowUnix + 60 * 60; // 1 hour

  // Small amounts (0.01 — 0.03 SOL) so the token-escrow path fits the
  // relayer's devnet wSOL balance. The privacy story is amount-agnostic;
  // demo amounts just need to be > MugenConfig.min_trade_amount (typically
  // 0.001 SOL = 1_000_000 lamports) and affordable to wrap.
  const samples: Array<Omit<EncryptedOrderEntry, 'makerNoncePubkey'>> = [
    {
      makerWallet: null,
      orderType: 'sell',
      cryptoAmountLamports: 10_000_000, // 0.01 SOL
      fiatAmountCents: 180, // 1.80 EUR
      fiatCurrency: 'EUR',
      paymentMethods: 0b00011, // SEPA | Revolut
      expiresAtUnix: expiry,
      computationOffset: 'seed-1',
      mpcTxSignature: 'seed-signature-1',
      registeredAt: nowUnix,
    },
    {
      makerWallet: null,
      orderType: 'sell',
      cryptoAmountLamports: 20_000_000, // 0.02 SOL
      fiatAmountCents: 360, // 3.60 USD
      fiatCurrency: 'USD',
      paymentMethods: 0b10100, // Cash | Zelle
      expiresAtUnix: expiry,
      computationOffset: 'seed-2',
      mpcTxSignature: 'seed-signature-2',
      registeredAt: nowUnix,
    },
    {
      makerWallet: null,
      orderType: 'sell',
      cryptoAmountLamports: 30_000_000, // 0.03 SOL
      fiatAmountCents: 540, // 5.40 EUR
      fiatCurrency: 'EUR',
      paymentMethods: 0b00111, // SEPA | Revolut | Wise
      expiresAtUnix: expiry,
      computationOffset: 'seed-3',
      mpcTxSignature: 'seed-signature-3',
      registeredAt: nowUnix,
    },
  ];

  let seeded = 0;
  for (const sample of samples) {
    const nonce = Keypair.generate().publicKey.toBase58();
    try {
      await registerEncryptedOrder({ ...sample, makerNoncePubkey: nonce });
      seeded += 1;
    } catch (err) {
      console.warn(
        '[api/debug/seed-orders] skipped one entry:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  console.info('[api/debug/seed-orders] seeded', { seeded });
  return NextResponse.json({ ok: true, seeded });
}
