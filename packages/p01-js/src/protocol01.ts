/**
 * Protocol 01 SDK
 *
 * Main SDK class for merchants to integrate Protocol 01 payments.
 *
 * @example Basic Usage
 * ```typescript
 * import { Protocol01 } from '@protocol01/sdk';
 *
 * const p01 = new Protocol01({
 *   merchantId: 'netflix-001',
 *   merchantName: 'Netflix',
 *   merchantLogo: 'https://assets.nflxext.com/...',
 *   merchantCategory: 'streaming',
 *   webhookUrl: 'https://api.netflix.com/p01/webhook',
 *   defaultToken: 'USDC',
 * });
 *
 * // Connect to wallet
 * await p01.connect();
 *
 * // One-time payment
 * const payment = await p01.requestPayment({
 *   amount: 15.99,
 *   description: 'Netflix Premium Monthly',
 *   orderId: 'order-123',
 * });
 *
 * // Subscription with Stream Secure
 * const sub = await p01.createSubscription({
 *   amount: 15.99,
 *   interval: 'monthly',
 *   maxPayments: 12,
 *   description: 'Netflix Premium',
 *   suggestedPrivacy: {
 *     amountNoise: 5,
 *     timingNoise: 2,
 *     useStealthAddress: true,
 *   },
 * });
 * ```
 */

import {
  MerchantConfig,
  MerchantCategory,
  PaymentRequestOptions,
  PaymentResult,
  SubscriptionOptions,
  SubscriptionResult,
  Subscription,
  ConnectResult,
  WalletInfo,
  Protocol01Event,
  Protocol01EventType,
  Protocol01Error,
  Protocol01ErrorCode,
  Protocol01Provider,
  EventCallback,
  InternalPaymentRequest,
  InternalSubscriptionRequest,
} from './types';
import {
  DEFAULT_CONFIG,
  PROVIDER_KEY,
  SOLANA_PROVIDER_KEY,
  PROVIDER_INITIALIZED_EVENT,
  SOLANA_INITIALIZED_EVENT,
} from './constants';
import {
  resolveTokenMint,
  toRawAmount,
  fromRawAmount,
  resolveInterval,
  validateAmount,
  validateInterval,
  validateMerchantConfig,
  normalizePrivacyOptions,
  ensureOrderId,
  calculateNextPayment,
  withTimeout,
  isBrowser,
  generateId,
} from './utils';

// ============ Configuration ============

/**
 * Full configuration with defaults applied
 */
interface ResolvedConfig {
  merchantId: string;
  merchantName: string;
  merchantLogo?: string;
  merchantCategory?: MerchantCategory;
  webhookUrl?: string;
  defaultToken: string;
  network: 'devnet' | 'mainnet-beta';
  rpcEndpoint?: string;
  timeout: number;
  autoConnect: boolean;
}

// ============ Main Class ============

/**
 * Protocol 01 SDK for merchant integrations
 */
export class Protocol01 {
  private config: ResolvedConfig;
  private provider: Protocol01Provider | null = null;
  private solanaProvider: SolanaProvider | null = null;
  private connected = false;
  private publicKey: string | null = null;
  private eventListeners = new Map<Protocol01EventType, Set<EventCallback>>();
  private initPromise: Promise<void> | null = null;

  /**
   * Create a new Protocol01 instance
   * @param config - Merchant configuration
   */
  constructor(config: MerchantConfig) {
    // Validate required config
    validateMerchantConfig(config);

    // Apply defaults
    this.config = {
      merchantId: config.merchantId,
      merchantName: config.merchantName,
      merchantLogo: config.merchantLogo,
      merchantCategory: config.merchantCategory,
      webhookUrl: config.webhookUrl,
      defaultToken: config.defaultToken ?? DEFAULT_CONFIG.defaultToken,
      network: config.network ?? DEFAULT_CONFIG.network,
      rpcEndpoint: config.rpcEndpoint,
      timeout: config.timeout ?? DEFAULT_CONFIG.timeout,
      autoConnect: config.autoConnect ?? DEFAULT_CONFIG.autoConnect,
    };

    // Initialize in browser
    if (isBrowser()) {
      this.initPromise = this.initialize();
    }
  }

  // ============ Initialization ============

  /**
   * Initialize the SDK and detect providers
   */
  private async initialize(): Promise<void> {
    // Wait for providers to be available
    const available = await this.waitForProvider(3000);

    if (!available) {
      console.warn(
        'Protocol 01 wallet not detected. Some features may be limited.'
      );
    }

    // Auto-connect if configured
    if (this.config.autoConnect && available) {
      try {
        await this.connect();
      } catch (error) {
        // Silent fail on auto-connect
        console.debug('Auto-connect failed:', error);
      }
    }
  }

