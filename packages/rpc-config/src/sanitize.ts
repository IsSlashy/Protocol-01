/**
 * URL sanitization & validation helpers for RPC endpoints.
 */

/**
 * Redact API keys / tokens from an RPC URL so it is safe for logging.
 *
 * Handles both query-param keys (`?api-key=SECRET`) and path-segment
 * tokens (`https://provider.com/v1/SECRET`).
 */
export function sanitizeRpcUrl(url: string): string {
  try {
    const u = new URL(url);

    // Mask query-param secrets (common patterns: api-key, api_key, apiKey, token, key)
    const sensitiveParams = ['api-key', 'api_key', 'apiKey', 'token', 'key'];
    for (const p of sensitiveParams) {
      if (u.searchParams.has(p)) {
        u.searchParams.set(p, '***');
      }
    }

    // Mask long path segments that look like API keys (32+ hex/base58 chars)
    const parts = u.pathname.split('/');
    const masked = parts.map((seg) =>
      /^[A-Za-z0-9_-]{32,}$/.test(seg) ? '***' : seg,
    );
    u.pathname = masked.join('/');

    return u.toString();
  } catch {
    // If URL parsing fails, just mask anything after common key patterns
    return url
      .replace(/(api-key=)[^&]+/gi, '$1***')
      .replace(/(api_key=)[^&]+/gi, '$1***')
      .replace(/(token=)[^&]+/gi, '$1***');
  }
}

/**
 * Validate that an RPC endpoint URL uses HTTPS (or is localhost / 127.0.0.1).
 *
 * Throws an `Error` if the URL is not acceptable.
 */
export function validateRpcEndpoint(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid RPC URL: ${url}`);
  }

  const isLocalhost =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '::1';

  if (!isLocalhost && parsed.protocol !== 'https:' && parsed.protocol !== 'wss:') {
    throw new Error(
      `RPC URL must use HTTPS (got ${parsed.protocol}). Only localhost is allowed over HTTP. URL: ${sanitizeRpcUrl(url)}`,
    );
  }
}
