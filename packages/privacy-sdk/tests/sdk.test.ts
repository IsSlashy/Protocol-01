import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  PrivacySDK,
  PrivacyError,
  PrivacyErrorCode,
  PROGRAM_IDS,
  TOKENS,
  SEEDS,
  DENOMINATIONS,
  MERKLE_TREE_DEPTH,
  SHIELD_FEE_BPS,
  UNSHIELD_FEE_BPS,
  STARK_CIRCUITS,
  COMPUTE_UNITS,
} from '../src';

// ─── Test Setup ───────────────────────────────────────────────────────────────

const DEVNET_URL = 'https://api.devnet.solana.com';
const mockConnection = new Connection(DEVNET_URL, 'confirmed');
const testKeypair = Keypair.generate();

function createSDK(overrides: Partial<Parameters<typeof PrivacySDK>[0]> = {}) {
  return new PrivacySDK({
    connection: mockConnection,
    wallet: testKeypair,
    network: 'devnet',
    ...overrides,
  } as any);
}

// ─── SDK Initialization ──────────────────────────────────────────────────────

describe('PrivacySDK', () => {
  describe('initialization', () => {
    it('should create SDK with valid config', () => {
      const sdk = createSDK();
      expect(sdk).toBeDefined();
      expect(sdk.network).toBe('devnet');
      expect(sdk.publicKey).toEqual(testKeypair.publicKey);
    });

    it('should throw on missing connection', () => {
      expect(() => new PrivacySDK({
        connection: null as any,
        wallet: testKeypair,
      })).toThrow(PrivacyError);
    });

    it('should throw on missing wallet', () => {
      expect(() => new PrivacySDK({
        connection: mockConnection,
        wallet: null as any,
      })).toThrow();
    });

    it('should default to devnet', () => {
      const sdk = new PrivacySDK({
        connection: mockConnection,
        wallet: testKeypair,
      });
      expect(sdk.network).toBe('devnet');
    });

    it('should accept mainnet config', () => {
      const sdk = createSDK({ network: 'mainnet' });
      expect(sdk.network).toBe('mainnet');
    });

    it('should allow program ID overrides', () => {
      const customId = Keypair.generate().publicKey;
      const sdk = createSDK({
        programIds: { zkShielded: customId },
      });
      expect(sdk.getProgramIds().zkShielded).toEqual(customId);
    });
  });

  describe('modules', () => {
    let sdk: PrivacySDK;

    beforeEach(() => {
      sdk = createSDK();
    });

    it('should expose shield module', () => {
      expect(sdk.shield).toBeDefined();
      expect(typeof sdk.shield.shield).toBe('function');
      expect(typeof sdk.shield.unshield).toBe('function');
      expect(typeof sdk.shield.transfer).toBe('function');
      expect(typeof sdk.shield.getPoolInfo).toBe('function');
      expect(typeof sdk.shield.getShieldedBalance).toBe('function');
    });

    it('should expose stealth module', () => {
      expect(sdk.stealth).toBeDefined();
      expect(typeof sdk.stealth.generateMetaAddress).toBe('function');
      expect(typeof sdk.stealth.send).toBe('function');
      expect(typeof sdk.stealth.scan).toBe('function');
      expect(typeof sdk.stealth.claim).toBe('function');
    });

    it('should expose confidential module', () => {
      expect(sdk.confidential).toBeDefined();
      expect(typeof sdk.confidential.deposit).toBe('function');
      expect(typeof sdk.confidential.transfer).toBe('function');
      expect(typeof sdk.confidential.withdraw).toBe('function');
      expect(typeof sdk.confidential.getBalance).toBe('function');
    });

    it('should expose streams module', () => {
      expect(sdk.streams).toBeDefined();
      expect(typeof sdk.streams.create).toBe('function');
      expect(typeof sdk.streams.withdraw).toBe('function');
      expect(typeof sdk.streams.cancel).toBe('function');
      expect(typeof sdk.streams.getStream).toBe('function');
      expect(typeof sdk.streams.listStreams).toBe('function');
    });

    it('should expose subscriptions module', () => {
      expect(sdk.subscriptions).toBeDefined();
      expect(typeof sdk.subscriptions.create).toBe('function');
      expect(typeof sdk.subscriptions.cancel).toBe('function');
      expect(typeof sdk.subscriptions.pause).toBe('function');
      expect(typeof sdk.subscriptions.resume).toBe('function');
    });

    it('should expose vault module', () => {
      expect(sdk.vault).toBeDefined();
      expect(typeof sdk.vault.create).toBe('function');
      expect(typeof sdk.vault.deposit).toBe('function');
      expect(typeof sdk.vault.withdraw).toBe('function');
      expect(typeof sdk.vault.getVault).toBe('function');
    });

    it('should expose registry module', () => {
      expect(sdk.registry).toBeDefined();
      expect(typeof sdk.registry.register).toBe('function');
      expect(typeof sdk.registry.lookup).toBe('function');
      expect(typeof sdk.registry.isRegistered).toBe('function');
    });

    it('should expose relay module', () => {
      expect(sdk.relay).toBeDefined();
      expect(typeof sdk.relay.submitJob).toBe('function');
      expect(typeof sdk.relay.listRelayers).toBe('function');
      expect(typeof sdk.relay.getJobStatus).toBe('function');
    });

    it('should expose mpc module', () => {
      expect(sdk.mpc).toBeDefined();
      expect(typeof sdk.mpc.createProposal).toBe('function');
      expect(typeof sdk.mpc.vote).toBe('function');
      expect(typeof sdk.mpc.submitSealedBid).toBe('function');
      expect(typeof sdk.mpc.isAvailable).toBe('function');
    });
  });

  describe('token resolution', () => {
    let sdk: PrivacySDK;

    beforeEach(() => {
      sdk = createSDK();
    });

    it('should resolve SOL', () => {
      const token = sdk.resolveToken('SOL');
      expect(token.symbol).toBe('SOL');
      expect(token.decimals).toBe(9);
      expect(token.mint.toBase58()).toBe('So11111111111111111111111111111111111111112');
    });

    it('should resolve USDC on devnet', () => {
      const token = sdk.resolveToken('USDC');
      expect(token.symbol).toBe('USDC');
      expect(token.decimals).toBe(6);
    });

    it('should resolve USDT on devnet', () => {
      const token = sdk.resolveToken('USDT');
      expect(token.decimals).toBe(6);
    });

    it('should resolve case-insensitive', () => {
      const t1 = sdk.resolveToken('sol');
      const t2 = sdk.resolveToken('SOL');
      expect(t1.mint).toEqual(t2.mint);
    });

    it('should accept custom mint address', () => {
      const mint = Keypair.generate().publicKey;
      const token = sdk.resolveToken(mint.toBase58());
      expect(token.mint).toEqual(mint);
      expect(token.decimals).toBe(9); // default
    });

    it('should throw on invalid token', () => {
      expect(() => sdk.resolveToken('INVALID_TOKEN_XYZ')).toThrow(PrivacyError);
    });

    it('should register and resolve custom tokens', () => {
      const mint = Keypair.generate().publicKey;
      sdk.registerToken('BONK', mint, 5);
      const token = sdk.resolveToken('BONK');
      expect(token.symbol).toBe('BONK');
      expect(token.mint).toEqual(mint);
      expect(token.decimals).toBe(5);
    });

    it('should resolve mainnet tokens', () => {
      const mainnetSdk = createSDK({ network: 'mainnet' });
      const usdc = mainnetSdk.resolveToken('USDC');
      expect(usdc.mint.toBase58()).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    });
  });

  describe('events', () => {
    it('should subscribe and emit events', () => {
      const sdk = createSDK();
      const handler = vi.fn();

      sdk.on('shield', handler);
      sdk.emit('shield', { amount: 1000 });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        type: 'shield',
        data: { amount: 1000 },
        timestamp: expect.any(Number),
      }));
    });

    it('should unsubscribe', () => {
      const sdk = createSDK();
      const handler = vi.fn();

      sdk.on('shield', handler);
      sdk.off('shield', handler);
      sdk.emit('shield', {});

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not crash on listener error', () => {
      const sdk = createSDK();
      sdk.on('error', () => { throw new Error('test'); });
      expect(() => sdk.emit('error', {})).not.toThrow();
    });
  });

  describe('health check', () => {
    it('should return wallet info', async () => {
      const sdk = createSDK();
      const health = await sdk.healthCheck();
      expect(health.network).toBe('devnet');
      expect(health.walletAddress).toBe(testKeypair.publicKey.toBase58());
      expect(typeof health.balance).toBe('number');
    });
  });

  describe('supported tokens', () => {
    it('should list devnet tokens', () => {
      const sdk = createSDK();
      const tokens = sdk.getSupportedTokens();
      expect(tokens.length).toBeGreaterThanOrEqual(3);
      expect(tokens.map(t => t.symbol)).toContain('SOL');
      expect(tokens.map(t => t.symbol)).toContain('USDC');
      expect(tokens.map(t => t.symbol)).toContain('USDT');
    });
  });
});

