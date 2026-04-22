/**
 * MoonPay Payments Service
 *
 * Production-grade MoonPay integration for the Protocol-01 mobile app.
 *
 * Design notes:
 * - We do NOT depend on `@moonpay/moonpay-react-native-sdk` (that package
 *   targets React web via `react-native-web`; on bare Expo/RN it pulls DOM
 *   APIs that break the bundler). The officially supported mobile path per
 *   MoonPay docs is "signed URL → WebView", which is what we implement.
 * - The payout destination is always a freshly-derived stealth address
 *   (ML-KEM-768 / ECDH), never the user's main wallet. The autoShield
 *   runner picks up arrivals and shields them into the denominated pool.
 * - HMAC-SHA256 signing is done with `@noble/hashes` (already in the
 *   mobile deps) so it works identically on Hermes, JSC, and Node (tests).
 * - Secret key source: `EXPO_PUBLIC_MOONPAY_SECRET_KEY`. If missing we log
 *   a warning and omit the signature — sandbox still accepts unsigned URLs,
 *   but production MUST have it set. We also support a server-side signing
 *   fallback (see `signMoonPayUrlRemote`) for when the secret must never
 *   ship in the app bundle.
 */

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export type MoonPayMode = 'sandbox' | 'live';

export type MoonPayFiatCurrency = 'EUR' | 'USD' | 'GBP';
export type MoonPayCryptoCurrency = 'sol' | 'usdc';

export interface MoonPayConfig {
  mode: MoonPayMode;
  apiKey: string;
  /** Override the widget base URL (defaults to the official live/sandbox URL). */
  baseUrl?: string;
  /** Optional HMAC secret (sk_*). If absent, URL is returned unsigned. */
  secretKey?: string;
  /** Deep link for MoonPay to redirect to after completion. */
  redirectUrl?: string;
  /** Widget theming color (hex without '#'). */
  colorCode?: string;
  /** Two-letter language code (e.g. 'en', 'fr'). */
  language?: string;
}

export interface MoonPayBuyParams {
  fiatAmount: number;
  fiatCurrency: MoonPayFiatCurrency;
  cryptoCurrency: MoonPayCryptoCurrency;
  /** Payout destination — MUST be a freshly derived stealth address. */
  stealthAddress: string;
  /** Optional: pre-fills the KYC form. */
  userEmail?: string;
  /** Optional: lock the widget to this wallet address (anti-swap). */
  lockWalletAddress?: boolean;
  /** Optional: pass-through external transaction id for reconciliation. */
  externalTransactionId?: string;
}

export interface MoonPayBuyResult {
  /** Signed (or unsigned) URL to open in a WebView. */
  widgetUrl: string;
  /** UUID for tracking / callbacks. */
  sessionId: string;
  /** True when the returned URL carries an HMAC signature. */
  signed: boolean;
}

// ─── URL bases ─────────────────────────────────────────────────────────────

const LIVE_BASE_URL = 'https://buy.moonpay.com';
const SANDBOX_BASE_URL = 'https://buy-sandbox.moonpay.com';

function defaultBaseUrl(mode: MoonPayMode): string {
  return mode === 'live' ? LIVE_BASE_URL : SANDBOX_BASE_URL;
}

// ─── UUID v4 (RN-safe, no `crypto` dep) ────────────────────────────────────

