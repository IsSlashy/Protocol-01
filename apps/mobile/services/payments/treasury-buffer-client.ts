// ═══════════════════════════════════════════════════════════════════════════
// Treasury Buffer Client
//
// Thin typed wrapper around the Mugen backend's `/api/treasury/*` endpoints.
// Used by the mobile MoonPay buy flow to pre-register a routing entry BEFORE
// opening the MoonPay widget:
//
//   1. Mobile generates a stealth address (final recipient).
//   2. Mobile calls `registerTreasuryRoute(...)` — backend spins up / reuses
//      a buffer wallet and schedules a randomized-delay forwarding job.
//   3. Mobile opens MoonPay with `walletAddress = bufferAddress` (NOT the
//      stealth address — MoonPay only ever sees the buffer).
//   4. After the user returns from MoonPay, mobile polls
//      `getTreasuryRouteStatus(id)` every ~10 s to show funding → forwarding
//      → paid progress in the UI.
//
// Error contract: re-uses `MugenApiError` from `services/mugen-encrypted`
// so callers can share a single error-handling branch. Each request has a
// 10-second AbortController timeout.
// ═══════════════════════════════════════════════════════════════════════════

import { getMugenApiBaseUrl } from '../mugen-encrypted/config';
import {
  MugenApiError,
  type MugenApiErrorCode,
} from '../mugen-encrypted/client';

const DEFAULT_TIMEOUT_MS = 10_000;

// ─── Types ─────────────────────────────────────────────────────────────────

export type TreasuryRouteStatus =
  | 'pending'
  | 'funded'
  | 'paid'
  | 'failed'
  | 'expired';

export interface TreasuryBufferRoute {
  id: string;
  bufferAddress: string;
  /** ms epoch of planned forwarding. */
  scheduledPayoutAt: number;
}

export interface TreasuryCohortInfo {
  /** Configured floor — N concurrent ready routes required before release. */
  minCohortSize: number;
  /** Funded + scheduled-time-passed routes currently in the cohort. */
  cohortCandidatesCount: number;
  /** True when the next runner pass would release the cohort. */
  cohortReady: boolean;
  /** Hard deadline (ms epoch) after which gate is bypassed for this route. */
  cohortGateExpiry: number;
  /** Convenience — ms remaining on this route's deadline. */
  cohortWaitMsRemaining: number;
}

export interface TreasuryBufferStatus {
  id: string;
  status: TreasuryRouteStatus;
  bufferAddress: string;
  destStealthAddress: string;
  scheduledPayoutAt: number;
  fundingTx?: string;
  payoutTx?: string;
  failureReason?: string;
  /** Present when the backend is gating this route on k-anonymity. */
  cohort?: TreasuryCohortInfo;
}

interface RegisterRouteArgs {
  /** Major units (e.g. 100 for 100 EUR). NOT cents — matches backend spec. */
  fiatAmount: number;
  fiatCurrency: 'EUR' | 'USD';
  destStealthAddress: string;
  /** Expected lamports the on-ramp will send. Approximate is OK. */
  expectedSolAmount: number;
}

// ─── Internal fetch helper ─────────────────────────────────────────────────

async function fetchJson<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<T> {
  const base = getMugenApiBaseUrl();
  const url = `${base}${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers:
        init.body !== undefined
          ? { 'content-type': 'application/json', accept: 'application/json' }
          : { accept: 'application/json' },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted =
      (err instanceof Error && err.name === 'AbortError') ||
      controller.signal.aborted;
    if (aborted) {
      throw new MugenApiError(
        `Treasury request to ${path} timed out after ${DEFAULT_TIMEOUT_MS}ms`,
        { status: 0, code: 'TIMEOUT', detail: String(err) },
      );
    }
    throw new MugenApiError(
      `Network error calling treasury ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      {
        status: 0,
        code: 'NETWORK_ERROR',
        detail: err instanceof Error ? err.message : String(err),
      },
    );
  }
  clearTimeout(timer);

  const text = await response.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new MugenApiError(
        `Non-JSON response from treasury ${path} (status ${response.status})`,
        {
          status: response.status,
          code: 'BAD_RESPONSE',
          detail: text.slice(0, 500),
        },
      );
    }
  }

  if (!response.ok) {
    const err = (parsed ?? {}) as { error?: unknown; detail?: unknown };
    const code: MugenApiErrorCode = `HTTP_${response.status}` as MugenApiErrorCode;
    throw new MugenApiError(
      typeof err.error === 'string'
        ? err.error
        : `HTTP ${response.status} from treasury ${path}`,
      {
        status: response.status,
        code,
        detail: typeof err.detail === 'string' ? err.detail : undefined,
        raw: parsed,
      },
    );
  }

  return parsed as T;
}

