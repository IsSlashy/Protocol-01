import { NextResponse } from 'next/server';
import {
  MAGICBLOCK_DEVNET_RPC,
  SOLANA_DEVNET_RPC,
  pingEndpoint,
  type PingResult,
} from '@/lib/magicblock';

/**
 * POST /api/ephemeral/ping — server-side latency probe.
 *
 * Pings each supplied endpoint in parallel via `getSlot` JSON-RPC and
 * returns round-trip timings. Running server-side avoids browser CORS
 * and gives more consistent numbers than client-side timing.
 *
 * Body shape:
 *   { endpoints?: { url: string; region: string }[] }
 *
 * When `endpoints` is omitted or empty, we ping the default pair:
 * Solana devnet vs MagicBlock PER devnet.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface EndpointSpec {
  url: string;
  region: string;
}

interface PingRequestBody {
  endpoints?: EndpointSpec[];
}

interface PingResponseBody {
  results: PingResult[];
  measuredAt: number;
}

const DEFAULT_ENDPOINTS: EndpointSpec[] = [
  { url: SOLANA_DEVNET_RPC, region: 'solana-devnet' },
  { url: MAGICBLOCK_DEVNET_RPC.us, region: 'mb-us' },
  { url: MAGICBLOCK_DEVNET_RPC.eu, region: 'mb-eu' },
  { url: MAGICBLOCK_DEVNET_RPC.asia, region: 'mb-asia' },
  { url: MAGICBLOCK_DEVNET_RPC.tee, region: 'mb-tee' },
];

function isEndpointSpec(v: unknown): v is EndpointSpec {
  if (typeof v !== 'object' || v === null) return false;
  const rec = v as Record<string, unknown>;
  return typeof rec.url === 'string' && typeof rec.region === 'string';
}

export async function POST(req: Request): Promise<NextResponse<PingResponseBody>> {
  let endpoints: EndpointSpec[] = DEFAULT_ENDPOINTS;

  try {
    const raw = (await req.json()) as PingRequestBody | null;
    if (raw && Array.isArray(raw.endpoints) && raw.endpoints.length > 0) {
      const filtered = raw.endpoints.filter(isEndpointSpec);
      if (filtered.length > 0) endpoints = filtered;
    }
  } catch {
    // Body missing or malformed — fall back to defaults.
  }

  const results = await Promise.all(
    endpoints.map((e) => pingEndpoint(e.url, e.region)),
  );

  return NextResponse.json({ results, measuredAt: Date.now() });
}
