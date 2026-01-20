import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import type {
  SpecterWallet,
  SpecterClientConfig,
  Balance,
  StealthAddress,
  StealthPayment,
  PrivacyOptions,
  Stream,
  StreamCreateOptions,
  ScanOptions,
  Cluster,
  WalletAdapter,
  SpecterEvent,
  SpecterEventListener,
  StealthMetaAddress,
} from './types';
import { SpecterError, SpecterErrorCode } from './types';
import {
  RPC_ENDPOINTS,
  DEFAULT_PROGRAM_ID,
  PROGRAM_IDS,
  LAMPORTS_PER_SOL,
} from './constants';
import { createConnection, formatSol, solToLamports } from './utils/helpers';

// Wallet operations
import { createWallet, createWalletState } from './wallet/create';
import { importFromSeedPhrase, importWalletState } from './wallet/import';
import type { WalletState } from './wallet/types';

// Stealth operations
import {
  generateStealthAddress,
  generateStealthMetaAddress,
} from './stealth/generate';
import { StealthScanner, subscribeToPayments } from './stealth/scan';
import { deriveStealthPrivateKey } from './stealth/derive';

// Transfer operations
import { sendPrivate, sendPublic, estimateTransferFee } from './transfer/send';
import { claimStealth, getStealthBalance, canClaim } from './transfer/claim';

// Stream operations
import {
  createStream,
  calculateWithdrawableAmount,
  getStreamProgress,
} from './streams/create';
import { withdrawStream, getStream, getUserStreams } from './streams/withdraw';
import { cancelStream, pauseStream, resumeStream } from './streams/cancel';

/**
 * Main client for interacting with the Specter Protocol
 *
 * @example
 * ```typescript
 * // Create a new client
 * const client = new SpecterClient({ cluster: 'devnet' });
 *
 * // Create a wallet
 * const wallet = await SpecterClient.createWallet();
 * client.connect(wallet);
 *
 * // Send a private transfer
 * const result = await client.sendPrivate(
 *   recipientStealthAddress,
 *   1.5, // SOL
 *   { level: 'enhanced' }
 * );
 * ```
 */
export class SpecterClient {
  private connection: Connection;
  private config: Required<SpecterClientConfig>;
  private walletState: WalletState | null = null;
  private externalWallet: WalletAdapter | null = null;
  private scanner: StealthScanner | null = null;
  private eventListeners: Map<string, SpecterEventListener[]> = new Map();
  private scanSubscription: { unsubscribe: () => void } | null = null;

  constructor(config: SpecterClientConfig = {}) {
    const cluster = config.cluster || 'devnet';

    this.config = {
      cluster,
      rpcEndpoint: config.rpcEndpoint || RPC_ENDPOINTS[cluster],
      commitment: config.commitment || 'confirmed',
      debug: config.debug || false,
      programId: config.programId || PROGRAM_IDS[cluster],
      timeout: config.timeout || 60000,
    };

    this.connection = createConnection(
      this.config.rpcEndpoint,
      this.config.commitment
    );

    if (this.config.debug) {
      console.log('[SpecterClient] Initialized with config:', this.config);
    }
  }

  // ============================================================================
  // Static Wallet Methods
  // ============================================================================

  /**
   * Create a new Specter wallet with a fresh seed phrase
   */
  static async createWallet(): Promise<SpecterWallet> {
    return createWallet();
  }

  /**
   * Import a wallet from a seed phrase
   * @param seedPhrase - BIP39 mnemonic phrase
   */
  static async importWallet(seedPhrase: string): Promise<SpecterWallet> {
    return importFromSeedPhrase(seedPhrase);
  }

  // ============================================================================
  // Connection Methods
  // ============================================================================

