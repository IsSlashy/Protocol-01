/**
 * Hook for P-01 fiat on-ramp
 * Buy crypto with credit card via P-01 Network
 */

import { useState, useCallback, useEffect } from 'react';
import { useWalletStore } from '../../stores/walletStore';
import {
  getCryptoPrices,
  getPaymentQuote,
  createPaymentSession,
  SUPPORTED_ASSETS,
  SUPPORTED_FIAT,
  PAYMENT_METHODS,
  type PaymentQuote,
  type CryptoAsset,
  type FiatCurrency,
  type PaymentMethod,
} from '../../services/payments/p01-payments';
import { isMainnet } from '../../services/solana/connection';

interface UseFiatOnRampReturn {
  // State
  isLoading: boolean;
  error: string | null;
  quote: PaymentQuote | null;
  prices: Record<string, number>;
  assets: CryptoAsset[];
  fiatCurrencies: FiatCurrency[];
  paymentMethods: PaymentMethod[];

  // Actions
  getQuote: (params: {
    fiatAmount: number;
    fiatCurrency: string;
    cryptoCurrency: string;
    paymentMethodId: string;
  }) => Promise<PaymentQuote | null>;
  createSession: (params: {
    quote: PaymentQuote;
    paymentMethodId: string;
  }) => Promise<string | null>;
  refreshPrices: () => Promise<void>;

  // Helpers
  formatFiat: (amount: number, currency?: string) => string;
  formatCrypto: (amount: number, symbol: string) => string;
}

export function useFiatOnRamp(): UseFiatOnRampReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<PaymentQuote | null>(null);
  const [prices, setPrices] = useState<Record<string, number>>({});

  const { publicKey } = useWalletStore();

  // Fetch prices on mount
  useEffect(() => {
    refreshPrices();
    const interval = setInterval(refreshPrices, 30000);
    return () => clearInterval(interval);
  }, []);

  const refreshPrices = useCallback(async () => {
    try {
      const newPrices = await getCryptoPrices();
      setPrices(newPrices);
    } catch (err) {
      console.error('[useFiatOnRamp] Failed to fetch prices:', err);
    }
  }, []);

  const getQuote = useCallback(async (params: {
    fiatAmount: number;
    fiatCurrency: string;
    cryptoCurrency: string;
    paymentMethodId: string;
  }) => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await getPaymentQuote({
        fiatAmount: params.fiatAmount,
        fiatCurrency: params.fiatCurrency,
        cryptoSymbol: params.cryptoCurrency,
        paymentMethodId: params.paymentMethodId,
      });
      setQuote(result);
      return result;
    } catch (err: any) {
      setError(err.message);
      console.error('[useFiatOnRamp] Quote error:', err);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const createSession = useCallback(async (params: {
    quote: PaymentQuote;
    paymentMethodId: string;
  }) => {
    if (!publicKey) {
      setError('No wallet connected');
      return null;
    }

    setIsLoading(true);
    setError(null);

    try {
      const session = await createPaymentSession({
        quote: params.quote,
        walletAddress: publicKey,
        paymentMethodId: params.paymentMethodId,
      });
      return session.paymentUrl;
    } catch (err: any) {
      setError(err.message);
      console.error('[useFiatOnRamp] Session error:', err);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [publicKey]);

  const formatFiat = useCallback((amount: number, currency = 'USD') => {
    const curr = SUPPORTED_FIAT.find(f => f.code === currency);
    return `${curr?.symbol || '$'}${amount.toFixed(2)}`;
  }, []);

  const formatCrypto = useCallback((amount: number, symbol: string) => {
    const decimals = symbol === 'SOL' ? 4 : 2;
    return `${amount.toFixed(decimals)} ${symbol}`;
  }, []);

  return {
    isLoading,
    error,
    quote,
    prices,
    assets: SUPPORTED_ASSETS,
    fiatCurrencies: SUPPORTED_FIAT,
    paymentMethods: PAYMENT_METHODS,
    getQuote,
    createSession,
    refreshPrices,
    formatFiat,
    formatCrypto,
  };
}
