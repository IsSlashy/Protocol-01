/**
 * MoonPay On-Ramp Service - Buy Crypto with Fiat
 * Browser Extension version
 * @see https://dev.moonpay.com
 */

// MoonPay environments
const MOONPAY_WIDGET_URL = 'https://buy.moonpay.com';
const MOONPAY_SANDBOX_URL = 'https://buy-sandbox.moonpay.com';
const MOONPAY_API_URL = 'https://api.moonpay.com/v3';

export interface MoonPayConfig {
  apiKey: string;
  secretKey?: string; // For URL signing (server-side)
  environment: 'production' | 'sandbox';
}

export interface BuyWidgetParams {
  currencyCode?: string;        // Crypto to buy (sol, usdc, etc.)
  baseCurrencyCode?: string;    // Fiat currency (usd, eur, etc.)
  baseCurrencyAmount?: number;  // Amount in fiat
  walletAddress?: string;       // Pre-fill wallet address
  email?: string;               // Pre-fill email
  externalCustomerId?: string;  // Your user ID
  externalTransactionId?: string;
  colorCode?: string;           // Hex color for widget theme
  language?: string;            // en, fr, es, etc.
  showWalletAddressForm?: boolean;
  lockAmount?: boolean;
  redirectUrl?: string;
}

export interface SellWidgetParams {
  currencyCode?: string;
  quoteCurrencyCode?: string;
  baseCurrencyAmount?: number;
  refundWalletAddress?: string;
  externalCustomerId?: string;
  colorCode?: string;
  language?: string;
}

export interface MoonPayQuote {
  baseCurrencyAmount: number;
  baseCurrencyCode: string;
  quoteCurrencyAmount: number;
  quoteCurrencyCode: string;
  quoteCurrencyPrice: number;
  feeAmount: number;
  extraFeeAmount: number;
  networkFeeAmount: number;
  totalAmount: number;
}

export interface MoonPayCurrency {
  id: string;
  code: string;
  name: string;
  type: 'crypto' | 'fiat';
  precision: number;
  minBuyAmount?: number;
  maxBuyAmount?: number;
  isSuspended: boolean;
  supportsLiveMode: boolean;
  supportsTestMode: boolean;
  metadata?: {
    chainId?: string;
    contractAddress?: string;
    networkCode?: string;
  };
}

export interface MoonPayTransaction {
  id: string;
  status: 'pending' | 'waitingPayment' | 'waitingAuthorization' | 'completed' | 'failed';
  baseCurrencyAmount: number;
  baseCurrencyCode: string;
  quoteCurrencyAmount: number;
  quoteCurrencyCode: string;
  feeAmount: number;
  walletAddress: string;
  cryptoTransactionId?: string;
  createdAt: string;
  updatedAt: string;
}

class MoonPayService {
  private config: MoonPayConfig | null = null;

  /**
   * Initialize MoonPay service
   */
  initialize(config: MoonPayConfig): void {
    this.config = config;
  }

  private getWidgetUrl(): string {
    if (!this.config) throw new Error('MoonPay not initialized');
    return this.config.environment === 'production'
      ? MOONPAY_WIDGET_URL
      : MOONPAY_SANDBOX_URL;
  }

  // ==================== Buy Widget ====================

  /**
   * Build the buy widget URL
   */
  buildBuyUrl(params: BuyWidgetParams = {}): string {
    if (!this.config) throw new Error('MoonPay not initialized');

    const url = new URL(this.getWidgetUrl());

    // Required
    url.searchParams.set('apiKey', this.config.apiKey);

    // Optional params
    if (params.currencyCode) {
      url.searchParams.set('currencyCode', params.currencyCode.toLowerCase());
    }
    if (params.baseCurrencyCode) {
      url.searchParams.set('baseCurrencyCode', params.baseCurrencyCode.toLowerCase());
    }
    if (params.baseCurrencyAmount) {
      url.searchParams.set('baseCurrencyAmount', params.baseCurrencyAmount.toString());
    }
    if (params.walletAddress) {
      url.searchParams.set('walletAddress', params.walletAddress);
    }
    if (params.email) {
      url.searchParams.set('email', params.email);
    }
    if (params.externalCustomerId) {
      url.searchParams.set('externalCustomerId', params.externalCustomerId);
    }
    if (params.externalTransactionId) {
      url.searchParams.set('externalTransactionId', params.externalTransactionId);
    }
    if (params.colorCode) {
      url.searchParams.set('colorCode', params.colorCode.replace('#', ''));
    }
    if (params.language) {
      url.searchParams.set('language', params.language);
    }
    if (params.showWalletAddressForm !== undefined) {
      url.searchParams.set('showWalletAddressForm', params.showWalletAddressForm.toString());
    }
    if (params.lockAmount) {
      url.searchParams.set('lockAmount', 'true');
    }
    if (params.redirectUrl) {
      url.searchParams.set('redirectURL', params.redirectUrl);
    }

    return url.toString();
  }

