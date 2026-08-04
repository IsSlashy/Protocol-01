/**
 * Canonical, framework-agnostic asset list.
 *
 * This is the single source of truth for what the coin selector renders across
 * BOTH apps/web and apps/extension. Adapters expose their own `assets` array
 * (used by the send/claim path), but the UI selector reads `ALL_ASSETS` so the
 * catalog — including `coming-soon` gates — is declared in exactly one place.
 *
 * Status policy: per-asset, declared on each entry below. Assets marked
 * `coming-soon` are rendered but gated in the selector.
 *
 * ── Starknet retired from the product surface, 2026-08-04 ──────────────────
 *
 * STRK, ETH (Starknet) and Starknet USDC are OFF the selector. They are not
 * deleted: the constants below are still exported and `starknetAdapter` still
 * lists them (chains/starknet.ts:705), so every line of Starknet work — the
 * pq_announcer transport, the stealth derivation, the e2e tests — is intact and
 * a single edit brings them back.
 *
 * WHY they went (two independent reasons, both must clear before they return):
 *
 *   1. They cannot be made private. The Starknet pool path is access-gated:
 *      chains/starknet.ts wires `shieldToStealth` to a throwing gate because
 *      the STRK20 SDK is not available to us. There is therefore NO reachable
 *      denominated pool on Starknet — only the direct ERC-20 + announcer path,
 *      where amounts are public. Shipping those coins in the same selector as
 *      a Solana pool tab implies a privacy they do not have, and this product's
 *      first rule is that the UI never claims more than the code delivers.
 *
 *   2. Founder instruction, 2026-08-04: "retire STRK if we cannot anonymise it
 *      for now, we will add it later, concentrate on SOL and USDC."
 *
 * WHAT BRINGS THEM BACK: a reachable STRK20 (or equivalent) denominated pool on
 * Starknet, i.e. `shieldToStealth` in chains/starknet.ts no longer throwing.
 * Then move the three entries out of `RETIRED_ASSETS` and back into
 * `ALL_ASSETS`, set their `status` back to `'live'` (Starknet USDC stays
 * `'coming-soon'`), and drop their `note`. The UI needs no other change: the
 * selector, the chain switch and the per-chain identity derivation are all
 * driven by what `ALL_ASSETS` contains.
 *
 * Note on the runtime gate that used to live in apps/web/components/pay/
 * PayApp.tsx: Starknet `live` entries previously ALSO depended on
 * `isStarknetConfigured()` (an RPC url + a deployed pq_announcer address), and
 * fell back to coming-soon in the UI without it. That gate is gone from the
 * page because it is now redundant — no Starknet asset reaches the selector at
 * all. Restore it alongside the entries if they come back.
 */

import type { Asset } from './types';

/**
 * The single reason string every retired Starknet asset carries, so a reader
 * who only ever sees one entry still learns why it is gated.
 */
export const STARKNET_RETIRED_NOTE =
  'Retired 2026-08-04: Starknet has no reachable denominated pool (the STRK20 ' +
  'shield path is access-gated and throws), so this asset cannot be made ' +
  'private. Returns when that pool is reachable.';

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
  status: 'coming-soon',
  note: STARKNET_RETIRED_NOTE,
};

export const STRK_STARKNET: Asset = {
  symbol: 'STRK',
  name: 'Starknet',
  chainId: 'starknet',
  decimals: 18,
  minSend: 1,
  status: 'coming-soon',
  note: STARKNET_RETIRED_NOTE,
};

export const USDC_STARKNET: Asset = {
  symbol: 'USDC',
  name: 'USD Coin (Starknet)',
  chainId: 'starknet',
  decimals: 6,
  minSend: 0.01,
  status: 'coming-soon',
  note: STARKNET_RETIRED_NOTE,
};

/**
 * Assets withdrawn from the product surface. NOT rendered by the selector.
 * Kept as a named, exported list so the retirement is a fact in the code
 * rather than an absence a future reader has to notice. See the file header
 * for why they went and what brings them back.
 */
export const RETIRED_ASSETS: Asset[] = [ETH_STARKNET, STRK_STARKNET, USDC_STARKNET];

/**
 * All assets on the product surface, in selector order. Solana only — see
 * `RETIRED_ASSETS` and the file header for the Starknet retirement.
 */
export const ALL_ASSETS: Asset[] = [SOL, USDC_SOLANA];
