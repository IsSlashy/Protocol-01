import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import type {
  P01Wallet,
  P01ClientConfig,
  Balance,
  StealthAddress,
  Cluster,
  WalletAdapter,
  StealthMetaAddress,
} from './types';
import { P01Error, P01ErrorCode } from './types';
import {
  REGISTRY_PROGRAM_IDS,
  RELAYER_PROGRAM_IDS,
  getEffectiveRpcEndpoint,
  isPublicRpcEndpoint,
  setFeature,
} from './constants';
import { createConnection, formatSol } from './utils/helpers';

// Wallet operations
import { createWallet, createWalletState } from './wallet/create';
import { importFromSeedPhrase } from './wallet/import';
import type { WalletState } from './wallet/types';

// Stealth operations — key derivation only, nothing touches the chain
import { generateStealthAddress } from './stealth/generate';

// Transfer operations — plain transfers only
import { sendPublic } from './transfer/send';

/**
 * Main client for interacting with Protocol 01.
 *
 * [2026-09-13] The on-chain `specter` program (stealth announcements, stealth
 * claims, payment streams; devnet id `FgKhXakZ…`) was closed on 2026-09-13.
 * Every method that sent it an instruction or read its accounts went with it:
 * `scanForIncoming`, `subscribeToIncoming`, `sendPrivate`, `claimStealth`,
 * `estimateFee`, `createStream`, `withdrawStream`, `cancelStream`,
 * `getStream`, `getMyStreams`, and the `programId` option. What remains is
 * wallet creation and import, balances, stealth meta-address and one-time
 * address derivation (off-chain math), and plain transfers. Private payments
 * go through the shielded pool (`./subscription`, `createPrivateSubscription`).
 *
 * @example
 * ```typescript
 * const client = new P01Client({ cluster: 'devnet' });
 *
 * const wallet = await P01Client.createWallet();
 * await client.connect(wallet);
 *
 * const balance = await client.getBalance();
 * const oneTime = client.generateStealthAddress();
 * ```
 */
export class P01Client {
  private connection: Connection;
  private config: Required<Omit<P01ClientConfig, 'features'>>;
  private walletState: WalletState | null = null;
  private externalWallet: WalletAdapter | null = null;

  constructor(config: P01ClientConfig = {}) {
    const cluster = config.cluster || 'devnet';

    // Resolve RPC endpoint: explicit override > custom global > default
    const rpcEndpoint = config.rpcEndpoint || getEffectiveRpcEndpoint(cluster);

    // Resolve program IDs: explicit override > cluster-based lookup
    const registryProgramId = config.registryProgramId || REGISTRY_PROGRAM_IDS[cluster];
    const relayerProgramId = config.relayerProgramId || RELAYER_PROGRAM_IDS[cluster];

    this.config = {
      cluster,
      rpcEndpoint,
      commitment: config.commitment || 'confirmed',
      debug: config.debug || false,
      registryProgramId,
      relayerProgramId,
      timeout: config.timeout || 60000,
    };

    // Apply feature flag overrides
    if (config.features) {
      for (const [name, enabled] of Object.entries(config.features)) {
        if (enabled !== undefined) {
          setFeature(name, enabled);
        }
      }
    }

    this.connection = createConnection(
      this.config.rpcEndpoint,
      this.config.commitment
    );

    // Warn when using a public RPC endpoint (rate-limited, not production-ready)
    if (isPublicRpcEndpoint(this.config.rpcEndpoint)) {
      console.warn(
        '[P01 SDK] Using public Solana RPC. For production, provide a custom ' +
        'rpcEndpoint (Helius, QuickNode, etc.) to avoid rate limits. ' +
        'Example: new P01Client({ rpcEndpoint: "https://devnet.helius-rpc.com/?api-key=..." })'
      );
    }
  }

  // ============================================================================
  // Static Wallet Methods
  // ============================================================================

  /**
   * Create a new Specter wallet with a fresh seed phrase
   */
  static async createWallet(): Promise<P01Wallet> {
    return createWallet();
  }