  /**
   * Connect a wallet to the client
   * @param wallet - SpecterWallet, Keypair, or external wallet adapter
   */
  async connect(
    wallet: SpecterWallet | Keypair | WalletAdapter
  ): Promise<void> {
    if ('seedPhrase' in wallet && wallet.seedPhrase) {
      // Full SpecterWallet with seed phrase
      this.walletState = await createWalletState(wallet.seedPhrase);
      this.externalWallet = null;
    } else if ('secretKey' in wallet) {
      // Raw Keypair - limited functionality
      this.walletState = null;
      this.externalWallet = null;
      // Store keypair for basic operations
      (this as any)._keypair = wallet;
    } else {
      // External wallet adapter
      this.externalWallet = wallet;
      this.walletState = null;
    }

    // Initialize scanner if we have stealth keys
    if (this.walletState) {
      this.scanner = new StealthScanner(
        this.connection,
        this.walletState.viewingKeypair.secretKey.slice(0, 32),
        this.walletState.spendingKeypair.publicKey.toBytes()
      );
    }

    if (this.config.debug) {
      console.log('[SpecterClient] Wallet connected:', this.publicKey?.toBase58());
    }
  }

  /**
   * Disconnect the current wallet
   */
  disconnect(): void {
    this.walletState = null;
    this.externalWallet = null;
    this.scanner = null;
    (this as any)._keypair = null;

    if (this.scanSubscription) {
      this.scanSubscription.unsubscribe();
      this.scanSubscription = null;
    }

    if (this.config.debug) {
      console.log('[SpecterClient] Wallet disconnected');
    }
  }

  /**
   * Check if a wallet is connected
   */
  get isConnected(): boolean {
    return !!(this.walletState || this.externalWallet || (this as any)._keypair);
  }

  /**
   * Get the connected wallet's public key
   */
  get publicKey(): PublicKey | null {
    if (this.walletState) {
      return this.walletState.keypair.publicKey;
    }
    if (this.externalWallet) {
      return this.externalWallet.publicKey;
    }
    if ((this as any)._keypair) {
      return ((this as any)._keypair as Keypair).publicKey;
    }
    return null;
  }

  /**
   * Get the stealth meta-address for receiving private payments
   */
  get stealthMetaAddress(): StealthMetaAddress | null {
    return this.walletState?.stealthMetaAddress || null;
  }

  // ============================================================================
  // Balance Methods
  // ============================================================================

  /**
   * Get the balance of the connected wallet
   */
  async getBalance(): Promise<Balance> {
    this.ensureConnected();

    const pubKey = this.publicKey!;

    try {
      // Get SOL balance
      const solBalance = await this.connection.getBalance(pubKey);

      // Get token accounts
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
        pubKey,
        { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
      );

      const tokens = tokenAccounts.value.map((account) => {
        const info = account.account.data.parsed.info;
        return {
          mint: new PublicKey(info.mint),
          symbol: '', // Would need token registry lookup
          amount: BigInt(info.tokenAmount.amount),
          decimals: info.tokenAmount.decimals,
        };
      });

      return {
        solBalance: BigInt(solBalance),
        solFormatted: formatSol(solBalance),
        tokens,
        lastUpdated: new Date(),
      };
    } catch (error) {
      throw new SpecterError(
        SpecterErrorCode.RPC_ERROR,
        'Failed to fetch balance',
        error as Error
      );
    }
  }

  // ============================================================================
  // Stealth Address Methods
  // ============================================================================

  /**
   * Generate a stealth address for receiving private payments
   */
  generateStealthAddress(): StealthAddress {
    this.ensureConnected();

    if (!this.walletState) {
      throw new SpecterError(
        SpecterErrorCode.WALLET_NOT_CONNECTED,
        'Full wallet required for stealth address generation'
      );
    }

    const result = generateStealthAddress(this.walletState.stealthMetaAddress);

    return {
      address: result.address,
      ephemeralPubKey: result.ephemeralPubKey,
      viewTag: result.viewTag,
      createdAt: result.createdAt,
    };
  }

  /**
   * Scan for incoming stealth payments
   * @param options - Scan options
   */
  async scanForIncoming(options: ScanOptions = {}): Promise<StealthPayment[]> {
    this.ensureConnected();

    if (!this.scanner) {
      throw new SpecterError(
        SpecterErrorCode.WALLET_NOT_CONNECTED,
        'Full wallet required for scanning'
      );
    }

    return this.scanner.scan(options);
  }