  /**
   * Wait for wallet provider to be available
   * @param timeout - Timeout in milliseconds
   * @returns true if provider is available
   */
  private waitForProvider(timeout = 3000): Promise<boolean> {
    return new Promise((resolve) => {
      // Check if already available
      if (this.detectProvider()) {
        resolve(true);
        return;
      }

      // Listen for initialization events
      const handleInit = () => {
        cleanup();
        resolve(this.detectProvider());
      };

      const cleanup = () => {
        window.removeEventListener(PROVIDER_INITIALIZED_EVENT, handleInit);
        window.removeEventListener(SOLANA_INITIALIZED_EVENT, handleInit);
      };

      window.addEventListener(PROVIDER_INITIALIZED_EVENT, handleInit);
      window.addEventListener(SOLANA_INITIALIZED_EVENT, handleInit);

      // Timeout
      setTimeout(() => {
        cleanup();
        resolve(this.detectProvider());
      }, timeout);
    });
  }

  /**
   * Detect available wallet providers
   * @returns true if a compatible provider is found
   */
  private detectProvider(): boolean {
    if (!isBrowser()) return false;

    const win = window as Window & {
      [PROVIDER_KEY]?: Protocol01Provider;
      [SOLANA_PROVIDER_KEY]?: SolanaProvider;
    };

    // Prefer Protocol 01 native provider
    if (win[PROVIDER_KEY]?.isProtocol01) {
      this.provider = win[PROVIDER_KEY];
      return true;
    }

    // Fall back to Solana provider with adapter
    if (win[SOLANA_PROVIDER_KEY]) {
      this.solanaProvider = win[SOLANA_PROVIDER_KEY];
      return true;
    }

    return false;
  }

  // ============ Static Methods ============

  /**
   * Check if a Protocol 01 compatible wallet is installed
   */
  static isInstalled(): boolean {
    if (!isBrowser()) return false;

    const win = window as Window & {
      [PROVIDER_KEY]?: Protocol01Provider;
      [SOLANA_PROVIDER_KEY]?: SolanaProvider;
    };

    return !!(win[PROVIDER_KEY]?.isProtocol01 || win[SOLANA_PROVIDER_KEY]);
  }

  /**
   * Wait for wallet to be installed
   * @param timeout - Timeout in milliseconds
   * @returns true if wallet is available
   */
  static waitForInstall(timeout = 5000): Promise<boolean> {
    return new Promise((resolve) => {
      if (Protocol01.isInstalled()) {
        resolve(true);
        return;
      }

      const handleInit = () => {
        cleanup();
        resolve(Protocol01.isInstalled());
      };

      const cleanup = () => {
        window.removeEventListener(PROVIDER_INITIALIZED_EVENT, handleInit);
        window.removeEventListener(SOLANA_INITIALIZED_EVENT, handleInit);
      };

      window.addEventListener(PROVIDER_INITIALIZED_EVENT, handleInit);
      window.addEventListener(SOLANA_INITIALIZED_EVENT, handleInit);

      setTimeout(() => {
        cleanup();
        resolve(Protocol01.isInstalled());
      }, timeout);
    });
  }

  /**
   * Get the URL to install Protocol 01 wallet
   */
  static getInstallUrl(): string {
    return 'https://protocol01.com/wallet';
  }

  // ============ Connection Methods ============

