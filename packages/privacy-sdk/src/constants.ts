import { PublicKey } from '@solana/web3.js';
import type { Network, ProgramIds, TokenInfo } from './types';

// ─── Program IDs ──────────────────────────────────────────────────────────────

export const PROGRAM_IDS: Record<Network, ProgramIds> = {
  devnet: {
    zkShielded: new PublicKey('2w4WRvujjrZYip1dUrp3X4nzoPVWeRZF9KnjtvSstGms'),     // deployed
    specter: new PublicKey('8rywsvheQZPp8efQ4bsZ37J9GWMLY2ER76f3o8opPsYh'),        // deployed
    trustless: new PublicKey('5x8qr9UwF6BTN4ySb4gPwL4TYgZiiLCzg4mKDmQrnjyJ'),     // deployed
    zkspl: new PublicKey('AY38smtdsnhmfMCzmnDEefiKCeRTkEPrFXHydAF2FuCT'),          // deployed
    relayer: new PublicKey('Ud2JYaq4frePBy3L2DmddmtPT3nXC1nqxsXEX934Hbw'),         // deployed
    registry: new PublicKey('ET9NrX6RCaNi4Ghr5HsySxMpm4GXQSSw7qZByW5cpLnr'),       // deployed
    feeSplitter: new PublicKey('UdxXEvcAzmGsqUtoBgnNkbmfnky4En2kLxNnsVQU5BM'),      // deployed
    stream: new PublicKey('C92xDDAtd21ED3MitZJ9dhuyGeig5xVx8Dgg6qrxA3vx'),          // deployed
    subscription: new PublicKey('3eDvPJTK2gryh3GhjFgwz94iBsE3hsqZL9ChAFyiBThW'),   // deployed
    quantumVault: new PublicKey('9yVr79XkwGabckVxedz4UH78twzkgmGqXHBAX7vfJvYv'),    // deployed
    starkVerifier: new PublicKey('EXmAQqmkQmq1vnSmKXY2rnUUrrWHqxddjXaJv8aNEL4Z'),  // deployed
    arcium: new PublicKey('FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT'),         // deployed
    bundler: new PublicKey('FzhzTRz8DZDESoCm851n1qB6sSSCTBGV3aZtLVbDfGGX'),        // deployed
    whitelist: new PublicKey('5PSYrjBKke4gj8BgBgRKZNXgjmLCnojZ5yuDqUvPiG33'),       // deployed
    mugenExchange: new PublicKey('EURLevwgmunRQU5piF7QLB1ithMPfxYFXp6jp6eGEAJN'),   // deployed
  },
  mainnet: {
    zkShielded: new PublicKey('8dK17NxQUFPWsLg7eJphiCjSyVfBk2ywC5GU6ctK4qrY'),     // deployed
    specter: new PublicKey('2tuztgD9RhdaBkiP79fHkrFbfWBX75v7UjSNN4ULfbSp'),        // deployed
    trustless: new PublicKey('11111111111111111111111111111111'),                     // not yet deployed
    zkspl: new PublicKey('EqppogLBFqoVfYR2t6WVswaGo7cHxvWmgsgLDnaUPpah'),          // deployed
    relayer: new PublicKey('11111111111111111111111111111111'),                       // not yet deployed
    registry: new PublicKey('11111111111111111111111111111111'),                      // not yet deployed
    feeSplitter: new PublicKey('7xwX64ZxMVyw7xWJPaPuy8WFcvvhJrDDWEkc64nUMDCu'),    // deployed
    stream: new PublicKey('2ko4FQSTj3Bqrmy3nvWeGx1KEhs5f2dFCy7JYY6wyxbs'),          // deployed
    subscription: new PublicKey('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS'),   // deployed
    quantumVault: new PublicKey('11111111111111111111111111111111'),                  // not yet deployed
    starkVerifier: new PublicKey('11111111111111111111111111111111'),                 // not yet deployed
    arcium: new PublicKey('11111111111111111111111111111111'),                        // not yet deployed
    bundler: new PublicKey('11111111111111111111111111111111'),                       // not yet deployed
    whitelist: new PublicKey('AjHD9r4VubPvxJapd5zztf1Yqym1QYiZaQ4SF5h3FPQE'),       // deployed
    mugenExchange: new PublicKey('11111111111111111111111111111111'),                 // not yet deployed
  },
};

/**
 * Get only the deployed program IDs for a given network.
 * Programs with placeholder IDs (System Program) are excluded and a warning is logged for each.
 *
 * @param network - The target network ('devnet' or 'mainnet')
 * @returns A partial ProgramIds object containing only deployed programs
 */
export function getDeployedProgramIds(network: Network): Partial<ProgramIds> {
  const PLACEHOLDER = '11111111111111111111111111111111';
  const all = PROGRAM_IDS[network];
  if (!all) {
    throw new Error(`getDeployedProgramIds: unknown network "${network}". Expected "devnet" or "mainnet".`);
  }

  const deployed: Partial<ProgramIds> = {};
  const undeployed: string[] = [];

  for (const [name, pubkey] of Object.entries(all)) {
    if ((pubkey as PublicKey).toBase58() === PLACEHOLDER) {
      undeployed.push(name);
    } else {
      (deployed as any)[name] = pubkey;
    }
  }

  if (undeployed.length > 0) {
    console.warn(
      `[Protocol01] The following programs are not yet deployed on ${network}: ${undeployed.join(', ')}. ` +
      `These modules will not be available.`,
    );
  }

  return deployed;
}

