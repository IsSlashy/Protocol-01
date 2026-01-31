/**
 * Protocol 01 Client
 *
 * Main SDK class for interacting with Protocol 01 wallet.
 */

import {
  PaymentOptions,
  PaymentResult,
  SubscriptionOptions,
  Subscription,
  SubscriptionResult,
  SubscriptionPeriod,
  ConnectResult,
  WalletInfo,
  P01Event,
  P01EventType,
  P01Error,
  P01ErrorCode,
} from './types';
import {
  PERIODS,
  TOKENS,
  TOKEN_DECIMALS,
  DEFAULT_CONFIG,
  P01_PROVIDER_KEY,
  P01_INITIALIZED_EVENT,
} from './constants';

export interface P01Config {
  /** Network to use */
  network?: 'devnet' | 'mainnet-beta';
  /** Auto-connect on initialization */
  autoConnect?: boolean;
  /** Request timeout in ms */
  timeout?: number;
  /** Custom RPC endpoint */
  rpcEndpoint?: string;
}

type EventCallback = (event: P01Event) => void;

export class P01 {
  private config: Required<P01Config>;
  private provider: P01Provider | null = null;
  private connected = false;
  private publicKey: string | null = null;
  private eventListeners = new Map<P01EventType, Set<EventCallback>>();

  constructor(config: P01Config = {}) {
    this.config = {
      network: config.network ?? DEFAULT_CONFIG.network,
      autoConnect: config.autoConnect ?? DEFAULT_CONFIG.autoConnect,
      timeout: config.timeout ?? DEFAULT_CONFIG.timeout,
      rpcEndpoint: config.rpcEndpoint ?? '',
    };

    // Auto-connect if configured
    if (typeof window !== 'undefined' && this.config.autoConnect) {
      this.connect().catch(() => {});
    }
  }

  // ============ Connection ============

  /**
   * Check if Protocol 01 wallet is installed
   */
  static isInstalled(): boolean {
    return typeof window !== 'undefined' && !!window[P01_PROVIDER_KEY as keyof Window];
  }

  /**
   * Wait for Protocol 01 wallet to be available
   */
  static waitForInstall(timeout = 3000): Promise<boolean> {
    return new Promise((resolve) => {
      if (P01.isInstalled()) {
        resolve(true);
        return;
      }

      const handler = () => {
        window.removeEventListener(P01_INITIALIZED_EVENT, handler);
        resolve(true);
      };

      window.addEventListener(P01_INITIALIZED_EVENT, handler);

      setTimeout(() => {
        window.removeEventListener(P01_INITIALIZED_EVENT, handler);
        resolve(P01.isInstalled());
      }, timeout);
    });
  }

  /**
   * Connect to Protocol 01 wallet
   */
  async connect(): Promise<ConnectResult> {
    if (!P01.isInstalled()) {
      throw new P01Error(
        P01ErrorCode.NOT_INSTALLED,
        'Protocol 01 wallet is not installed. Please install the extension.'
      );
    }

    this.provider = (window as Window & { specter?: P01Provider })[P01_PROVIDER_KEY] as P01Provider;

    try {
      const result = await this.provider.connect();
      this.connected = true;
      this.publicKey = result.publicKey;

      this.emit('connect', result);

      return result;
    } catch (error) {
      throw new P01Error(
        P01ErrorCode.USER_REJECTED,
        'Connection rejected by user',
        error
      );
    }
  }

