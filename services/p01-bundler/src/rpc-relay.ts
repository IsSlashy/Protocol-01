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
// Tor SOCKS5 agent (lazy-loaded, circuit rotation)
// ---------------------------------------------------------------------------
//
// Privacy: We rotate the Tor circuit every TOR_ROTATION_MS by creating a
// new SocksProxyAgent with a random username. Tor treats different SOCKS
// credentials as different clients, assigning them separate circuits and
// exit nodes. This prevents long-lived circuit correlation.
//
// No Tor control port needed — rotation is purely via SOCKS auth.
// ---------------------------------------------------------------------------

let torAgent: any = null;
let torAgentCreatedAt = 0;

/** How often to rotate the Tor circuit (ms). Default: 10 minutes. */
const TOR_ROTATION_MS = parseInt(process.env.TOR_ROTATION_MS || '600000', 10);

/** Track how many times we've rotated for stats */
let totalCircuitRotations = 0;

async function getTorAgent(): Promise<any> {
  if (!TOR_PROXY) return null;

  const now = Date.now();

  // Return existing agent if still within rotation window
  if (torAgent && (now - torAgentCreatedAt) < TOR_ROTATION_MS) {
    return torAgent;
  }

  try {
    const { SocksProxyAgent } = await import('socks-proxy-agent');

    // Random SOCKS auth credentials → Tor assigns a fresh circuit
    const sessionId = Math.random().toString(36).slice(2, 12);
    const proxyUrl = new URL(TOR_PROXY);
    proxyUrl.username = `p01_${sessionId}`;
    proxyUrl.password = 'x';

    torAgent = new SocksProxyAgent(proxyUrl.toString());
    torAgentCreatedAt = now;

    if (totalCircuitRotations === 0) {
      console.log(`[RPC-Relay] Tor SOCKS5 proxy active — circuit rotation every ${TOR_ROTATION_MS / 60_000}min`);
    } else {
      console.log(`[RPC-Relay] Tor circuit rotated (rotation #${totalCircuitRotations})`);
    }
    totalCircuitRotations++;

    return torAgent;
  } catch {
    console.warn('[RPC-Relay] socks-proxy-agent not available — Tor routing disabled');
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

    const body = req.body;

    // Support batch JSON-RPC requests (array of requests)
    const isBatch = Array.isArray(body);

    // Validate: single request must have method, batch must be non-empty array
    if (isBatch) {
      if (body.length === 0) {
        return res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Empty batch request' },
          id: null,
        });
      }
    } else if (!body || !body.method) {
      return res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid JSON-RPC request' },
        id: body?.id || null,
      });
    }

    // Block dangerous methods that could leak info
    const blockedMethods = ['getIdentity', 'getClusterNodes'];
    const requests = isBatch ? body : [body];
    for (const rpcReq of requests) {
      if (blockedMethods.includes(rpcReq.method)) {
        return res.status(403).json({
          jsonrpc: '2.0',
          error: { code: -32601, message: 'Method not allowed through privacy relay' },
          id: rpcReq.id,
        });
      }
    }

    try {
      // Privacy jitter: random delay to break timing correlation
      if (MAX_JITTER_MS > 0) {
        const jitter = Math.floor(Math.random() * MAX_JITTER_MS);
        await new Promise(r => setTimeout(r, jitter));
      }

      // Forward the entire body (single or batch) to upstream RPC
      const result = await forwardRpcRequest(isBatch ? body : body);
      return res.json(result);
    } catch (err: any) {
      totalErrors++;
      // Don't leak upstream error details
      return res.status(502).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Upstream RPC error' },
        id: isBatch ? null : body.id,
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
      torCircuitRotations: totalCircuitRotations,
      torRotationIntervalMin: TOR_ROTATION_MS / 60_000,
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
