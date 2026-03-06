/**
 * Common hooks exports
 * @module hooks/common
 */

export { useNetwork, useNetworkStatus } from './useNetwork';

export { useRefresh, useMultiRefresh, useSequentialRefresh, useAutoRefresh } from './useRefresh';
export type { RefreshConfig, MultiRefreshSource, AutoRefreshConfig } from './useRefresh';

export {
  useHaptics,
  useButtonHaptics,
  useListHaptics,
  useSwipeHaptics,
} from './useHaptics';
export type { HapticFeedbackType, HapticsSettings } from './useHaptics';
