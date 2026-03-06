/**
 * Relayer Client Module for Protocol 01
 *
 * DEPRECATED: This module uses a centralized HTTP relayer which has been replaced
 * by the on-chain p01_relayer program. Use @p01/specter-sdk relay module for
 * on-chain relay via the p01_relayer program instead.
 *
 * This file is retained for backward compatibility with external consumers.
 *
 * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
 * @module relayer-client
 */

// ============ Types ============

/**
 * Configuration for the relayer client.
 * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
 */
export interface RelayerConfig {
  /** Base URL of the relayer service */
  url: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Maximum number of retry attempts for failed requests (default: 3) */
  maxRetries?: number;
}

/**
 * Status information from the relayer service.
 * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
 */
export interface RelayerStatus {
  /** Whether the relayer is online and processing transactions */
  online: boolean;
  /** List of supported token mint addresses */
  supportedTokens: string[];
  /** Fee percentage charged by the relayer (e.g., 1.0 = 1%) */
  feePercent: number;
  /** Relayer software version */
  version: string;
}

/**
 * Parameters for submitting an unshield request to the relayer.
 * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
 */
export interface UnshieldRequest {
  /** Groth16 proof (pi_a, pi_b, pi_c) */
  proof: {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
  };
  /** Public signals (decimal strings): [merkle_root, nullifier, min_epoch, token_mint] */
  publicSignals: string[];
  /** Base58-encoded recipient address */
  recipient: string;
  /** Base58-encoded pool PDA address */
  pool: string;
}

/**
 * Response from a successful unshield submission.
 * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
 */
export interface UnshieldResponse {
  /** Base58-encoded transaction signature */
  signature: string;
  /** Status of the transaction */
  status: 'submitted' | 'confirmed' | 'finalized';
  /** Timestamp of submission (Unix ms) */
  timestamp: number;
  /** Fee deducted (in token base units) */
  fee?: number;
}

/**
 * Error response from the relayer.
 * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
 */
export interface RelayerError {
  /** Error code */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Additional error details */
  details?: unknown;
}

// ============ Constants ============

/** Default request timeout (30 seconds) */
const DEFAULT_TIMEOUT = 30_000;

/** Default maximum retries */
const DEFAULT_MAX_RETRIES = 3;

/** Maximum backoff delay (5 minutes) */
const MAX_BACKOFF_MS = 5 * 60 * 1000;

/** Base backoff delay (1 second) */
const BASE_BACKOFF_MS = 1_000;

// ============ RelayerClient ============

/**
 * Client for communicating with Protocol 01 relayer services.
 *
 * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program.
 * This HTTP-based relayer client is no longer the recommended approach.
 *
 * @example
 * ```typescript
 * // DEPRECATED - prefer on-chain relay via specter-sdk
 * const relayer = new RelayerClient({
 *   url: 'https://your-relayer-url.example.com',
 *   timeout: 30000,
 *   maxRetries: 3,
 * });
 * ```
 */
export class RelayerClient {
  private readonly url: string;
  private readonly timeout: number;
  private readonly maxRetries: number;

