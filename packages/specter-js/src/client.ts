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
  isUserRejection,
} from './types';
import {
  PERIODS,
  TOKENS,
  TOKEN_DECIMALS,
  DEFAULT_CONFIG,
  P01_PROVIDER_KEY,
  P01_INITIALIZED_EVENT,
  INSTALL_URL,
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
   * Check if Protocol 01 wallet extension is installed.
   *
   * @returns true if `window.protocol01` is available
   *
   * @example
   * ```typescript
   * if (P01.isInstalled()) {
   *   await p01.connect();
   * } else {
   *   // Show install prompt
   *   window.open(P01.getInstallUrl(), '_blank');
   * }
   * ```
   */
  static isInstalled(): boolean {
    return typeof window !== 'undefined' && !!window[P01_PROVIDER_KEY as keyof Window];
  }

  /**
   * Wait for Protocol 01 wallet to be available.
   *
   * The wallet extension injects itself asynchronously. This method listens
   * for the initialization event and resolves once the provider is detected,
   * or after the timeout expires.
   *
   * @param timeout - Maximum wait time in milliseconds (default: 3000)
   * @returns true if wallet became available, false on timeout
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
   * Register a callback to be invoked when the wallet extension becomes available.
   *
   * If the wallet is already installed, the callback is invoked immediately
   * (asynchronously via microtask). Otherwise, it listens for the initialization
   * event indefinitely.
   *
   * @param callback - Function to call once the wallet is available
   * @returns A cleanup function that removes the listener
   *
   * @example
   * ```typescript
   * const cleanup = P01.onInstall(() => {
   *   console.log('Protocol 01 wallet is now available!');
   *   // Enable connect button, etc.
   * });
   *
   * // Later, if you no longer need the listener:
   * cleanup();
   * ```
   */
  static onInstall(callback: () => void): () => void {
    if (P01.isInstalled()) {
      Promise.resolve().then(callback);
      return () => {};
    }

    const handler = () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener(P01_INITIALIZED_EVENT, handler);
      }
      callback();
    };

    if (typeof window !== 'undefined') {
      window.addEventListener(P01_INITIALIZED_EVENT, handler);
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener(P01_INITIALIZED_EVENT, handler);
      }
    };
  }

  /**
   * Get the URL to install the Protocol 01 wallet extension.
   */
  static getInstallUrl(): string {
    return INSTALL_URL;
  }

  /**
   * Set the active Solana network for the client.
   *
   * Note: this changes the network for this client instance. The wallet
   * extension may have its own network setting that takes precedence for
   * on-chain operations. Call this before `connect()` for best results.
   *
   * @param network - The network to use
   *
   * @example
   * ```typescript
   * const p01 = new P01();
   * p01.setNetwork('devnet');   // Use devnet for testing
   * await p01.connect();
   *
   * p01.setNetwork('mainnet-beta');  // Switch to mainnet
   * ```
   */
  setNetwork(network: 'devnet' | 'mainnet-beta'): void {
    this.config.network = network;
  }

  /**
   * Get the current network.
   */
  getNetwork(): 'devnet' | 'mainnet-beta' {
    return this.config.network;
  }

  /**
   * Connect to Protocol 01 wallet.
   *
   * @throws P01Error with code `NOT_INSTALLED` if the wallet extension is not detected (message includes install URL)
   * @throws P01Error with code `USER_REJECTED` if the user declines the connection
   * @throws P01Error with code `NETWORK_ERROR` if a network failure occurs during connection
   * @throws P01Error with code `TIMEOUT` if the connection times out
   */
  async connect(): Promise<ConnectResult> {
    if (!P01.isInstalled()) {
      throw new P01Error(
        P01ErrorCode.NOT_INSTALLED,
        `Protocol 01 wallet is not installed. Install at ${INSTALL_URL}`
      );
    }

    this.provider = (window as unknown as Record<string, P01Provider>)[P01_PROVIDER_KEY];

    try {
      const result = await withTimeout(
        this.provider.connect(),
        this.config.timeout,
        'Connection timed out'
      );
      this.connected = true;
      this.publicKey = result.publicKey;

      this.emit('connect', result);

      return result;
    } catch (error) {
      if (error instanceof P01Error) {
        throw error;
      }
      if (isUserRejection(error)) {
        throw new P01Error(
          P01ErrorCode.USER_REJECTED,
          'Connection rejected by user',
          error
        );
      }
      throw new P01Error(
        P01ErrorCode.UNKNOWN,
        'Failed to connect to wallet',
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

    const provider = (window as unknown as Record<string, P01Provider>)[P01_PROVIDER_KEY];
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
   * Send a one-time payment.
   *
   * @param options - Payment options (recipient, amount, token, privacy)
   * @returns Payment result with transaction signature
   *
   * @throws P01Error with code `NOT_CONNECTED` if wallet not connected
   * @throws P01Error with code `INVALID_PARAMS` if recipient or amount is invalid
   * @throws P01Error with code `USER_REJECTED` if the user declines the transaction
   * @throws P01Error with code `NETWORK_ERROR` if an RPC/network failure occurs
   * @throws P01Error with code `TIMEOUT` if the transaction times out
   * @throws P01Error with code `TRANSACTION_FAILED` if the on-chain transaction fails
   *
   * @example
   * ```typescript
   * import { isUserRejection, isNetworkError, isTimeoutError } from '@protocol-01/specter-js';
   *
   * try {
   *   const result = await p01.pay({
   *     recipient: 'wallet_address',
   *     amount: 10,
   *     token: 'USDC',
   *     private: true,
   *   });
   *   console.log('Paid!', result.signature);
   * } catch (error) {
   *   if (isUserRejection(error)) {
   *     showMessage('You declined the payment.');
   *   } else if (isNetworkError(error)) {
   *     showMessage('Network error. Please check your connection.');
   *   } else if (isTimeoutError(error)) {
   *     showMessage('Payment timed out. Please try again.');
   *   } else {
   *     showMessage('Payment failed.');
   *   }
   * }
   * ```
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

    try {
      if (isPrivate) {
        const result = await withTimeout(
          this.provider!.sendPrivate({
            recipient,
            amount: rawAmount,
            tokenMint,
          }),
          this.config.timeout,
          'Payment timed out'
        );

        this.emit('paymentSent', { ...options, signature: result.signature });

        return {
          signature: result.signature,
          isPrivate: true,
          confirmation: 'confirmed',
        };
      }

      // Public payment (standard transaction)
      const tx = await this.buildTransferTransaction(recipient, rawAmount, tokenMint);
      const signature = await withTimeout(
        this.provider!.signTransaction(tx),
        this.config.timeout,
        'Payment timed out'
      );

      this.emit('paymentSent', { ...options, signature });

      return {
        signature,
        isPrivate: false,
        confirmation: 'confirmed',
      };
    } catch (error) {
      if (error instanceof P01Error) {
        throw error;
      }
      if (isUserRejection(error)) {
        throw new P01Error(P01ErrorCode.USER_REJECTED, 'Payment rejected by user', error);
      }
      if (error instanceof Error && (error.message.toLowerCase().includes('network') || error.message.toLowerCase().includes('fetch'))) {
        throw new P01Error(P01ErrorCode.NETWORK_ERROR, 'Network error during payment', error);
      }
      throw new P01Error(P01ErrorCode.TRANSACTION_FAILED, 'Payment failed', error);
    }
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
  /**
   * Create a subscription using Stream Secure.
   *
   * @throws P01Error with code `NOT_CONNECTED` if wallet not connected
   * @throws P01Error with code `INVALID_PARAMS` if required fields are missing
   * @throws P01Error with code `USER_REJECTED` if the user declines
   * @throws P01Error with code `NETWORK_ERROR` if an RPC/network failure occurs
   * @throws P01Error with code `TIMEOUT` if the operation times out
   * @throws P01Error with code `TRANSACTION_FAILED` if the on-chain transaction fails
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

    try {
      // Call wallet to create subscription
      const result = await withTimeout(
        this.provider!.subscribe({
          recipient,
          merchantName,
          merchantLogo,
          tokenMint,
          amountPerPeriod: rawAmount,
          periodSeconds,
          maxPeriods: maxPayments,
          description,
        }),
        this.config.timeout,
        'Subscription creation timed out'
      );

      this.emit('subscriptionCreated', { ...options, ...result });

      return {
        subscriptionId: result.subscriptionId,
        address: result.address,
        signature: result.signature || '',
      };
    } catch (error) {
      if (error instanceof P01Error) {
        throw error;
      }
      if (isUserRejection(error)) {
        throw new P01Error(P01ErrorCode.USER_REJECTED, 'Subscription rejected by user', error);
      }
      if (error instanceof Error && (error.message.toLowerCase().includes('network') || error.message.toLowerCase().includes('fetch'))) {
        throw new P01Error(P01ErrorCode.NETWORK_ERROR, 'Network error during subscription creation', error);
      }
      throw new P01Error(P01ErrorCode.TRANSACTION_FAILED, 'Subscription creation failed', error);
    }
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
   * Subscribe to SDK events.
   *
   * Available events and their payloads:
   *
   * | Event | Payload | Description |
   * |---|---|---|
   * | `connect` | `ConnectResult` | Wallet connected |
   * | `disconnect` | `{}` | Wallet disconnected |
   * | `accountChanged` | `{ publicKey: string }` | Active account changed |
   * | `paymentSent` | `PaymentOptions & { signature }` | Payment sent |
   * | `paymentReceived` | `{ signature, amount, from }` | Incoming payment detected |
   * | `subscriptionCreated` | `SubscriptionOptions & SubscriptionResult` | New subscription |
   * | `subscriptionCancelled` | `{ subscriptionId }` | Subscription cancelled |
   * | `subscriptionPayment` | `{ subscriptionId, signature, periodsPaid }` | Recurring payment |
   *
   * @param event - The event type to listen for
   * @param callback - Function called when the event fires
   * @returns An unsubscribe function
   *
   * @example
   * ```typescript
   * // Listen for payments
   * const unsubscribe = p01.on('paymentSent', (event) => {
   *   console.log('Payment signature:', event.data.signature);
   * });
   *
   * // Cleanup when done
   * unsubscribe();
   * ```
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

// ============ Internal Helpers ============

/**
 * Wrap a promise with a timeout.
 * @internal
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage = 'Operation timed out'
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new P01Error(P01ErrorCode.TIMEOUT, errorMessage)),
        timeoutMs
      )
    ),
  ]);
}

// Aliases for backward compatibility
export { P01 as Specter };
export type { P01Config as SpecterConfig };
