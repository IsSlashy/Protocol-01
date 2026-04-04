import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { CONFIG } from './config.js';
import { OrderIndexer } from './services/order-indexer.js';
import { PriceFeed } from './services/price-feed.js';
import { ChatRelay } from './services/chat-relay.js';
import { AutoConfirmBot, loadBotWallet } from './services/auto-confirm-bot.js';
import { RevolutClient } from './services/revolut-client.js';
import { ordersRouter } from './routes/orders.js';
import { pricesRouter } from './routes/prices.js';
import { botRouter } from './routes/bot.js';

// ─── Initialize services ────────────────────────────────────────────────────

const indexer = new OrderIndexer();
const priceFeed = new PriceFeed();
const chatRelay = new ChatRelay();
let bot: AutoConfirmBot | null = null;

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

// Routes
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

  // Start HTTP server
  const server = serve({
    fetch: app.fetch,
    port: CONFIG.port,
  });

  // Attach WebSocket chat relay
  chatRelay.attach(server as any);

  const botStatus = bot ? '● ACTIVE' : '○ disabled';
  console.log(`
  ┌─────────────────────────────────────────┐
  │  MUGEN EXCHANGE SERVICE  無限            │
  │                                         │
  │  HTTP:  http://localhost:${CONFIG.port}          │
  │  WS:    ws://localhost:${CONFIG.port}/ws/chat    │
  │  Bot:   ${botStatus.padEnd(30)}│
  │  RPC:   ${CONFIG.rpcUrl.slice(0, 35)}...│
  │  Program: ${CONFIG.programId.toBase58().slice(0, 20)}... │
  └─────────────────────────────────────────┘
  `);
}

main().catch(console.error);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[mugen] Shutting down...');
  bot?.stop();
  indexer.stop();
  priceFeed.stop();
  chatRelay.close();
  process.exit(0);
});
