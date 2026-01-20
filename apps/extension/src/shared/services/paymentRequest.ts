/**
 * Payment Request Service for Social Chat
 * Handles payment requests and in-chat crypto transfers
 */

import { Keypair } from '@solana/web3.js';
import {
  NetworkType,
  sendSol,
  isValidSolanaAddress,
} from './wallet';
import { generateId } from '../utils';

// ============ Types ============

export interface PaymentRequest {
  id: string;
  requesterId: string; // wallet address of requester
  recipientId: string; // wallet address of person who should pay
  amount: number;
  token: string; // 'SOL', 'USDC', etc.
  tokenMint?: string; // for SPL tokens
  note?: string;
  status: 'pending' | 'paid' | 'declined' | 'expired';
  createdAt: number;
  expiresAt?: number;
  txSignature?: string; // when paid
}

export interface PaymentSent {
  id: string;
  senderId: string;
  recipientId: string;
  amount: number;
  token: string;
  tokenMint?: string;
  note?: string;
  txSignature: string;
  timestamp: number;
}

export interface CreatePaymentRequestOptions {
  requesterId: string;
  recipient: string;
  amount: number;
  token: string;
  tokenMint?: string;
  note?: string;
  expiresIn?: number; // seconds
}

export interface SendCryptoOptions {
  keypair: Keypair;
  recipient: string;
  amount: number;
  token: string;
  tokenMint?: string;
  note?: string;
  network: NetworkType;
}

// ============ Known Token Mints ============

export const KNOWN_TOKENS: Record<string, { mint: string; decimals: number; symbol: string }> = {
  SOL: {
    mint: 'So11111111111111111111111111111111111111112',
    decimals: 9,
    symbol: 'SOL',
  },
  USDC: {
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
    symbol: 'USDC',
  },
  USDT: {
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    decimals: 6,
    symbol: 'USDT',
  },
  BONK: {
    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    decimals: 5,
    symbol: 'BONK',
  },
};

// ============ Payment Request Functions ============

/**
 * Create a new payment request
 */
export function createPaymentRequest(options: CreatePaymentRequestOptions): PaymentRequest {
  const { requesterId, recipient, amount, token, tokenMint, note, expiresIn } = options;

  if (!isValidSolanaAddress(recipient)) {
    throw new Error('Invalid recipient address');
  }

  if (amount <= 0) {
    throw new Error('Amount must be greater than 0');
  }

  const now = Date.now();
  const expiresAt = expiresIn ? now + expiresIn * 1000 : undefined;

  const paymentRequest: PaymentRequest = {
    id: generateId(),
    requesterId,
    recipientId: recipient,
    amount,
    token,
    tokenMint: tokenMint || KNOWN_TOKENS[token]?.mint,
    note,
    status: 'pending',
    createdAt: now,
    expiresAt,
  };

  return paymentRequest;
}

/**
 * Pay a payment request
 */
export async function payRequest(
  request: PaymentRequest,
  keypair: Keypair,
  network: NetworkType
): Promise<{ signature: string; updatedRequest: PaymentRequest }> {
  // Validate request is still payable
  if (request.status !== 'pending') {
    throw new Error(`Cannot pay request with status: ${request.status}`);
  }

  if (request.expiresAt && Date.now() > request.expiresAt) {
    throw new Error('Payment request has expired');
  }

  // Currently only support SOL transfers
  // TODO: Add SPL token transfer support
  if (request.token !== 'SOL') {
    throw new Error(`Token ${request.token} transfers not yet supported`);
  }

  try {
    // Send the payment
    const signature = await sendSol(
      keypair,
      request.requesterId, // Pay to the requester
      request.amount,
      network
    );

    // Update request status
    const updatedRequest: PaymentRequest = {
      ...request,
      status: 'paid',
      txSignature: signature,
    };

    return { signature, updatedRequest };
  } catch (error) {
    throw new Error(`Failed to pay request: ${(error as Error).message}`);
  }
}

/**
 * Decline a payment request
 */
export function declineRequest(request: PaymentRequest): PaymentRequest {
  if (request.status !== 'pending') {
    throw new Error(`Cannot decline request with status: ${request.status}`);
  }

  return {
    ...request,
    status: 'declined',
  };
}

/**
 * Check if a payment request has expired
 */
export function isRequestExpired(request: PaymentRequest): boolean {
  if (!request.expiresAt) return false;
  return Date.now() > request.expiresAt;
}

/**
 * Update expired requests status
 */
export function updateExpiredRequests(requests: PaymentRequest[]): PaymentRequest[] {
  return requests.map((req) => {
    if (req.status === 'pending' && isRequestExpired(req)) {
      return { ...req, status: 'expired' as const };
    }
    return req;
  });
}

// ============ In-Chat Transfer Functions ============

/**
 * Send crypto directly in chat
 */
export async function sendCryptoInChat(
  options: SendCryptoOptions
): Promise<{ signature: string; payment: PaymentSent }> {
  const { keypair, recipient, amount, token, tokenMint, note, network } = options;

  if (!isValidSolanaAddress(recipient)) {
    throw new Error('Invalid recipient address');
  }

  if (amount <= 0) {
    throw new Error('Amount must be greater than 0');
  }

  // Currently only support SOL transfers
  // TODO: Add SPL token transfer support
  if (token !== 'SOL') {
    throw new Error(`Token ${token} transfers not yet supported`);
  }

  try {
    const signature = await sendSol(keypair, recipient, amount, network);

    const payment: PaymentSent = {
      id: generateId(),
      senderId: keypair.publicKey.toBase58(),
      recipientId: recipient,
      amount,
      token,
      tokenMint: tokenMint || KNOWN_TOKENS[token]?.mint,
      note,
      txSignature: signature,
      timestamp: Date.now(),
    };

    return { signature, payment };
  } catch (error) {
    throw new Error(`Failed to send crypto: ${(error as Error).message}`);
  }
}

// ============ Utility Functions ============

/**
 * Format payment amount for display
 */
export function formatPaymentAmount(amount: number, token: string): string {
  const decimals = token === 'SOL' ? 4 : 2;
  return `${amount.toFixed(decimals)} ${token}`;
}

/**
 * Get token info by symbol
 */
export function getTokenInfo(symbol: string): { mint: string; decimals: number; symbol: string } | undefined {
  return KNOWN_TOKENS[symbol];
}

/**
 * Get token symbol from mint address
 */
export function getTokenSymbolFromMint(mint: string): string {
  for (const [symbol, info] of Object.entries(KNOWN_TOKENS)) {
    if (info.mint === mint) {
      return symbol;
    }
  }
  return 'SPL';
}

/**
 * Validate payment amount against balance
 */
export function validatePaymentAmount(
  amount: number,
  balance: number,
  token: string
): { valid: boolean; error?: string } {
  if (amount <= 0) {
    return { valid: false, error: 'Amount must be greater than 0' };
  }

  // Reserve some for transaction fees
  const minReserve = token === 'SOL' ? 0.001 : 0;
  const availableBalance = balance - minReserve;

  if (amount > availableBalance) {
    return {
      valid: false,
      error: `Insufficient balance. Available: ${availableBalance.toFixed(4)} ${token}`,
    };
  }

  return { valid: true };
}

/**
 * Get Solscan URL for a transaction
 */
export function getPaymentSolscanUrl(signature: string, network: NetworkType): string {
  const cluster = network === 'mainnet-beta' ? '' : `?cluster=${network}`;
  return `https://solscan.io/tx/${signature}${cluster}`;
}
