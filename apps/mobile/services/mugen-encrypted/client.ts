// ═══════════════════════════════════════════════════════════════════════════
// MugenEncryptedClient — typed HTTP wrapper over the encrypted Mugen backend.
//
// - Uses native fetch (RN 0.81 / Expo 54).
// - Per-request AbortController with a configurable timeout.
// - All errors surface as `MugenApiError` with a structured `code`:
//     THRESHOLD_REJECTED     — 409, FROST signers didn't reach threshold
//     COORDINATOR_UNREACHABLE — 503, FROST coordinator down
//     NETWORK_ERROR          — fetch threw (offline, DNS, etc.)
//     TIMEOUT                — AbortController fired
//     BAD_RESPONSE           — non-JSON body where JSON expected
//     HTTP_<status>          — any other non-2xx
//   along with `status`, `detail`, and optional `threshold` / `signers` meta.
// ═══════════════════════════════════════════════════════════════════════════

import { getMugenApiBaseUrl } from './config';
import type {
  BlindTakeRequest,
  BlindTakeResponse,
  CancelResponse,
  ClaimMatchResponse,
  ConfirmPaymentResponse,
  DisputeResponse,
  EncryptedOfferRequest,
  EncryptedOfferSuccess,
  EscrowStatusResponse,
  MpcApiError,
  MyOrderResponse,
  PrivateMatchesFeedResponse,
  ReleaseEscrowResponse,
  ThresholdMetaFailure,
} from './types';

// Default per-request timeouts (ms). MPC round-trips can be slow; plain reads
// should fail fast so the UI stays responsive.
const DEFAULT_MPC_TIMEOUT_MS = 15_000;
const DEFAULT_READ_TIMEOUT_MS = 5_000;

export type MugenApiErrorCode =
  | 'THRESHOLD_REJECTED'
  | 'COORDINATOR_UNREACHABLE'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'BAD_RESPONSE'
  | `HTTP_${number}`;

export interface MugenApiErrorMeta {
  status: number;
  code: MugenApiErrorCode;
  detail?: string;
  signers?: { region: string; port: number }[];
  threshold?: ThresholdMetaFailure;
  raw?: unknown;
}

export class MugenApiError extends Error {
  readonly status: number;
  readonly code: MugenApiErrorCode;
  readonly detail?: string;
  readonly signers?: { region: string; port: number }[];
  readonly threshold?: ThresholdMetaFailure;
  readonly raw?: unknown;

  constructor(message: string, meta: MugenApiErrorMeta) {
    super(message);
    this.name = 'MugenApiError';
    this.status = meta.status;
    this.code = meta.code;
    this.detail = meta.detail;
    this.signers = meta.signers;
    this.threshold = meta.threshold;
    this.raw = meta.raw;
  }
}

interface RequestOptions {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  timeoutMs?: number;
  query?: Record<string, string>;
}

export interface MugenEncryptedClientOptions {
  baseUrl?: string;
  mpcTimeoutMs?: number;
  readTimeoutMs?: number;
}

export class MugenEncryptedClient {
  private readonly baseUrlOverride?: string;
  private readonly mpcTimeoutMs: number;
  private readonly readTimeoutMs: number;

  constructor(baseUrlOrOptions?: string | MugenEncryptedClientOptions) {
    if (typeof baseUrlOrOptions === 'string') {
      this.baseUrlOverride = baseUrlOrOptions;
      this.mpcTimeoutMs = DEFAULT_MPC_TIMEOUT_MS;
      this.readTimeoutMs = DEFAULT_READ_TIMEOUT_MS;
    } else {
      this.baseUrlOverride = baseUrlOrOptions?.baseUrl;
      this.mpcTimeoutMs = baseUrlOrOptions?.mpcTimeoutMs ?? DEFAULT_MPC_TIMEOUT_MS;
      this.readTimeoutMs = baseUrlOrOptions?.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    }
  }

  private resolveBaseUrl(): string {
    const base = this.baseUrlOverride ?? getMugenApiBaseUrl();
    return base.replace(/\/+$/, '');
  }

