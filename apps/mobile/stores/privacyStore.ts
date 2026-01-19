/**
 * Protocol 01 - Privacy Zone Store
 *
 * State management for Bluetooth-based privacy zones:
 * - Track nearby trusted devices
 * - Privacy zone status (active/inactive)
 * - Auto-lock when leaving privacy zone
 * - Trusted device management
 */

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  TrustedDevice,
  NearbyDevice,
  PrivacyZoneSettings,
  PrivacyZoneStatus,
  MeshEvent,
  initialize as initMesh,
  startScanning,
  stopScanning,
  isScanningActive,
  getNearbyDevices,
  getTrustedDevices,
  addTrustedDevice as meshAddTrusted,
  removeTrustedDevice as meshRemoveTrusted,
  loadSettings,
  saveSettings,
  getSettings,
  addEventListener,
  addZoneStatusListener,
  calculateZoneStatus,
  scheduleAutoLock,
  cancelAutoLock,
  destroy as destroyMesh,
  getBluetoothState,
  PRIVACY_ZONE_CONFIG,
} from '../services/bluetooth/mesh';

// Storage key for privacy history
const PRIVACY_HISTORY_KEY = '@p01_privacy_zone_history';

export interface PrivacyZoneEvent {
  id: string;
  type: 'zone_entered' | 'zone_exited' | 'device_added' | 'device_removed' | 'auto_locked';
  deviceId?: string;
  deviceName?: string;
  timestamp: number;
}

export interface PrivacyState {
  // Initialization
  isInitialized: boolean;
  isInitializing: boolean;
  error: string | null;

  // Bluetooth state
  bluetoothState: 'on' | 'off' | 'unauthorized' | 'unsupported' | 'unknown';
  isScanning: boolean;

  // Privacy zone status
  zoneStatus: PrivacyZoneStatus;
  wasInZone: boolean;

  // Devices
  nearbyDevices: NearbyDevice[];
  trustedDevices: TrustedDevice[];

  // Settings
  settings: PrivacyZoneSettings;

  // Event history
  eventHistory: PrivacyZoneEvent[];

  // Auto-lock callback
  onAutoLock: (() => void) | null;

  // Actions
  initialize: () => Promise<void>;
  startScan: () => Promise<boolean>;
  stopScan: () => void;
  refreshDevices: () => void;
  addTrustedDevice: (device: NearbyDevice) => Promise<TrustedDevice | null>;
  removeTrustedDevice: (deviceId: string) => Promise<void>;
  updateSettings: (settings: Partial<PrivacyZoneSettings>) => Promise<void>;
  setAutoLockCallback: (callback: (() => void) | null) => void;
  clearError: () => void;
  cleanup: () => void;
}

const initialZoneStatus: PrivacyZoneStatus = {
  isActive: false,
  inBufferZone: false,
  nearbyTrustedCount: 0,
  totalNearbyCount: 0,
  lastUpdated: Date.now(),
  autoLockScheduled: false,
  autoLockTime: null,
};

const initialSettings: PrivacyZoneSettings = {
  enabled: false,
  autoLockEnabled: true,
  autoLockDelay: PRIVACY_ZONE_CONFIG.AUTO_LOCK_DELAY,
  requireMinDevices: PRIVACY_ZONE_CONFIG.MIN_TRUSTED_DEVICES,
  notifyOnZoneChange: true,
  backgroundScanEnabled: false,
};

