/**
 * P-01 Network Payments Service (Extension)
 * Native fiat-to-crypto via Mugen Exchange (P2P, no KYC)
 *
 * Users see "P01 Network" — Mugen is the invisible backend.
 * Spread is baked into the exchange rate (not shown as fee).
 */

// ─── Fee Structure ──────────────────────────────────────────────────────────
// Visible to user: "P-01 Network Fee 0.5%"
// Hidden spread in exchange rate: 0.8-1.0% depending on payment method
// Total effective take rate: 1.3% (bank) to 2.9% (card)

export const P01_NETWORK_FEE_BPS = 50; // 0.5% visible fee

const SPREAD_BPS: Record<string, number> = {
  card: 100,      // 1.0% spread
  bank: 80,       // 0.8% spread
  revolut: 80,
  wise: 80,
  sepa: 80,
};

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CryptoAsset {
  symbol: string;
  name: string;
  mint: string;
  decimals: number;
  coingeckoId: string;
}

export interface FiatCurrency {
  code: string;
  symbol: string;
  name: string;
}

export interface PaymentMethod {
  id: string;
  name: string;
  icon: string;
  processingTime: string;
  feeBps: number;
  minAmount: number;
  maxAmount: number;
}

export interface PaymentQuote {
  fiatAmount: number;
  fiatCurrency: string;
  cryptoAmount: number;
  cryptoSymbol: string;
  cryptoPrice: number;         // Rate shown to user (includes spread)
  marketPrice: number;         // Real market price
  paymentMethodFee: number;
  p01NetworkFee: number;
  totalFees: number;
  netAmount: number;
  expiresAt: number;
}

export interface PaymentSession {
  id: string;
  paymentUrl: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  quote: PaymentQuote;
  walletAddress: string;
  createdAt: number;
  orderId?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

export const SUPPORTED_ASSETS: CryptoAsset[] = [
  { symbol: 'SOL', name: 'Solana', mint: 'So11111111111111111111111111111111111111112', decimals: 9, coingeckoId: 'solana' },
  { symbol: 'USDC', name: 'USD Coin', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, coingeckoId: 'usd-coin' },
  { symbol: 'USDT', name: 'Tether', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6, coingeckoId: 'tether' },
];

export const SUPPORTED_FIAT: FiatCurrency[] = [
  { code: 'USD', symbol: '$', name: 'US Dollar' },
  { code: 'EUR', symbol: '€', name: 'Euro' },
  { code: 'GBP', symbol: '£', name: 'British Pound' },
];

export const PAYMENT_METHODS: PaymentMethod[] = [
  { id: 'card', name: 'Credit / Debit Card', icon: 'CreditCard', processingTime: 'Instant', feeBps: 190, minAmount: 10, maxAmount: 10000 },
  { id: 'bank', name: 'Bank Transfer (IBAN)', icon: 'Building', processingTime: '1-2 business days', feeBps: 50, minAmount: 50, maxAmount: 50000 },
];

// ─── Price Feed ─────────────────────────────────────────────────────────────

let priceCache: { prices: Record<string, number>; timestamp: number } | null = null;
const PRICE_CACHE_TTL = 30000;

export async function getCryptoPrices(): Promise<Record<string, number>> {
  if (priceCache && Date.now() - priceCache.timestamp < PRICE_CACHE_TTL) {
    return priceCache.prices;
  }

  // Try Mugen API first (our own)
  try {
    const res = await fetch('https://mugen-exchange.vercel.app/api/prices', {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      const prices: Record<string, number> = {
        SOL: data.SOL?.usd || 0,
        USDC: data.USDC?.usd || 1,
        USDT: data.USDT?.usd || 1,
      };
      if (prices.SOL > 0) {
        priceCache = { prices, timestamp: Date.now() };
        return prices;
      }
    }
  } catch {}

  // Fallback: Jupiter
  try {
    const mints = SUPPORTED_ASSETS.map(a => a.mint).join(',');
    const res = await fetch(`https://api.jup.ag/price/v2?ids=${mints}`);
    if (res.ok) {
      const data = await res.json();
      const prices: Record<string, number> = {};
      for (const asset of SUPPORTED_ASSETS) {
        prices[asset.symbol] = data.data?.[asset.mint]?.price || 0;
      }
      if (prices.SOL > 0) {
        priceCache = { prices, timestamp: Date.now() };
        return prices;
      }
    }
  } catch {}

  // Fallback: CoinGecko
  try {
    const ids = SUPPORTED_ASSETS.map(a => a.coingeckoId).join(',');
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
    if (res.ok) {
      const data = await res.json();
      const prices: Record<string, number> = {};
      for (const asset of SUPPORTED_ASSETS) {
        prices[asset.symbol] = data[asset.coingeckoId]?.usd || 0;
      }
      priceCache = { prices, timestamp: Date.now() };
      return prices;
    }
  } catch {}

  if (priceCache) return priceCache.prices;
  return { SOL: 150, USDC: 1, USDT: 1 };
}

// ─── Quote ──────────────────────────────────────────────────────────────────

export async function getPaymentQuote(params: {
  fiatAmount: number;
  fiatCurrency: string;
  cryptoSymbol: string;
  paymentMethodId: string;
}): Promise<PaymentQuote> {
  const { fiatAmount, fiatCurrency, cryptoSymbol, paymentMethodId } = params;

  const prices = await getCryptoPrices();
  const marketPrice = prices[cryptoSymbol] || 0;

  const paymentMethod = PAYMENT_METHODS.find(m => m.id === paymentMethodId);
  if (!paymentMethod) throw new Error('Invalid payment method');

  // Apply spread to exchange rate (hidden from user)
  const spreadBps = SPREAD_BPS[paymentMethodId] || 80;
  const cryptoPrice = marketPrice * (1 + spreadBps / 10000);

  // Visible fees
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
    marketPrice,
    paymentMethodFee,
    p01NetworkFee,
    totalFees,
    netAmount,
    expiresAt: Date.now() + 60000,
  };
}

// ─── Payment Session (via Mugen Exchange backend) ───────────────────────────

export async function createPaymentSession(params: {
  quote: PaymentQuote;
  walletAddress: string;
  paymentMethodId: string;
}): Promise<PaymentSession> {
  const { quote, walletAddress, paymentMethodId } = params;

  const sessionId = `p01_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Use Mugen Exchange /pay page as the payment gateway
  const paymentParams = new URLSearchParams({
    amount: quote.fiatAmount.toString(),
    token: quote.cryptoSymbol,
    method: paymentMethodId,
    wallet: walletAddress,
    session: sessionId,
  });

  const paymentUrl = `https://mugen-exchange.vercel.app/pay?${paymentParams.toString()}`;

  return {
    id: sessionId,
    paymentUrl,
    status: 'pending',
    quote,
    walletAddress,
    createdAt: Date.now(),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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
  paymentMethodId: string,
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