// ─── Constants Validation ─────────────────────────────────────────────────────

describe('Constants', () => {
  it('should have devnet program IDs', () => {
    const ids = PROGRAM_IDS.devnet;
    expect(ids.zkShielded).toBeInstanceOf(PublicKey);
    expect(ids.specter).toBeInstanceOf(PublicKey);
    expect(ids.trustless).toBeInstanceOf(PublicKey);
    expect(ids.zkspl).toBeInstanceOf(PublicKey);
    expect(ids.relayer).toBeInstanceOf(PublicKey);
    expect(ids.registry).toBeInstanceOf(PublicKey);
    expect(ids.feeSplitter).toBeInstanceOf(PublicKey);
    expect(ids.stream).toBeInstanceOf(PublicKey);
    expect(ids.subscription).toBeInstanceOf(PublicKey);
    expect(ids.quantumVault).toBeInstanceOf(PublicKey);
    expect(ids.starkVerifier).toBeInstanceOf(PublicKey);
    expect(ids.arcium).toBeInstanceOf(PublicKey);
    expect(ids.bundler).toBeInstanceOf(PublicKey);
    expect(ids.whitelist).toBeInstanceOf(PublicKey);
  });

  it('should have correct fee configuration', () => {
    expect(SHIELD_FEE_BPS).toBe(30);
    expect(UNSHIELD_FEE_BPS).toBe(50);
  });

  it('should have correct merkle depth', () => {
    expect(MERKLE_TREE_DEPTH).toBe(20);
  });

  it('should have STARK circuit IDs', () => {
    expect(STARK_CIRCUITS.SUBSCRIBER_OWNERSHIP).toBe(0);
    expect(STARK_CIRCUITS.TRANSFER).toBe(5);
  });

  it('should have SOL denominations', () => {
    expect(DENOMINATIONS.SOL).toHaveLength(4);
    expect(DENOMINATIONS.SOL[0]).toBe(0.1 * 1e9);
  });

  it('should have PDA seeds', () => {
    expect(SEEDS.SHIELDED_POOL).toBe('shielded_pool');
    expect(SEEDS.MERKLE_TREE).toBe('merkle_tree');
    expect(SEEDS.NULLIFIER).toBe('nullifier');
    expect(SEEDS.REGISTRY).toBe('registry');
  });

  it('should have compute unit budgets', () => {
    expect(COMPUTE_UNITS.SHIELD).toBe(200_000);
    expect(COMPUTE_UNITS.STARK_VERIFY).toBe(1_400_000);
  });
});

