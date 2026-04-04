import { Connection, PublicKey } from '@solana/web3.js';
import type {
  PrivacySDKConfig,
  Network,
  ProgramIds,
  Signer,
  TokenInfo,
  TokenSymbol,
  PrivacyEventType,
  PrivacyEventCallback,
  PrivacyEvent,
} from './types';
import { PrivacyError, PrivacyErrorCode } from './errors';
import { PROGRAM_IDS, TOKENS } from './constants';

import { ShieldModule } from './modules/shield';
import { StealthModule } from './modules/stealth';
import { ConfidentialModule } from './modules/confidential';
import { StreamsModule } from './modules/streams';
import { SubscriptionsModule } from './modules/subscriptions';
import { VaultModule } from './modules/vault';
import { RegistryModule } from './modules/registry';
import { RelayModule } from './modules/relay';
import { MPCModule } from './modules/mpc';
import { ComplianceModule } from './modules/compliance';
import { AirdropModule } from './modules/airdrop';
import { OTCModule } from './modules/otc';
import { PayrollModule } from './modules/payroll';
import { TreasuryModule } from './modules/treasury';
import { MugenExchangeModule } from './modules/exchange';

/**
 * Protocol 01 Privacy SDK — unified entry point for all privacy operations on Solana.
 *
 * @example
 * ```typescript
 * import { PrivacySDK } from '@p01/privacy-sdk';
 *
 * const sdk = new PrivacySDK({
 *   connection: new Connection('https://api.devnet.solana.com'),
 *   wallet: myKeypair, // or WalletAdapter
 *   network: 'devnet',
 * });
 *
 * // Shield 1 SOL
 * const receipt = await sdk.shield.shield({ amount: 1e9, token: 'SOL' });
 *
 * // Send private payment via stealth address
 * await sdk.stealth.send({ to: 'st:...', amount: 0.5e9 });
 *
 * // Create payment stream
 * await sdk.streams.create({ recipient, totalAmount: 10e9, duration: 86400 });
 * ```
 */
export class PrivacySDK {
  readonly connection: Connection;
  readonly wallet: Signer;
  readonly network: Network;
  readonly programIds: ProgramIds;

  /** Shield, unshield, and private transfer operations */
  readonly shield: ShieldModule;
  /** Stealth address generation, sending, scanning, and claiming */
  readonly stealth: StealthModule;
  /** Confidential token balances (zkSPL) */
  readonly confidential: ConfidentialModule;
  /** Payment streaming */
  readonly streams: StreamsModule;
  /** Recurring subscription payments */
  readonly subscriptions: SubscriptionsModule;
  /** Quantum-safe vaults (WOTS+ and Hash-Timelock) */
  readonly vault: VaultModule;
  /** Stealth meta-address registry */
  readonly registry: RegistryModule;
  /** Privacy relay for transaction submission */
  readonly relay: RelayModule;
  /** Arcium MPC operations (voting, audits, sealed-bid auctions) */
  readonly mpc: MPCModule;
  /** Compliance gateway (range proofs, sanctions innocence) */
  readonly compliance: ComplianceModule;
  /** Stealth airdrops (Merkle-based private token distribution) */
  readonly airdrop: AirdropModule;
  /** Private OTC desk (atomic P2P swaps) */
  readonly otc: OTCModule;
  /** Confidential payroll (batch private salary payments) */
  readonly payroll: PayrollModule;
  /** Private DAO treasury (shield + vote + audit) */
  readonly treasury: TreasuryModule;
  /** Mugen Exchange — P2P fiat-to-crypto with ZK compliance, no KYC */
  readonly exchange: MugenExchangeModule;

  private listeners: Map<PrivacyEventType, Set<PrivacyEventCallback>> = new Map();
  private tokenCache: Map<string, TokenInfo> = new Map();

