import { PublicKey } from '@solana/web3.js';

/**
 * Stream program ID on devnet
 */
export const STREAM_PROGRAM_ID_DEVNET = new PublicKey(
  '46i1Li5pMumVSB4YBF9DmQTCibe5x9DrNFEiqdfsZSf8'
);

/**
 * Stream program ID on mainnet (to be set after mainnet deployment)
 */
export const STREAM_PROGRAM_ID_MAINNET = new PublicKey(
  '11111111111111111111111111111111' // Placeholder - update after mainnet deployment
);

/**
 * Native SOL mint address
 */
export const NATIVE_SOL_MINT = new PublicKey(
  'So11111111111111111111111111111111111111112'
);

/**
 * USDC mint address on devnet
 */
export const USDC_MINT_DEVNET = new PublicKey(
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
);

/**
 * USDC mint address on mainnet
 */
export const USDC_MINT_MAINNET = new PublicKey(
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
);

/**
 * Default RPC endpoints
 */
export const RPC_ENDPOINTS = {
  devnet: 'https://api.devnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  testnet: 'https://api.testnet.solana.com',
} as const;

/**
 * Subscription intervals in seconds
 */
export const INTERVALS = {
  HOURLY: 3600,
  DAILY: 86400,
  WEEKLY: 604800,
  MONTHLY: 2592000, // 30 days
  YEARLY: 31536000, // 365 days
} as const;

/**
 * Protocol 01 subscription tiers
 */
export const P01_TIERS = {
  basic: {
    name: 'Basic',
    pricePerInterval: 9.99 * 1e9, // 9.99 USDC (6 decimals) converted to lamports equivalent
    intervalSeconds: INTERVALS.MONTHLY,
    totalIntervals: 12, // 1 year
    features: [
      'SDK Access',
      'Stealth Addresses',
      'Basic API (1000 req/day)',
    ],
  },
  pro: {
    name: 'Pro',
    pricePerInterval: 24.99 * 1e6, // 24.99 USDC
    intervalSeconds: INTERVALS.MONTHLY,
    totalIntervals: 12,
    features: [
      'Everything in Basic',
      'Private Transactions',
      'Advanced API (10000 req/day)',
      'Priority Support',
    ],
  },
  enterprise: {
    name: 'Enterprise',
    pricePerInterval: 99.99 * 1e6, // 99.99 USDC
    intervalSeconds: INTERVALS.MONTHLY,
    totalIntervals: 12,
    features: [
      'Everything in Pro',
      'ZK Transactions',
      'Unlimited API',
      'Dedicated Support',
      'Custom Integration',
    ],
  },
} as const;

/**
 * Stream account seed prefix
 */
export const STREAM_SEED = 'stream';

/**
 * Escrow account seed prefix
 */
export const ESCROW_SEED = 'escrow';
