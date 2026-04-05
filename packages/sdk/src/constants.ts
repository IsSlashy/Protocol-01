import { PublicKey } from '@solana/web3.js';

/**
 * Stream program ID on devnet
 */
export const STREAM_PROGRAM_ID_DEVNET = new PublicKey(
  '2ko4FQSTj3Bqrmy3nvWeGx1KEhs5f2dFCy7JYY6wyxbs'
);

/**
 * Stream program ID on mainnet (to be set after mainnet deployment)
 */
export const STREAM_PROGRAM_ID_MAINNET = new PublicKey(
  '11111111111111111111111111111111' // Placeholder - update after mainnet deployment
);

/**
 * Whether the stream program has been deployed to mainnet-beta.
 * Set to `true` once the program is live on mainnet and
 * `STREAM_PROGRAM_ID_MAINNET` has been updated to the real address.
 */
export const MAINNET_DEPLOYED = false;

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

// ============================================================================
// Anchor instruction discriminators
//
// These 8-byte prefixes identify each instruction in the on-chain stream
// program. They are the first 8 bytes of SHA-256("global:<ix_name>") as per
// the Anchor framework convention. Every transaction instruction sent to the
// program must start with the matching discriminator.
// ============================================================================

/**
 * Anchor instruction discriminator for `create_stream`.
 * SHA-256("global:create_stream")[0..8]
 */
export const IX_DISCRIMINATOR_CREATE_STREAM = Buffer.from([0x2e, 0x83, 0x64, 0x35, 0x9e, 0x1b, 0x4c, 0x5b]);

/**
 * Anchor instruction discriminator for `cancel_stream`.
 * SHA-256("global:cancel_stream")[0..8]
 */
export const IX_DISCRIMINATOR_CANCEL_STREAM = Buffer.from([0x24, 0x9b, 0x9b, 0x88, 0x45, 0x3e, 0x8a, 0x2c]);

/**
 * Anchor instruction discriminator for `withdraw`.
 * SHA-256("global:withdraw")[0..8]
 */
export const IX_DISCRIMINATOR_WITHDRAW = Buffer.from([0xb7, 0x12, 0x46, 0x9c, 0x94, 0x6d, 0xa1, 0x22]);

/**
 * Size in bytes of a stream account (used in `getProgramAccounts` filters).
 * Layout: 8 (discriminator) + 32 (sender) + 32 (recipient) + 32 (mint)
 *       + 8 (amountPerInterval) + 8 (intervalSeconds) + 8 (totalIntervals)
 *       + 8 (intervalsPaid) + 8 (createdAt) + 8 (lastWithdrawalAt)
 *       + 1 (status) + 4 (name length prefix) + up to ~32 (name)
 *
 * The filter uses an approximate fixed size (200) since stream names vary.
 */
export const STREAM_ACCOUNT_SIZE = 200;

/**
 * Byte offset of the `sender` public key within a stream account buffer.
 * Immediately after the 8-byte Anchor discriminator.
 */
export const STREAM_SENDER_OFFSET = 8;

/**
 * Byte offset of the `recipient` public key within a stream account buffer.
 * After discriminator (8) + sender (32).
 */
export const STREAM_RECIPIENT_OFFSET = 40;
