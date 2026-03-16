/**
 * P01 Bundle Engine — HTTP Server
 *
 * Public API for submitting transaction bundles.
 * Designed to be deployed on any VPS, edge function, or cloud provider.
 *
 * Privacy guarantees:
 * - No IP logging (request metadata stripped)
 * - No TX content inspection (opaque bytes)
 * - No persistent storage (stateless, in-memory mempool only)
 * - CORS enabled for browser/mobile clients
 *
 * Endpoints:
 *   POST /v1/bundle        — Submit a bundle of serialized TXs
 *   GET  /v1/bundle/:id    — Check bundle status (optional)
 *   GET  /v1/stats         — Mempool statistics (public, no PII)
 *   GET  /health           — Health check
 */

import express from 'express';
import cors from 'cors';
import { PrivacyMempool, BundleFlushResult } from './mempool';
import { createRpcRelay } from './rpc-relay';

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '3099', 10);
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const BATCH_WINDOW_MS = parseInt(process.env.BATCH_WINDOW_MS || '2000', 10);
const MAX_BUNDLE_SIZE = 20; // Max TXs per bundle submission

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();
const mempool = new PrivacyMempool(RPC_URL, { batchWindowMs: BATCH_WINDOW_MS });

// ── Privacy middleware: strip all identifying headers ──
app.use((req, _res, next) => {
  // Don't log IPs, user-agents, or any request metadata
  // This is intentional — the bundler should not know who submits what
  delete req.headers['x-forwarded-for'];
  delete req.headers['x-real-ip'];
  delete req.headers['user-agent'];
  delete req.headers['referer'];
  delete req.headers['origin'];
  next();
});

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

// ── Privacy RPC Relay ──
app.use('/v1/rpc', createRpcRelay());

// Completed bundle results (short-lived cache for status polling)
const bundleResults = new Map<string, BundleFlushResult>();
const RESULT_TTL_MS = 5 * 60_000; // 5 minutes

function cacheBundleResult(result: BundleFlushResult): void {
  bundleResults.set(result.bundleId, result);
  // Auto-cleanup after TTL
  setTimeout(() => bundleResults.delete(result.bundleId), RESULT_TTL_MS);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * POST /v1/bundle
 *
 * Submit a bundle of serialized transactions.
 *
 * Body:
 * {
 *   "transactions": ["base64_tx_1", "base64_tx_2", ...],
 *   "bundleId": "optional_client_id"
 * }
 *
 * Response:
 * {
 *   "bundleId": "...",
 *   "queued": true,
 *   "txCount": 2,
 *   "estimatedFlushMs": 2000
 * }
 */
app.post('/v1/bundle', async (req, res) => {
  try {
    const { transactions, bundleId: clientBundleId } = req.body;

    if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({ error: 'Missing or empty transactions array' });
    }

    if (transactions.length > MAX_BUNDLE_SIZE) {
      return res.status(400).json({
        error: `Bundle too large: ${transactions.length} TXs (max ${MAX_BUNDLE_SIZE})`,
      });
    }

    // Decode base64 transactions
    const txBuffers: Buffer[] = [];
    for (const txBase64 of transactions) {
      if (typeof txBase64 !== 'string') {
        return res.status(400).json({ error: 'Each transaction must be a base64 string' });
      }
      txBuffers.push(Buffer.from(txBase64, 'base64'));
    }

    // Generate bundle ID if not provided
    const bundleId = clientBundleId || `p01_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    // Submit to mempool (returns when batch is flushed)
    // Run async — return immediately with queued status
    mempool.submit(bundleId, txBuffers).then((result) => {
      cacheBundleResult(result);
    });

    return res.json({
      bundleId,
      queued: true,
      txCount: txBuffers.length,
      estimatedFlushMs: BATCH_WINDOW_MS,
    });
  } catch (err: any) {
    console.error('[Server] Bundle submission error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /v1/bundle/sync
 *
 * Submit a bundle and wait for it to be flushed + submitted.
 * Blocks until the batch window closes and TXs are sent to the network.
 *
 * Same body as POST /v1/bundle.
 *
 * Response includes full results:
 * {
 *   "bundleId": "...",
 *   "landed": true,
 *   "results": [{ "txId": "...", "signature": "..." }, ...],
 *   "batchSize": 5,
 *   "flushTimestamp": 1234567890
 * }
 */
app.post('/v1/bundle/sync', async (req, res) => {
  try {
    const { transactions, bundleId: clientBundleId } = req.body;

    if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({ error: 'Missing or empty transactions array' });
    }

    if (transactions.length > MAX_BUNDLE_SIZE) {
      return res.status(400).json({
        error: `Bundle too large: ${transactions.length} TXs (max ${MAX_BUNDLE_SIZE})`,
      });
    }

    const txBuffers = transactions.map((tx: string) => Buffer.from(tx, 'base64'));
    const bundleId = clientBundleId || `p01_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    // Wait for flush
    const result = await mempool.submit(bundleId, txBuffers);
    cacheBundleResult(result);

    return res.json(result);
  } catch (err: any) {
    console.error('[Server] Sync bundle error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /v1/bundle/:id
 *
 * Check the status of a previously submitted bundle.
 */
app.get('/v1/bundle/:id', (req, res) => {
  const result = bundleResults.get(req.params.id);
  if (!result) {
    return res.status(404).json({
      bundleId: req.params.id,
      status: 'pending_or_expired',
      message: 'Bundle not found. It may still be in the mempool or has expired.',
    });
  }
  return res.json(result);
});

/**
 * GET /v1/stats
 *
 * Public mempool statistics. No PII or TX data exposed.
 */
app.get('/v1/stats', (_req, res) => {
  const stats = mempool.getStats();
  return res.json({
    ...stats,
    version: '0.1.0',
    engine: 'p01-bundler',
    cluster: RPC_URL.includes('devnet') ? 'devnet' : RPC_URL.includes('mainnet') ? 'mainnet' : 'custom',
  });
});

/**
 * GET /health
 */
app.get('/health', (_req, res) => {
  return res.json({ status: 'ok', timestamp: Date.now() });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║         P01 Bundle Engine v0.1.0              ║');
  console.log('║   Privacy-first TX bundling for Solana        ║');
  console.log('╠═══════════════════════════════════════════════╣');
  console.log(`║  Port:    ${String(PORT).padEnd(36)}║`);
  console.log(`║  RPC:     ${RPC_URL.slice(0, 36).padEnd(36)}║`);
  console.log(`║  Window:  ${String(BATCH_WINDOW_MS + 'ms').padEnd(36)}║`);
  console.log('╚═══════════════════════════════════════════════╝');
  console.log('');
  console.log('  POST /v1/bundle       — Submit bundle (async)');
  console.log('  POST /v1/bundle/sync  — Submit bundle (wait for result)');
  console.log('  GET  /v1/bundle/:id   — Check bundle status');
  console.log('  GET  /v1/stats        — Mempool statistics');
  console.log('  POST /v1/rpc          — Privacy RPC relay (Tor-routed)');
  console.log('  GET  /v1/rpc/stats    — Relay statistics');
  console.log('  GET  /health          — Health check');
  console.log('');
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[Server] SIGINT — flushing mempool...');
  await mempool.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[Server] SIGTERM — flushing mempool...');
  await mempool.shutdown();
  process.exit(0);
});

export { app, mempool };
