/**
 * Canonical, framework-agnostic asset list.
 *
 * This is the single source of truth for what the coin selector renders across
 * BOTH apps/web and apps/extension. Adapters expose their own `assets` array
 * (used by the send/claim path), but the UI selector reads `ALL_ASSETS` so the
 * catalog — including `coming-soon` gates — is declared in exactly one place.
 *
 * Status policy: per-asset, declared on each entry below. Assets marked
 * `coming-soon` are rendered but gated in the selector. Starknet `live`
 * entries additionally depend on runtime config (isStarknetConfigured):
 * without an RPC url + deployed pq_announcer address they fall back to
 * coming-soon in the UI.
 */

import type { Asset } from './types';

export const SOL: Asset = {
  symbol: 'SOL',
  name: 'Solana',
  chainId: 'solana',
  decimals: 9,
  minSend: 0.001,
  status: 'live',
};

export const USDC_SOLANA: Asset = {
  symbol: 'USDC',
  name: 'USD Coin (Solana)',
  chainId: 'solana',
  decimals: 6,
  minSend: 0.01,
  status: 'live',
};

export const ETH_STARKNET: Asset = {
  symbol: 'ETH',
  name: 'Ethereum (Starknet)',
  chainId: 'starknet',
  decimals: 18,
  minSend: 0.001,
  status: 'live',
};

export const STRK_STARKNET: Asset = {
  symbol: 'STRK',
  name: 'Starknet',
  chainId: 'starknet',
  decimals: 18,
  minSend: 1,
  status: 'live',
};

export const USDC_STARKNET: Asset = {
  symbol: 'USDC',
  name: 'USD Coin (Starknet)',
  chainId: 'starknet',
  decimals: 6,
  minSend: 0.01,
  status: 'coming-soon',
};

/** All assets across all chains, in selector order. */
export const ALL_ASSETS: Asset[] = [
  SOL,
  USDC_SOLANA,
  ETH_STARKNET,
  STRK_STARKNET,
  USDC_STARKNET,
];