  private async request<T>(opts: RequestOptions): Promise<T> {
    const base = this.resolveBaseUrl();
    const qs = opts.query
      ? '?' +
        Object.entries(opts.query)
          .map(
            ([k, v]) =>
              `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
          )
          .join('&')
      : '';
    const url = `${base}${opts.path}${qs}`;

    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? this.mpcTimeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: opts.method,
        headers:
          opts.body !== undefined
            ? { 'content-type': 'application/json', accept: 'application/json' }
            : { accept: 'application/json' },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted =
        (err instanceof Error && err.name === 'AbortError') ||
        controller.signal.aborted;
      if (aborted) {
        throw new MugenApiError(`Request to ${opts.path} timed out after ${timeoutMs}ms`, {
          status: 0,
          code: 'TIMEOUT',
          detail: String(err),
        });
      }
      throw new MugenApiError(
        `Network error calling ${opts.path}: ${err instanceof Error ? err.message : String(err)}`,
        {
          status: 0,
          code: 'NETWORK_ERROR',
          detail: err instanceof Error ? err.message : String(err),
        },
      );
    }
    clearTimeout(timer);

    // Parse body once; the server always returns JSON (even for errors).
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new MugenApiError(
          `Non-JSON response from ${opts.path} (status ${response.status})`,
          {
            status: response.status,
            code: 'BAD_RESPONSE',
            detail: text.slice(0, 500),
          },
        );
      }
    }

    if (!response.ok) {
      const err = (parsed ?? {}) as Partial<MpcApiError>;
      let code: MugenApiErrorCode;
      if (response.status === 409) {
        code = 'THRESHOLD_REJECTED';
      } else if (response.status === 503) {
        code = 'COORDINATOR_UNREACHABLE';
      } else {
        code = `HTTP_${response.status}` as MugenApiErrorCode;
      }
      throw new MugenApiError(
        typeof err.error === 'string'
          ? err.error
          : `HTTP ${response.status} from ${opts.path}`,
        {
          status: response.status,
          code,
          detail: typeof err.detail === 'string' ? err.detail : undefined,
          signers: err.signers,
          threshold: err.threshold,
          raw: parsed,
        },
      );
    }

    return parsed as T;
  }

  // ─── Orders ───────────────────────────────────────────────────────────────
  async submitEncryptedOffer(
    input: EncryptedOfferRequest,
  ): Promise<EncryptedOfferSuccess> {
    return this.request<EncryptedOfferSuccess>({
      method: 'POST',
      path: '/api/orders/encrypted',
      body: input,
      timeoutMs: this.mpcTimeoutMs,
    });
  }

  async cancelEncryptedOrder(makerNoncePubkey: string): Promise<CancelResponse> {
    return this.request<CancelResponse>({
      method: 'POST',
      path: '/api/orders/cancel-encrypted',
      body: { makerNoncePubkey },
      timeoutMs: this.mpcTimeoutMs,
    });
  }

  async lookupMyOrder(makerNoncePubkey: string): Promise<MyOrderResponse> {
    return this.request<MyOrderResponse>({
      method: 'POST',
      path: '/api/orders/mine',
      body: { makerNoncePubkey },
      timeoutMs: this.readTimeoutMs,
    });
  }

  // ─── Trade ────────────────────────────────────────────────────────────────
  async blindTake(input: BlindTakeRequest): Promise<BlindTakeResponse> {
    return this.request<BlindTakeResponse>({
      method: 'POST',
      path: '/api/trade/blind-take',
      body: input,
      timeoutMs: this.mpcTimeoutMs,
    });
  }

  async claimMatch(input: {
    takerNoncePubkey: string;
    matchedMakerNonce: string;
    takerWallet: string;
  }): Promise<ClaimMatchResponse> {
    return this.request<ClaimMatchResponse>({
      method: 'POST',
      path: '/api/trade/claim-match',
      body: input,
      timeoutMs: this.mpcTimeoutMs,
    });
  }

  async getEscrowStatus(escrowPDA: string): Promise<EscrowStatusResponse> {
    return this.request<EscrowStatusResponse>({
      method: 'GET',
      path: '/api/trade/escrow-status',
      query: { escrowPDA },
      timeoutMs: this.readTimeoutMs,
    });
  }

  async confirmPayment(input: {
    escrowPDA: string;
    as: 'taker' | 'maker';
  }): Promise<ConfirmPaymentResponse> {
    return this.request<ConfirmPaymentResponse>({
      method: 'POST',
      path: '/api/trade/confirm-payment',
      body: input,
      timeoutMs: this.mpcTimeoutMs,
    });
  }

  async releaseEscrow(input: {
    escrowPDA: string;
  }): Promise<ReleaseEscrowResponse> {
    return this.request<ReleaseEscrowResponse>({
      method: 'POST',
      path: '/api/trade/release-escrow',
      body: input,
      timeoutMs: this.mpcTimeoutMs,
    });
  }

  async dispute(input: {
    escrowPDA: string;
    as: 'taker' | 'maker';
    reason: number;
  }): Promise<DisputeResponse> {
    return this.request<DisputeResponse>({
      method: 'POST',
      path: '/api/trade/dispute',
      body: input,
      timeoutMs: this.mpcTimeoutMs,
    });
  }

  // ─── Activity ─────────────────────────────────────────────────────────────
  async listPrivateMatches(): Promise<PrivateMatchesFeedResponse> {
    return this.request<PrivateMatchesFeedResponse>({
      method: 'GET',
      path: '/api/activity/private-matches',
      timeoutMs: this.readTimeoutMs,
    });
  }
}