  /**
   * Subscribe to incoming payments
   * @param callback - Called when new payments are detected
   */
  subscribeToIncoming(callback: (payment: StealthPayment) => void): () => void {
    this.ensureConnected();

    if (!this.walletState) {
      throw new SpecterError(
        SpecterErrorCode.WALLET_NOT_CONNECTED,
        'Full wallet required for subscriptions'
      );
    }

    const subscription = subscribeToPayments(
      this.connection,
      this.walletState.viewingKeypair.secretKey.slice(0, 32),
      this.walletState.spendingKeypair.publicKey.toBytes(),
      callback
    );

    this.scanSubscription = subscription;
    return subscription.unsubscribe;
  }

  // ============================================================================
  // Transfer Methods
  // ============================================================================

  /**
   * Send a private transfer to a stealth address
   * @param to - Recipient's stealth meta-address
   * @param amount - Amount in SOL
   * @param options - Privacy options
   */
  async sendPrivate(
    to: string,
    amount: number,
    options?: PrivacyOptions
  ): Promise<string> {
    this.ensureConnected();

    const sender = this.getSender();

    const result = await sendPrivate({
      sender,
      connection: this.connection,
      recipient: to,
      amount,
      privacyOptions: options,
      programId: this.config.programId,
    });

    if (this.config.debug) {
      console.log('[SpecterClient] Private transfer sent:', result.signature);
    }

    return result.signature;
  }

  /**
   * Send a regular (non-private) transfer
   * @param to - Recipient's public key
   * @param amount - Amount in SOL
   */
  async sendPublic(to: string, amount: number): Promise<string> {
    this.ensureConnected();

    const sender = this.getSender();

    const result = await sendPublic(
      this.connection,
      sender,
      to,
      amount
    );

    return result.signature;
  }

  /**
   * Claim a stealth payment
   * @param paymentOrAddress - StealthPayment object or stealth address string
   */
  async claimStealth(
    paymentOrAddress: StealthPayment | string
  ): Promise<string> {
    this.ensureConnected();

    if (!this.walletState) {
      throw new SpecterError(
        SpecterErrorCode.WALLET_NOT_CONNECTED,
        'Full wallet required for claiming'
      );
    }

    let payment: StealthPayment;

    if (typeof paymentOrAddress === 'string') {
      // Fetch payment details from address
      const stealthAddress = new PublicKey(paymentOrAddress);
      const balance = await getStealthBalance(this.connection, stealthAddress);

      payment = {
        stealthAddress,
        ephemeralPubKey: new Uint8Array(32), // Would need to be fetched
        amount: balance,
        tokenMint: null,
        signature: '',
        blockTime: 0,
        claimed: false,
        viewTag: 0,
      };
    } else {
      payment = paymentOrAddress;
    }

    const result = await claimStealth({
      connection: this.connection,
      payment,
      spendingPrivateKey: this.walletState.spendingKeypair.secretKey.slice(0, 32),
      viewingPrivateKey: this.walletState.viewingKeypair.secretKey.slice(0, 32),
      destination: this.walletState.keypair.publicKey,
    });

    if (this.config.debug) {
      console.log('[SpecterClient] Stealth payment claimed:', result.signature);
    }

    return result.signature;
  }

  /**
   * Estimate the fee for a transfer
   * @param privacyLevel - Privacy level
   */
  async estimateFee(privacyLevel: PrivacyOptions['level'] = 'standard'): Promise<bigint> {
    return estimateTransferFee(this.connection, privacyLevel);
  }

  // ============================================================================
  // Stream Methods
  // ============================================================================

  /**
   * Create a payment stream
   * @param recipient - Recipient's stealth meta-address or public key
   * @param amount - Total amount in SOL
   * @param durationDays - Stream duration in days
   * @param options - Additional stream options
   */
  async createStream(
    recipient: string,
    amount: number,
    durationDays: number,
    options?: StreamCreateOptions
  ): Promise<Stream> {
    this.ensureConnected();

    const sender = this.getSender();

    const stream = await createStream({
      connection: this.connection,
      sender,
      recipient,
      totalAmount: amount,
      durationDays,
      options,
      programId: this.config.programId,
    });

    if (this.config.debug) {
      console.log('[SpecterClient] Stream created:', stream.id.toBase58());
    }

    return stream;
  }

