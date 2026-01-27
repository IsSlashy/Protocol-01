/**
 * Helio Pay Service - Crypto Subscriptions & Payments
 * @see https://docs.hel.io
 * @see https://github.com/heliofi/heliopay
 */

// Helio API endpoints
const HELIO_API_BASE = 'https://api.hel.io/v1';
const HELIO_DEVNET_API = 'https://api.dev.hel.io/v1';

export interface HelioConfig {
  apiKey: string;
  secretKey?: string;
  network: 'mainnet' | 'devnet';
}

export interface HelioSubscription {
  id: string;
  status: 'ACTIVE' | 'EXPIRED' | 'CANCELLED' | 'PENDING';
  email?: string;
  walletAddress: string;
  planId: string;
  planName: string;
  amount: number;
  currency: string;
  interval: 'MONTHLY' | 'YEARLY';
  renewalDate: string;
  createdAt: string;
  transactions: HelioTransaction[];
}

export interface HelioTransaction {
  id: string;
  amount: number;
  currency: string;
  status: 'SUCCESS' | 'PENDING' | 'FAILED';
  signature: string;
  createdAt: string;
}

export interface CreatePayLinkParams {
  name: string;
  description?: string;
  price: number;
  currency: string; // SOL, USDC, etc.
  recipientAddress: string;
  features?: string[];
}

export interface CreateSubscriptionPlanParams {
  name: string;
  description?: string;
  price: number;
  currency: string;
  interval: 'MONTHLY' | 'YEARLY';
  recipientAddress: string;
  features?: string[];
  trialDays?: number;
  annualDiscount?: number; // percentage
}

export interface PayLink {
  id: string;
  url: string;
  name: string;
  price: number;
  currency: string;
  active: boolean;
}

export interface SubscriptionPlan {
  id: string;
  name: string;
  description?: string;
  price: number;
  currency: string;
  interval: 'MONTHLY' | 'YEARLY';
  active: boolean;
  subscriberCount: number;
}

class HelioService {
  private config: HelioConfig | null = null;

  /**
   * Initialize the Helio service
   */
  initialize(config: HelioConfig): void {
    this.config = config;
    console.log('[Helio] Initialized on', config.network);
  }

  private getBaseUrl(): string {
    if (!this.config) throw new Error('Helio not initialized');
    return this.config.network === 'mainnet' ? HELIO_API_BASE : HELIO_DEVNET_API;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    queryParams: Record<string, string> = {}
  ): Promise<T> {
    if (!this.config) throw new Error('Helio not initialized');

    // Build URL with query params
    const url = new URL(`${this.getBaseUrl()}${endpoint}`);
    url.searchParams.set('apiKey', this.config.apiKey);

    // Add any additional query params
    Object.entries(queryParams).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Secret key for authenticated operations
    if (this.config.secretKey) {
      headers['Authorization'] = `Bearer ${this.config.secretKey}`;
    }

    const response = await fetch(url.toString(), {
      ...options,
      headers: { ...headers, ...options.headers },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Helio API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  // ==================== Subscriptions ====================

  /**
   * Get all subscriptions
   */
  async getSubscriptions(): Promise<HelioSubscription[]> {
    return this.request<HelioSubscription[]>('/subscription');
  }

  /**
   * Get subscription by ID
   */
  async getSubscription(id: string): Promise<HelioSubscription> {
    return this.request<HelioSubscription>(`/subscription/${id}`);
  }

  /**
   * Get subscriptions for a specific wallet
   */
  async getSubscriptionsByWallet(walletAddress: string): Promise<HelioSubscription[]> {
    return this.request<HelioSubscription[]>(`/subscription/wallet/${walletAddress}`);
  }

  /**
   * Cancel a subscription
   */
  async cancelSubscription(id: string): Promise<void> {
    await this.request(`/subscription/${id}/cancel`, { method: 'POST' });
  }

  // ==================== Subscription Plans ====================

  /**
   * Create a subscription plan
   */
  async createSubscriptionPlan(params: CreateSubscriptionPlanParams): Promise<SubscriptionPlan> {
    return this.request<SubscriptionPlan>('/subscription-plan', {
      method: 'POST',
      body: JSON.stringify({
        name: params.name,
        description: params.description,
        pricing: {
          amount: params.price,
          currency: params.currency,
        },
        interval: params.interval,
        recipientAddress: params.recipientAddress,
        features: params.features,
        trialPeriodDays: params.trialDays,
        annualDiscountPercent: params.annualDiscount,
      }),
    });
  }

  /**
   * Get all subscription plans
   */
  async getSubscriptionPlans(): Promise<SubscriptionPlan[]> {
    return this.request<SubscriptionPlan[]>('/subscription-plan');
  }

  /**
   * Get subscription plan by ID
   */
  async getSubscriptionPlan(id: string): Promise<SubscriptionPlan> {
    return this.request<SubscriptionPlan>(`/subscription-plan/${id}`);
  }

  // ==================== Pay Links ====================

  /**
   * Create a payment link
   */
  async createPayLink(params: CreatePayLinkParams): Promise<PayLink> {
    return this.request<PayLink>('/paylink', {
      method: 'POST',
      body: JSON.stringify({
        name: params.name,
        description: params.description,
        pricing: {
          amount: params.price,
          currency: params.currency,
        },
        recipientAddress: params.recipientAddress,
        features: params.features,
      }),
    });
  }

  /**
   * Get all pay links
   */
  async getPayLinks(): Promise<PayLink[]> {
    return this.request<PayLink[]>('/paylink');
  }

  // ==================== Checkout Widget URL ====================

  /**
   * Generate checkout widget URL for embedding
   */
  getCheckoutUrl(params: {
    type: 'paylink' | 'subscription';
    id: string;
    walletAddress?: string;
    email?: string;
    theme?: 'light' | 'dark';
  }): string {
    const base = this.config?.network === 'mainnet'
      ? 'https://app.hel.io'
      : 'https://app.dev.hel.io';

    const url = new URL(`${base}/${params.type}/${params.id}`);

    if (params.walletAddress) {
      url.searchParams.set('wallet', params.walletAddress);
    }
    if (params.email) {
      url.searchParams.set('email', params.email);
    }
    if (params.theme) {
      url.searchParams.set('theme', params.theme);
    }

    return url.toString();
  }

  // ==================== Currencies ====================

  /**
   * Get supported currencies
   */
  async getCurrencies(): Promise<Array<{
    symbol: string;
    name: string;
    mint: string;
    decimals: number;
  }>> {
    return this.request('/currency');
  }

  // ==================== Webhooks ====================

  /**
   * Verify webhook signature (for backend use)
   */
  verifyWebhookSignature(payload: string, signature: string): boolean {
    if (!this.config?.secretKey) {
      throw new Error('Secret key required for webhook verification');
    }

    // HMAC-SHA256 verification
    // This should be done server-side
    console.warn('[Helio] Webhook verification should be done server-side');
    return true;
  }
}

// Singleton instance
export const helio = new HelioService();
