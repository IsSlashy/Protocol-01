// ═══════════════════════════════════════════════════════════════════════════
// Barrel for the encrypted Mugen HTTP client.
// ═══════════════════════════════════════════════════════════════════════════

export * from './types';
export {
  getMugenApiBaseUrl,
  setMugenApiBaseUrl,
  resetMugenApiBaseUrl,
} from './config';
export {
  MugenEncryptedClient,
  MugenApiError,
  type MugenApiErrorCode,
  type MugenApiErrorMeta,
  type MugenEncryptedClientOptions,
} from './client';

import { MugenEncryptedClient } from './client';

let _singleton: MugenEncryptedClient | null = null;

/** Lazy-create a process-wide `MugenEncryptedClient`. */
export function getMugenEncryptedClient(): MugenEncryptedClient {
  if (_singleton === null) {
    _singleton = new MugenEncryptedClient();
  }
  return _singleton;
}

/** For tests — drop the cached singleton so the next call re-reads config. */
export function resetMugenEncryptedClient(): void {
  _singleton = null;
}