function uuidv4(): string {
  // 16 random bytes from the global polyfill (react-native-get-random-values)
  const bytes = new Uint8Array(16);
  // globalThis.crypto.getRandomValues is provided by the RN polyfill already
  // imported at app startup. Falls back to Math.random if unavailable (tests).
  const g = globalThis as unknown as {
    crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array };
  };
  if (g.crypto?.getRandomValues) {
    g.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // v4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ─── HMAC signing ──────────────────────────────────────────────────────────

/**
 * HMAC-SHA256(secret, "?<query-string>") returned as Base64.
 *
 * MoonPay signs the entire query string INCLUDING the leading '?'.
 * The resulting signature is URL-encoded and appended as `&signature=...`.
 *
 * @param urlOrQuery Either the full widget URL or just the query portion.
 * @param secretKey  The MoonPay SK (sk_test_... or sk_live_...).
 */
export function signMoonPayUrl(urlOrQuery: string, secretKey: string): string {
  if (!secretKey) throw new Error('signMoonPayUrl: secretKey required');

  let query = urlOrQuery;
  const q = urlOrQuery.indexOf('?');
  if (q >= 0) query = urlOrQuery.slice(q); // includes the leading '?'
  if (!query.startsWith('?')) query = `?${query}`;

  const keyBytes = new TextEncoder().encode(secretKey);
  const msgBytes = new TextEncoder().encode(query);
  const mac = hmac(sha256, keyBytes, msgBytes);

  // Base64 (standard, not URL-safe — MoonPay expects the URL-encoded form).
  return bytesToBase64(mac);
}

function bytesToBase64(bytes: Uint8Array): string {
  // RN's JSC and Hermes both have `btoa`/`atob` polyfills via `expo`. For
  // test/node environments, fall back to Buffer if available.
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  const g = globalThis as unknown as {
    btoa?: (s: string) => string;
    Buffer?: { from: (s: string, enc: string) => { toString: (enc: string) => string } };
  };
  if (typeof g.btoa === 'function') return g.btoa(binary);
  if (g.Buffer) return g.Buffer.from(binary, 'binary').toString('base64');
  throw new Error('No base64 encoder available');
}

// ─── URL builder ───────────────────────────────────────────────────────────

/**
 * Build (and optionally sign) a MoonPay widget URL.
 *
 * The param order matters for the signature: we lock it with a sorted
 * URLSearchParams so signature generation + verification are deterministic.
 */
export function createMoonPayUrl(
  params: MoonPayBuyParams,
  config: MoonPayConfig,
): MoonPayBuyResult {
  if (!config.apiKey) throw new Error('createMoonPayUrl: MoonPay apiKey required');
  if (!params.stealthAddress) {
    throw new Error('createMoonPayUrl: stealthAddress required (must be a fresh payout address)');
  }
  if (!Number.isFinite(params.fiatAmount) || params.fiatAmount <= 0) {
    throw new Error('createMoonPayUrl: fiatAmount must be positive');
  }

  const sessionId = uuidv4();
  const base = config.baseUrl ?? defaultBaseUrl(config.mode);

  // Collect then sort params alphabetically — deterministic signing surface.
  const entries: [string, string][] = [
    ['apiKey', config.apiKey],
    ['currencyCode', params.cryptoCurrency],
    ['walletAddress', params.stealthAddress],
    ['baseCurrencyCode', params.fiatCurrency.toLowerCase()],
    ['baseCurrencyAmount', params.fiatAmount.toString()],
    ['externalTransactionId', params.externalTransactionId ?? sessionId],
  ];
  if (params.userEmail) entries.push(['email', params.userEmail]);
  if (params.lockWalletAddress) entries.push(['showWalletAddressForm', 'false']);
  if (config.redirectUrl) entries.push(['redirectURL', config.redirectUrl]);
  if (config.colorCode) entries.push(['colorCode', config.colorCode]);
  if (config.language) entries.push(['language', config.language]);

  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const qs = new URLSearchParams(entries).toString();
  const unsignedUrl = `${base}?${qs}`;

  if (!config.secretKey) {
    console.warn(
      '[MoonPay] No secret key configured — returning unsigned URL. ' +
        'Sandbox accepts unsigned; PRODUCTION will reject. Set ' +
        'EXPO_PUBLIC_MOONPAY_SECRET_KEY or sign server-side.',
    );
    return { widgetUrl: unsignedUrl, sessionId, signed: false };
  }

  const signature = signMoonPayUrl(`?${qs}`, config.secretKey);
  const widgetUrl = `${unsignedUrl}&signature=${encodeURIComponent(signature)}`;
  return { widgetUrl, sessionId, signed: true };
}

// ─── Env helper ────────────────────────────────────────────────────────────

/**
 * Load MoonPay config from Expo public env vars. Throws if the API key
 * is missing. The secret key is optional (unsigned sandbox works).
 */
export function loadMoonPayConfigFromEnv(): MoonPayConfig {
  const apiKey = process.env.EXPO_PUBLIC_MOONPAY_API_KEY;
  const secretKey = process.env.EXPO_PUBLIC_MOONPAY_SECRET_KEY;
  const mode = (process.env.EXPO_PUBLIC_MOONPAY_MODE ?? 'sandbox') as MoonPayMode;

  if (!apiKey) {
    throw new Error(
      'EXPO_PUBLIC_MOONPAY_API_KEY is not set. Add it to apps/mobile/.env ' +
        '(see .env.example).',
    );
  }
  if (mode !== 'sandbox' && mode !== 'live') {
    throw new Error(`Invalid EXPO_PUBLIC_MOONPAY_MODE: ${mode} (expected 'sandbox' | 'live')`);
  }
  // Live MoonPay rejects unsigned widget URLs. Refuse to build a config that
  // would silently fall through to an unsigned-URL warning at request time.
  if (mode === 'live' && !secretKey) {
    throw new Error(
      'EXPO_PUBLIC_MOONPAY_MODE=live requires EXPO_PUBLIC_MOONPAY_SECRET_KEY ' +
        '(or a server-side signer). Refusing to build an unsigned live URL.',
    );
  }

  return {
    mode,
    apiKey,
    secretKey,
    colorCode: '39c5bb',
    language: 'en',
  };
}
