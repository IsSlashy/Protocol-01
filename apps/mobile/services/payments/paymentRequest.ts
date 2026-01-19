/**
 * Payment Request Service for Social Chat
 * Handles payment requests and in-chat crypto transfers
 * Ported from extension with mobile-specific adaptations
 */

import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { sendSol, isValidAddress } from '../solana/transactions';
import { getConnection, getExplorerUrl } from '../solana/connection';
import * as Linking from 'expo-linking';

// ============ Types ============

export interface PaymentRequest {
  id: string;
  requesterId: string; // wallet address of requester
  recipientId: string; // wallet address of person who should pay
  amount: number;
  token: string; // 'SOL', 'USDC', etc.
  tokenMint?: string; // for SPL tokens
  note?: string;
  status: PaymentRequestStatus;
  createdAt: number;
  expiresAt?: number;
  txSignature?: string; // when paid
}

export type PaymentRequestStatus = 'pending' | 'paid' | 'declined' | 'expired';

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
  recipientId: string;
  amount: number;
  token: string;
  tokenMint?: string;
  note?: string;
  expiresIn?: number; // seconds
}

export interface SendCryptoOptions {
  senderAddress: string;
  recipientAddress: string;
  amount: number;
  token: string;
  tokenMint?: string;
  note?: string;
}

export interface ChatPaymentMessage {
  id: string;
  type: 'payment_request' | 'payment_sent';
  senderId: string;
  recipientId: string;
  amount: number;
  token: string;
  tokenMint?: string;
  note?: string;
  status: PaymentRequestStatus;
  txSignature?: string;
  timestamp: number;
  expiresAt?: number;
}

// ============ Known Token Mints ============

export const KNOWN_TOKENS: Record<
  string,
  { mint: string; decimals: number; symbol: string; name: string; icon?: string }
> = {
  SOL: {
    mint: 'So11111111111111111111111111111111111111112',
    decimals: 9,
    symbol: 'SOL',
    name: 'Solana',
    icon: 'logo-usd',
  },
  USDC: {
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
    symbol: 'USDC',
    name: 'USD Coin',
    icon: 'cash-outline',
  },
  USDT: {
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    decimals: 6,
    symbol: 'USDT',
    name: 'Tether USD',
    icon: 'cash-outline',
  },
  BONK: {
    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    decimals: 5,
    symbol: 'BONK',
    name: 'Bonk',
    icon: 'paw-outline',
  },
};

export const SUPPORTED_TOKENS = ['SOL', 'USDC', 'USDT', 'BONK'] as const;
export type SupportedToken = (typeof SUPPORTED_TOKENS)[number];

// ============ Helper Functions ============

/**
 * Generate a unique ID
 */
function generateId(): string {
  return `pay_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Validate a Solana address
 */
export function isValidSolanaAddress(address: string): boolean {
  return isValidAddress(address);
}

// ============ Payment Request Functions ============

/**
 * Create a new payment request
 */
export function createPaymentRequest(
  options: CreatePaymentRequestOptions
): PaymentRequest {
  const {
    requesterId,
    recipientId,
    amount,
    token,
    tokenMint,
    note,
    expiresIn,
  } = options;

  if (!isValidSolanaAddress(recipientId)) {
    throw new Error('Invalid recipient address');
  }

  if (amount <= 0) {
    throw new Error('Amount must be greater than 0');
  }

  const now = Date.now();
  const expiresAt = expiresIn ? now + expiresIn * 1000 : now + 7 * 24 * 60 * 60 * 1000; // Default 7 days

  const paymentRequest: PaymentRequest = {
    id: generateId(),
    requesterId,
    recipientId,
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
  request: PaymentRequest
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
    // Send the payment to the requester
    const result = await sendSol(request.requesterId, request.amount);

    if (!result.success || !result.signature) {
      throw new Error(result.error || 'Transaction failed');
    }

    // Update request status
    const updatedRequest: PaymentRequest = {
      ...request,
      status: 'paid',
      txSignature: result.signature,
    };

    return { signature: result.signature, updatedRequest };
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
export function updateExpiredRequests(
  requests: PaymentRequest[]
): PaymentRequest[] {
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
  const { senderAddress, recipientAddress, amount, token, tokenMint, note } =
    options;

  if (!isValidSolanaAddress(recipientAddress)) {
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
    const result = await sendSol(recipientAddress, amount);

    if (!result.success || !result.signature) {
      throw new Error(result.error || 'Transaction failed');
    }

    const payment: PaymentSent = {
      id: generateId(),
      senderId: senderAddress,
      recipientId: recipientAddress,
      amount,
      token,
      tokenMint: tokenMint || KNOWN_TOKENS[token]?.mint,
      note,
      txSignature: result.signature,
      timestamp: Date.now(),
    };

    return { signature: result.signature, payment };
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
export function getTokenInfo(
  symbol: string
): { mint: string; decimals: number; symbol: string; name: string } | undefined {
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
export function getTransactionUrl(signature: string): string {
  return getExplorerUrl(signature, 'tx');
}

/**
 * Open transaction in browser/explorer
 */
export async function openTransactionInExplorer(
  signature: string
): Promise<void> {
  const url = getTransactionUrl(signature);
  const canOpen = await Linking.canOpenURL(url);
  if (canOpen) {
    await Linking.openURL(url);
  }
}

/**
 * Create a chat payment message from a payment request
 */
export function createChatPaymentMessage(
  request: PaymentRequest,
  type: 'payment_request' | 'payment_sent'
): ChatPaymentMessage {
  return {
    id: request.id,
    type,
    senderId: request.requesterId,
    recipientId: request.recipientId,
    amount: request.amount,
    token: request.token,
    tokenMint: request.tokenMint,
    note: request.note,
    status: request.status,
    txSignature: request.txSignature,
    timestamp: request.createdAt,
    expiresAt: request.expiresAt,
  };
}

/**
 * Format time remaining until expiration
 */
export function formatExpirationTime(expiresAt: number): string {
  const now = Date.now();
  const diff = expiresAt - now;

  if (diff <= 0) return 'Expired';

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d remaining`;
  if (hours > 0) return `${hours}h remaining`;
  if (minutes > 0) return `${minutes}m remaining`;
  return 'Expiring soon';
}

/**
 * Get status display text
 */
export function getStatusText(status: PaymentRequestStatus): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'paid':
      return 'Paid';
    case 'declined':
      return 'Declined';
    case 'expired':
      return 'Expired';
    default:
      return status;
  }
}

/**
 * Get status color for UI
 */
export function getStatusColor(status: PaymentRequestStatus): string {
  switch (status) {
    case 'pending':
      return '#FF6B9D'; // pink
    case 'paid':
      return '#00ff88'; // green
    case 'declined':
      return '#888892'; // gray
    case 'expired':
      return '#888892'; // gray
    default:
      return '#888892';
  }
}
