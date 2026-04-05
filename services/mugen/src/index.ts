import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { CONFIG } from './config.js';
import { OrderIndexer } from './services/order-indexer.js';
import { PriceFeed } from './services/price-feed.js';
import { ChatRelay } from './services/chat-relay.js';
import { AutoConfirmBot, loadBotWallet } from './services/auto-confirm-bot.js';
import { RevolutClient } from './services/revolut-client.js';
import { NoiseEngine, deriveMasterSeed } from './services/noise-engine.js';
import { Mixer } from './services/mixer.js';
import { MpcMatcher } from './services/mpc-matcher.js';
import { ordersRouter } from './routes/orders.js';
import { pricesRouter } from './routes/prices.js';
import { botRouter } from './routes/bot.js';
import { privacyRouter } from './routes/privacy.js';

// ─── Initialize services ────────────────────────────────────────────────────

const indexer = new OrderIndexer();
const priceFeed = new PriceFeed();
const chatRelay = new ChatRelay();
let bot: AutoConfirmBot | null = null;
let noiseEngine: NoiseEngine | null = null;
let mixer: Mixer | null = null;
let mpcMatcher: MpcMatcher | null = null;

// ─── Hono app ───────────────────────────────────────────────────────────────

const app = new Hono();

// CORS
app.use(
  '*',
  cors({
    origin: CONFIG.corsOrigin,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
  }),
);

// Health check
app.get('/', (c) =>
  c.json({
    service: 'mugen-exchange',
    version: '0.1.0',
    status: 'ok',
    network: CONFIG.rpcUrl.includes('devnet') ? 'devnet' : 'mainnet',
    programId: CONFIG.programId.toBase58(),
  }),
);

app.get('/health', (c) => {
  const orderStats = indexer.getStats();
  const chatStats = chatRelay.getStats();
  return c.json({
    status: 'ok',
    uptime: process.uptime(),
    orders: orderStats,
    chat: chatStats,
  });
});

// Routes (static services — available immediately)
app.route('/api/orders', ordersRouter(indexer));
app.route('/api/prices', pricesRouter(priceFeed));
app.route('/api/bot', botRouter(indexer));

// ─── Start ──────────────────────────────────────────────────────────────────

async function main() {
  // Start background services
  await Promise.all([indexer.start(), priceFeed.start()]);

  // Start auto-confirm bot if configured
  if (CONFIG.botEnabled && CONFIG.botWalletKey && CONFIG.revolutApiKey) {
    const wallet = loadBotWallet(CONFIG.botWalletKey);
    const revolut = new RevolutClient({
      apiKey: CONFIG.revolutApiKey,
      sandbox: CONFIG.revolutSandbox,
    });
    bot = new AutoConfirmBot({
      wallet,
      revolut,
      indexer,
      priceFeed,
      pollIntervalMs: CONFIG.botPollMs,
    });
    await bot.start();
  }

  // Start noise engine if configured
  if (CONFIG.noiseEnabled && CONFIG.noiseSeed) {
    noiseEngine = new NoiseEngine({
      masterSeed: deriveMasterSeed(CONFIG.noiseSeed),
      priceFeed,
      walletCount: CONFIG.noiseWalletCount,
      meanIntervalMs: CONFIG.noiseMeanIntervalMs,
      minStepDelayMs: CONFIG.noiseMinStepDelayMs,
      maxStepDelayMs: CONFIG.noiseMaxStepDelayMs,
    });
    await noiseEngine.start();
  }

  // Start mixer if configured
  if (CONFIG.mixerEnabled && CONFIG.mixerSeed) {
    mixer = new Mixer({
      masterSeed: deriveMasterSeed(CONFIG.mixerSeed),
      hops: CONFIG.mixerHops,
      minHopDelayMs: CONFIG.mixerMinHopDelayMs,
      maxHopDelayMs: CONFIG.mixerMaxHopDelayMs,
    });
    mixer.start();
  }

  // Start MPC matcher (listens for Arcium blind match results)
  mpcMatcher = new MpcMatcher();
  mpcMatcher.onMatch = async (match) => {
    console.log(
      `[mugen] MPC match → creating escrow: ` +
      `${Number(match.cryptoAmount) / 1e9} SOL for ${Number(match.fiatAmount)} cents`,
    );
    // TODO: Wire to p01_mugen.take_order() using match.makerNonce/takerNonce
    // The escrow is created from the MPC-revealed trade terms.
    // This link (MPC event → escrow) is invisible to on-chain observers.
  };
  await mpcMatcher.start();

  // Register privacy routes (after services are initialized)
  app.route('/api/privacy', privacyRouter(noiseEngine, mixer));

  // Start HTTP server
  const server = serve({
    fetch: app.fetch,
    port: CONFIG.port,
  });

  // Attach WebSocket chat relay
  chatRelay.attach(server as any);

  const botStatus = bot ? '● ACTIVE' : '○ disabled';
  const noiseStatus = noiseEngine ? '● ACTIVE' : '○ disabled';
  const mixerStatus = mixer ? '● ACTIVE' : '○ disabled';
  console.log(`
  ┌─────────────────────────────────────────┐
  │  MUGEN EXCHANGE SERVICE  無限            │
  │                                         │
  │  HTTP:   http://localhost:${CONFIG.port}         │
  │  WS:     ws://localhost:${CONFIG.port}/ws/chat   │
  │  Bot:    ${botStatus.padEnd(29)}│
  │  Noise:  ${noiseStatus.padEnd(29)}│
  │  Mixer:  ${mixerStatus.padEnd(29)}│
  │  RPC:    ${CONFIG.rpcUrl.slice(0, 28)}...│
  └─────────────────────────────────────────┘
  `);
}

main().catch(console.error);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[mugen] Shutting down...');
  mpcMatcher?.stop();
  noiseEngine?.stop();
  mixer?.stop();
  bot?.stop();
  indexer.stop();
  priceFeed.stop();
  chatRelay.close();
  process.exit(0);
});
