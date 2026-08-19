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
  MAX_LEAVES,
  SHIELD_FEE_BPS,
  UNSHIELD_FEE_BPS,
  STARK_CIRCUITS,
  COMPUTE_UNITS,
  LiquidityModule,
  P01_LIQUIDITY_PROGRAM_ID,
} from '../src';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

// ─── Test Setup ───────────────────────────────────────────────────────────────

const DEVNET_URL = 'https://api.devnet.solana.com';
const mockConnection = new Connection(DEVNET_URL, 'confirmed');
const testKeypair = Keypair.generate();
const testSpendingKey = new Uint8Array(32).fill(7);

function createSDK(overrides: Partial<Parameters<typeof PrivacySDK>[0]> = {}) {
  return new PrivacySDK({
    connection: mockConnection,
    wallet: testKeypair,
    network: 'devnet',
    spendingKey: testSpendingKey,
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
        spendingKey: testSpendingKey,
      })).toThrow(PrivacyError);
    });

    it('should throw on missing wallet', () => {
      expect(() => new PrivacySDK({
        connection: mockConnection,
        wallet: null as any,
        spendingKey: testSpendingKey,
      })).toThrow();
    });

    it('should throw on missing spendingKey', () => {
      expect(() => new PrivacySDK({
        connection: mockConnection,
        wallet: testKeypair,
      } as any)).toThrow(PrivacyError);
    });

    it('should throw on spendingKey with wrong length', () => {
      expect(() => new PrivacySDK({
        connection: mockConnection,
        wallet: testKeypair,
        spendingKey: new Uint8Array(16),
      })).toThrow(PrivacyError);
    });

    it('should default to devnet', () => {
      const sdk = new PrivacySDK({
        connection: mockConnection,
        wallet: testKeypair,
        spendingKey: testSpendingKey,
      });
      expect(sdk.network).toBe('devnet');
    });

    it('should accept mainnet config', () => {
      // Mainnet rejects placeholder program IDs, so supply custom IDs for all
      // modules that aren't yet deployed on mainnet.
      const dummy = Keypair.generate().publicKey;
      const sdk = createSDK({
        network: 'mainnet',
        programIds: {
          trustless: dummy,
          relayer: dummy,
          registry: dummy,
          quantumVault: dummy,
          starkVerifier: dummy,
          arcium: dummy,
          bundler: dummy,
        },
      });
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

    it('does not expose an mpc module (Arcium removed from Protocol 01)', () => {
      expect((sdk as unknown as { mpc?: unknown }).mpc).toBeUndefined();
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
      const dummy = Keypair.generate().publicKey;
      const mainnetSdk = createSDK({
        network: 'mainnet',
        programIds: {
          trustless: dummy,
          relayer: dummy,
          registry: dummy,
          quantumVault: dummy,
          starkVerifier: dummy,
          arcium: dummy,
          bundler: dummy,
        },
      });
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

  // These MUST equal the on-chain constant. The shielded pool is created with
  // `DEFAULT_TREE_DEPTH = 15` (programs/zk_shielded/src/state/pool_v3.rs) and the
  // STARK verifier rejects any proof whose depth public input is not
  // `CANONICAL_DEPTH = 15` (programs/p01_stark_verifier/src/verify.rs).
  // If this drifts, every root this SDK computes desyncs from the chain and
  // inserts/proofs are rejected. Mirrors packages/p01-js/src/shielded-pool.test.ts.
  it('should have correct merkle depth', () => {
    expect(MERKLE_TREE_DEPTH).toBe(15);
  });

  it('should have correct max leaves', () => {
    expect(MAX_LEAVES).toBe(32768); // 2^15
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
      spendingKey: testSpendingKey,
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
    expect((mod as unknown as { MPCModule?: unknown }).MPCModule).toBeUndefined();
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

  it('should export LiquidityModule', async () => {
    const mod = await import('../src');
    expect(mod.LiquidityModule).toBeDefined();
    expect(mod.P01_LIQUIDITY_PROGRAM_ID).toBeDefined();
  });
});

// ─── LiquidityModule ─────────────────────────────────────────────────────────

function disc(name: string): Buffer {
  return Buffer.from(sha256(utf8ToBytes(`global:${name}`))).subarray(0, 8);
}

describe('LiquidityModule', () => {
  const liquidity = new LiquidityModule(mockConnection);

  describe('PDAs', () => {
    it('should derive pool PDA deterministically', () => {
      const [a, bumpA] = liquidity.getPoolPDA();
      const [b, bumpB] = liquidity.getPoolPDA();
      expect(a.toBase58()).toBe(b.toBase58());
      expect(bumpA).toBe(bumpB);
    });

    it('should derive prefund record PDA from denom_pool + nullifier', () => {
      const denomPool = Keypair.generate().publicKey;
      const nullifier = new Uint8Array(32).fill(1);
      const [pda1] = liquidity.getPrefundRecordPDA(denomPool, nullifier);
      const [pda2] = liquidity.getPrefundRecordPDA(denomPool, nullifier);
      expect(pda1.toBase58()).toBe(pda2.toBase58());

      const other = new Uint8Array(32).fill(2);
      const [pda3] = liquidity.getPrefundRecordPDA(denomPool, other);
      expect(pda1.toBase58()).not.toBe(pda3.toBase58());
    });

    it('should derive lp share PDA per (owner, pool)', () => {
      const owner = Keypair.generate().publicKey;
      const [poolPda] = liquidity.getPoolPDA();
      const [sharePda1] = liquidity.getLpSharePDA(owner, poolPda);
      const [sharePda2] = liquidity.getLpSharePDA(owner, poolPda);
      expect(sharePda1.toBase58()).toBe(sharePda2.toBase58());

      const other = Keypair.generate().publicKey;
      const [sharePda3] = liquidity.getLpSharePDA(other, poolPda);
      expect(sharePda1.toBase58()).not.toBe(sharePda3.toBase58());
    });

    it('should use the default p01_liquidity program ID', () => {
      expect(liquidity.programId.toBase58()).toBe(
        P01_LIQUIDITY_PROGRAM_ID.toBase58(),
      );
    });
  });

  describe('instruction discriminators', () => {
    it('buildInitPoolIx → sha256("global:init_pool")[..8]', () => {
      const ix = liquidity.buildInitPoolIx(testKeypair.publicKey, 80, 20);
      expect(ix.data.subarray(0, 8).equals(disc('init_pool'))).toBe(true);
      expect(ix.data.readUInt16LE(8)).toBe(80);
      expect(ix.data.readUInt16LE(10)).toBe(20);
      expect(ix.data.length).toBe(12);
    });

    it('buildDepositIx → disc + amount LE', () => {
      const amount = 1_500_000_000n;
      const ix = liquidity.buildDepositIx(testKeypair.publicKey, amount);
      expect(ix.data.subarray(0, 8).equals(disc('deposit'))).toBe(true);
      expect(ix.data.readBigUInt64LE(8)).toBe(amount);
    });

    it('buildWithdrawIx → disc + shares (u128 LE)', () => {
      const shares = 42n;
      const ix = liquidity.buildWithdrawIx(testKeypair.publicKey, shares);
      expect(ix.data.subarray(0, 8).equals(disc('withdraw'))).toBe(true);
      expect(ix.data.readBigUInt64LE(8)).toBe(shares); // lo
      expect(ix.data.readBigUInt64LE(16)).toBe(0n);    // hi
    });

    it('buildPrefundIx → disc + nullifier + root + minEpoch + starkCommitment + amount', () => {
      const nullifier = new Uint8Array(32).fill(0xaa);
      const merkleRoot = new Uint8Array(32).fill(0xbb);
      const minEpoch = 123n;
      const starkCommitment = 0xDEADBEEFn;
      const amount = 1_000_000_000n;

      const ix = liquidity.buildPrefundIx({
        ephemeralSigner:  Keypair.generate().publicKey,
        recipient:        Keypair.generate().publicKey,
        denominatedPool:  Keypair.generate().publicKey,
        starkProofBuffer: Keypair.generate().publicKey,
        nullifier,
        merkleRoot,
        minEpoch,
        starkCommitment,
        amount,
      });

      expect(ix.data.subarray(0, 8).equals(disc('prefund'))).toBe(true);
      expect(ix.data.subarray(8, 40).equals(Buffer.from(nullifier))).toBe(true);
      expect(ix.data.subarray(40, 72).equals(Buffer.from(merkleRoot))).toBe(true);
      expect(ix.data.readBigUInt64LE(72)).toBe(minEpoch);
      expect(ix.data.readBigUInt64LE(80)).toBe(starkCommitment);
      expect(ix.data.readBigUInt64LE(88)).toBe(amount);
      expect(ix.data.length).toBe(8 + 32 + 32 + 8 + 8 + 8);
      expect(ix.keys).toHaveLength(7);
      expect(ix.keys[0]!.isSigner).toBe(true);
    });

    it('buildSettleIx → disc only, 10 accounts', () => {
      const ix = liquidity.buildSettleIx({
        settler:           testKeypair.publicKey,
        denominatedPool:   Keypair.generate().publicKey,
        merkleTree:        Keypair.generate().publicKey,
        nullifierRecord:   Keypair.generate().publicKey,
        starkProofBuffer:  Keypair.generate().publicKey,
        nullifier:         new Uint8Array(32),
        zkShieldedProgram: PROGRAM_IDS.devnet.zkShielded,
        protocolFeeWallet: Keypair.generate().publicKey,
      });
      expect(ix.data.equals(disc('settle'))).toBe(true);
      expect(ix.keys).toHaveLength(10);
      expect(ix.keys[0]!.isSigner).toBe(true);
    });
  });

  describe('parsers', () => {
    it('parsePoolState round-trips admin + fees + flags', () => {
      const admin = Keypair.generate().publicKey;
      const data = Buffer.alloc(70);
      // skip disc (bytes 0..8)
      admin.toBuffer().copy(data, 8);
      data.writeBigUInt64LE(500_000_000n, 40); // total_shares lo
      data.writeBigUInt64LE(0n,            48); // total_shares hi
      data.writeBigUInt64LE(BigInt(LAMPORTS_PER_SOL), 56); // reserve
      data.writeUInt16LE(80, 64); // prefund_fee
      data.writeUInt16LE(20, 66); // settler_reward
      data[68] = 1;               // is_active
      data[69] = 254;             // bump

      const s = LiquidityModule.parsePoolState(data);
      expect(s.admin.toBase58()).toBe(admin.toBase58());
      expect(s.totalShares).toBe(500_000_000n);
      expect(s.reserveLamports).toBe(BigInt(LAMPORTS_PER_SOL));
      expect(s.prefundFeeBps).toBe(80);
      expect(s.settlerRewardBps).toBe(20);
      expect(s.isActive).toBe(true);
      expect(s.bump).toBe(254);
    });

    it('parsePrefundRecord round-trips the 273-byte layout', () => {
      const pool = Keypair.generate().publicKey;
      const denomPool = Keypair.generate().publicKey;
      const proofBuffer = Keypair.generate().publicKey;
      const ephemeral = Keypair.generate().publicKey;
      const nullifier = new Uint8Array(32).fill(1);
      const root = new Uint8Array(32).fill(2);
      const inputsHash = new Uint8Array(32).fill(3);

      const data = Buffer.alloc(273);
      pool.toBuffer().copy(data, 8);
      denomPool.toBuffer().copy(data, 40);
      Buffer.from(nullifier).copy(data, 72);
      Buffer.from(root).copy(data, 104);
      Buffer.from(inputsHash).copy(data, 136);
      data.writeBigUInt64LE(999n, 168);            // commitment
      data.writeBigUInt64LE(1_000_000_000n, 176);  // amount
      data.writeBigUInt64LE(42n, 184);             // min_epoch
      proofBuffer.toBuffer().copy(data, 192);
      ephemeral.toBuffer().copy(data, 224);
      data.writeBigUInt64LE(2_000_000n, 256);      // settler_reward
      data.writeBigUInt64LE(1234567n, 264);        // opened_at_slot
      data[272] = 253;

      const r = LiquidityModule.parsePrefundRecord(data);
      expect(r.pool.toBase58()).toBe(pool.toBase58());
      expect(r.denominatedPool.toBase58()).toBe(denomPool.toBase58());
      expect(Buffer.from(r.nullifier).equals(Buffer.from(nullifier))).toBe(true);
      expect(Buffer.from(r.merkleRoot).equals(Buffer.from(root))).toBe(true);
      expect(Buffer.from(r.publicInputsHash).equals(Buffer.from(inputsHash))).toBe(true);
      expect(r.starkCommitment).toBe(999n);
      expect(r.amount).toBe(1_000_000_000n);
      expect(r.minEpoch).toBe(42n);
      expect(r.proofBuffer.toBase58()).toBe(proofBuffer.toBase58());
      expect(r.ephemeralSigner.toBase58()).toBe(ephemeral.toBase58());
      expect(r.settlerReward).toBe(2_000_000n);
      expect(r.openedAtSlot).toBe(1234567n);
      expect(r.bump).toBe(253);
    });
  });

  describe('computePrefundFees', () => {
    it('matches on-chain fee math (80/20 bps on 1 SOL)', () => {
      const oneSol = BigInt(LAMPORTS_PER_SOL);
      const { prefundFee, settlerReward, recipientAmount } =
        LiquidityModule.computePrefundFees(oneSol, 80, 20);
      expect(prefundFee).toBe(8_000_000n);      // 0.8% of 1e9
      expect(settlerReward).toBe(2_000_000n);   // 0.2% of 1e9
      expect(recipientAmount).toBe(oneSol - prefundFee - settlerReward);
    });

    it('handles zero fees', () => {
      const { prefundFee, settlerReward, recipientAmount } =
        LiquidityModule.computePrefundFees(1_000_000n, 0, 0);
      expect(prefundFee).toBe(0n);
      expect(settlerReward).toBe(0n);
      expect(recipientAmount).toBe(1_000_000n);
    });

    it('floors via integer bigint division', () => {
      // 999 * 80 / 10000 = 7.992 → 7
      const { prefundFee } = LiquidityModule.computePrefundFees(999n, 80, 0);
      expect(prefundFee).toBe(7n);
    });
  });
});