// ─── Error System ─────────────────────────────────────────────────────────────

describe('PrivacyError', () => {
  it('should create error with code and message', () => {
    const err = new PrivacyError(PrivacyErrorCode.SHIELD_FAILED, 'test');
    expect(err.code).toBe(PrivacyErrorCode.SHIELD_FAILED);
    expect(err.message).toBe('test');
    expect(err.name).toBe('PrivacyError');
  });

  it('should chain cause errors', () => {
    const cause = new Error('root cause');
    const err = new PrivacyError(PrivacyErrorCode.TRANSACTION_FAILED, 'tx failed', cause);
    expect(err.cause).toBe(cause);
  });

  it('should have static factory methods', () => {
    expect(PrivacyError.walletNotConnected().code).toBe(PrivacyErrorCode.WALLET_NOT_CONNECTED);
    expect(PrivacyError.unsupportedToken('FOO').code).toBe(PrivacyErrorCode.UNSUPPORTED_TOKEN);
    expect(PrivacyError.proofFailed('transfer').code).toBe(PrivacyErrorCode.PROOF_GENERATION_FAILED);
    expect(PrivacyError.txFailed('shield').code).toBe(PrivacyErrorCode.TRANSACTION_FAILED);
    expect(PrivacyError.poolNotFound('SOL').code).toBe(PrivacyErrorCode.POOL_NOT_FOUND);
    expect(PrivacyError.nullifierSpent().code).toBe(PrivacyErrorCode.NULLIFIER_ALREADY_SPENT);
  });

  it('should have correct error code ranges', () => {
    // General: 1xxx
    expect(PrivacyErrorCode.WALLET_NOT_CONNECTED).toBe(1001);
    // Shield: 2xxx
    expect(PrivacyErrorCode.SHIELD_FAILED).toBe(2001);
    // Stealth: 3xxx
    expect(PrivacyErrorCode.STEALTH_SEND_FAILED).toBe(3001);
    // Confidential: 4xxx
    expect(PrivacyErrorCode.CONFIDENTIAL_DEPOSIT_FAILED).toBe(4001);
    // Streams: 5xxx
    expect(PrivacyErrorCode.STREAM_CREATE_FAILED).toBe(5001);
    // Subscriptions: 6xxx
    expect(PrivacyErrorCode.SUBSCRIPTION_CREATE_FAILED).toBe(6001);
    // Vault: 7xxx
    expect(PrivacyErrorCode.VAULT_CREATE_FAILED).toBe(7001);
    // Relay: 8xxx
    expect(PrivacyErrorCode.RELAY_SUBMIT_FAILED).toBe(8001);
    // MPC: 9xxx
    expect(PrivacyErrorCode.MPC_VOTE_FAILED).toBe(9001);
    // Registry: 10xxx
    expect(PrivacyErrorCode.REGISTRY_NOT_FOUND).toBe(10001);
  });
});

