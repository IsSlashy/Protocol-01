/**
 * P-01 Network Payments Service
 * Native fiat-to-crypto payment solution powered by Helio
 *
 * Features:
 * - Real-time crypto price feeds
 * - P-01 Network fee collection
 * - Multiple payment methods (card, bank, Apple Pay)
 * - Webhook handling for payment confirmation
 */

import { Buffer } from 'buffer';

// Configuration
const HELIO_API_KEY = process.env.EXPO_PUBLIC_HELIO_API_KEY || '';
const HELIO_SECRET_KEY = process.env.HELIO_SECRET_KEY || '';
const HELIO_API_URL = 'https://api.hel.io/v1';

// P-01 Network Fee (your commission)
export const P01_NETWORK_FEE_BPS = 50; // 0.5% = 50 basis points

// Supported assets
export interface CryptoAsset {
  symbol: string;
  name: string;
  mint: string; // Solana token mint address
  decimals: number;
  coingeckoId: string;
}

export const SUPPORTED_ASSETS: CryptoAsset[] = [
  {
    symbol: 'SOL',
    name: 'Solana',
    mint: 'So11111111111111111111111111111111111111112',
    decimals: 9,
    coingeckoId: 'solana',
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
    coingeckoId: 'usd-coin',
  },
  {
    symbol: 'USDT',
    name: 'Tether',
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    decimals: 6,
    coingeckoId: 'tether',
  },
];

// Supported fiat currencies
export interface FiatCurrency {
  code: string;
  symbol: string;
  name: string;
}

export const SUPPORTED_FIAT: FiatCurrency[] = [
  { code: 'USD', symbol: '$', name: 'US Dollar' },
  { code: 'EUR', symbol: '€', name: 'Euro' },
  { code: 'GBP', symbol: '£', name: 'British Pound' },
  { code: 'CAD', symbol: 'C$', name: 'Canadian Dollar' },
  { code: 'AUD', symbol: 'A$', name: 'Australian Dollar' },
];

// Payment methods
export interface PaymentMethod {
  id: string;
  name: string;
  icon: string;
  processingTime: string;
  feeBps: number; // Fee in basis points
  minAmount: number;
  maxAmount: number;
}

export const PAYMENT_METHODS: PaymentMethod[] = [
  {
    id: 'card',
    name: 'Credit / Debit Card',
    icon: 'card',
    processingTime: 'Instant',
    feeBps: 290, // 2.9%
    minAmount: 10,
    maxAmount: 10000,
  },
  {
    id: 'bank',
    name: 'Bank Transfer (SEPA/ACH)',
    icon: 'business',
    processingTime: '1-3 business days',
    feeBps: 100, // 1%
    minAmount: 50,
    maxAmount: 50000,
  },
  {
    id: 'apple_pay',
    name: 'Apple Pay',
    icon: 'logo-apple',
    processingTime: 'Instant',
    feeBps: 290, // 2.9%
    minAmount: 10,
    maxAmount: 10000,
  },
];

// Price cache
interface PriceCache {
  prices: Record<string, number>;
  timestamp: number;
}

let priceCache: PriceCache | null = null;
const PRICE_CACHE_TTL = 30000; // 30 seconds

/**
 * Get current crypto prices in USD
 * Uses Jupiter Price API (more reliable for Solana tokens)
 */
