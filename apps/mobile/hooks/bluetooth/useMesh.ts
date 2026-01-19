/**
 * useMesh - Hook for Bluetooth mesh operations
 *
 * Provides React hook interface for:
 * - Starting/stopping Bluetooth scanning
 * - Advertising presence to nearby devices
 * - Managing privacy zone status
 * - Handling incoming connections
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import {
  usePrivacyStore,
  getZoneStatusColor,
  getZoneStatusLabel,
  getDeviceZoneColor,
  formatDeviceZone,
} from '../../stores/privacyStore';
import type {
  NearbyDevice,
  TrustedDevice,
  PrivacyZoneSettings,
  PrivacyZoneStatus,
} from '../../services/bluetooth/mesh';

export interface UseMeshOptions {
  autoStart?: boolean;
  onAutoLock?: () => void;
  onZoneEnter?: () => void;
  onZoneExit?: () => void;
}

export interface UseMeshReturn {
  // State
  isInitialized: boolean;
  isScanning: boolean;
  bluetoothState: 'on' | 'off' | 'unauthorized' | 'unsupported' | 'unknown';
  error: string | null;

  // Zone status
  zoneStatus: PrivacyZoneStatus;
  isInZone: boolean;
  isInBufferZone: boolean;
  zoneColor: string;
  zoneLabel: string;

  // Devices
  nearbyDevices: NearbyDevice[];
  trustedDevices: TrustedDevice[];
  nearbyTrustedCount: number;

  // Settings
  settings: PrivacyZoneSettings;

  // Actions
  startScanning: () => Promise<boolean>;
  stopScanning: () => void;
  refreshDevices: () => void;
  addTrustedDevice: (device: NearbyDevice) => Promise<TrustedDevice | null>;
  removeTrustedDevice: (deviceId: string) => Promise<void>;
  updateSettings: (settings: Partial<PrivacyZoneSettings>) => Promise<void>;
  clearError: () => void;
}

export function useMesh(options: UseMeshOptions = {}): UseMeshReturn {
  const {
    autoStart = false,
    onAutoLock,
    onZoneEnter,
    onZoneExit,
  } = options;

  // Track previous zone status for callbacks
  const prevZoneStatus = useRef<PrivacyZoneStatus | null>(null);
  const appState = useRef(AppState.currentState);

  // Get store state and actions
  const {
    isInitialized,
    isInitializing,
    isScanning,
    bluetoothState,
    error,
    zoneStatus,
    nearbyDevices,
    trustedDevices,
    settings,
    initialize,
    startScan,
    stopScan,
    refreshDevices,
    addTrustedDevice: storeAddTrusted,
    removeTrustedDevice: storeRemoveTrusted,
    updateSettings: storeUpdateSettings,
    setAutoLockCallback,
    clearError,
    cleanup,
  } = usePrivacyStore();

  // Derived values
  const isInZone = zoneStatus.isActive;
  const isInBufferZone = zoneStatus.inBufferZone;
  const zoneColor = getZoneStatusColor(zoneStatus);
  const zoneLabel = getZoneStatusLabel(zoneStatus);
  const nearbyTrustedCount = zoneStatus.nearbyTrustedCount;

  // Initialize on mount
  useEffect(() => {
    initialize();

    return () => {
      // Cleanup handled by store
    };
  }, []);

  // Set auto-lock callback
  useEffect(() => {
    if (onAutoLock) {
      setAutoLockCallback(onAutoLock);
    }

    return () => {
      setAutoLockCallback(null);
    };
  }, [onAutoLock, setAutoLockCallback]);

  // Handle zone status changes for callbacks
  useEffect(() => {
    if (!prevZoneStatus.current) {
      prevZoneStatus.current = zoneStatus;
      return;
    }

    const wasActive = prevZoneStatus.current.isActive;
    const isNowActive = zoneStatus.isActive;

    if (!wasActive && isNowActive && onZoneEnter) {
      onZoneEnter();
    }

    if (wasActive && !isNowActive && onZoneExit) {
      onZoneExit();
    }

    prevZoneStatus.current = zoneStatus;
  }, [zoneStatus, onZoneEnter, onZoneExit]);

  // Auto-start scanning when initialized
  useEffect(() => {
    if (isInitialized && autoStart && settings.enabled && !isScanning) {
      startScan();
    }
  }, [isInitialized, autoStart, settings.enabled, isScanning]);

  // Handle app state changes for background scanning
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      if (appState.current === 'active' && nextAppState.match(/inactive|background/)) {
        // App going to background
        if (!settings.backgroundScanEnabled && isScanning) {
          stopScan();
        }
      } else if (appState.current.match(/inactive|background/) && nextAppState === 'active') {
        // App coming to foreground
        if (settings.enabled && !isScanning) {
          startScan();
        }
        refreshDevices();
      }

      appState.current = nextAppState;
    });

    return () => {
      subscription.remove();
    };
  }, [settings.backgroundScanEnabled, settings.enabled, isScanning]);

  // Start scanning
  const startScanning = useCallback(async (): Promise<boolean> => {
    return await startScan();
  }, [startScan]);

  // Stop scanning
  const stopScanning = useCallback((): void => {
    stopScan();
  }, [stopScan]);

  // Add trusted device
  const addTrustedDevice = useCallback(async (device: NearbyDevice): Promise<TrustedDevice | null> => {
    return await storeAddTrusted(device);
  }, [storeAddTrusted]);

  // Remove trusted device
  const removeTrustedDevice = useCallback(async (deviceId: string): Promise<void> => {
    await storeRemoveTrusted(deviceId);
  }, [storeRemoveTrusted]);

  // Update settings
  const updateSettings = useCallback(async (newSettings: Partial<PrivacyZoneSettings>): Promise<void> => {
    await storeUpdateSettings(newSettings);
  }, [storeUpdateSettings]);

  return {
    // State
    isInitialized,
    isScanning,
    bluetoothState,
    error,

    // Zone status
    zoneStatus,
    isInZone,
    isInBufferZone,
    zoneColor,
    zoneLabel,

    // Devices
    nearbyDevices,
    trustedDevices,
    nearbyTrustedCount,

    // Settings
    settings,

    // Actions
    startScanning,
    stopScanning,
    refreshDevices,
    addTrustedDevice,
    removeTrustedDevice,
    updateSettings,
    clearError,
  };
}

// Re-export utility functions
export { getZoneStatusColor, getZoneStatusLabel, getDeviceZoneColor, formatDeviceZone };

export default useMesh;
