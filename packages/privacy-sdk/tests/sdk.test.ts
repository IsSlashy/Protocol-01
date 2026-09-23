import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
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
  getDeployedProgramIds,
} from '../src';

// ─── Test Setup ───────────────────────────────────────────────────────────────

const DEVNET_URL = 'https://api.devnet.solana.com';
const mockConnection = new Connection(DEVNET_URL, 'confirmed');
const testKeypair = Keypair.generate();
const testSpendingKey = new Uint8Array(32).fill(7);

const PKG = resolve(__dirname, '..');
const REPO = resolve(PKG, '..', '..');

/**
 * Modules removed in 2.0.0. Each built instructions for a program that is not
 * deployed, or that the deployed zk_shielded program does not register
 * (CHANGELOG.md). `stealth`, `vault` and `mpc` left earlier.
 */
const REMOVED_MODULES = [
  'shield',
  'confidential',
  'streams',
  'subscriptions',
  'compliance',
  'airdrop',
  'otc',
  'payroll',
  'treasury',
  'liquidity',
  'instantUnshield',
] as const;

function createSDK(overrides: Partial<Parameters<typeof PrivacySDK>[0]> = {}) {
  return new PrivacySDK({
    connection: mockConnection,
    wallet: testKeypair,
    network: 'devnet',
    spendingKey: testSpendingKey,
    ...overrides,
  } as any);
}

/** Mainnet rejects placeholder program ids: supply the undeployed ones. */
function mainnetOverrides() {
  const dummy = Keypair.generate().publicKey;
  return { relayer: dummy, registry: dummy, starkVerifier: dummy };
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

    it('should accept mainnet config once the undeployed ids are overridden', () => {
      const sdk = createSDK({ network: 'mainnet', programIds: mainnetOverrides() });
      expect(sdk.network).toBe('mainnet');
    });

    it('should refuse mainnet while a program id is still a placeholder', () => {
      expect(() => createSDK({ network: 'mainnet' })).toThrow(PrivacyError);
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

    it('has none of the removed modules, nor stealth, vault or mpc', () => {
      const bag = sdk as unknown as Record<string, unknown>;
      for (const name of [...REMOVED_MODULES, 'stealth', 'vault', 'mpc']) {
        expect(bag[name], `sdk.${name}`).toBeUndefined();
      }
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
      const mainnetSdk = createSDK({ network: 'mainnet', programIds: mainnetOverrides() });
      const usdc = mainnetSdk.resolveToken('USDC');
      expect(usdc.mint.toBase58()).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    });
  });

  describe('events', () => {
    it('should subscribe and emit events', () => {
      const sdk = createSDK();
      const handler = vi.fn();

      sdk.on('relay:submit', handler);
      sdk.emit('relay:submit', { jobId: 'j1' });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        type: 'relay:submit',
        data: { jobId: 'j1' },
        timestamp: expect.any(Number),
      }));
    });

    it('should unsubscribe', () => {
      const sdk = createSDK();
      const handler = vi.fn();

      sdk.on('relay:complete', handler);
      sdk.off('relay:complete', handler);
      sdk.emit('relay:complete', {});

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
    expect(ids.relayer).toBeInstanceOf(PublicKey);
    expect(ids.registry).toBeInstanceOf(PublicKey);
    expect(ids.starkVerifier).toBeInstanceOf(PublicKey);
  });

  it('carries no key for a closed or never-deployed program', () => {
    // specter/feeSplitter/quantumVault/arcium: closed on devnet 2026-09-13.
    // trustless/zkspl/stream/subscription/whitelist/bundler: nothing deployed
    // behind them; removed with their modules. A caller that still reads one
    // gets undefined, never an address.
    for (const network of ['devnet', 'mainnet'] as const) {
      const bag = PROGRAM_IDS[network] as unknown as Record<string, unknown>;
      for (const key of [
        'specter', 'feeSplitter', 'quantumVault', 'arcium',
        'trustless', 'zkspl', 'stream', 'subscription', 'whitelist', 'bundler',
      ]) {
        expect(bag[key], `${network}.${key}`).toBeUndefined();
      }
      expect(Object.keys(bag).sort()).toEqual(['registry', 'relayer', 'starkVerifier', 'zkShielded']);
    }
  });

  // These MUST equal the on-chain constant. The shielded pool is created with
  // `DEFAULT_TREE_DEPTH = 15` (programs/zk_shielded/src/state/pool_v3.rs) and the
  // STARK verifier rejects any proof whose depth public input is not
  // `CANONICAL_DEPTH = 15` (programs/p01_stark_verifier/src/verify.rs).
  it('should have correct merkle depth', () => {
    expect(MERKLE_TREE_DEPTH).toBe(15);
  });

  it('should have correct max leaves', () => {
    expect(MAX_LEAVES).toBe(32768); // 2^15
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
    expect(SEEDS.RELAYER).toBe('relayer');
    expect(SEEDS.JOB).toBe('job');
  });

  it('should have the token registry for both networks', () => {
    expect(TOKENS.devnet.SOL).toBeDefined();
    expect(TOKENS.mainnet.USDC).toBeDefined();
  });
});