  /**
   * Connect to the user's wallet
   * @returns Connection result with public key
   * @throws Protocol01Error if connection fails
   *
   * @example
   * ```typescript
   * try {
   *   const { publicKey } = await p01.connect();
   *   console.log('Connected:', publicKey);
   * } catch (error) {
   *   if (error.code === 'WALLET_NOT_INSTALLED') {
   *     // Show install prompt
   *   }
   * }
   * ```
   */
  async connect(): Promise<ConnectResult> {
    // Wait for initialization
    if (this.initPromise) {
      await this.initPromise;
    }

    // Check for provider
    if (!this.provider && !this.solanaProvider) {
      throw new Protocol01Error(
        Protocol01ErrorCode.WALLET_NOT_INSTALLED,
        'No compatible wallet found. Please install Protocol 01 wallet.',
        { recoverable: true }
      );
    }

    try {
      let result: ConnectResult;

      if (this.provider) {
        // Use native Protocol 01 provider
        result = await withTimeout(
          this.provider.connect(),
          this.config.timeout,
          'Connection timed out'
        );
      } else if (this.solanaProvider) {
        // Use Solana provider adapter
        const response = await withTimeout(
          this.solanaProvider.connect(),
          this.config.timeout,
          'Connection timed out'
        );
        result = {
          publicKey: response.publicKey.toString(),
          supportsProtocol01: false,
        };
      } else {
        throw new Protocol01Error(
          Protocol01ErrorCode.WALLET_NOT_INSTALLED,
          'No wallet provider available'
        );
      }

      this.connected = true;
      this.publicKey = result.publicKey;

      // Emit connect event
      this.emit('connect', result);

      return result;
    } catch (error) {
      // Handle user rejection
      if (
        error instanceof Error &&
        (error.message.includes('rejected') ||
          error.message.includes('cancelled'))
      ) {
        throw new Protocol01Error(
          Protocol01ErrorCode.CONNECTION_REJECTED,
          'Connection rejected by user',
          { details: error, recoverable: true }
        );
      }

      // Re-throw Protocol01Error
      if (error instanceof Protocol01Error) {
        throw error;
      }

      // Wrap unknown errors
      throw new Protocol01Error(
        Protocol01ErrorCode.UNKNOWN,
        'Failed to connect to wallet',
        { details: error }
      );
    }
  }

  /**
   * Disconnect from the wallet
   */
  async disconnect(): Promise<void> {
    if (this.provider) {
      await this.provider.disconnect();
    } else if (this.solanaProvider) {
      await this.solanaProvider.disconnect();
    }

    this.connected = false;
    this.publicKey = null;

    this.emit('disconnect', {});
  }

  /**
   * Check if currently connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get connected wallet public key
   */
  getPublicKey(): string | null {
    return this.publicKey;
  }

  /**
   * Get wallet information
   */
  async getWalletInfo(): Promise<WalletInfo | null> {
    if (!this.connected) return null;

    const features = ['payments'];

    if (this.provider) {
      return {
        publicKey: this.publicKey!,
        name: 'Protocol 01',
        isProtocol01Compatible: true,
        version: this.provider.version,
        features: [
          'payments',
          'subscriptions',
          'stealth-addresses',
          'privacy-options',
          'webhooks',
        ],
      };
    }

    if (this.solanaProvider) {
      return {
        publicKey: this.publicKey!,
        name: 'Solana Wallet',
        isProtocol01Compatible: false,
        version: '1.0.0',
        features: features as WalletInfo['features'],
      };
    }

    return null;
  }

  // ============ Payment Methods ============

  /**
   * Request a one-time payment from the connected wallet
   * @param options - Payment options
   * @returns Payment result with transaction signature
   *
   * @example
   * ```typescript
   * const payment = await p01.requestPayment({
   *   amount: 15.99,
   *   token: 'USDC',
   *   description: 'Netflix Premium Monthly',
   *   orderId: 'order-123',
   *   metadata: { planType: 'premium' },
   * });
   *
   * console.log('Payment signature:', payment.signature);
   * ```
   */
  async requestPayment(options: PaymentRequestOptions): Promise<PaymentResult> {
    this.ensureConnected();

    // Validate amount
    validateAmount(options.amount);

    // Resolve token
    const token = options.token ?? this.config.defaultToken;
    const tokenMint = resolveTokenMint(token, this.config.network);

    // Generate order ID if not provided
    const orderId = ensureOrderId(options.orderId);

    // Build internal request
    const request: InternalPaymentRequest = {
      merchantId: this.config.merchantId,
      merchantName: this.config.merchantName,
      merchantLogo: this.config.merchantLogo,
      merchantCategory: this.config.merchantCategory,
      amount: Number(toRawAmount(options.amount, tokenMint, this.config.network)),
      tokenMint,
      description: options.description,
      orderId,
      metadata: options.metadata,
      memo: options.memo,
      useStealthAddress: options.useStealthAddress,
      webhookUrl: this.config.webhookUrl,
    };

    try {
      let result: PaymentResult;

      if (this.provider) {
        // Use native Protocol 01 provider
        result = await withTimeout(
          this.provider.requestPayment(request),
          this.config.timeout,
          'Payment request timed out'
        );
      } else {
        // Use Solana provider fallback (limited features)
        result = await this.requestPaymentViaSolana(request);
      }

      // Emit event
      this.emit('paymentComplete', result);

      return result;
    } catch (error) {
      this.emit('paymentFailed', { error, options });

      if (
        error instanceof Error &&
        (error.message.includes('rejected') ||
          error.message.includes('cancelled'))
      ) {
        throw new Protocol01Error(
          Protocol01ErrorCode.PAYMENT_REJECTED,
          'Payment rejected by user',
          { details: error, recoverable: true }
        );
      }

      if (error instanceof Protocol01Error) {
        throw error;
      }

      throw new Protocol01Error(
        Protocol01ErrorCode.PAYMENT_FAILED,
        'Payment failed',
        { details: error }
      );
    }
  }

