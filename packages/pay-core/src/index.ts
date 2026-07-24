/**
 * @protocol-01/pay-core — framework-agnostic private-payment core.
 *
 * The single shared source of truth for the chain-pluggable stealth interface,
 * the canonical asset catalog, and the per-chain adapters. Consumed identically
 * by apps/web (Next 16) and apps/extension (Vite): NO Next- or Vite-specific
 * imports live here.
 *
 * Adding a chain — or flipping Starknet from `coming-soon` to `live` — is a
 * one-line change in this registry; no UI edits required.
 */

import type { ChainId, ChainStealthAdapter } from './types';
import { solanaAdapter } from './chains/solana';
import { starknetAdapter } from './chains/starknet';

/**
 * The active Solana adapter — the real specter-sdk-backed implementation
 * (secret-free; stealth crypto runs in worker/workerCore.ts). Kept as a named
 * indirection so an alternative implementation could swap in without UI edits.
 */
export const activeSolanaAdapter: ChainStealthAdapter = solanaAdapter;

export const ADAPTERS: Record<ChainId, ChainStealthAdapter> = {
  solana: activeSolanaAdapter,
  starknet: starknetAdapter,
};

export const CHAINS: ChainStealthAdapter[] = [ADAPTERS.solana, ADAPTERS.starknet];

export function getAdapter(id: ChainId): ChainStealthAdapter {
  return ADAPTERS[id];
}

// Re-export the interface/types, the canonical asset catalog, and the adapters.
export * from './types';
export * from './assets';
export {
  solanaAdapter,
  setSolanaWorkerClient,
  setSolanaSignerRuntime,
  configureSolanaWorkerCore,
  clearStealthSessions,
} from './chains/solana';
export {
  starknetAdapter,
  clearStarknetSessions,
  isStarknetConfigured,
} from './chains/starknet';
export type {
  SolanaWorkerClient,
  SolanaWorkerConfig,
  SolanaSignerRuntime,
  WorkerRequest,
  WorkerResponse,
  ResponseFor,
} from './worker/messages';