export const usePrivacyStore = create<PrivacyState>((set, get) => {
  // Unsubscribe functions
  let unsubscribeEvents: (() => void) | null = null;
  let unsubscribeZoneStatus: (() => void) | null = null;

  return {
    // Initial state
    isInitialized: false,
    isInitializing: false,
    error: null,
    bluetoothState: 'unknown',
    isScanning: false,
    zoneStatus: initialZoneStatus,
    wasInZone: false,
    nearbyDevices: [],
    trustedDevices: [],
    settings: initialSettings,
    eventHistory: [],
    onAutoLock: null,

    // Initialize privacy zone functionality
    initialize: async () => {
      const { isInitialized, isInitializing } = get();
      if (isInitialized || isInitializing) return;

      set({ isInitializing: true, error: null });

      try {
        // Check Bluetooth state
        const btState = await getBluetoothState();
        set({ bluetoothState: btState });

        // Load settings
        const settings = await loadSettings();
        set({ settings });

        // Load event history
        const historyData = await AsyncStorage.getItem(PRIVACY_HISTORY_KEY);
        const eventHistory: PrivacyZoneEvent[] = historyData ? JSON.parse(historyData) : [];
        set({ eventHistory: eventHistory.slice(0, 100) }); // Keep last 100 events

        // Subscribe to mesh events
        unsubscribeEvents = addEventListener((event: MeshEvent) => {
          const state = get();

          // Add to history
          if (['zone_entered', 'zone_exited'].includes(event.type)) {
            const historyEvent: PrivacyZoneEvent = {
              id: `${event.type}_${Date.now()}`,
              type: event.type as any,
              deviceId: event.device?.id,
              deviceName: event.device?.name || undefined,
              timestamp: event.timestamp,
            };

            const updatedHistory = [historyEvent, ...state.eventHistory].slice(0, 100);
            set({ eventHistory: updatedHistory });
            AsyncStorage.setItem(PRIVACY_HISTORY_KEY, JSON.stringify(updatedHistory));
          }

          // Update nearby devices
          set({ nearbyDevices: getNearbyDevices() });
        });

        // Subscribe to zone status changes
        unsubscribeZoneStatus = addZoneStatusListener((status: PrivacyZoneStatus) => {
          const state = get();
          const wasActive = state.zoneStatus.isActive;
          const isNowActive = status.isActive;

          set({
            zoneStatus: status,
            wasInZone: wasActive,
          });

          // Handle zone exit - schedule auto-lock
          if (wasActive && !isNowActive && state.settings.autoLockEnabled && state.onAutoLock) {
            scheduleAutoLock(state.onAutoLock);
          }

          // Handle zone enter - cancel auto-lock
          if (!wasActive && isNowActive) {
            cancelAutoLock();
          }
        });

        // Initialize mesh if enabled
        if (btState === 'on' && settings.enabled) {
          await initMesh();
          set({
            trustedDevices: getTrustedDevices(),
            nearbyDevices: getNearbyDevices(),
            zoneStatus: calculateZoneStatus(),
          });
        }

        set({
          isInitialized: true,
          isInitializing: false,
          trustedDevices: getTrustedDevices(),
        });
      } catch (error: any) {
        set({
          error: error.message || 'Failed to initialize privacy zone',
          isInitializing: false,
        });
      }
    },

    // Start scanning for nearby devices
    startScan: async () => {
      const { bluetoothState, settings } = get();

      if (bluetoothState !== 'on') {
        set({ error: 'Bluetooth is not enabled' });
        return false;
      }

      set({ error: null });

      try {
        const success = await startScanning();
        set({
          isScanning: success,
          nearbyDevices: getNearbyDevices(),
        });
        return success;
      } catch (error: any) {
        set({ error: error.message || 'Failed to start scanning' });
        return false;
      }
    },

    // Stop scanning
    stopScan: () => {
      stopScanning();
      set({ isScanning: false });
    },

    // Refresh device lists
    refreshDevices: () => {
      set({
        nearbyDevices: getNearbyDevices(),
        trustedDevices: getTrustedDevices(),
        zoneStatus: calculateZoneStatus(),
      });
    },

    // Add a device as trusted
    addTrustedDevice: async (device: NearbyDevice) => {
      try {
        const trusted = await meshAddTrusted(device);

        // Add to history
        const historyEvent: PrivacyZoneEvent = {
          id: `device_added_${Date.now()}`,
          type: 'device_added',
          deviceId: device.id,
          deviceName: device.name || undefined,
          timestamp: Date.now(),
        };

        const { eventHistory } = get();
        const updatedHistory = [historyEvent, ...eventHistory].slice(0, 100);

        set({
          trustedDevices: getTrustedDevices(),
          nearbyDevices: getNearbyDevices(),
          zoneStatus: calculateZoneStatus(),
          eventHistory: updatedHistory,
        });

        await AsyncStorage.setItem(PRIVACY_HISTORY_KEY, JSON.stringify(updatedHistory));

        return trusted;
      } catch (error: any) {
        set({ error: error.message || 'Failed to add trusted device' });
        return null;
      }
    },

    // Remove a trusted device
    removeTrustedDevice: async (deviceId: string) => {
      try {
        const device = getTrustedDevices().find(d => d.id === deviceId);
        await meshRemoveTrusted(deviceId);

        // Add to history
        const historyEvent: PrivacyZoneEvent = {
          id: `device_removed_${Date.now()}`,
          type: 'device_removed',
          deviceId: deviceId,
          deviceName: device?.name,
          timestamp: Date.now(),
        };

        const { eventHistory } = get();
        const updatedHistory = [historyEvent, ...eventHistory].slice(0, 100);

        set({
          trustedDevices: getTrustedDevices(),
          nearbyDevices: getNearbyDevices(),
          zoneStatus: calculateZoneStatus(),
          eventHistory: updatedHistory,
        });

        await AsyncStorage.setItem(PRIVACY_HISTORY_KEY, JSON.stringify(updatedHistory));
      } catch (error: any) {
        set({ error: error.message || 'Failed to remove trusted device' });
      }
    },

    // Update settings
    updateSettings: async (newSettings: Partial<PrivacyZoneSettings>) => {
      try {
        const settings = await saveSettings(newSettings);
        set({ settings });

        // Start or stop scanning based on enabled state
        if (newSettings.enabled !== undefined) {
          if (newSettings.enabled) {
            await get().startScan();
          } else {
            get().stopScan();
          }
        }
      } catch (error: any) {
        set({ error: error.message || 'Failed to update settings' });
      }
    },

    // Set auto-lock callback
    setAutoLockCallback: (callback: (() => void) | null) => {
      set({ onAutoLock: callback });
    },

    // Clear error
    clearError: () => {
      set({ error: null });
    },

    // Cleanup resources
    cleanup: () => {
      if (unsubscribeEvents) {
        unsubscribeEvents();
        unsubscribeEvents = null;
      }
      if (unsubscribeZoneStatus) {
        unsubscribeZoneStatus();
        unsubscribeZoneStatus = null;
      }
      destroyMesh();
      set({
        isInitialized: false,
        isScanning: false,
        nearbyDevices: [],
        zoneStatus: initialZoneStatus,
      });
    },
  };
});

