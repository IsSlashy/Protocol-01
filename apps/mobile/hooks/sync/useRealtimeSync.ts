/**
 * useRealtimeSync - Hook for real-time subscription synchronization
 * @module hooks/sync/useRealtimeSync
 *
 * Uses the RealtimeSyncService to:
 * - Connect when wallet is available
 * - Disconnect on unmount
 * - Returns sync status (connected, syncing, error)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getRealtimeSyncService,
  RealtimeSyncService,
  SyncStatus,
  SyncEvent,
  RealtimeSyncConfig,
} from '../../services/sync/realtimeSync';
import { useWalletStore } from '../../stores/walletStore';
import { Stream } from '../../services/solana/streams';

// ============ Types ============

export interface UseRealtimeSyncOptions extends RealtimeSyncConfig {
  /** Auto-start when wallet is connected (default: true) */
  autoStart?: boolean;
  /** Callback when a new subscription is detected */
  onSubscriptionAdded?: (stream: Stream) => void;
  /** Callback when sync completes */
  onSyncComplete?: (result: { newStreams: number; updatedStreams: number }) => void;
  /** Callback on error */
  onError?: (error: string) => void;
}

export interface UseRealtimeSyncReturn {
  /** Current sync status */
  status: SyncStatus;
  /** Whether the service is connected */
  isConnected: boolean;
  /** Whether the service is syncing */
  isSyncing: boolean;
  /** Whether there's an error */
  hasError: boolean;
  /** Last error message */
  error: string | null;
  /** Last sync event */
  lastEvent: SyncEvent | null;
  /** Connected wallet address */
  walletAddress: string | null;
  /** Manually start the sync service */
  start: () => Promise<void>;
  /** Manually stop the sync service */
  stop: () => Promise<void>;
  /** Force a sync */
  forceSync: () => Promise<{ newStreams: number; updatedStreams: number }>;
}

// ============ Hook ============

export function useRealtimeSync(options: UseRealtimeSyncOptions = {}): UseRealtimeSyncReturn {
  const {
    autoStart = true,
    onSubscriptionAdded,
    onSyncComplete,
    onError,
    ...serviceConfig
  } = options;

  // State
  const [status, setStatus] = useState<SyncStatus>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<SyncEvent | null>(null);

  // Get wallet from store
  const { publicKey, hasWallet } = useWalletStore();

  // Service reference
  const serviceRef = useRef<RealtimeSyncService | null>(null);
  const listenerCleanupRef = useRef<(() => void) | null>(null);
  const isStartingRef = useRef<boolean>(false);

  // Get or create service instance
  const getService = useCallback((): RealtimeSyncService => {
    if (!serviceRef.current) {
      serviceRef.current = getRealtimeSyncService(serviceConfig);
    }
    return serviceRef.current;
  }, []);

  // Event handler
  const handleEvent = useCallback((event: SyncEvent) => {
    setLastEvent(event);

    switch (event.type) {
      case 'subscription_added':
        if (event.data && onSubscriptionAdded) {
          onSubscriptionAdded(event.data as Stream);
        }
        break;

      case 'sync_complete':
        if (event.data && onSyncComplete) {
          onSyncComplete(event.data as { newStreams: number; updatedStreams: number });
        }
        break;

      case 'error':
        setError(event.error || 'Unknown error');
        if (onError && event.error) {
          onError(event.error);
        }
        break;
    }
  }, [onSubscriptionAdded, onSyncComplete, onError]);

  // Start the sync service
  const start = useCallback(async (): Promise<void> => {
    if (!publicKey) {
      console.warn('[useRealtimeSync] Cannot start: no wallet connected');
      return;
    }

    if (isStartingRef.current) {
      console.log('[useRealtimeSync] Already starting, ignoring');
      return;
    }

    isStartingRef.current = true;

    try {
      const service = getService();

      // Clean up previous listener if exists
      if (listenerCleanupRef.current) {
        listenerCleanupRef.current();
      }

      // Add event listener
      listenerCleanupRef.current = service.addEventListener(handleEvent);

      // Start the service
      await service.start(publicKey);

      // Update status
      setStatus(service.getStatus());
      setError(null);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to start sync service';
      setError(errorMessage);
      setStatus('error');
    } finally {
      isStartingRef.current = false;
    }
  }, [publicKey, getService, handleEvent]);

  // Stop the sync service
  const stop = useCallback(async (): Promise<void> => {
    try {
      const service = getService();
      await service.stop();

      // Clean up listener
      if (listenerCleanupRef.current) {
        listenerCleanupRef.current();
        listenerCleanupRef.current = null;
      }

      setStatus('disconnected');
    } catch (err) {
      console.error('[useRealtimeSync] Error stopping service:', err);
    }
  }, [getService]);

  // Force a sync
  const forceSync = useCallback(async (): Promise<{ newStreams: number; updatedStreams: number }> => {
    const service = getService();
    setStatus('syncing');

    try {
      const result = await service.forceSync();
      setStatus(service.getStatus());
      return result;
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Sync failed');
      return { newStreams: 0, updatedStreams: 0 };
    }
  }, [getService]);

  // Poll status from service
  useEffect(() => {
    const service = getService();
    const interval = setInterval(() => {
      const currentStatus = service.getStatus();
      if (currentStatus !== status) {
        setStatus(currentStatus);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [getService, status]);

  // Auto-start when wallet becomes available
  useEffect(() => {
    if (autoStart && hasWallet && publicKey) {
      console.log('[useRealtimeSync] Auto-starting sync service for wallet:', publicKey);
      start();
    }

    // Cleanup on unmount or when wallet changes
    return () => {
      const service = serviceRef.current;
      if (service) {
        const currentWallet = service.getWalletAddress();
        // Only stop if wallet changed or component unmounted
        if (!publicKey || (currentWallet && currentWallet !== publicKey)) {
          console.log('[useRealtimeSync] Stopping sync service on cleanup');
          stop();
        }
      }
    };
  }, [autoStart, hasWallet, publicKey]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (listenerCleanupRef.current) {
        listenerCleanupRef.current();
      }
    };
  }, []);

  // Computed values
  const isConnected = status === 'connected';
  const isSyncing = status === 'syncing';
  const hasError = status === 'error';

  return {
    status,
    isConnected,
    isSyncing,
    hasError,
    error,
    lastEvent,
    walletAddress: publicKey,
    start,
    stop,
    forceSync,
  };
}

export default useRealtimeSync;
