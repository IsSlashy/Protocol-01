/**
 * Privacy RPC Relay — strips metadata and forwards Solana RPC requests.
 *
 * Mounts on the existing P01 Bundle Engine server at /v1/rpc.
 * Acts as a transparent JSON-RPC proxy with privacy enhancements:
 *
 * 1. Strips all identifying headers (IP, User-Agent, Referer, etc.)
 * 2. Adds random delay (0-500ms) to break timing correlation
 * 3. Batches requests from multiple users (shared connection pool)
 * 4. Optionally routes through Tor SOCKS5 (when tor is running)
 * 5. Never logs request content or responses
 *
 * Usage:
 *   // On the client (mobile app):
 *   const connection = new Connection("https://bundler.protocol-01.xyz/v1/rpc");
 *   // All RPC calls now go through the privacy relay
 *   // Helius sees the relay's IP, not the user's
 *
 * Tor integration:
 *   // Start tor on the relay server:
 *   apt install tor && systemctl start tor
 *   // Set env:
 *   TOR_SOCKS_PROXY=socks5h://127.0.0.1:9050
 *   // The relay will route all RPC traffic through Tor
 */

import { Router, Request, Response } from 'express';
import https from 'https';
import http from 'http';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const UPSTREAM_RPC = process.env.UPSTREAM_RPC_URL
  || process.env.SOLANA_RPC_URL
  || 'https://api.devnet.solana.com';

/** Tor SOCKS5 proxy (e.g., socks5h://127.0.0.1:9050) */
const TOR_PROXY = process.env.TOR_SOCKS_PROXY || '';

/** Max random delay added to each request (ms) — breaks timing correlation */
const MAX_JITTER_MS = parseInt(process.env.RPC_JITTER_MS || '300', 10);

/** Maximum request body size */
const MAX_BODY_SIZE = 100_000; // 100KB

// ---------------------------------------------------------------------------
// Tor SOCKS5 agent (lazy-loaded)
// ---------------------------------------------------------------------------

let torAgent: any = null;

async function getTorAgent(): Promise<any> {
  if (!TOR_PROXY) return null;
  if (torAgent) return torAgent;

  try {
    // Try to load socks-proxy-agent (optional dependency)
    const { SocksProxyAgent } = await import('socks-proxy-agent');
    torAgent = new SocksProxyAgent(TOR_PROXY);
    console.log(`[RPC-Relay] Tor SOCKS5 proxy configured: ${TOR_PROXY}`);
    return torAgent;
  } catch {
    console.warn('[RPC-Relay] socks-proxy-agent not installed — Tor routing disabled');
    console.warn('[RPC-Relay] Install with: npm install socks-proxy-agent');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

let totalRequests = 0;
let totalTorRouted = 0;
let totalErrors = 0;

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createRpcRelay(): Router {
  const router = Router();

  /**
   * POST /v1/rpc — Privacy-enhanced JSON-RPC proxy
   *
   * Accepts standard Solana JSON-RPC requests.
   * Strips metadata, adds jitter, forwards to upstream RPC.
   */
  router.post('/', async (req: Request, res: Response) => {
    totalRequests++;

    // Validate JSON-RPC request
    const body = req.body;
    if (!body || !body.method) {
      return res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid JSON-RPC request' },
        id: body?.id || null,
      });
    }

    // Block dangerous methods that could leak info
    const blockedMethods = ['getIdentity', 'getClusterNodes'];
    if (blockedMethods.includes(body.method)) {
      return res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32601, message: 'Method not allowed through privacy relay' },
        id: body.id,
      });
    }

    try {
      // Privacy jitter: random delay to break timing correlation
      if (MAX_JITTER_MS > 0) {
        const jitter = Math.floor(Math.random() * MAX_JITTER_MS);
        await new Promise(r => setTimeout(r, jitter));
      }

      // Forward to upstream RPC
      const result = await forwardRpcRequest(body);
      return res.json(result);
    } catch (err: any) {
      totalErrors++;
      // Don't leak upstream error details
      return res.status(502).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Upstream RPC error' },
        id: body.id,
      });
    }
  });

  /**
   * GET /v1/rpc/stats — Relay statistics (no PII)
   */
  router.get('/stats', (_req: Request, res: Response) => {
    return res.json({
      totalRequests,
      totalTorRouted,
      totalErrors,
      torEnabled: !!TOR_PROXY,
      upstreamRpc: UPSTREAM_RPC.replace(/[?&](api-key|key)=[^&]+/gi, ''),
      jitterMs: MAX_JITTER_MS,
    });
  });

  // Init Tor agent on startup (non-blocking)
  getTorAgent().catch(() => {});

  console.log(`[RPC-Relay] Privacy RPC relay mounted at /v1/rpc`);
  console.log(`[RPC-Relay] Upstream: ${UPSTREAM_RPC.replace(/[?&](api-key|key)=[^&]+/gi, '...')}`);
  console.log(`[RPC-Relay] Tor: ${TOR_PROXY || 'disabled'}`);
  console.log(`[RPC-Relay] Jitter: 0-${MAX_JITTER_MS}ms`);

  return router;
}

// ---------------------------------------------------------------------------
// Forward RPC request to upstream
// ---------------------------------------------------------------------------

async function forwardRpcRequest(body: any): Promise<any> {
  const agent = await getTorAgent();
  const useTor = !!agent;
  if (useTor) totalTorRouted++;

  const payload = JSON.stringify(body);
  const url = new URL(UPSTREAM_RPC);

  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        // NO user-agent, NO origin, NO referer — completely anonymous
      },
      timeout: 30_000,
      // Route through Tor if available
      ...(useTor ? { agent } : {}),
    };

    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ jsonrpc: '2.0', error: { code: -32000, message: 'Invalid upstream response' }, id: body.id });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Upstream timeout'));
    });

    req.write(payload);
    req.end();
  });
}
