// ============================================================================
// Protocol 01 SDK — `core` entrypoint (browser / worker safe)
// ============================================================================
//
// Everything the stealth key-derivation path needs, and nothing heavier:
// apps/web + apps/extension import from `@protocol-01/specter-sdk/core`
// instead of the package root to keep browser bundles small.
//
// Only re-exports modules verified free of node builtins:
// constants, types, wallet, stealth, transfer, utils, registry, quantum.
// Excluded (heavier deps not needed for discovery):
// client, indexing, subscription, relay, service-registry.
//
// [2026-09-23] The `./proving` module (the zkSPL client prover for circuits 2
// and 4, which inlined `@protocol-01/stark-prover` and its Node-only
// `fs/promises` import) was removed; this entry no longer needs to avoid it.
//
// [2026-09-13] `./stealth` no longer scans or announces anything on chain and
// `./transfer` is the plain transfer only: the `specter` program those paths
// targeted was closed on devnet on 2026-09-13.

export * from './constants';
export * from './types';
export * from './wallet';
export * from './stealth';
export * from './transfer';
export * from './utils';
export * from './registry';
export * from './quantum';
