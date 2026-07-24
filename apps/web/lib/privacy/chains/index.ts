/**
 * Re-export of the framework-agnostic adapter registry.
 *
 * The registry (ADAPTERS, CHAINS, ALL_ASSETS, getAdapter, activeSolanaAdapter)
 * now lives in `@protocol-01/pay-core` so it is shared with apps/extension.
 * This barrel keeps the existing `@/lib/privacy/chains` import path working.
 */

export * from '@protocol-01/pay-core';