  /**
   * Fallback payment via standard Solana provider
   */
  private async requestPaymentViaSolana(
    request: InternalPaymentRequest
  ): Promise<PaymentResult> {
    if (!this.solanaProvider) {
      throw new Protocol01Error(
        Protocol01ErrorCode.WALLET_NOT_CONNECTED,
        'No wallet connected'
      );
    }

    // This would build and send a standard Solana transaction
    // For full implementation, would need to integrate with @solana/web3.js
    // This is a placeholder showing the structure
    throw new Protocol01Error(
      Protocol01ErrorCode.UNKNOWN,
      'Standard Solana payments require Protocol 01 wallet for full features. Please install Protocol 01 wallet.',
      { recoverable: true }
    );
  }

  // ============ Subscription Methods ============

  /**
   * Create a subscription using Stream Secure
   *
   * Stream Secure subscriptions have strict on-chain limits that protect users:
   * - Maximum amount per payment period (cannot be exceeded)
   * - Payment frequency (merchant can only charge once per period)
   * - Maximum total payments (optional, enforced on-chain)
   *
   * Privacy options allow users to obscure their subscription patterns.
   *
   * @param options - Subscription options
   * @returns Subscription result
   *
   * @example
   * ```typescript
   * const sub = await p01.createSubscription({
   *   amount: 15.99,
   *   token: 'USDC',
   *   interval: 'monthly',
   *   maxPayments: 12, // 1 year
   *   description: 'Netflix Premium',
   *   suggestedPrivacy: {
   *     amountNoise: 5,    // +/-5% variance
   *     timingNoise: 2,    // +/-2 hour variance
   *     useStealthAddress: true,
   *   },
   * });
   *
   * console.log('Subscription created:', sub.subscriptionId);
   * console.log('Next payment:', new Date(sub.nextPaymentAt));
   * ```
   */
  async createSubscription(
    options: SubscriptionOptions
  ): Promise<SubscriptionResult> {
    this.ensureConnected();

    // Validate
    validateAmount(options.amount);
    validateInterval(options.interval);

    // Resolve values
    const token = options.token ?? this.config.defaultToken;
    const tokenMint = resolveTokenMint(token, this.config.network);
    const periodSeconds = resolveInterval(options.interval);
    const rawAmount = Number(
      toRawAmount(options.amount, tokenMint, this.config.network)
    );
    const privacy = normalizePrivacyOptions(options.suggestedPrivacy);

    // Build internal request
    const request: InternalSubscriptionRequest = {
      merchantId: this.config.merchantId,
      merchantName: this.config.merchantName,
      merchantLogo: this.config.merchantLogo,
      merchantCategory: this.config.merchantCategory,
      tokenMint,
      amountPerPeriod: rawAmount,
      periodSeconds,
      maxPeriods: options.maxPayments ?? 0,
      description: options.description,
      subscriptionRef: options.subscriptionRef,
      metadata: options.metadata,
      suggestedPrivacy: privacy,
      trialDays: options.trialDays,
      startDate: options.startDate?.getTime(),
      webhookUrl: this.config.webhookUrl,
    };

    try {
      if (!this.provider) {
        throw new Protocol01Error(
          Protocol01ErrorCode.WALLET_NOT_INSTALLED,
          'Stream Secure subscriptions require Protocol 01 wallet. Please install Protocol 01 wallet.',
          { recoverable: true }
        );
      }

      const result = await withTimeout(
        this.provider.createSubscription(request),
        this.config.timeout,
        'Subscription creation timed out'
      );

      // Emit event
      this.emit('subscriptionCreated', result);

      return result;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('rejected') ||
          error.message.includes('cancelled'))
      ) {
        throw new Protocol01Error(
          Protocol01ErrorCode.PAYMENT_REJECTED,
          'Subscription rejected by user',
          { details: error, recoverable: true }
        );
      }