  /**
   * Withdraw from a payment stream
   * @param streamId - Stream ID (PDA)
   * @param amount - Optional specific amount to withdraw
   */
  async withdrawStream(
    streamId: string | PublicKey,
    amount?: number
  ): Promise<string> {
    this.ensureConnected();

    const recipient = this.getSender();
    const id = typeof streamId === 'string' ? new PublicKey(streamId) : streamId;

    const result = await withdrawStream({
      connection: this.connection,
      streamId: id,
      recipient,
      amount: amount ? solToLamports(amount) : undefined,
      programId: this.config.programId,
    });

    if (this.config.debug) {
      console.log('[SpecterClient] Stream withdrawal:', result.signature);
    }

    return result.signature;
  }

  /**
   * Cancel a payment stream
   * @param streamId - Stream ID (PDA)
   */
  async cancelStream(streamId: string | PublicKey): Promise<string> {
    this.ensureConnected();

    const sender = this.getSender();
    const id = typeof streamId === 'string' ? new PublicKey(streamId) : streamId;

    const result = await cancelStream({
      connection: this.connection,
      streamId: id,
      sender,
      programId: this.config.programId,
    });

    if (this.config.debug) {
      console.log('[SpecterClient] Stream cancelled:', result.signature);
    }

    return result.signature;
  }

  /**
   * Get stream details
   * @param streamId - Stream ID (PDA)
   */
  async getStream(streamId: string | PublicKey): Promise<Stream | null> {
    const id = typeof streamId === 'string' ? new PublicKey(streamId) : streamId;
    return getStream(this.connection, id, this.config.programId);
  }

  /**
   * Get all streams for the connected wallet
   */
  async getMyStreams(): Promise<Stream[]> {
    this.ensureConnected();
    return getUserStreams(this.connection, this.publicKey!, this.config.programId);
  }

  // ============================================================================
  // Event Methods
  // ============================================================================

  /**
   * Add an event listener
   * @param event - Event type
   * @param listener - Callback function
   */
  on(event: string, listener: SpecterEventListener): void {
    const listeners = this.eventListeners.get(event) || [];
    listeners.push(listener);
    this.eventListeners.set(event, listeners);
  }

  /**
   * Remove an event listener
   * @param event - Event type
   * @param listener - Callback function to remove
   */
  off(event: string, listener: SpecterEventListener): void {
    const listeners = this.eventListeners.get(event) || [];
    const index = listeners.indexOf(listener);
    if (index !== -1) {
      listeners.splice(index, 1);
      this.eventListeners.set(event, listeners);
    }
  }

  /**
   * Emit an event
   */
  private emit(event: SpecterEvent): void {
    const listeners = this.eventListeners.get(event.type) || [];
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('Event listener error:', error);
      }
    }
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Get the Solana connection
   */
  getConnection(): Connection {
    return this.connection;
  }

  /**
   * Get the program ID
   */
  getProgramId(): PublicKey {
    return this.config.programId;
  }

  /**
   * Change the network cluster
   * @param cluster - New cluster
   */
  setCluster(cluster: Cluster): void {
    this.config.cluster = cluster;
    this.config.rpcEndpoint = RPC_ENDPOINTS[cluster];
    this.config.programId = PROGRAM_IDS[cluster];
    this.connection = createConnection(
      this.config.rpcEndpoint,
      this.config.commitment
    );
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private ensureConnected(): void {
    if (!this.isConnected) {
      throw new SpecterError(
        SpecterErrorCode.WALLET_NOT_CONNECTED,
        'No wallet connected. Call connect() first.'
      );
    }
  }

  private getSender(): Keypair | WalletAdapter {
    if (this.walletState) {
      return this.walletState.keypair;
    }
    if (this.externalWallet) {
      return this.externalWallet;
    }
    if ((this as any)._keypair) {
      return (this as any)._keypair;
    }
    throw new SpecterError(
      SpecterErrorCode.WALLET_NOT_CONNECTED,
      'No wallet connected'
    );
  }
}

export default SpecterClient;