// ─── WalletAdapter Compatibility ──────────────────────────────────────────────

describe('WalletAdapter compatibility', () => {
  it('should accept WalletAdapter-style wallet', () => {
    const mockAdapter = {
      publicKey: Keypair.generate().publicKey,
      signTransaction: vi.fn(),
      signAllTransactions: vi.fn(),
    };

    const sdk = new PrivacySDK({
      connection: mockConnection,
      wallet: mockAdapter,
      network: 'devnet',
    });

    expect(sdk.publicKey).toEqual(mockAdapter.publicKey);
  });
});

// ─── Export Completeness ──────────────────────────────────────────────────────

describe('Exports', () => {
  it('should export all module classes via ESM', async () => {
    const mod = await import('../src');

    expect(mod.ShieldModule).toBeDefined();
    expect(mod.StealthModule).toBeDefined();
    expect(mod.ConfidentialModule).toBeDefined();
    expect(mod.StreamsModule).toBeDefined();
    expect(mod.SubscriptionsModule).toBeDefined();
    expect(mod.VaultModule).toBeDefined();
    expect(mod.RegistryModule).toBeDefined();
    expect(mod.RelayModule).toBeDefined();
    expect(mod.MPCModule).toBeDefined();
  });

  it('should export error system', async () => {
    const mod = await import('../src');
    expect(mod.PrivacyError).toBeDefined();
    expect(mod.PrivacyErrorCode).toBeDefined();
  });

  it('should export constants', async () => {
    const mod = await import('../src');
    expect(mod.PROGRAM_IDS).toBeDefined();
    expect(mod.TOKENS).toBeDefined();
    expect(mod.SEEDS).toBeDefined();
    expect(mod.DENOMINATIONS).toBeDefined();
  });
});
