/**
 * Mugen Exchange P2P Service
 *
 * Handles P2P fiat-to-crypto orders via the Mugen Exchange program on Solana.
 * No KYC required — uses ZK compliance attestations.
 *
 * Flow:
 * 1. Browse sell orders (sellers offering crypto for fiat)
 * 2. Take order → crypto locked in on-chain escrow
 * 3. Send fiat via IBAN/CB directly to seller
 * 4. Confirm payment → seller releases escrow
 * 5. Crypto arrives at your wallet (or stealth address)
 */

import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  ComputeBudgetProgram,
  type Keypair,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { getConnection } from '@/services/solana/connection';

// ─── Constants ──────────────────────────────────────────────────────────────

export const MUGEN_PROGRAM_ID = new PublicKey('EURLevwgmunRQU5piF7QLB1ithMPfxYFXp6jp6eGEAJN');

const CONFIG_SEED = 'mugen_config';
const ORDER_SEED = 'mugen_order';
const ESCROW_SEED = 'mugen_escrow';
const VAULT_SEED = 'mugen_vault';
const REPUTATION_SEED = 'mugen_rep';

export type PaymentMethod = 'bank' | 'revolut' | 'wise' | 'sepa' | 'zelle' | 'cash';
export type OrderType = 'buy_crypto' | 'sell_crypto';
export type OrderStatus = 'open' | 'in_escrow' | 'completed' | 'cancelled' | 'disputed' | 'expired';
export type EscrowStatus = 'awaiting_payment' | 'payment_confirmed' | 'released' | 'disputed' | 'refunded' | 'expired';

export interface MugenOrder {
  address: string;
  maker: string;
  orderType: OrderType;
  token: string;
  tokenMint: string;
  cryptoAmount: number;
  fiatAmount: number; // in cents
  fiatCurrency: string;
  paymentMethods: PaymentMethod[];
  reputation: { trades: number; positive: number };
  status: OrderStatus;
  createdAt: number;
  expiresAt: number;
}

export interface MugenEscrow {
  address: string;
  order: string;
  maker: string;
  taker: string;
  cryptoAmount: number;
  fiatAmount: number;
  status: EscrowStatus;
  createdAt: number;
  expiresAt: number;
  paymentMethod: PaymentMethod;
}

export interface CryptoPrice {
  symbol: string;
  usd: number;
  eur: number;
  gbp: number;
}

// ─── Payment method display config ──────────────────────────────────────────

export const PAYMENT_METHOD_CONFIG: Record<PaymentMethod, {
  name: string;
  icon: string;
  processingTime: string;
  description: string;
}> = {
  bank: {
    name: 'Bank Transfer (IBAN)',
    icon: 'business-outline',
    processingTime: '1-2 business days',
    description: 'Direct wire transfer to seller\'s IBAN',
  },
  revolut: {
    name: 'Revolut',
    icon: 'swap-horizontal-outline',
    processingTime: 'Instant',
    description: 'Send via Revolut tag or phone number',
  },
  wise: {
    name: 'Wise (TransferWise)',
    icon: 'globe-outline',
    processingTime: '1-2 hours',
    description: 'Low-fee international transfer via Wise',
  },
  sepa: {
    name: 'SEPA Transfer',
    icon: 'card-outline',
    processingTime: '1 business day',
    description: 'EUR SEPA bank transfer',
  },
  zelle: {
    name: 'Zelle',
    icon: 'flash-outline',
    processingTime: 'Instant',
    description: 'US bank-to-bank instant transfer',
  },
  cash: {
    name: 'Cash Deposit',
    icon: 'cash-outline',
    processingTime: 'Same day',
    description: 'In-person cash deposit at bank',
  },
};

// ─── Price fetching ─────────────────────────────────────────────────────────

export async function fetchCryptoPrices(): Promise<CryptoPrice[]> {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana,usd-coin,tether&vs_currencies=usd,eur,gbp',
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    const data = await res.json();
    return [
      { symbol: 'SOL', usd: data.solana?.usd ?? 0, eur: data.solana?.eur ?? 0, gbp: data.solana?.gbp ?? 0 },
      { symbol: 'USDC', usd: data['usd-coin']?.usd ?? 1, eur: data['usd-coin']?.eur ?? 0.92, gbp: data['usd-coin']?.gbp ?? 0.79 },
      { symbol: 'USDT', usd: data.tether?.usd ?? 1, eur: data.tether?.eur ?? 0.92, gbp: data.tether?.gbp ?? 0.79 },
    ];
  } catch {
    // Fallback
    return [
      { symbol: 'SOL', usd: 148, eur: 136, gbp: 117 },
      { symbol: 'USDC', usd: 1, eur: 0.92, gbp: 0.79 },
      { symbol: 'USDT', usd: 1, eur: 0.92, gbp: 0.79 },
    ];
  }
}