// ─── Token Registry ───────────────────────────────────────────────────────────

export const TOKENS: Record<Network, Record<string, TokenInfo>> = {
  devnet: {
    SOL: {
      symbol: 'SOL',
      mint: new PublicKey('So11111111111111111111111111111111111111112'),
      decimals: 9,
    },
    USDC: {
      symbol: 'USDC',
      mint: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
      decimals: 6,
    },
    USDT: {
      symbol: 'USDT',
      mint: new PublicKey('EJwZgeZrdC8TXTQbQBoL6bfuAnFUQQRb18wrLowMGerG'),
      decimals: 6,
    },
  },
  mainnet: {
    SOL: {
      symbol: 'SOL',
      mint: new PublicKey('So11111111111111111111111111111111111111112'),
      decimals: 9,
    },
    USDC: {
      symbol: 'USDC',
      mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
      decimals: 6,
    },
    USDT: {
      symbol: 'USDT',
      mint: new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
      decimals: 6,
    },
  },
};

// ─── PDA Seeds ────────────────────────────────────────────────────────────────

export const SEEDS = {
  // zk_shielded
  SHIELDED_POOL: 'shielded_pool',
  DENOMINATED_POOL: 'denominated_pool',
  MERKLE_TREE: 'merkle_tree',
  NULLIFIER: 'nullifier',
  NULLIFIER_SET: 'nullifier_set',
  NULLIFIER_BATCH: 'nullifier_batch',
  VK_DATA: 'vk_data',
  VK_DATA_SUBSCRIBER: 'vk_data_subscriber',
  SUBSCRIPTION_VAULT: 'subscription_vault',
  PRIVACY_ROUTE: 'privacy_route',
  AUCTION_ESCROW: 'auction_escrow',

  // specter
  P01_WALLET: 'p01_wallet',
  STEALTH: 'stealth',
  STEALTH_V2: 'stealth_v2',
  STREAM: 'stream',

  // trustless
  TRUSTLESS_POOL: 'trustless_pool',
  CONFIDENTIAL_ACCOUNT: 'confidential_account',

  // relayer
  RELAYER_CONFIG: 'relayer_config',
  RELAYER: 'relayer',
  JOB: 'job',

  // registry
  REGISTRY: 'registry',

  // fee-splitter
  FEE_CONFIG: 'p01-fee-config',

  // subscription
  SUBSCRIPTION: 'subscription',

  // quantum vault
  WINTERNITZ_VAULT: 'winternitz_vault',
  HASH_VAULT: 'hash_vault',
  COMMIT_RECORD: 'commit_record',

  // stark verifier
  PROOF_BUFFER: 'proof_buffer',

  // mugen exchange
  MUGEN_CONFIG: 'mugen_config',
  MUGEN_ORDER: 'mugen_order',
  MUGEN_ESCROW: 'mugen_escrow',
  MUGEN_VAULT: 'mugen_vault',
  MUGEN_REPUTATION: 'mugen_rep',
} as const;

// ─── Standard Denominations (in lamports/base units) ──────────────────────────

export const DENOMINATIONS = {
  SOL: [
    0.1 * 1e9,   // 0.1 SOL
    1 * 1e9,     // 1 SOL
    10 * 1e9,    // 10 SOL
    100 * 1e9,   // 100 SOL
  ],
  USDC: [
    10 * 1e6,    // $10
    100 * 1e6,   // $100
    1000 * 1e6,  // $1,000
    10000 * 1e6, // $10,000
  ],
  USDT: [
    10 * 1e6,
    100 * 1e6,
    1000 * 1e6,
    10000 * 1e6,
  ],
} as const;

// ─── Merkle Tree Config ───────────────────────────────────────────────────────

export const MERKLE_TREE_DEPTH = 20;
export const MAX_LEAVES = 2 ** MERKLE_TREE_DEPTH; // 1,048,576

// ─── Fee Config ───────────────────────────────────────────────────────────────

export const SHIELD_FEE_BPS = 30;   // 0.3%
export const UNSHIELD_FEE_BPS = 50; // 0.5%
export const MAX_FEE_BPS = 500;     // 5%
export const FEE_WALLET = new PublicKey('BRop3akxwuQaAHeMUC33ZyRjzLh78ENquVMgHum9TjNN');

// ─── STARK Circuit IDs ────────────────────────────────────────────────────────

export const STARK_CIRCUITS = {
  SUBSCRIBER_OWNERSHIP: 0,
  POOL_COMMITMENT: 1,
  BALANCE_PROOF: 2,
  MERKLE_PATH: 3,
  CONFIDENTIAL_BALANCE: 4,
  TRANSFER: 5,
} as const;

// ─── Compute Budget ───────────────────────────────────────────────────────────

export const COMPUTE_UNITS = {
  SHIELD: 200_000,
  UNSHIELD: 400_000,
  TRANSFER: 400_000,
  STARK_VERIFY: 1_400_000,
  STEALTH_SEND: 200_000,
  STEALTH_CLAIM: 200_000,
  STREAM_CREATE: 200_000,
  SUBSCRIPTION_CREATE: 300_000,
  MPC_VOTE: 300_000,
} as const;