      if (error instanceof Protocol01Error) {
        throw error;
      }

      throw new Protocol01Error(
        Protocol01ErrorCode.UNKNOWN,
        'Failed to create subscription',
        { details: error }
      );
    }
  }

  /**
   * Get all subscriptions for the connected wallet with this merchant
   * @returns Array of subscriptions
   */
  async getSubscriptions(): Promise<Subscription[]> {
    this.ensureConnected();

    if (!this.provider) {
      return [];
    }

    return this.provider.getSubscriptions(this.config.merchantId);
  }

  /**
   * Get a specific subscription by ID
   * @param subscriptionId - Subscription ID
   * @returns Subscription or null if not found
   */
  async getSubscription(subscriptionId: string): Promise<Subscription | null> {
    const subs = await this.getSubscriptions();
    return subs.find((s) => s.id === subscriptionId) ?? null;
  }

  /**
   * Cancel a subscription
   * @param subscriptionId - Subscription ID to cancel
   */
  async cancelSubscription(subscriptionId: string): Promise<void> {
    this.ensureConnected();

    if (!this.provider) {
      throw new Protocol01Error(
        Protocol01ErrorCode.WALLET_NOT_INSTALLED,
        'Subscription management requires Protocol 01 wallet'
      );
    }

    await this.provider.cancelSubscription(subscriptionId);

    this.emit('subscriptionCancelled', { subscriptionId });
  }

  // ============ Event Methods ============

  /**
   * Subscribe to SDK events
   * @param event - Event type
   * @param callback - Callback function
   * @returns Unsubscribe function
   *
   * @example
   * ```typescript
   * const unsubscribe = p01.on('paymentComplete', (event) => {
   *   console.log('Payment completed:', event.data);
   * });
   *
   * // Later...
   * unsubscribe();
   * ```
   */
  on<T = unknown>(
    event: Protocol01EventType,
    callback: EventCallback<T>
  ): () => void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(callback as EventCallback);

    return () => this.off(event, callback);
  }

  /**
   * Unsubscribe from SDK events
   * @param event - Event type
   * @param callback - Callback function
   */
  off<T = unknown>(event: Protocol01EventType, callback: EventCallback<T>): void {
    this.eventListeners.get(event)?.delete(callback as EventCallback);
  }

  /**
   * Emit an event
   */
  private emit<T>(type: Protocol01EventType, data: T): void {
    const event: Protocol01Event<T> = {
      type,
      data,
      timestamp: Date.now(),
    };

    this.eventListeners.get(type)?.forEach((cb) => {
      try {
        cb(event);
      } catch (error) {
        console.error(`Error in ${type} event handler:`, error);
      }
    });
  }

  // ============ Helper Methods ============

  /**
   * Ensure wallet is connected
   * @throws Protocol01Error if not connected
   */
  private ensureConnected(): void {
    if (!this.connected) {
      throw new Protocol01Error(
        Protocol01ErrorCode.WALLET_NOT_CONNECTED,
        'Wallet not connected. Call connect() first.',
        { recoverable: true }
      );
    }
  }

  /**
   * Get merchant configuration
   */
  getMerchantConfig(): Readonly<ResolvedConfig> {
    return { ...this.config };
  }

  /**
   * Update merchant configuration
   * Note: Cannot update merchantId after creation
   */
  updateConfig(updates: Partial<Omit<MerchantConfig, 'merchantId'>>): void {
    if (updates.merchantName !== undefined) {
      this.config.merchantName = updates.merchantName;
    }
    if (updates.merchantLogo !== undefined) {
      this.config.merchantLogo = updates.merchantLogo;
    }
    if (updates.merchantCategory !== undefined) {
      this.config.merchantCategory = updates.merchantCategory;
    }
    if (updates.webhookUrl !== undefined) {
      this.config.webhookUrl = updates.webhookUrl;
    }
    if (updates.defaultToken !== undefined) {
      this.config.defaultToken = updates.defaultToken;
    }
  }
}

// ============ Solana Provider Interface ============

/**
 * Standard Solana wallet provider interface
 * @internal
 */
interface SolanaProvider {
  connect(): Promise<{ publicKey: { toString(): string } }>;
  disconnect(): Promise<void>;
  signTransaction?(transaction: unknown): Promise<unknown>;
  signAllTransactions?(transactions: unknown[]): Promise<unknown[]>;
  signMessage?(message: Uint8Array): Promise<{ signature: Uint8Array }>;
}

// ============ Export ============

export type { MerchantConfig, ResolvedConfig };
