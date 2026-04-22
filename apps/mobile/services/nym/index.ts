/**
 * Nym mixnet — mobile barrel.
 *
 * Current state: scaffolding only. `nymFetch` falls back to plain `fetch`
 * and reports `viaMixnet: false`. See `./WebViewPlan.md` for the Phase 2
 * implementation plan using a hidden WebView (same pattern as the STARK
 * prover in `services/stark/`).
 */

export type {
  NymFetchOptions,
  NymFetchResult,
  NymInitState,
  NymMetadata,
  NymStateListener,
  NymStrategy,
} from './types';

export {
  getNymState,
  initNym,
  nymFetch,
  onNymStateChange,
  resetNym,
} from './client';
