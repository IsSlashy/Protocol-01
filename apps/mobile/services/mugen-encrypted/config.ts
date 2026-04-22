// ═══════════════════════════════════════════════════════════════════════════
// Base URL configuration for the encrypted Mugen backend HTTP client.
//
// Reads `process.env.EXPO_PUBLIC_MUGEN_API_URL` at module load time (Expo
// inlines EXPO_PUBLIC_* env vars into the bundle). Defaults to localhost for
// local dev. The setter lets tests / debug UIs override at runtime.
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_BASE_URL = 'http://localhost:3001';

function readEnvBaseUrl(): string {
  const fromEnv =
    typeof process !== 'undefined' &&
    typeof process.env !== 'undefined' &&
    typeof process.env.EXPO_PUBLIC_MUGEN_API_URL === 'string'
      ? process.env.EXPO_PUBLIC_MUGEN_API_URL
      : undefined;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_BASE_URL;
}

let currentBaseUrl: string = readEnvBaseUrl();

/** Returns the active Mugen API base URL with any trailing slash stripped. */
export function getMugenApiBaseUrl(): string {
  return currentBaseUrl.replace(/\/+$/, '');
}

/** Override the Mugen API base URL (useful for tests, preview builds). */
export function setMugenApiBaseUrl(url: string): void {
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('setMugenApiBaseUrl: url must be a non-empty string');
  }
  currentBaseUrl = url;
}

/** Reset to the value from `EXPO_PUBLIC_MUGEN_API_URL` (or default). */
export function resetMugenApiBaseUrl(): void {
  currentBaseUrl = readEnvBaseUrl();
}