// ─── Error System ─────────────────────────────────────────────────────────────

describe('PrivacyError', () => {
  it('should create error with code and message', () => {
    const err = new PrivacyError(PrivacyErrorCode.RELAY_SUBMIT_FAILED, 'test');
    expect(err.code).toBe(PrivacyErrorCode.RELAY_SUBMIT_FAILED);
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
    expect(PrivacyError.txFailed('register').code).toBe(PrivacyErrorCode.TRANSACTION_FAILED);
  });

  it('should have correct error code ranges', () => {
    // General: 1xxx
    expect(PrivacyErrorCode.WALLET_NOT_CONNECTED).toBe(1001);
    // Relay: 8xxx
    expect(PrivacyErrorCode.RELAY_SUBMIT_FAILED).toBe(8001);
    // Registry: 10xxx
    expect(PrivacyErrorCode.REGISTRY_NOT_FOUND).toBe(10001);
  });

  it('has retired the codes of the removed modules and does not reuse their numbers', () => {
    const codes = PrivacyErrorCode as unknown as Record<string, unknown>;
    for (const name of [
      'SHIELD_FAILED', 'LIQUIDITY_DISABLED', 'CONFIDENTIAL_DEPOSIT_FAILED',
      'STREAM_CREATE_FAILED', 'SUBSCRIPTION_CREATE_FAILED', 'MPC_VOTE_FAILED',
    ]) {
      expect(codes[name], name).toBeUndefined();
    }
    const numbers = Object.values(PrivacyErrorCode).filter((v): v is number => typeof v === 'number');
    for (const n of numbers) {
      const range = Math.floor(n / 1000);
      expect([1, 8, 10], `code ${n}`).toContain(range);
    }
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
  it('should export the kept module classes via ESM', async () => {
    const mod = await import('../src');
    expect(mod.RegistryModule).toBeDefined();
    expect(mod.RelayModule).toBeDefined();
    expect(mod.splitAmount).toBeDefined();
  });

  it('exports none of the removed module classes or flows', async () => {
    const mod = (await import('../src')) as unknown as Record<string, unknown>;
    for (const name of [
      'ShieldModule', 'ConfidentialModule', 'StreamsModule', 'SubscriptionsModule',
      'ComplianceModule', 'AirdropModule', 'OTCModule', 'PayrollModule', 'TreasuryModule',
      'LiquidityModule', 'P01_LIQUIDITY_PROGRAM_ID', 'InstantUnshieldFlow', 'buildInstantUnshield',
      'MPCModule', 'StealthModule', 'VaultModule',
      'SHIELD_FEE_BPS', 'UNSHIELD_FEE_BPS', 'FEE_WALLET', 'STARK_CIRCUITS', 'COMPUTE_UNITS',
    ]) {
      expect(mod[name], name).toBeUndefined();
    }
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

  it('the React entry exposes only the hooks of the kept modules', async () => {
    const react = (await import('../src/react')) as unknown as Record<string, unknown>;
    expect(react.usePrivacy).toBeDefined();
    expect(react.useRegistry).toBeDefined();
    expect(react.useRelay).toBeDefined();
    for (const name of ['useShield', 'useConfidential', 'useStreams', 'useSubscriptions', 'useStealth', 'useVault']) {
      expect(react[name], name).toBeUndefined();
    }
  });
});

// ─── Package surface: no dangling entry point for a removed module ────────────

describe('package surface', () => {
  const pkg = JSON.parse(readFileSync(resolve(PKG, 'package.json'), 'utf8')) as {
    exports: Record<string, unknown>;
    dependencies: Record<string, string>;
  };
  const tsup = readFileSync(resolve(PKG, 'tsup.config.ts'), 'utf8');

  it('every subpath export is built by a tsup entry whose source exists', () => {
    for (const sub of Object.keys(pkg.exports)) {
      if (sub === '.') continue;
      const name = sub.slice(2); // './registry' -> 'registry'
      const entry = name === 'react' ? 'react/index' : `modules/${name}`;
      expect(tsup, `tsup entry for ${sub}`).toContain(`'${entry}'`);
      const src = name === 'react' ? 'src/react/index.ts' : `src/modules/${name}.ts`;
      expect(existsSync(resolve(PKG, src)), `${src} for ${sub}`).toBe(true);
    }
  });

  it('no export, tsup entry or source file remains for a removed module', () => {
    for (const name of REMOVED_MODULES) {
      expect(pkg.exports[`./${name}`], `export ./${name}`).toBeUndefined();
      expect(tsup).not.toContain(`'modules/${name}'`);
      expect(existsSync(resolve(PKG, 'src', 'modules', `${name}.ts`)), `src/modules/${name}.ts`).toBe(false);
    }
  });

  it('does not depend on the deleted privacy-toolkit or on a Groth16 prover', () => {
    for (const dep of ['@protocol-01/privacy-toolkit', 'snarkjs', 'poseidon-lite']) {
      expect(pkg.dependencies[dep], dep).toBeUndefined();
    }
  });
});

// ─── READMEs: no removed call advertised, no deployment overclaim ─────────────

const REMOVED_CALL = new RegExp(
  `^\\s*(const\\s+\\w+\\s*=\\s*)?(await\\s+)?sdk\\.(${REMOVED_MODULES.join('|')}|transfer|unshield)\\b`,
);

function privacySdkCodeBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```(?:typescript|tsx)\n([\s\S]*?)```/g)]
    .map((m) => m[1]!)
    .filter((b) => b.includes('@protocol-01/privacy-sdk') || /\bsdk\./.test(b));
}

describe('README.md files do not advertise the removed calls as working', () => {
  it('the package README code samples call no removed module', () => {
    const readme = readFileSync(resolve(PKG, 'README.md'), 'utf8');
    for (const b of privacySdkCodeBlocks(readme)) {
      const live = b.split('\n').filter((l) => REMOVED_CALL.test(l));
      expect(live, 'README shows removed calls as working').toEqual([]);
    }
  });

  it('the root README privacy-sdk code samples call no removed module', () => {
    const readme = readFileSync(resolve(REPO, 'README.md'), 'utf8');
    const blocks = [...readme.matchAll(/```typescript\n([\s\S]*?)```/g)]
      .map((m) => m[1]!)
      .filter((b) => b.includes('@protocol-01/privacy-sdk'));
    for (const b of blocks) {
      const live = b.split('\n').filter((l) => REMOVED_CALL.test(l));
      expect(live, 'root README shows removed calls as working').toEqual([]);
    }
  });

  it('the root README architecture line for privacy-sdk does not say shield/unshield/subscribe work', () => {
    const line = readFileSync(resolve(REPO, 'README.md'), 'utf8')
      .split('\n')
      .find((l) => /│\s+├── privacy-sdk\//.test(l));
    expect(line).toBeDefined();
    expect(line!).not.toMatch(/shield\/unshield\/subscribe with STARK proofs/);
  });
});

describe('the package README does not claim any program of this SDK is deployed on mainnet', () => {
  it('no Mainnet cell of the Network Support table says Deployed', () => {
    const readme = readFileSync(resolve(PKG, 'README.md'), 'utf8');
    const at = readme.indexOf('## Network Support');
    expect(at, 'README has no "## Network Support" section').toBeGreaterThanOrEqual(0);
    const lines = readme.slice(at).split('\n');
    const first = lines.findIndex((l) => l.startsWith('|'));
    const end = lines.findIndex((l, k) => k > first && !l.startsWith('|'));
    const rows = lines.slice(first, end < 0 ? undefined : end).filter((l) => !/^\|\s*-/.test(l)).slice(1);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const cells = r.split('|').map((c) => c.trim());
      expect(cells[3], r).not.toMatch(/^Deployed/);
    }
  });
});

describe('getDeployedProgramIds is not presented as a deployment check (F45/F27 verifier finding)', () => {
  const readme = readFileSync(resolve(PKG, 'README.md'), 'utf8');
  const constantsSrc = readFileSync(resolve(PKG, 'src', 'constants.ts'), 'utf8');

  it('behaviour pin: it returns declared ids minus System-program placeholders, including one the table says is not deployed', () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      // The Network Support table says "Not deployed" for mainnet zk_shielded.
      expect(getDeployedProgramIds('mainnet').zkShielded).toBeDefined();
      expect(getDeployedProgramIds('mainnet').registry).toBeUndefined(); // placeholder
      expect(getDeployedProgramIds('devnet').starkVerifier).toBeDefined();
    } finally {
      console.warn = warn;
    }
  });

  it('no README line tells the reader to rely on it, or says it returns what is actually deployed', () => {
    expect(readme).not.toMatch(/getDeployedProgramIds\(network\)`? before relying on a module/i);
    expect(readme).not.toMatch(/only programs that are actually deployed/i);
  });

  it('the README says it filters placeholders only and does not check the chain', () => {
    const mentions = [...readme.matchAll(/getDeployedProgramIds\(/g)].map((m) => m.index!);
    expect(mentions.length).toBeGreaterThan(0);
    for (const at of mentions) {
      const around = readme.slice(Math.max(0, at - 600), at + 600);
      expect(around, `mention at offset ${at}`).toMatch(/placeholder/i);
      expect(around, `mention at offset ${at}`).toMatch(/does not (check|query|read) the chain/i);
    }
  });

  it('its JSDoc does not call the result the deployed programs', () => {
    const at = constantsSrc.indexOf('export function getDeployedProgramIds');
    const doc = constantsSrc.slice(constantsSrc.lastIndexOf('/**', at), at);
    expect(doc).not.toMatch(/Get only the deployed program IDs/);
    expect(doc).not.toMatch(/containing only deployed programs/);
    expect(doc).toMatch(/does not (check|query|read) the chain/i);
  });
});
