import { PublicKey } from '@solana/web3.js';

export const CONFIG = {
  /** Solana RPC endpoint. */
  rpcUrl: process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com',

  /** Mugen Exchange program ID. */
  programId: new PublicKey(
    process.env.MUGEN_PROGRAM_ID ?? 'EURLevwgmunRQU5piF7QLB1ithMPfxYFXp6jp6eGEAJN',
  ),

  /** Server port. */
  port: parseInt(process.env.PORT ?? '3002', 10),

  /** Order indexer poll interval (ms). */
  indexerPollMs: parseInt(process.env.INDEXER_POLL_MS ?? '5000', 10),

  /** Price feed cache TTL (ms). */
  priceCacheTtlMs: parseInt(process.env.PRICE_CACHE_TTL_MS ?? '30000', 10),

  /** CORS origin for Mugen web app. */
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3001',

  /** WebSocket path for chat relay. */
  wsPath: '/ws/chat',

  // ── Auto-confirm bot ──────────────────────────────────────────────────

  /** Enable the auto-confirm bot (market maker). */
  botEnabled: process.env.BOT_ENABLED === 'true',

  /** Bot wallet keypair (JSON array or base58 secret key). */
  botWalletKey: process.env.BOT_WALLET_KEY ?? '',

  /** Revolut Business API key. */
  revolutApiKey: process.env.REVOLUT_API_KEY ?? '',

  /** Use Revolut sandbox (true for testing). */
  revolutSandbox: process.env.REVOLUT_SANDBOX !== 'false',

  /** Bot Revolut poll interval (ms). */
  botPollMs: parseInt(process.env.BOT_POLL_MS ?? '15000', 10),

  // ── Auto-order creation ───────────────────────────────────────────────

  /** Token mint the bot sells (default: devnet USDC or wrapped SOL). */
  botTokenMint: process.env.BOT_TOKEN_MINT ?? 'So11111111111111111111111111111111111111112',

  /** Fiat currencies to create orders for (comma-separated). */
  botFiatCurrencies: (process.env.BOT_FIAT_CURRENCIES ?? 'EUR,USD').split(','),

  /** Price spread in basis points (e.g., 200 = 2% markup). */
  botSpreadBps: parseInt(process.env.BOT_SPREAD_BPS ?? '200', 10),

  /** Order size in token base units (lamports). Default: 0.5 SOL. */
  botOrderSize: BigInt(process.env.BOT_ORDER_SIZE ?? '500000000'),

  /** Max concurrent open orders per currency. */
  botMaxOrders: parseInt(process.env.BOT_MAX_ORDERS ?? '3', 10),

  /** Order TTL in seconds. Default: 4 hours. */
  botOrderTtl: parseInt(process.env.BOT_ORDER_TTL ?? '14400', 10),

  /** Accepted payment methods bitfield. Default: Revolut(2) + SEPA(16) + Wise(4). */
  botPaymentMethods: parseInt(process.env.BOT_PAYMENT_METHODS ?? '22', 10),

  /** Minimum reserve to keep in wallet (lamports). Default: 0.1 SOL for rent/fees. */
  botReserveLamports: BigInt(process.env.BOT_RESERVE ?? '100000000'),
} as const;