// ─── Order fetching ─────────────────────────────────────────────────────────

const PAYMENT_BITFIELD: Record<number, PaymentMethod> = {
  1: 'bank', 2: 'revolut', 4: 'wise', 8: 'cash', 16: 'sepa', 32: 'zelle',
};

function parseMethods(bitfield: number): PaymentMethod[] {
  const methods: PaymentMethod[] = [];
  for (const [bit, method] of Object.entries(PAYMENT_BITFIELD)) {
    if (bitfield & Number(bit)) methods.push(method);
  }
  return methods;
}

const STATUS_MAP: Record<number, OrderStatus> = {
  0: 'open', 1: 'in_escrow', 2: 'completed', 3: 'cancelled', 4: 'disputed', 5: 'expired',
};

const TOKEN_MINTS: Record<string, string> = {
  So11111111111111111111111111111111111111112: 'SOL',
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU': 'USDC',
  EJwZgeZrdC8TXTQbQBoL6bfuAnFUQQRb18wrLowMGerG: 'USDT',
};

export async function fetchOrders(): Promise<MugenOrder[]> {
  try {
    const connection = getConnection();
    const accounts = await connection.getProgramAccounts(MUGEN_PROGRAM_ID, {
      filters: [{ dataSize: 200 }], // MugenOrder size
    });

    return accounts.map(({ pubkey, account }) => {
      const data = Buffer.from(account.data);
      let offset = 8;
      const maker = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
      const orderTypeU8 = data.readUInt8(offset); offset += 1;
      const tokenMint = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
      const cryptoAmount = Number(data.readBigUInt64LE(offset)); offset += 8;
      const fiatAmount = Number(data.readBigUInt64LE(offset)); offset += 8;
      const fiatCurrency = data.subarray(offset, offset + 3).toString('ascii').replace(/\0/g, ''); offset += 3;
      const paymentBitfield = data.readUInt16LE(offset); offset += 2;
      offset += 8 + 8; // min/max
      offset += 32; // compliance
      offset += 32; // rep commitment
      offset += 16; // nonce
      const status = data.readUInt8(offset); offset += 1;
      const createdAt = Number(data.readBigInt64LE(offset)); offset += 8;
      const expiresAt = Number(data.readBigInt64LE(offset));

      return {
        address: pubkey.toBase58(),
        maker,
        orderType: orderTypeU8 === 0 ? 'buy_crypto' as const : 'sell_crypto' as const,
        token: TOKEN_MINTS[tokenMint] || 'Unknown',
        tokenMint,
        cryptoAmount: cryptoAmount / 1e9,
        fiatAmount,
        fiatCurrency,
        paymentMethods: parseMethods(paymentBitfield),
        reputation: { trades: 0, positive: 0 }, // TODO: fetch from reputation PDA
        status: STATUS_MAP[status] || 'expired',
        createdAt,
        expiresAt,
      };
    }).filter(o => o.status === 'open');
  } catch (err) {
    console.error('[mugen] Failed to fetch orders:', err);
    return [];
  }
}

// ─── Seed / demo orders (until real orders exist on-chain) ──────────────────

export function getSeedOrders(): MugenOrder[] {
  const now = Math.floor(Date.now() / 1000);
  return [
    { address: 'seed1', maker: '7gWp...6QmU', orderType: 'sell_crypto', token: 'SOL', tokenMint: '', cryptoAmount: 50, fiatAmount: 7350, fiatCurrency: 'USD', paymentMethods: ['bank', 'revolut'], reputation: { trades: 47, positive: 46 }, status: 'open', createdAt: now - 120, expiresAt: now + 86400 },
    { address: 'seed2', maker: '3EzP...T4y', orderType: 'sell_crypto', token: 'SOL', tokenMint: '', cryptoAmount: 100, fiatAmount: 14800, fiatCurrency: 'USD', paymentMethods: ['wise', 'sepa'], reputation: { trades: 123, positive: 121 }, status: 'open', createdAt: now - 300, expiresAt: now + 86400 },
    { address: 'seed3', maker: '9yVr...JvYv', orderType: 'sell_crypto', token: 'USDC', tokenMint: '', cryptoAmount: 5000, fiatAmount: 4980, fiatCurrency: 'EUR', paymentMethods: ['bank', 'sepa'], reputation: { trades: 12, positive: 12 }, status: 'open', createdAt: now - 720, expiresAt: now + 86400 },
    { address: 'seed4', maker: 'Ud2J...3Hbw', orderType: 'sell_crypto', token: 'USDT', tokenMint: '', cryptoAmount: 2000, fiatAmount: 1990, fiatCurrency: 'USD', paymentMethods: ['bank', 'wise', 'zelle'], reputation: { trades: 234, positive: 230 }, status: 'open', createdAt: now - 60, expiresAt: now + 86400 },
  ];
}