export async function getCryptoPrices(): Promise<Record<string, number>> {
  // Check cache
  if (priceCache && Date.now() - priceCache.timestamp < PRICE_CACHE_TTL) {
    return priceCache.prices;
  }

  // Try Jupiter Price API first (more reliable for Solana)
  try {
    const mints = SUPPORTED_ASSETS.map(a => a.mint).join(',');
    const response = await fetch(
      `https://api.jup.ag/price/v2?ids=${mints}`,
      {
        headers: {
          'Accept': 'application/json',
        },
      }
    );

    if (response.ok) {
      const data = await response.json();
      const prices: Record<string, number> = {};

      for (const asset of SUPPORTED_ASSETS) {
        const priceData = data.data?.[asset.mint];
        prices[asset.symbol] = priceData?.price || 0;
      }

      // Update cache if we got valid prices
      if (prices.SOL > 0) {
        priceCache = {
          prices,
          timestamp: Date.now(),
        };
        return prices;
      }
    }
  } catch (error) {
    console.warn('[P01Payments] Jupiter API failed, trying CoinGecko...');
  }

  // Fallback to CoinGecko
  try {
    const ids = SUPPORTED_ASSETS.map(a => a.coingeckoId).join(',');
    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      {
        headers: {
          'Accept': 'application/json',
        },
      }
    );

    if (!response.ok) {
      throw new Error('Failed to fetch prices');
    }

    const data = await response.json();

    const prices: Record<string, number> = {};
    for (const asset of SUPPORTED_ASSETS) {
      prices[asset.symbol] = data[asset.coingeckoId]?.usd || 0;
    }

    // Update cache
    priceCache = {
      prices,
      timestamp: Date.now(),
    };

    return prices;
  } catch (error) {
    console.error('[P01Payments] Error fetching prices:', error);

    // Return cached prices if available, otherwise fallback
    if (priceCache) {
      return priceCache.prices;
    }

    // Fallback prices (approximate)
    const fallbackPrices = {
      SOL: 150,
      USDC: 1,
      USDT: 1,
    };
    return fallbackPrices;
  }
}

/**
 * Calculate payment quote
 */
export interface PaymentQuote {
  fiatAmount: number;
  fiatCurrency: string;
  cryptoAmount: number;
  cryptoSymbol: string;
  cryptoPrice: number;
  paymentMethodFee: number;
  p01NetworkFee: number;
  totalFees: number;
  netAmount: number;
  expiresAt: number;
}

export async function getPaymentQuote(params: {
  fiatAmount: number;
  fiatCurrency: string;
  cryptoSymbol: string;
  paymentMethodId: string;
}): Promise<PaymentQuote> {
  const { fiatAmount, fiatCurrency, cryptoSymbol, paymentMethodId } = params;

  // Get prices
  const prices = await getCryptoPrices();
  const cryptoPrice = prices[cryptoSymbol] || 0;

  // Get payment method
  const paymentMethod = PAYMENT_METHODS.find(m => m.id === paymentMethodId);
  if (!paymentMethod) {
    throw new Error('Invalid payment method');
  }

  // Calculate fees
  const paymentMethodFee = fiatAmount * (paymentMethod.feeBps / 10000);
  const p01NetworkFee = fiatAmount * (P01_NETWORK_FEE_BPS / 10000);
  const totalFees = paymentMethodFee + p01NetworkFee;
  const netAmount = fiatAmount - totalFees;

  // Calculate crypto amount
  // Note: For non-USD currencies, we'd need FX rates here
  const cryptoAmount = cryptoPrice > 0 ? netAmount / cryptoPrice : 0;

  return {
    fiatAmount,
    fiatCurrency,
    cryptoAmount,
    cryptoSymbol,
    cryptoPrice,
    paymentMethodFee,
    p01NetworkFee,
    totalFees,
    netAmount,
    expiresAt: Date.now() + 60000, // Quote valid for 1 minute
  };
}

/**
 * Create a payment session via Helio
 */
export interface PaymentSession {
  id: string;
  paymentUrl: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  quote: PaymentQuote;
  walletAddress: string;
  createdAt: number;
}