  /**
   * Import a wallet from a seed phrase
   * @param seedPhrase - BIP39 mnemonic phrase
   */
  static async importWallet(seedPhrase: string): Promise<P01Wallet> {
    return importFromSeedPhrase(seedPhrase);
  }

  // ============================================================================
  // Connection Methods
  // ============================================================================

  /**
   * Connect a wallet to the client
   * @param wallet - P01Wallet, Keypair, or external wallet adapter
   */
  async connect(
    wallet: P01Wallet | Keypair | WalletAdapter
  ): Promise<void> {
    if ('seedPhrase' in wallet && wallet.seedPhrase) {
      // Full P01Wallet with seed phrase
      this.walletState = await createWalletState(wallet.seedPhrase);
      this.externalWallet = null;
    } else if ('secretKey' in wallet) {
      // Raw Keypair - limited functionality
      this.walletState = null;
      this.externalWallet = null;
      // Store keypair for basic operations
      (this as any)._keypair = wallet;
    } else {
      // External wallet adapter — validate before accepting
      const adapter = wallet as WalletAdapter;
      if (!adapter.publicKey || typeof adapter.signTransaction !== 'function') {
        throw new P01Error(
          P01ErrorCode.WALLET_NOT_CONNECTED,
          'Invalid wallet adapter. Must implement { publicKey: PublicKey, signTransaction: (tx) => Promise<Transaction> }. ' +
          'If using @solana/wallet-adapter, ensure the wallet is connected before passing it to P01Client.connect().'
        );
      }
      this.externalWallet = adapter;
      this.walletState = null;
    }
  }

  /**
   * Disconnect the current wallet
   */
  disconnect(): void {
    this.walletState = null;
    this.externalWallet = null;
    (this as any)._keypair = null;
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
      throw new P01Error(
        P01ErrorCode.RPC_ERROR,
        'Failed to fetch balance: RPC error. Check your rpcEndpoint configuration and network connectivity. ' +
        `Current endpoint: ${this.config.rpcEndpoint}`,
        error as Error
      );
    }
  }

  // ============================================================================
  // Stealth Address Methods
  // ============================================================================

  /**
   * Generate a one-time stealth address from the connected wallet's
   * meta-address. Pure key derivation; nothing is announced on chain.
   */
  generateStealthAddress(): StealthAddress {
    this.ensureConnected();

    if (!this.walletState) {
      throw new P01Error(
        P01ErrorCode.WALLET_NOT_CONNECTED,
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

  // ============================================================================
  // Transfer Methods
  // ============================================================================

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
   * Change the network cluster
   * @param cluster - New cluster
   */
  setCluster(cluster: Cluster): void {
    this.config.cluster = cluster;
    this.config.rpcEndpoint = getEffectiveRpcEndpoint(cluster);
    this.config.registryProgramId = REGISTRY_PROGRAM_IDS[cluster];
    this.config.relayerProgramId = RELAYER_PROGRAM_IDS[cluster];
    this.connection = createConnection(
      this.config.rpcEndpoint,
      this.config.commitment
    );

    if (isPublicRpcEndpoint(this.config.rpcEndpoint)) {
      console.warn(
        '[P01 SDK] Using public Solana RPC. For production, provide a custom ' +
        'rpcEndpoint (Helius, QuickNode, etc.) to avoid rate limits.'
      );
    }
  }

  /**
   * Get the registry program ID
   */
  getRegistryProgramId(): PublicKey {
    return this.config.registryProgramId;
  }

  /**
   * Get the relayer program ID
   */
  getRelayerProgramId(): PublicKey {
    return this.config.relayerProgramId;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private ensureConnected(): void {
    if (!this.isConnected) {
      throw new P01Error(
        P01ErrorCode.WALLET_NOT_CONNECTED,
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
    throw new P01Error(
      P01ErrorCode.WALLET_NOT_CONNECTED,
      'No wallet connected'
    );
  }
}

export default P01Client;