  /**
   * Create a new RelayerClient.
   *
   * @param config - Relayer connection configuration
   */
  constructor(config: RelayerConfig) {
    if (!config.url) {
      throw new Error('RelayerClient requires a url in the config.');
    }

    // Normalize URL (remove trailing slash)
    this.url = config.url.replace(/\/+$/, '');
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  // ============ Public Methods ============

  /**
   * Get the relayer service status.
   *
   * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
   * @returns RelayerStatus with online state, supported tokens, fee, and version
   * @throws Error if the relayer is unreachable
   */
  async getStatus(): Promise<RelayerStatus> {
    const response = await this.fetchWithRetry<RelayerStatus>(
      '/status',
      { method: 'GET' }
    );
    return response;
  }

  /**
   * Submit an unshield (withdrawal) request to the relayer.
   *
   * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
   *
   * The relayer will:
   * 1. Verify the ZK proof locally
   * 2. Check that the nullifier hasn't been spent
   * 3. Submit the unshield transaction on-chain
   * 4. Return the transaction signature
   *
   * @param params - Unshield request parameters
   * @returns Base58-encoded transaction signature
   * @throws Error if proof is invalid, nullifier is spent, or submission fails
   */
  async submitUnshield(params: UnshieldRequest): Promise<string> {
    // Validate required fields
    if (!params.proof) throw new Error('proof is required');
    if (!params.publicSignals || params.publicSignals.length === 0) {
      throw new Error('publicSignals are required');
    }
    if (!params.recipient) throw new Error('recipient address is required');
    if (!params.pool) throw new Error('pool address is required');

    const response = await this.fetchWithRetry<UnshieldResponse>(
      '/unshield',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proof: params.proof,
          publicSignals: params.publicSignals,
          recipient: params.recipient,
          pool: params.pool,
        }),
      }
    );

    return response.signature;
  }

  /**
   * Estimate the relayer fee for a given denomination.
   *
   * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
   * @param denomination - Pool denomination (1, 10, 100, or 1000)
   * @returns Estimated fee in token base units
   * @throws Error if the relayer is unreachable
   */
  async estimateFee(denomination: number): Promise<number> {
    try {
      const status = await this.getStatus();
      // Fee is a percentage of the denomination
      return Math.ceil(denomination * (status.feePercent / 100) * 1_000_000); // Convert to base units (6 decimals for USDC)
    } catch (error: any) {
      throw new Error(`Failed to estimate fee: ${error?.message || 'Relayer unreachable'}`);
    }
  }

  /**
   * Check if a specific nullifier has already been spent.
   *
   * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program.
   * Nullifier checks are now performed on-chain via p01_trustless nullifier PDAs.
   * @param nullifier - Hex-encoded nullifier to check
   * @param pool - Base58-encoded pool PDA address
   * @returns true if the nullifier has been spent
   */
  async isNullifierSpent(nullifier: string, pool: string): Promise<boolean> {
    try {
      const response = await this.fetchWithRetry<{ spent: boolean }>(
        `/nullifier/${pool}/${nullifier}`,
        { method: 'GET' }
      );
      return response.spent;
    } catch {
      // If the endpoint doesn't exist or fails, assume we can't check
      // The on-chain program will reject double-spends regardless
      return false;
    }
  }

  /**
   * Get the relayer's base URL.
   * @deprecated Use @p01/specter-sdk relay module for on-chain relay via p01_relayer program
   */
  getUrl(): string {
    return this.url;
  }

  // ============ Private Methods ============

  /**
   * Fetch with retry and exponential backoff.
   *
   * Retry strategy: 1s, 2s, 4s, 8s, ... up to MAX_BACKOFF_MS (5 min).
   * Only retries on network errors and 5xx server errors.
   * Does not retry on 4xx client errors (bad request, invalid proof, etc.).
   *
   * @param path - URL path (appended to base URL)
   * @param init - Fetch RequestInit options
   * @returns Parsed JSON response
   */
  private async fetchWithRetry<T>(
    path: string,
    init: RequestInit
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.fetchWithTimeout(
          `${this.url}${path}`,
          init
        );

        // Don't retry on client errors (4xx)
        if (response.status >= 400 && response.status < 500) {
          let errorData: RelayerError;
          try {
            errorData = await response.json();
          } catch {
            errorData = {
              code: `HTTP_${response.status}`,
              message: response.statusText || `HTTP ${response.status}`,
            };
          }
          throw new Error(
            `Relayer error (${errorData.code}): ${errorData.message}`
          );
        }

        // Retry on server errors (5xx)
        if (response.status >= 500) {
          throw new Error(`Relayer server error: HTTP ${response.status}`);
        }

        // Success - parse response
        const data = await response.json();
        return data as T;
      } catch (error: any) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on client errors
        if (lastError.message.includes('Relayer error')) {
          throw lastError;
        }

        // If we have retries left, wait with exponential backoff
        if (attempt < this.maxRetries) {
          const backoffMs = Math.min(
            BASE_BACKOFF_MS * Math.pow(2, attempt),
            MAX_BACKOFF_MS
          );
          await this.sleep(backoffMs);
        }
      }
    }

    throw new Error(
      `Relayer request failed after ${this.maxRetries + 1} attempts: ${lastError?.message || 'Unknown error'}`
    );
  }

  /**
   * Fetch with timeout using AbortController.
   *
   * @param url - Full URL to fetch
   * @param init - Fetch RequestInit options
   * @returns Fetch Response
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      return response;
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw new Error(
          `Relayer request timed out after ${this.timeout}ms. ` +
          'The relayer may be overloaded or unreachable.'
        );
      }
      throw new Error(
        `Network error connecting to relayer at ${this.url}: ${error?.message || 'Connection failed'}`
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Sleep for a duration (used for backoff).
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
