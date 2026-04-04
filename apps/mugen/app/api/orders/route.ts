import { NextRequest, NextResponse } from 'next/server';
import { Connection, PublicKey } from '@solana/web3.js';

/**
 * GET /api/orders — Fetch real orders from Solana devnet
 *
 * Reads MugenOrder accounts directly from the on-chain program.
 */

const MUGEN_PROGRAM_ID = new PublicKey('EURLevwgmunRQU5piF7QLB1ithMPfxYFXp6jp6eGEAJN');
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const NATIVE_SOL = 'So11111111111111111111111111111111111111112';
const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const DEVNET_USDT = 'EJwZgeZrdC8TXTQbQBoL6bfuAnFUQQRb18wrLowMGerG';

const TOKEN_NAMES: Record<string, string> = {
  [NATIVE_SOL]: 'SOL',
  [DEVNET_USDC]: 'USDC',
  [DEVNET_USDT]: 'USDT',
};

const STATUS_MAP: Record<number, string> = {
  0: 'open', 1: 'in_escrow', 2: 'completed', 3: 'cancelled', 4: 'disputed', 5: 'expired',
};

const PAYMENT_BITFIELD: Record<number, string> = {
  1: 'bank', 2: 'revolut', 4: 'wise', 8: 'cash', 16: 'sepa', 32: 'zelle',
};

function parseMethods(bitfield: number): string[] {
  const methods: string[] = [];
  for (const [bit, method] of Object.entries(PAYMENT_BITFIELD)) {
    if (bitfield & Number(bit)) methods.push(method);
  }
  return methods;
}

// Cache: refresh every 10s
let cachedOrders: any[] | null = null;
let cacheTime = 0;
const CACHE_TTL = 10_000;

export async function GET(request: NextRequest) {
  const now = Date.now();

  // Return cache if fresh
  if (cachedOrders && now - cacheTime < CACHE_TTL) {
    return NextResponse.json({ orders: cachedOrders, cached: true, count: cachedOrders.length });
  }

  try {
    const connection = new Connection(RPC_URL, 'confirmed');
    const accounts = await connection.getProgramAccounts(MUGEN_PROGRAM_ID, {
      filters: [{ dataSize: 208 }], // MugenOrder account size
    });

    const orders = accounts.map(({ pubkey, account }) => {
      try {
        const data = Buffer.from(account.data);
        let offset = 8; // skip discriminator
        const maker = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
        const orderTypeU8 = data.readUInt8(offset); offset += 1;
        const tokenMint = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
        const cryptoAmount = Number(data.readBigUInt64LE(offset)); offset += 8;
        const fiatAmount = Number(data.readBigUInt64LE(offset)); offset += 8;
        const fiatCurrency = data.subarray(offset, offset + 3).toString('ascii').replace(/\0/g, ''); offset += 3;
        const paymentBitfield = data.readUInt16LE(offset); offset += 2;
        offset += 8 + 8 + 32 + 32 + 16; // min, max, compliance, reputation, nonce
        const status = data.readUInt8(offset); offset += 1;
        const createdAt = Number(data.readBigInt64LE(offset)); offset += 8;
        const expiresAt = Number(data.readBigInt64LE(offset));

        const token = TOKEN_NAMES[tokenMint] || 'Unknown';
        const decimals = token === 'SOL' ? 9 : 6;

        return {
          address: pubkey.toBase58(),
          maker,
          orderType: orderTypeU8 === 0 ? 'buy_crypto' : 'sell_crypto',
          token,
          tokenMint,
          cryptoAmount: cryptoAmount / (10 ** decimals),
          fiatAmount: fiatAmount / 100, // cents to dollars
          fiatCurrency,
          paymentMethods: parseMethods(paymentBitfield),
          status: STATUS_MAP[status] || 'unknown',
          createdAt,
          expiresAt,
        };
      } catch {
        return null;
      }
    }).filter(Boolean);

    cachedOrders = orders;
    cacheTime = now;

    return NextResponse.json({ orders, cached: false, count: orders.length });
  } catch (error: any) {
    console.error('[api/orders] Error:', error.message);
    // Return cache even if stale
    if (cachedOrders) {
      return NextResponse.json({ orders: cachedOrders, cached: true, stale: true, count: cachedOrders.length });
    }
    return NextResponse.json({ orders: [], error: error.message, count: 0 }, { status: 500 });
  }
}