export async function createPaymentSession(params: {
  quote: PaymentQuote;
  walletAddress: string;
  paymentMethodId: string;
  customerEmail?: string;
}): Promise<PaymentSession> {
  const { quote, walletAddress, paymentMethodId, customerEmail } = params;

  // Generate session ID
  const sessionId = `p01_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Build payment URL using available providers
  const paymentUrl = buildPaymentUrl({
    sessionId,
    amount: quote.fiatAmount,
    currency: quote.fiatCurrency,
    cryptoCurrency: quote.cryptoSymbol,
    walletAddress,
    paymentMethod: paymentMethodId,
  });

  return {
    id: sessionId,
    paymentUrl,
    status: 'pending',
    quote,
    walletAddress,
    createdAt: Date.now(),
  };
}

/**
 * Build payment URL - uses multiple providers
 * Priority: 1. MoonPay (best for cards), 2. Ramp (Europe), 3. Direct deposit
 */
function buildPaymentUrl(params: {
  sessionId: string;
  amount: number;
  currency: string;
  cryptoCurrency: string;
  walletAddress: string;
  paymentMethod: string;
}): string {
  // Use MoonPay widget for card payments (most reliable)
  // MoonPay widget URL with pre-filled parameters
  const moonpayParams = new URLSearchParams({
    apiKey: process.env.EXPO_PUBLIC_MOONPAY_API_KEY || 'pk_test_123', // Test key for demo
    currencyCode: params.cryptoCurrency.toLowerCase(),
    baseCurrencyCode: params.currency.toLowerCase(),
    baseCurrencyAmount: params.amount.toString(),
    walletAddress: params.walletAddress,
    externalTransactionId: params.sessionId,
    colorCode: '39c5bb', // P-01 cyan
    theme: 'dark',
  });

  // Try MoonPay first (most reliable for cards)
  if (params.paymentMethod === 'card' || params.paymentMethod === 'apple_pay') {
    return `https://buy.moonpay.com?${moonpayParams.toString()}`;
  }

  // For bank transfers, use Ramp Network (better for SEPA/ACH)
  if (params.paymentMethod === 'bank') {
    const rampParams = new URLSearchParams({
      hostAppName: 'P-01 Wallet',
      hostLogoUrl: 'https://p01.network/logo.png',
      swapAsset: `SOLANA_${params.cryptoCurrency}`,
      fiatValue: params.amount.toString(),
      fiatCurrency: params.currency,
      userAddress: params.walletAddress,
      webhookStatusUrl: 'https://api.p01.network/webhooks/ramp', // Backend webhook
    });
    return `https://app.ramp.network?${rampParams.toString()}`;
  }

  // Fallback to MoonPay
  return `https://buy.moonpay.com?${moonpayParams.toString()}`;
}

/**
 * Verify payment webhook signature (server-side only)
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string
): boolean {
  if (!HELIO_SECRET_KEY) {
    console.warn('[P01Payments] No secret key configured');
    return false;
  }

  try {
    // HMAC-SHA256 verification
    const crypto = require('crypto');
    const expectedSignature = crypto
      .createHmac('sha256', HELIO_SECRET_KEY)
      .update(payload)
      .digest('hex');

    return signature === expectedSignature;
  } catch (error) {
    console.error('[P01Payments] Webhook verification error:', error);
    return false;
  }
}

/**
 * Format crypto amount for display
 */
export function formatCryptoAmount(amount: number, symbol: string): string {
  const asset = SUPPORTED_ASSETS.find(a => a.symbol === symbol);
  const decimals = symbol === 'SOL' ? 4 : 2;
  return `${amount.toFixed(decimals)} ${symbol}`;
}

/**
 * Format fiat amount for display
 */
export function formatFiatAmount(amount: number, currencyCode: string): string {
  const currency = SUPPORTED_FIAT.find(c => c.code === currencyCode);
  const symbol = currency?.symbol || '$';
  return `${symbol}${amount.toFixed(2)}`;
}

/**
 * Get asset by symbol
 */
export function getAsset(symbol: string): CryptoAsset | undefined {
  return SUPPORTED_ASSETS.find(a => a.symbol === symbol);
}

/**
 * Get payment method by ID
 */
export function getPaymentMethod(id: string): PaymentMethod | undefined {
  return PAYMENT_METHODS.find(m => m.id === id);
}

/**
 * Calculate P-01 Network fee amount
 */
export function calculateP01Fee(fiatAmount: number): number {
  return fiatAmount * (P01_NETWORK_FEE_BPS / 10000);
}

/**
 * Check if payment is within limits
 */
export function validatePaymentLimits(
  amount: number,
  paymentMethodId: string
): { valid: boolean; error?: string } {
  const method = getPaymentMethod(paymentMethodId);
  if (!method) {
    return { valid: false, error: 'Invalid payment method' };
  }

  if (amount < method.minAmount) {
    return {
      valid: false,
      error: `Minimum amount is $${method.minAmount}`,
    };
  }

  if (amount > method.maxAmount) {
    return {
      valid: false,
      error: `Maximum amount is $${method.maxAmount.toLocaleString()}`,
    };
  }

  return { valid: true };
}