  constructor(config: PrivacySDKConfig) {
    if (!config.connection) {
      throw new PrivacyError(PrivacyErrorCode.INVALID_CONFIG, 'Connection is required.');
    }
    if (!config.wallet) {
      throw PrivacyError.walletNotConnected();
    }

    this.connection = config.connection;
    this.wallet = config.wallet;
    this.network = config.network ?? 'devnet';
    this.programIds = {
      ...PROGRAM_IDS[this.network],
      ...config.programIds,
    };

    const resolveToken = this.resolveToken.bind(this);

    this.shield = new ShieldModule(this.connection, this.wallet, this.network, this.programIds, resolveToken);
    this.stealth = new StealthModule(this.connection, this.wallet, this.network, this.programIds, resolveToken);
    this.confidential = new ConfidentialModule(this.connection, this.wallet, this.network, this.programIds, resolveToken);
    this.streams = new StreamsModule(this.connection, this.wallet, this.network, this.programIds, resolveToken);
    this.subscriptions = new SubscriptionsModule(this.connection, this.wallet, this.network, this.programIds, resolveToken);
    this.vault = new VaultModule(this.connection, this.wallet, this.network, this.programIds, resolveToken);
    this.registry = new RegistryModule(this.connection, this.wallet, this.network, this.programIds, resolveToken);
    this.relay = new RelayModule(this.connection, this.wallet, this.network, this.programIds, resolveToken);
    this.mpc = new MPCModule(this.connection, this.wallet, this.network, this.programIds, resolveToken);
    this.compliance = new ComplianceModule(this.connection, this.wallet, this.network, this.programIds, resolveToken);
    this.airdrop = new AirdropModule(this.connection, this.wallet, this.network, this.programIds, resolveToken);
    this.otc = new OTCModule(this.connection, this.wallet, this.network, this.programIds, resolveToken);
    this.payroll = new PayrollModule(this.connection, this.wallet, this.network, this.programIds, resolveToken);
    this.treasury = new TreasuryModule(this.connection, this.wallet, this.network, this.programIds, resolveToken);
    this.exchange = new MugenExchangeModule(this.connection, this.wallet, this.network, this.programIds, resolveToken);
  }

  /**
   * Resolve a token symbol (SOL, USDC, USDT) to its mint address and decimals.
   * Also accepts raw PublicKey strings as custom token mints.
   */
  resolveToken(symbol: TokenSymbol): TokenInfo {
    const cached = this.tokenCache.get(symbol);
    if (cached) return cached;

    const networkTokens = TOKENS[this.network];
    const info = networkTokens?.[symbol.toUpperCase()];
    if (info) {
      this.tokenCache.set(symbol, info);
      return info;
    }

    // Try to parse as PublicKey (custom mint)
    try {
      const mint = new PublicKey(symbol);
      const custom: TokenInfo = { symbol, mint, decimals: 9 };
      this.tokenCache.set(symbol, custom);
      return custom;
    } catch {
      throw PrivacyError.unsupportedToken(symbol);
    }
  }

  /** Get the wallet's public key */
  get publicKey(): PublicKey {
    return this.wallet.publicKey;
  }

  /** Register a token with custom decimals (for non-standard SPL tokens) */
  registerToken(symbol: string, mint: PublicKey, decimals: number): void {
    this.tokenCache.set(symbol, { symbol, mint, decimals });
  }

  /** Subscribe to SDK events */
  on(type: PrivacyEventType, callback: PrivacyEventCallback): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(callback);
  }

  /** Unsubscribe from SDK events */
  off(type: PrivacyEventType, callback: PrivacyEventCallback): void {
    this.listeners.get(type)?.delete(callback);
  }

  /** Emit an event to all listeners */
  emit(type: PrivacyEventType, data: any): void {
    const event: PrivacyEvent = { type, data, timestamp: Date.now() };
    this.listeners.get(type)?.forEach(cb => {
      try {
        cb(event);
      } catch {
        // Listener errors should not break SDK flow
      }
    });
  }

  /**
   * Check if the SDK is properly configured and the wallet has SOL for fees.
   * Returns the wallet balance in lamports.
   */
  async healthCheck(): Promise<{ balance: number; network: Network; walletAddress: string }> {
    const balance = await this.connection.getBalance(this.wallet.publicKey);
    return {
      balance,
      network: this.network,
      walletAddress: this.wallet.publicKey.toBase58(),
    };
  }

  /**
   * Get all supported tokens for the current network.
   */
  getSupportedTokens(): TokenInfo[] {
    return Object.values(TOKENS[this.network]);
  }

  /**
   * Get all program IDs for the current network.
   */
  getProgramIds(): ProgramIds {
    return { ...this.programIds };
  }
}
