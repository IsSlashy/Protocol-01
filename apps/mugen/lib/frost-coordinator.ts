// ═══════════════════════════════════════════════════════════════════════════
// FROST Threshold Coordinator (MVP)
// ─────────────────────────────────────────────────────────────────────────
// Fan out a transaction-approval request to N independent signer services
// running on localhost ports (4001/4002/4003 by default), gather signatures
// in parallel, and return as soon as the threshold is met.
//
// NOTE: Real production uses FROST-Ed25519 math (off-chain aggregation into
// a single Ed25519 signature). This MVP demonstrates the *architecture* —
// independent signers, threshold required, geographic distribution — using
// each signer's own keypair. The crypto math upgrade ships in Phase 2.
// ═══════════════════════════════════════════════════════════════════════════

export interface SignerInfo {
  pubkey: string;
  region: string;
  port: number;
  signerId: string;
  version: string;
  online: boolean;
}

export interface SignerSignature {
  signerPubkey: string;
  signerId: string;
  region: string;
  port: number;
  signature: string;
  signedAt: number;
}

export interface ThresholdApproval {
  txHashHex: string;
  requestId: string;
  signatures: SignerSignature[];
  threshold: number;
  totalSigners: number;
  aggregatedAt: number;
  thresholdReached: boolean;
}

export const DEFAULT_SIGNER_PORTS: readonly number[] = [4001, 4002, 4003];
export const DEFAULT_THRESHOLD = 2;
export const DEFAULT_HOST = 'http://localhost';

// Env-driven per-signer base URL overrides. When set, these take precedence
// over `${host}:${port}` — e.g. FROST_HOST_0=https://signer-eu.example.com
// points index 0 (default port 4001) at a remote signer without changing
// the port catalogue.
function resolveSignerBaseUrl(index: number, port: number, host: string): string {
  const envKey = `FROST_HOST_${index}`;
  const override = process.env[envKey];
  if (override && override.length > 0) return override;
  return `${host}:${port}`;
}

const HEALTH_TIMEOUT_MS = 1500;
const SIGN_TIMEOUT_MS = 5000;

// ───────────────────────────────────────────────────────────────────────────
// Internal types matching the signer service contract
// ───────────────────────────────────────────────────────────────────────────

interface SignerInfoResponse {
  pubkey: string;
  region: string;
  port: number;
  signerId: string;
  version: string;
}

interface SignApprovalResponse {
  signerPubkey: string;
  signature: string;
  signerId: string;
  region: string;
  port: number;
  signedAt: number;
  requestId: string;
}

// ───────────────────────────────────────────────────────────────────────────
// fetch helper with abort + timeout
// ───────────────────────────────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// getSignerInfos — health probe with 1.5s timeout
// ───────────────────────────────────────────────────────────────────────────

export async function getSignerInfos(
  ports: readonly number[] = DEFAULT_SIGNER_PORTS,
  host: string = DEFAULT_HOST,
): Promise<SignerInfo[]> {
  const probes = ports.map(async (port, idx): Promise<SignerInfo> => {
    const baseUrl = resolveSignerBaseUrl(idx, port, host);
    try {
      const res = await fetchWithTimeout(
        `${baseUrl}/info`,
        { method: 'GET' },
        HEALTH_TIMEOUT_MS,
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as SignerInfoResponse;
      return {
        pubkey: data.pubkey,
        region: data.region,
        port: data.port,
        signerId: data.signerId,
        version: data.version,
        online: true,
      };
    } catch {
      return {
        pubkey: '',
        region: regionForPort(port),
        port,
        signerId: `signer-${port}`,
        version: '',
        online: false,
      };
    }
  });

  return Promise.all(probes);
}

// ───────────────────────────────────────────────────────────────────────────
// requestThresholdApproval — fan out, return when threshold met OR all done
// ───────────────────────────────────────────────────────────────────────────

export async function requestThresholdApproval(
  txHashHex: string,
  threshold: number = DEFAULT_THRESHOLD,
  ports: readonly number[] = DEFAULT_SIGNER_PORTS,
  host: string = DEFAULT_HOST,
): Promise<ThresholdApproval> {
  const requestId = generateRequestId();
  const body = JSON.stringify({ txHashHex, requestId });

  const promises = ports.map((port, idx) =>
    fetchWithTimeout(
      `${resolveSignerBaseUrl(idx, port, host)}/sign-approval`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      },
      SIGN_TIMEOUT_MS,
    )
      .then(async (res): Promise<SignerSignature> => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as SignApprovalResponse;
        return {
          signerPubkey: data.signerPubkey,
          signerId: data.signerId,
          region: data.region,
          port: data.port,
          signature: data.signature,
          signedAt: data.signedAt,
        };
      }),
  );

  const settled = await Promise.allSettled(promises);
  const signatures: SignerSignature[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') signatures.push(result.value);
  }

  return {
    txHashHex,
    requestId,
    signatures,
    threshold,
    totalSigners: ports.length,
    aggregatedAt: Date.now(),
    thresholdReached: signatures.length >= threshold,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function generateRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback (very unlikely in modern browsers/node)
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function generateTxHashHex(): string {
  const bytes = new Uint8Array(32);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function regionForPort(port: number): string {
  switch (port) {
    case 4001:
      return 'US-EAST';
    case 4002:
      return 'EU-WEST';
    case 4003:
      return 'APAC';
    default:
      return 'UNKNOWN';
  }
}

export function regionLabelForPort(port: number): string {
  return regionForPort(port);
}
