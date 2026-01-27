/**
 * P-01 Network Payments Service (Extension)
 * Native fiat-to-crypto payment solution
 *
 * Features:
 * - Real-time crypto price feeds (Jupiter + CoinGecko fallback)
 * - P-01 Network fee collection (0.5%)
 * - Multiple payment methods (card, bank transfer)
 * - MoonPay + Ramp integration
 */

// P-01 Network Fee (commission)
export const P01_NETWORK_FEE_BPS = 50; // 0.5% = 50 basis points

// Supported assets
export interface CryptoAsset {
  symbol: string;
  name: string;
  mint: string;
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
];

// Payment methods
export interface PaymentMethod {
  id: string;
  name: string;
  icon: string;
  processingTime: string;
  feeBps: number;
  minAmount: number;
  maxAmount: number;
}

export const PAYMENT_METHODS: PaymentMethod[] = [
  {
    id: 'card',
    name: 'Credit / Debit Card',
    icon: 'CreditCard',
    processingTime: 'Instant',
    feeBps: 290, // 2.9%
    minAmount: 10,
    maxAmount: 10000,
  },
  {
    id: 'bank',
    name: 'Bank Transfer',
    icon: 'Building',
    processingTime: '1-3 business days',
    feeBps: 100, // 1%
    minAmount: 50,
    maxAmount: 50000,
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
 */
export async function getCryptoPrices(): Promise<Record<string, number>> {
  if (priceCache && Date.now() - priceCache.timestamp < PRICE_CACHE_TTL) {
    return priceCache.prices;
  }

  // Try Jupiter Price API first
  try {
    const mints = SUPPORTED_ASSETS.map(a => a.mint).join(',');
    const response = await fetch(
      `https://api.jup.ag/price/v2?ids=${mints}`,
      { headers: { 'Accept': 'application/json' } }
    );

    if (response.ok) {
      const data = await response.json();
      const prices: Record<string, number> = {};

      for (const asset of SUPPORTED_ASSETS) {
        const priceData = data.data?.[asset.mint];
        prices[asset.symbol] = priceData?.price || 0;
      }

      if (prices.SOL > 0) {
        priceCache = { prices, timestamp: Date.now() };
        return prices;
      }
    }
  } catch {
    console.warn('[P01Payments] Jupiter API failed, trying CoinGecko...');
  }

  // Fallback to CoinGecko
  try {
    const ids = SUPPORTED_ASSETS.map(a => a.coingeckoId).join(',');
    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      { headers: { 'Accept': 'application/json' } }
    );

    if (!response.ok) throw new Error('Failed to fetch prices');

    const data = await response.json();
    const prices: Record<string, number> = {};
    for (const asset of SUPPORTED_ASSETS) {
      prices[asset.symbol] = data[asset.coingeckoId]?.usd || 0;
    }

    priceCache = { prices, timestamp: Date.now() };
    return prices;
  } catch (error) {
    console.error('[P01Payments] Error fetching prices:', error);

    if (priceCache) return priceCache.prices;

    return { SOL: 150, USDC: 1, USDT: 1 };
  }
}

/**
 * Payment quote
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

  const prices = await getCryptoPrices();
  const cryptoPrice = prices[cryptoSymbol] || 0;

  const paymentMethod = PAYMENT_METHODS.find(m => m.id === paymentMethodId);
  if (!paymentMethod) throw new Error('Invalid payment method');

  const paymentMethodFee = fiatAmount * (paymentMethod.feeBps / 10000);
  const p01NetworkFee = fiatAmount * (P01_NETWORK_FEE_BPS / 10000);
  const totalFees = paymentMethodFee + p01NetworkFee;
  const netAmount = fiatAmount - totalFees;
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
    expiresAt: Date.now() + 60000,
  };
}

/**
 * Payment session
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
}): Promise<PaymentSession> {
  const { quote, walletAddress, paymentMethodId } = params;

  const sessionId = `p01_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

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

function buildPaymentUrl(params: {
  sessionId: string;
  amount: number;
  currency: string;
  cryptoCurrency: string;
  walletAddress: string;
  paymentMethod: string;
}): string {
  const moonpayParams = new URLSearchParams({
    apiKey: 'pk_test_123',
    currencyCode: params.cryptoCurrency.toLowerCase(),
    baseCurrencyCode: params.currency.toLowerCase(),
    baseCurrencyAmount: params.amount.toString(),
    walletAddress: params.walletAddress,
    externalTransactionId: params.sessionId,
    colorCode: '39c5bb',
    theme: 'dark',
  });

  if (params.paymentMethod === 'card') {
    return `https://buy.moonpay.com?${moonpayParams.toString()}`;
  }

  if (params.paymentMethod === 'bank') {
    const rampParams = new URLSearchParams({
      hostAppName: 'P-01 Wallet',
      swapAsset: `SOLANA_${params.cryptoCurrency}`,
      fiatValue: params.amount.toString(),
      fiatCurrency: params.currency,
      userAddress: params.walletAddress,
    });
    return `https://app.ramp.network?${rampParams.toString()}`;
  }

  return `https://buy.moonpay.com?${moonpayParams.toString()}`;
}

export function getSupportedAssets(): CryptoAsset[] {
  return SUPPORTED_ASSETS;
}

export function formatCryptoAmount(amount: number, symbol: string): string {
  const decimals = symbol === 'SOL' ? 4 : 2;
  return `${amount.toFixed(decimals)} ${symbol}`;
}

export function formatFiatAmount(amount: number, currencyCode: string): string {
  const currency = SUPPORTED_FIAT.find(c => c.code === currencyCode);
  const symbol = currency?.symbol || '$';
  return `${symbol}${amount.toFixed(2)}`;
}

export function validatePaymentLimits(
  amount: number,
  paymentMethodId: string
): { valid: boolean; error?: string } {
  const method = PAYMENT_METHODS.find(m => m.id === paymentMethodId);
  if (!method) return { valid: false, error: 'Invalid payment method' };

  if (amount < method.minAmount) {
    return { valid: false, error: `Minimum amount is $${method.minAmount}` };
  }
  if (amount > method.maxAmount) {
    return { valid: false, error: `Maximum amount is $${method.maxAmount.toLocaleString()}` };
  }

  return { valid: true };
}