// Selectors
export const selectIsInPrivacyZone = (state: PrivacyState) => state.zoneStatus.isActive;
export const selectIsInBufferZone = (state: PrivacyState) => state.zoneStatus.inBufferZone;
export const selectNearbyTrustedCount = (state: PrivacyState) => state.zoneStatus.nearbyTrustedCount;
export const selectPrivacyEnabled = (state: PrivacyState) => state.settings.enabled;
export const selectTrustedDevices = (state: PrivacyState) => state.trustedDevices;
export const selectNearbyDevices = (state: PrivacyState) => state.nearbyDevices;

/**
 * Get zone status color
 */
export function getZoneStatusColor(status: PrivacyZoneStatus): string {
  if (status.isActive) return '#00ff88'; // Green
  if (status.inBufferZone) return '#f59e0b'; // Orange
  return '#666666'; // Gray
}

/**
 * Get zone status label
 */
export function getZoneStatusLabel(status: PrivacyZoneStatus): string {
  if (status.isActive) return 'Active';
  if (status.inBufferZone) return 'Buffer Zone';
  return 'Inactive';
}

/**
 * Format device zone for display
 */
export function formatDeviceZone(zone: 'active' | 'buffer' | 'out'): string {
  switch (zone) {
    case 'active':
      return 'In Zone';
    case 'buffer':
      return 'Near';
    case 'out':
      return 'Out of Range';
  }
}

/**
 * Get device zone color
 */
export function getDeviceZoneColor(zone: 'active' | 'buffer' | 'out'): string {
  switch (zone) {
    case 'active':
      return '#00ff88';
    case 'buffer':
      return '#f59e0b';
    case 'out':
      return '#666666';
  }
}

export default usePrivacyStore;