  /**
   * Open buy widget in new tab
   */
  async openBuyWidget(params: BuyWidgetParams = {}): Promise<void> {
    const url = this.buildBuyUrl(params);
    window.open(url, '_blank');
  }

  /**
   * Open buy widget in popup window
   */
  openBuyWidgetPopup(params: BuyWidgetParams = {}): Window | null {
    const url = this.buildBuyUrl(params);
    return window.open(
      url,
      'moonpay-buy',
      'width=500,height=700,left=100,top=100'
    );
  }

  // ==================== Sell Widget ====================

  /**
   * Build the sell widget URL
   */
  buildSellUrl(params: SellWidgetParams = {}): string {
    if (!this.config) throw new Error('MoonPay not initialized');

    const baseUrl = this.config.environment === 'production'
      ? 'https://sell.moonpay.com'
      : 'https://sell-sandbox.moonpay.com';

    const url = new URL(baseUrl);
    url.searchParams.set('apiKey', this.config.apiKey);

    if (params.currencyCode) {
      url.searchParams.set('baseCurrencyCode', params.currencyCode.toLowerCase());
    }
    if (params.quoteCurrencyCode) {
      url.searchParams.set('quoteCurrencyCode', params.quoteCurrencyCode.toLowerCase());
    }
    if (params.baseCurrencyAmount) {
      url.searchParams.set('baseCurrencyAmount', params.baseCurrencyAmount.toString());
    }
    if (params.refundWalletAddress) {
      url.searchParams.set('refundWalletAddress', params.refundWalletAddress);
    }
    if (params.colorCode) {
      url.searchParams.set('colorCode', params.colorCode.replace('#', ''));
    }

    return url.toString();
  }

  /**
   * Open sell widget in new tab
   */
  async openSellWidget(params: SellWidgetParams = {}): Promise<void> {
    const url = this.buildSellUrl(params);
    window.open(url, '_blank');
  }

  /**
   * Open sell widget in popup window
   */
  openSellWidgetPopup(params: SellWidgetParams = {}): Window | null {
    const url = this.buildSellUrl(params);
    return window.open(
      url,
      'moonpay-sell',
      'width=500,height=700,left=100,top=100'
    );
  }

  // ==================== Quotes ====================

  /**
   * Get a buy quote
   */
  async getBuyQuote(params: {
    baseCurrencyCode: string;
    baseCurrencyAmount: number;
    quoteCurrencyCode: string;
  }): Promise<MoonPayQuote> {
    if (!this.config) throw new Error('MoonPay not initialized');

    const url = new URL(`${MOONPAY_API_URL}/currencies/${params.quoteCurrencyCode}/buy_quote`);
    url.searchParams.set('apiKey', this.config.apiKey);
    url.searchParams.set('baseCurrencyCode', params.baseCurrencyCode.toLowerCase());
    url.searchParams.set('baseCurrencyAmount', params.baseCurrencyAmount.toString());

    const response = await fetch(url.toString());
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`MoonPay quote error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  // ==================== Currencies ====================

  /**
   * Get supported currencies
   */
  async getCurrencies(): Promise<MoonPayCurrency[]> {
    if (!this.config) throw new Error('MoonPay not initialized');

    const url = new URL(`${MOONPAY_API_URL}/currencies`);
    url.searchParams.set('apiKey', this.config.apiKey);

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Failed to fetch currencies: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Get Solana-specific currencies
   */
  async getSolanaCurrencies(): Promise<MoonPayCurrency[]> {
    const currencies = await this.getCurrencies();
    return currencies.filter(c =>
      c.metadata?.networkCode === 'solana' ||
      c.code.toLowerCase() === 'sol'
    );
  }

  // ==================== Helpers ====================

  /**
   * Check if a currency is supported for buying
   */
  async isCurrencySupported(code: string): Promise<boolean> {
    const currencies = await this.getCurrencies();
    return currencies.some(
      c => c.code.toLowerCase() === code.toLowerCase() && !c.isSuspended
    );
  }

  /**
   * Get min/max buy amounts for a currency
   */
  async getBuyLimits(currencyCode: string): Promise<{
    minAmount: number;
    maxAmount: number;
  } | null> {
    const currencies = await this.getCurrencies();
    const currency = currencies.find(
      c => c.code.toLowerCase() === currencyCode.toLowerCase()
    );

    if (!currency) return null;

    return {
      minAmount: currency.minBuyAmount || 0,
      maxAmount: currency.maxBuyAmount || Infinity,
    };
  }

  /**
   * Format amount for display
   */
  formatAmount(amount: number, currencyCode: string): string {
    const isFiat = ['usd', 'eur', 'gbp'].includes(currencyCode.toLowerCase());

    if (isFiat) {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currencyCode.toUpperCase(),
      }).format(amount);
    }

    return `${amount.toFixed(6)} ${currencyCode.toUpperCase()}`;
  }
}

// Singleton instance
export const moonpay = new MoonPayService();
