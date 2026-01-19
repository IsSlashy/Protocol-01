/**
 * Common hooks exports
 * @module hooks/common
 */

export { useNetwork, useNetworkStatus, NETWORKS } from './useNetwork';
export type { NetworkType, NetworkConfig, NetworkState } from './useNetwork';

export { usePrice, useTokenPrice, TOKEN_IDS } from './usePrice';
export type { TokenPrice, PriceCache } from './usePrice';

export { useRefresh, useMultiRefresh, useSequentialRefresh, useAutoRefresh } from './useRefresh';
export type { RefreshConfig, MultiRefreshSource, AutoRefreshConfig } from './useRefresh';

export {
  useHaptics,
  useButtonHaptics,
  useListHaptics,
  useSwipeHaptics,
} from './useHaptics';
export type { HapticFeedbackType, HapticsSettings } from './useHaptics';
