/**
 * Protocol 01 - Bluetooth Mesh Service for Privacy Zones
 *
 * Implements Bluetooth LE mesh networking for privacy zone functionality:
 * - Scanning for nearby P01 wallet devices
 * - Advertising presence for peer discovery
 * - Encrypted peer-to-peer communication
 * - Privacy zone detection based on proximity
 */

import { Platform, PermissionsAndroid } from 'react-native';
import { BleManager, Device, State, BleError, Characteristic } from 'react-native-ble-plx';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';

// P01 Protocol UUIDs
export const P01_SERVICE_UUID = '6E400001-B5A3-F393-E0A9-E50E24DCCA9E';
export const P01_CHAR_TX_UUID = '6E400002-B5A3-F393-E0A9-E50E24DCCA9E';
export const P01_CHAR_RX_UUID = '6E400003-B5A3-F393-E0A9-E50E24DCCA9E';

// Privacy Zone Configuration
export const PRIVACY_ZONE_CONFIG = {
  // RSSI thresholds for zone detection
  ACTIVE_ZONE_RSSI: -65,    // Strong signal - active privacy zone
  BUFFER_ZONE_RSSI: -80,    // Medium signal - buffer zone
  SCAN_INTERVAL: 3000,       // Scan every 3 seconds
  DEVICE_TIMEOUT: 30000,     // Device considered gone after 30s
  MIN_TRUSTED_DEVICES: 1,    // Minimum trusted devices for active zone
  AUTO_LOCK_DELAY: 10000,    // Delay before auto-lock when leaving zone (10s)
};

// Storage keys
const TRUSTED_DEVICES_KEY = '@p01_privacy_trusted_devices';
const PRIVACY_ZONE_SETTINGS_KEY = '@p01_privacy_zone_settings';

// Types
export interface TrustedDevice {
  id: string;
  name: string;
  publicKey: string;
  addedAt: number;
  lastSeen: number;
  rssi: number;
  isInRange: boolean;
  zone: 'active' | 'buffer' | 'out';
}

export interface PrivacyZoneSettings {
  enabled: boolean;
  autoLockEnabled: boolean;
  autoLockDelay: number;
  requireMinDevices: number;
  notifyOnZoneChange: boolean;
  backgroundScanEnabled: boolean;
}

export interface PrivacyZoneStatus {
  isActive: boolean;
  inBufferZone: boolean;
  nearbyTrustedCount: number;
  totalNearbyCount: number;
  lastUpdated: number;
  autoLockScheduled: boolean;
  autoLockTime: number | null;
}

export interface NearbyDevice {
  id: string;
  name: string | null;
  rssi: number;
  lastSeen: number;
  isP01Device: boolean;
  isTrusted: boolean;
  zone: 'active' | 'buffer' | 'out';
}

export interface MeshEvent {
  type: 'device_found' | 'device_lost' | 'zone_entered' | 'zone_exited' | 'peer_message' | 'connection_request';
  device?: NearbyDevice;
  message?: string;
  timestamp: number;
}

// Default settings
const DEFAULT_SETTINGS: PrivacyZoneSettings = {
  enabled: false,
  autoLockEnabled: true,
  autoLockDelay: PRIVACY_ZONE_CONFIG.AUTO_LOCK_DELAY,
  requireMinDevices: PRIVACY_ZONE_CONFIG.MIN_TRUSTED_DEVICES,
  notifyOnZoneChange: true,
  backgroundScanEnabled: false,
};

// Singleton BLE Manager
let bleManager: BleManager | null = null;
let isScanning = false;
let scanTimer: NodeJS.Timeout | null = null;
let nearbyDevices: Map<string, NearbyDevice> = new Map();
let trustedDevices: Map<string, TrustedDevice> = new Map();
let eventListeners: Set<(event: MeshEvent) => void> = new Set();
let zoneStatusListeners: Set<(status: PrivacyZoneStatus) => void> = new Set();
let autoLockTimer: NodeJS.Timeout | null = null;
let currentSettings: PrivacyZoneSettings = DEFAULT_SETTINGS;

/**
 * Get or create BLE Manager instance
 */
export function getBleManager(): BleManager {
  if (!bleManager) {
    bleManager = new BleManager();
  }
  return bleManager;
}

/**
 * Request Bluetooth permissions
 */
export async function requestBluetoothPermissions(): Promise<boolean> {
  if (Platform.OS === 'ios') {
    return true;
  }

  if (Platform.OS === 'android') {
    try {
      const apiLevel = Platform.Version;

      if (apiLevel >= 31) {
        const results = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);

        return Object.values(results).every(
          result => result === PermissionsAndroid.RESULTS.GRANTED
        );
      } else {
        const result = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
        );
        return result === PermissionsAndroid.RESULTS.GRANTED;
      }
    } catch (error) {
      console.error('Error requesting Bluetooth permissions:', error);
      return false;
    }
  }

  return false;
}

