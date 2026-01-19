/**
 * useRefresh - Pull to refresh functionality
 * @module hooks/common/useRefresh
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useHaptics } from './useHaptics';

export interface RefreshConfig {
  onRefresh: () => Promise<void>;
  minimumDuration?: number; // Minimum time to show refreshing state (ms)
  cooldown?: number; // Time between allowed refreshes (ms)
  enableHaptics?: boolean;
}

interface UseRefreshReturn {
  isRefreshing: boolean;
  refresh: () => Promise<void>;
  onRefresh: () => Promise<void>; // For RefreshControl
  lastRefreshed: number | null;
  canRefresh: boolean;
}

const DEFAULT_MINIMUM_DURATION = 500;
const DEFAULT_COOLDOWN = 1000;

export function useRefresh({
  onRefresh,
  minimumDuration = DEFAULT_MINIMUM_DURATION,
  cooldown = DEFAULT_COOLDOWN,
  enableHaptics = true,
}: RefreshConfig): UseRefreshReturn {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<number | null>(null);
  const [canRefresh, setCanRefresh] = useState(true);

  const cooldownTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const { trigger } = useHaptics();

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (cooldownTimeoutRef.current) {
        clearTimeout(cooldownTimeoutRef.current);
      }
    };
  }, []);

  const refresh = useCallback(async () => {
    if (isRefreshing || !canRefresh) {
      return;
    }

    // Haptic feedback at start
    if (enableHaptics) {
      trigger('selection');
    }

    setIsRefreshing(true);
    setCanRefresh(false);

    const startTime = Date.now();

    try {
      await onRefresh();

      // Haptic feedback on success
      if (enableHaptics) {
        trigger('success');
      }
    } catch (error) {
      // Haptic feedback on error
      if (enableHaptics) {
        trigger('error');
      }
      throw error;
    } finally {
      // Ensure minimum duration for better UX
      const elapsed = Date.now() - startTime;
      const remainingTime = Math.max(0, minimumDuration - elapsed);

      if (remainingTime > 0) {
        await new Promise(resolve => setTimeout(resolve, remainingTime));
      }

      setIsRefreshing(false);
      setLastRefreshed(Date.now());

      // Start cooldown
      cooldownTimeoutRef.current = setTimeout(() => {
        setCanRefresh(true);
      }, cooldown);
    }
  }, [isRefreshing, canRefresh, onRefresh, minimumDuration, cooldown, enableHaptics, trigger]);

  return {
    isRefreshing,
    refresh,
    onRefresh: refresh, // Alias for RefreshControl compatibility
    lastRefreshed,
    canRefresh,
  };
}

// Hook for multiple data sources refresh
export interface MultiRefreshSource {
  id: string;
  onRefresh: () => Promise<void>;
  priority?: number; // Lower = higher priority, runs first
}

export function useMultiRefresh(
  sources: MultiRefreshSource[],
  options: Omit<RefreshConfig, 'onRefresh'> = {}
): UseRefreshReturn {
  const sortedSources = [...sources].sort(
    (a, b) => (a.priority ?? 0) - (b.priority ?? 0)
  );

  const onRefresh = useCallback(async () => {
    // Run all refresh functions in parallel
    await Promise.all(sortedSources.map(source => source.onRefresh()));
  }, [sortedSources]);

  return useRefresh({
    onRefresh,
    ...options,
  });
}

// Hook for sequential refresh (useful when sources depend on each other)
export function useSequentialRefresh(
  sources: MultiRefreshSource[],
  options: Omit<RefreshConfig, 'onRefresh'> = {}
): UseRefreshReturn {
  const sortedSources = [...sources].sort(
    (a, b) => (a.priority ?? 0) - (b.priority ?? 0)
  );

  const onRefresh = useCallback(async () => {
    // Run refresh functions sequentially
    for (const source of sortedSources) {
      await source.onRefresh();
    }
  }, [sortedSources]);

  return useRefresh({
    onRefresh,
    ...options,
  });
}

// Hook for auto-refresh at intervals
export interface AutoRefreshConfig extends RefreshConfig {
  interval: number; // ms
  enabled?: boolean;
  refreshOnMount?: boolean;
  refreshOnFocus?: boolean;
}

export function useAutoRefresh({
  interval,
  enabled = true,
  refreshOnMount = true,
  refreshOnFocus = true,
  ...refreshConfig
}: AutoRefreshConfig): UseRefreshReturn & { setEnabled: (enabled: boolean) => void } {
  const [autoEnabled, setAutoEnabled] = useState(enabled);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const refreshHook = useRefresh(refreshConfig);

  // Auto-refresh interval
  useEffect(() => {
    if (!autoEnabled || interval <= 0) {
      return;
    }

    intervalRef.current = setInterval(() => {
      if (refreshHook.canRefresh) {
        refreshHook.refresh();
      }
    }, interval);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [autoEnabled, interval, refreshHook]);

  // Refresh on mount
  useEffect(() => {
    if (refreshOnMount && autoEnabled) {
      refreshHook.refresh();
    }
  }, []); // Only on mount

  // Note: For refreshOnFocus, you would typically use React Navigation's useFocusEffect
  // or AppState listener, which would be implemented at the component level

  const setEnabled = useCallback((newEnabled: boolean) => {
    setAutoEnabled(newEnabled);
  }, []);

  return {
    ...refreshHook,
    setEnabled,
  };
}