export interface TreasuryHealth {
  bufferAddress: string;
  bufferBalanceLamports: number;
  minBalanceLamports: number;
  healthy: boolean;
  reason?: string;
  lastTickAt: number | null;
  lastPayoutAt: number | null;
  queue: Record<TreasuryRouteStatus, number>;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Pre-register a MoonPay payout with the Treasury Buffer. The returned
 * `bufferAddress` MUST be used as the MoonPay `walletAddress`, NOT the
 * user's stealth address.
 */
export async function registerTreasuryRoute(
  args: RegisterRouteArgs,
): Promise<TreasuryBufferRoute> {
  if (!(args.fiatAmount > 0)) {
    throw new MugenApiError('fiatAmount must be > 0', {
      status: 0,
      code: 'BAD_RESPONSE',
    });
  }
  if (args.fiatCurrency !== 'EUR' && args.fiatCurrency !== 'USD') {
    throw new MugenApiError("fiatCurrency must be 'EUR' or 'USD'", {
      status: 0,
      code: 'BAD_RESPONSE',
    });
  }
  if (
    typeof args.destStealthAddress !== 'string' ||
    args.destStealthAddress.length < 32
  ) {
    throw new MugenApiError('destStealthAddress must be a base58 pubkey', {
      status: 0,
      code: 'BAD_RESPONSE',
    });
  }
  if (!(args.expectedSolAmount > 0)) {
    throw new MugenApiError('expectedSolAmount must be > 0 (lamports)', {
      status: 0,
      code: 'BAD_RESPONSE',
    });
  }

  return fetchJson<TreasuryBufferRoute>('/api/treasury/register-route', {
    method: 'POST',
    body: {
      sourceFrom: 'moonpay',
      fiatAmount: args.fiatAmount,
      fiatCurrency: args.fiatCurrency,
      destStealthAddress: args.destStealthAddress,
      expectedSolAmount: args.expectedSolAmount,
    },
  });
}

/**
 * Poll for the current status of a registered treasury route.
 *
 * The backend wraps its response as `{ route: BufferRoutingEntry }`. We
 * unwrap here so callers see a flat shape.
 */
export async function getTreasuryRouteStatus(
  id: string,
): Promise<TreasuryBufferStatus> {
  if (typeof id !== 'string' || id.length === 0) {
    throw new MugenApiError('route id must be a non-empty string', {
      status: 0,
      code: 'BAD_RESPONSE',
    });
  }
  const resp = await fetchJson<{ route: TreasuryBufferStatus }>(
    `/api/treasury/status/${encodeURIComponent(id)}`,
    { method: 'GET' },
  );
  if (!resp || typeof resp !== 'object' || !('route' in resp) || !resp.route) {
    throw new MugenApiError('Malformed treasury status response (no route)', {
      status: 0,
      code: 'BAD_RESPONSE',
      raw: resp,
    });
  }
  return resp.route;
}

/**
 * Probe the buffer wallet's liveness. Returns `{ healthy: false, reason }`
 * when the buffer is unfunded or the runner has stopped ticking. Mobile
 * callers should treat any thrown error as `healthy: false` and fall back
 * to direct stealth payout.
 */
export async function getTreasuryHealth(): Promise<TreasuryHealth> {
  return fetchJson<TreasuryHealth>('/api/treasury/health', { method: 'GET' });
}