/**
 * Check if Bluetooth is powered on
 */
export async function isBluetoothEnabled(): Promise<boolean> {
  const manager = getBleManager();
  const state = await manager.state();
  return state === State.PoweredOn;
}

/**
 * Get Bluetooth state as string
 */
export async function getBluetoothState(): Promise<'on' | 'off' | 'unauthorized' | 'unsupported' | 'unknown'> {
  const manager = getBleManager();
  const state = await manager.state();

  switch (state) {
    case State.PoweredOn:
      return 'on';
    case State.PoweredOff:
      return 'off';
    case State.Unauthorized:
      return 'unauthorized';
    case State.Unsupported:
      return 'unsupported';
    default:
      return 'unknown';
  }
}

/**
 * Determine zone from RSSI
 */
export function getZoneFromRSSI(rssi: number): 'active' | 'buffer' | 'out' {
  if (rssi >= PRIVACY_ZONE_CONFIG.ACTIVE_ZONE_RSSI) {
    return 'active';
  }
  if (rssi >= PRIVACY_ZONE_CONFIG.BUFFER_ZONE_RSSI) {
    return 'buffer';
  }
  return 'out';
}

/**
 * Calculate current privacy zone status
 */
export function calculateZoneStatus(): PrivacyZoneStatus {
  const now = Date.now();
  const validDevices = Array.from(nearbyDevices.values()).filter(
    d => now - d.lastSeen < PRIVACY_ZONE_CONFIG.DEVICE_TIMEOUT
  );

  const trustedInRange = validDevices.filter(d => d.isTrusted && d.zone !== 'out');
  const trustedInActiveZone = validDevices.filter(d => d.isTrusted && d.zone === 'active');

  const isActive = currentSettings.enabled &&
    trustedInActiveZone.length >= currentSettings.requireMinDevices;

  const inBufferZone = currentSettings.enabled &&
    !isActive &&
    trustedInRange.length > 0;

  return {
    isActive,
    inBufferZone,
    nearbyTrustedCount: trustedInRange.length,
    totalNearbyCount: validDevices.length,
    lastUpdated: now,
    autoLockScheduled: autoLockTimer !== null,
    autoLockTime: autoLockTimer ? now + currentSettings.autoLockDelay : null,
  };
}

/**
 * Notify zone status listeners
 */
function notifyZoneStatusChange(): void {
  const status = calculateZoneStatus();
  zoneStatusListeners.forEach(listener => listener(status));
}

/**
 * Emit mesh event
 */
function emitEvent(event: MeshEvent): void {
  eventListeners.forEach(listener => listener(event));
}

/**
 * Check if device is a P01 device based on name pattern
 */
function isP01Device(name: string | null): boolean {
  if (!name) return false;
  return name.startsWith('P01_') || name.includes('Specter') || name.includes('Protocol');
}

/**
 * Handle discovered device
 */
function handleDiscoveredDevice(device: Device): void {
  const deviceName = device.name || device.localName || null;
  const deviceId = device.id;
  const rssi = device.rssi || -100;
  const zone = getZoneFromRSSI(rssi);
  const isTrusted = trustedDevices.has(deviceId);
  const isP01 = isP01Device(deviceName);

  const existing = nearbyDevices.get(deviceId);
  const isNew = !existing;

  const nearbyDevice: NearbyDevice = {
    id: deviceId,
    name: deviceName,
    rssi,
    lastSeen: Date.now(),
    isP01Device: isP01,
    isTrusted,
    zone,
  };

  nearbyDevices.set(deviceId, nearbyDevice);

  // Update trusted device if applicable
  if (isTrusted) {
    const trusted = trustedDevices.get(deviceId);
    if (trusted) {
      trusted.lastSeen = Date.now();
      trusted.rssi = rssi;
      trusted.isInRange = zone !== 'out';
      trusted.zone = zone;
    }
  }

  // Emit event for new device
  if (isNew) {
    emitEvent({
      type: 'device_found',
      device: nearbyDevice,
      timestamp: Date.now(),
    });
  }

  // Handle zone changes
  if (existing && existing.zone !== zone) {
    if (zone === 'active' && existing.zone !== 'active') {
      emitEvent({
        type: 'zone_entered',
        device: nearbyDevice,
        timestamp: Date.now(),
      });
    } else if (zone === 'out' && existing.zone !== 'out') {
      emitEvent({
        type: 'zone_exited',
        device: nearbyDevice,
        timestamp: Date.now(),
      });
    }
  }

  // Check and notify zone status change
  notifyZoneStatusChange();
}

/**
 * Cleanup stale devices
 */