  /**
   * Disconnect from wallet
   */
  async disconnect(): Promise<void> {
    if (this.provider) {
      await this.provider.disconnect();
    }
    this.connected = false;
    this.publicKey = null;
    this.emit('disconnect', {});
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get wallet info
   */
  async getWalletInfo(): Promise<WalletInfo | null> {
    if (!P01.isInstalled()) return null;

    const provider = (window as Window & { specter?: P01Provider })[P01_PROVIDER_KEY] as P01Provider;
    return {
      publicKey: this.publicKey || '',
      isP01: provider.isP01,
      version: provider.version,
    };
  }

  /**
   * Get connected public key
   */
  getPublicKey(): string | null {
    return this.publicKey;
  }

  // ============ Payments ============

  /**
   * Send a one-time payment
   */
  async pay(options: PaymentOptions): Promise<PaymentResult> {
    this.ensureConnected();

    const { recipient, amount, token = 'USDC', private: isPrivate = true } = options;

    // Validate
    if (!recipient) {
      throw new P01Error(P01ErrorCode.INVALID_PARAMS, 'Recipient required');
    }
    if (!amount || amount <= 0) {
      throw new P01Error(P01ErrorCode.INVALID_PARAMS, 'Invalid amount');
    }

    // Convert amount to raw units
    const tokenMint = this.resolveToken(token);
    const decimals = TOKEN_DECIMALS[tokenMint] || 9;
    const rawAmount = Math.floor(amount * Math.pow(10, decimals));

    if (isPrivate) {
      const result = await this.provider!.sendPrivate({
        recipient,
        amount: rawAmount,
        tokenMint,
      });

      this.emit('paymentSent', { ...options, signature: result.signature });

      return {
        signature: result.signature,
        isPrivate: true,
        confirmation: 'confirmed',
      };
    }

    // Public payment (standard transaction)
    const tx = await this.buildTransferTransaction(recipient, rawAmount, tokenMint);
    const signature = await this.provider!.signTransaction(tx);

    this.emit('paymentSent', { ...options, signature });

    return {
      signature,
      isPrivate: false,
      confirmation: 'confirmed',
    };
  }

  // ============ Subscriptions (Stream Secure) ============

  /**
   * Create a subscription
   *
   * Stream Secure subscriptions have strict on-chain limits:
   * - Maximum amount per payment period
   * - Payment frequency (merchant can only charge once per period)
   * - Maximum total payments (optional)
   *
   * Unlike traditional "approve unlimited" patterns, the merchant
   * cannot exceed these limits under any circumstances.
   *
   * @example
   * ```ts
   * // Monthly Netflix subscription
   * await specter.subscribe({
   *   recipient: 'netflix_wallet',
   *   merchantName: 'Netflix',
   *   amount: 15.99,
   *   period: 'monthly',
   *   maxPayments: 12,
   * });
   *
   * // Unlimited duration subscription
   * await specter.subscribe({
   *   recipient: 'spotify_wallet',
   *   merchantName: 'Spotify',
   *   amount: 9.99,
   *   period: 'monthly',
   *   maxPayments: 0, // No limit
   * });
   * ```
   */
  async subscribe(options: SubscriptionOptions): Promise<SubscriptionResult> {
    this.ensureConnected();

    const {
      recipient,
      merchantName,
      merchantLogo,
      amount,
      token = 'USDC',
      period,
      maxPayments = 0,
      description,
    } = options;

    // Validate
    if (!recipient) {
      throw new P01Error(P01ErrorCode.INVALID_PARAMS, 'Recipient required');
    }
    if (!merchantName) {
      throw new P01Error(P01ErrorCode.INVALID_PARAMS, 'Merchant name required');
    }
    if (!amount || amount <= 0) {
      throw new P01Error(P01ErrorCode.INVALID_PARAMS, 'Invalid amount');
    }

    // Resolve period to seconds
    const periodSeconds = this.resolvePeriod(period);

    // Convert amount to raw units
    const tokenMint = this.resolveToken(token);
    const decimals = TOKEN_DECIMALS[tokenMint] || 6;
    const rawAmount = Math.floor(amount * Math.pow(10, decimals));

    // Call wallet to create subscription
    const result = await this.provider!.subscribe({
      recipient,
      merchantName,
      merchantLogo,
      tokenMint,
      amountPerPeriod: rawAmount,
      periodSeconds,
      maxPeriods: maxPayments,
      description,
    });

    this.emit('subscriptionCreated', { ...options, ...result });

    return {
      subscriptionId: result.subscriptionId,
      address: result.address,
      signature: result.signature || '',
    };
  }

  /**
   * Get all subscriptions for connected wallet
   */
  async getSubscriptions(): Promise<Subscription[]> {
    this.ensureConnected();
    return this.provider!.getSubscriptions();
  }

  /**
   * Cancel a subscription
   */
  async cancelSubscription(subscriptionId: string): Promise<void> {
    this.ensureConnected();

    await this.provider!.cancelSubscription(subscriptionId);

    this.emit('subscriptionCancelled', { subscriptionId });
  }

  // ============ Events ============

  /**
   * Subscribe to events
   */
  on(event: P01EventType, callback: EventCallback): () => void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(callback);

    // Return unsubscribe function
    return () => this.off(event, callback);
  }

  /**
   * Unsubscribe from events
   */
  off(event: P01EventType, callback: EventCallback): void {
    this.eventListeners.get(event)?.delete(callback);
  }

  /**
   * Emit an event
   */
  private emit(type: P01EventType, data: unknown): void {
    const event: P01Event = {
      type,
      data,
      timestamp: Date.now(),
    };

    this.eventListeners.get(type)?.forEach((cb) => {
      try {
        cb(event);
      } catch (e) {
        console.error('Event handler error:', e);
      }
    });
  }

  // ============ Helpers ============

  private ensureConnected(): void {
    if (!this.connected || !this.provider) {
      throw new P01Error(
        P01ErrorCode.NOT_CONNECTED,
        'Not connected to wallet. Call connect() first.'
      );
    }
  }

  private resolveToken(token: string): string {
    // Check if it's a known symbol
    const upper = token.toUpperCase();
    if (upper in TOKENS) {
      return TOKENS[upper as keyof typeof TOKENS];
    }
    // Assume it's a mint address
    return token;
  }

  private resolvePeriod(period: SubscriptionPeriod): number {
    if (typeof period === 'number') {
      return period;
    }
    return PERIODS[period];
  }

  private async buildTransferTransaction(
    recipient: string,
    amount: number,
    tokenMint: string
  ): Promise<string> {
    // This would build the actual transaction
    // For now, return a placeholder
    return 'mock_transaction';
  }
}

// Provider interface (what window.specter provides)
interface P01Provider {
  isP01: boolean;
  version: string;
  connect(): Promise<{ publicKey: string }>;
  disconnect(): Promise<void>;
  isConnected(): Promise<boolean>;
  getAccounts(): Promise<string[]>;
  signTransaction(tx: string): Promise<string>;
  signAllTransactions(txs: string[]): Promise<string[]>;
  signMessage(msg: string): Promise<string>;
  sendPrivate(options: {
    recipient: string;
    amount: number;
    tokenMint?: string;
  }): Promise<{ signature: string }>;
  subscribe(options: {
    recipient: string;
    merchantName: string;
    merchantLogo?: string;
    tokenMint?: string;
    amountPerPeriod: number;
    periodSeconds: number;
    maxPeriods: number;
    description?: string;
  }): Promise<{ subscriptionId: string; address: string; signature?: string }>;
  getSubscriptions(): Promise<Subscription[]>;
  cancelSubscription(id: string): Promise<{ success: boolean }>;
  on(event: string, callback: (...args: unknown[]) => void): void;
  off(event: string, callback: (...args: unknown[]) => void): void;
}

// Aliases for backward compatibility
export { P01 as Specter };
export type { P01Config as SpecterConfig };
