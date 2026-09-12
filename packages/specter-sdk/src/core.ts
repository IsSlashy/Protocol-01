// ============================================================================
// Protocol 01 SDK — `core` entrypoint (browser / worker safe)
// ============================================================================
//
// Everything the stealth key-derivation path needs, WITHOUT the `./proving`
// module. The STARK prover (`@protocol-01/stark-prover`) does a Node-only
// `await import('fs/promises')`, which breaks browser bundlers
// (Next/turbopack, Vite). The stealth path never uses the prover, so
// apps/web + apps/extension import from `@protocol-01/specter-sdk/core`
// instead of the package root.
//
// Only re-exports modules verified free of `./proving` and node builtins:
// constants, types, wallet, stealth, transfer, utils, registry, quantum.
// Excluded (pull the prover or heavier deps not needed for discovery):
// client, indexing, subscription, proving, relay, service-registry.
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