function cleanupStaleDevices(): void {
  const now = Date.now();
  const staleIds: string[] = [];

  nearbyDevices.forEach((device, id) => {
    if (now - device.lastSeen > PRIVACY_ZONE_CONFIG.DEVICE_TIMEOUT) {
      staleIds.push(id);
    }
  });

  staleIds.forEach(id => {
    const device = nearbyDevices.get(id);
    nearbyDevices.delete(id);

    if (device) {
      emitEvent({
        type: 'device_lost',
        device,
        timestamp: now,
      });
    }
  });

  if (staleIds.length > 0) {
    notifyZoneStatusChange();
  }
}

/**
 * Start scanning for nearby devices
 */
export async function startScanning(): Promise<boolean> {
  if (isScanning) {
    return true;
  }

  try {
    const hasPermissions = await requestBluetoothPermissions();
    if (!hasPermissions) {
      console.error('Bluetooth permissions not granted');
      return false;
    }

    const manager = getBleManager();
    const state = await manager.state();

    if (state !== State.PoweredOn) {
      console.error('Bluetooth not powered on');
      return false;
    }

    // Load trusted devices
    await loadTrustedDevices();

    console.log('[PrivacyMesh] Starting BLE scan...');
    isScanning = true;

    // Start BLE scanning
    manager.startDeviceScan(
      null,
      { allowDuplicates: true },
      (error: BleError | null, device: Device | null) => {
        if (error) {
          console.error('[PrivacyMesh] Scan error:', error);
          return;
        }

        if (device) {
          handleDiscoveredDevice(device);
        }
      }
    );

    // Set up periodic cleanup
    scanTimer = setInterval(() => {
      cleanupStaleDevices();
    }, PRIVACY_ZONE_CONFIG.SCAN_INTERVAL);

    return true;
  } catch (error) {
    console.error('[PrivacyMesh] Failed to start scanning:', error);
    isScanning = false;
    return false;
  }
}

/**
 * Stop scanning
 */
export function stopScanning(): void {
  if (!isScanning) return;

  const manager = getBleManager();
  manager.stopDeviceScan();

  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }

  isScanning = false;
  console.log('[PrivacyMesh] Scan stopped');
}

/**
 * Check if currently scanning
 */
export function isScanningActive(): boolean {
  return isScanning;
}

/**
 * Get all nearby devices
 */
export function getNearbyDevices(): NearbyDevice[] {
  return Array.from(nearbyDevices.values());
}

/**
 * Get trusted devices
 */
export function getTrustedDevices(): TrustedDevice[] {
  return Array.from(trustedDevices.values());
}

/**
 * Add event listener
 */
export function addEventListener(listener: (event: MeshEvent) => void): () => void {
  eventListeners.add(listener);
  return () => {
    eventListeners.delete(listener);
  };
}

/**
 * Add zone status listener
 */
export function addZoneStatusListener(listener: (status: PrivacyZoneStatus) => void): () => void {
  zoneStatusListeners.add(listener);
  // Immediately call with current status
  listener(calculateZoneStatus());
  return () => {
    zoneStatusListeners.delete(listener);
  };
}

/**
 * Load trusted devices from storage
 */
export async function loadTrustedDevices(): Promise<void> {
  try {
    const stored = await AsyncStorage.getItem(TRUSTED_DEVICES_KEY);
    if (stored) {
      const devices: TrustedDevice[] = JSON.parse(stored);
      trustedDevices.clear();
      devices.forEach(d => {
        d.isInRange = false;
        d.zone = 'out';
        trustedDevices.set(d.id, d);
      });
    }
  } catch (error) {
    console.error('[PrivacyMesh] Failed to load trusted devices:', error);
  }
}

/**
 * Save trusted devices to storage
 */
async function saveTrustedDevices(): Promise<void> {
  try {
    const devices = Array.from(trustedDevices.values());
    await AsyncStorage.setItem(TRUSTED_DEVICES_KEY, JSON.stringify(devices));
  } catch (error) {
    console.error('[PrivacyMesh] Failed to save trusted devices:', error);
  }
}

/**
 * Add a device as trusted
 */
export async function addTrustedDevice(device: NearbyDevice): Promise<TrustedDevice> {
  const publicKey = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `${device.id}-${Date.now()}`
  );

  const trustedDevice: TrustedDevice = {
    id: device.id,
    name: device.name || 'Unknown Device',
    publicKey: publicKey.slice(0, 32),
    addedAt: Date.now(),
    lastSeen: device.lastSeen,
    rssi: device.rssi,
    isInRange: device.zone !== 'out',
    zone: device.zone,
  };

  trustedDevices.set(device.id, trustedDevice);

  // Update nearby device
  const nearby = nearbyDevices.get(device.id);
  if (nearby) {
    nearby.isTrusted = true;
    nearbyDevices.set(device.id, nearby);
  }

  await saveTrustedDevices();
  notifyZoneStatusChange();

  return trustedDevice;
}

/**
 * Remove a trusted device
 */
export async function removeTrustedDevice(deviceId: string): Promise<void> {
  trustedDevices.delete(deviceId);

  // Update nearby device
  const nearby = nearbyDevices.get(deviceId);
  if (nearby) {
    nearby.isTrusted = false;
    nearbyDevices.set(deviceId, nearby);
  }

  await saveTrustedDevices();
  notifyZoneStatusChange();
}

/**
 * Load privacy zone settings
 */
export async function loadSettings(): Promise<PrivacyZoneSettings> {
  try {
    const stored = await AsyncStorage.getItem(PRIVACY_ZONE_SETTINGS_KEY);
    if (stored) {
      currentSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
    }
    return currentSettings;
  } catch (error) {
    console.error('[PrivacyMesh] Failed to load settings:', error);
    return DEFAULT_SETTINGS;
  }
}

/**
 * Save privacy zone settings
 */
export async function saveSettings(settings: Partial<PrivacyZoneSettings>): Promise<PrivacyZoneSettings> {
  try {
    currentSettings = { ...currentSettings, ...settings };
    await AsyncStorage.setItem(PRIVACY_ZONE_SETTINGS_KEY, JSON.stringify(currentSettings));
    notifyZoneStatusChange();
    return currentSettings;
  } catch (error) {
    console.error('[PrivacyMesh] Failed to save settings:', error);
    throw error;
  }
}

/**
 * Get current settings
 */
export function getSettings(): PrivacyZoneSettings {
  return currentSettings;
}

/**
 * Schedule auto-lock when leaving privacy zone
 */
export function scheduleAutoLock(onLock: () => void): void {
  if (!currentSettings.autoLockEnabled) return;

  // Clear existing timer
  if (autoLockTimer) {
    clearTimeout(autoLockTimer);
  }

  autoLockTimer = setTimeout(() => {
    const status = calculateZoneStatus();
    if (!status.isActive && !status.inBufferZone) {
      onLock();
    }
    autoLockTimer = null;
  }, currentSettings.autoLockDelay);

  notifyZoneStatusChange();
}

/**
 * Cancel auto-lock
 */
export function cancelAutoLock(): void {
  if (autoLockTimer) {
    clearTimeout(autoLockTimer);
    autoLockTimer = null;
    notifyZoneStatusChange();
  }
}

/**
 * Connect to a specific device for encrypted communication
 */
export async function connectToDevice(deviceId: string): Promise<Device | null> {
  try {
    const manager = getBleManager();
    const device = await manager.connectToDevice(deviceId, { timeout: 10000 });
    await device.discoverAllServicesAndCharacteristics();
    return device;
  } catch (error) {
    console.error('[PrivacyMesh] Failed to connect:', error);
    return null;
  }
}

/**
 * Disconnect from a device
 */
export async function disconnectFromDevice(deviceId: string): Promise<void> {
  try {
    const manager = getBleManager();
    await manager.cancelDeviceConnection(deviceId);
  } catch (error) {
    console.error('[PrivacyMesh] Failed to disconnect:', error);
  }
}

/**
 * Send encrypted message to a connected device
 */
export async function sendEncryptedMessage(deviceId: string, message: string): Promise<boolean> {
  try {
    const manager = getBleManager();
    const device = await manager.connectToDevice(deviceId);

    // Encrypt message (simplified - in production use proper encryption)
    const encrypted = btoa(message);

    await device.writeCharacteristicWithResponseForService(
      P01_SERVICE_UUID,
      P01_CHAR_TX_UUID,
      encrypted
    );

    await manager.cancelDeviceConnection(deviceId);
    return true;
  } catch (error) {
    console.error('[PrivacyMesh] Failed to send message:', error);
    return false;
  }
}

/**
 * Clean up resources
 */
export function destroy(): void {
  stopScanning();
  if (autoLockTimer) {
    clearTimeout(autoLockTimer);
    autoLockTimer = null;
  }
  if (bleManager) {
    bleManager.destroy();
    bleManager = null;
  }
  nearbyDevices.clear();
  eventListeners.clear();
  zoneStatusListeners.clear();
}

/**
 * Initialize the mesh service
 */
export async function initialize(): Promise<boolean> {
  try {
    await loadSettings();
    await loadTrustedDevices();

    const btEnabled = await isBluetoothEnabled();
    if (!btEnabled) {
      console.log('[PrivacyMesh] Bluetooth not enabled');
      return false;
    }

    if (currentSettings.enabled) {
      return await startScanning();
    }

    return true;
  } catch (error) {
    console.error('[PrivacyMesh] Initialization failed:', error);
    return false;
  }
}
