/**
 * Protocol 01 - BLE Manager
 *
 * Real Bluetooth Low Energy implementation for mesh peer discovery
 * Uses react-native-ble-plx for BLE scanning and connections
 */

import { Platform, PermissionsAndroid } from 'react-native';
import { BleManager, Device, State, BleError } from 'react-native-ble-plx';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MeshPeer, MESH_CONFIG, estimateDistance, getOrCreateIdentity } from './bluetooth';

// Singleton BLE Manager
let bleManager: BleManager | null = null;

// Storage keys
const DISCOVERED_PEERS_KEY = '@p01_discovered_peers';

// P-01 service UUID - all P-01 devices will advertise this
const P01_SERVICE_UUID = MESH_CONFIG.SERVICE_UUID;

// State
let isScanning = false;
let scanSubscription: any = null;
let discoveredDevices: Map<string, Device> = new Map();
let onPeersUpdatedCallback: ((peers: MeshPeer[]) => void) | null = null;

/**
 * Initialize BLE Manager
 */
export function getBleManager(): BleManager {
  if (!bleManager) {
    bleManager = new BleManager();
  }
  return bleManager;
}

/**
 * Request Bluetooth permissions (Android)
 */
export async function requestBluetoothPermissions(): Promise<boolean> {
  if (Platform.OS === 'ios') {
    // iOS handles permissions through Info.plist
    return true;
  }

  if (Platform.OS === 'android') {
    try {
      const apiLevel = Platform.Version;

      if (apiLevel >= 31) {
        // Android 12+ requires new Bluetooth permissions
        const results = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);

        const allGranted = Object.values(results).every(
          result => result === PermissionsAndroid.RESULTS.GRANTED
        );

        if (!allGranted) {
          console.warn('Not all Bluetooth permissions granted:', results);
        }

        return allGranted;
      } else {
        // Android 11 and below
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
 * Check if Bluetooth is enabled
 */
export async function isBluetoothEnabled(): Promise<boolean> {
  const manager = getBleManager();
  const state = await manager.state();
  return state === State.PoweredOn;
}

/**
 * Wait for Bluetooth to be powered on
 */
export function waitForBluetoothPoweredOn(): Promise<void> {
  return new Promise((resolve, reject) => {
    const manager = getBleManager();

    const subscription = manager.onStateChange((state) => {
      if (state === State.PoweredOn) {
        subscription.remove();
        resolve();
      } else if (state === State.Unauthorized || state === State.Unsupported) {
        subscription.remove();
        reject(new Error(`Bluetooth not available: ${state}`));
      }
    }, true);

    // Timeout after 10 seconds
    setTimeout(() => {
      subscription.remove();
      reject(new Error('Bluetooth initialization timeout'));
    }, 10000);
  });
}

/**
 * Start scanning for nearby P-01 devices
 */
export async function startScanning(
  onPeersUpdated: (peers: MeshPeer[]) => void
): Promise<boolean> {
  if (isScanning) {
    console.log('Already scanning');
    return true;
  }

  try {
    // Request permissions first
    const hasPermissions = await requestBluetoothPermissions();
    if (!hasPermissions) {
      console.error('Bluetooth permissions not granted');
      return false;
    }

    // Wait for Bluetooth to be ready
    const manager = getBleManager();
    const state = await manager.state();

    if (state !== State.PoweredOn) {
      console.log('Waiting for Bluetooth to power on...');
      await waitForBluetoothPoweredOn();
    }

    // Store callback
    onPeersUpdatedCallback = onPeersUpdated;

    // Clear previous discoveries
    discoveredDevices.clear();

    // Get our identity for filtering
    const identity = await getOrCreateIdentity();

    console.log('Starting BLE scan...');
    isScanning = true;

    // Start scanning
    // We scan for all devices and filter by name/service
    manager.startDeviceScan(
      null, // Scan for all services (we'll filter by name)
      {
        allowDuplicates: true, // Allow updates for RSSI changes
      },
      async (error: BleError | null, device: Device | null) => {
        if (error) {
          console.error('BLE Scan error:', error);
          return;
        }

        if (device) {
          // Accept any device with a name (likely a phone/device, not a beacon)
          const deviceName = device.name || device.localName || '';

          // Skip devices with no name (random BLE beacons, etc.)
          if (!deviceName || deviceName.length < 2) {
            return;
          }

          // Update discovered devices
          discoveredDevices.set(device.id, device);

          // Convert to MeshPeer format and notify
          const peers = await convertDevicesToPeers();
          onPeersUpdatedCallback?.(peers);
        }
      }
    );

    return true;
  } catch (error) {
    console.error('Failed to start scanning:', error);
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
  isScanning = false;
  onPeersUpdatedCallback = null;
  console.log('BLE scan stopped');
}

/**
 * Convert discovered BLE devices to MeshPeer format
 */
async function convertDevicesToPeers(): Promise<MeshPeer[]> {
  const peers: MeshPeer[] = [];
  const knownPeers = await loadKnownPeers();

  discoveredDevices.forEach((device) => {
    const deviceName = device.name || device.localName || 'Unknown';

    // Try to parse P-01 identity from device name
    // Format: P01_<alias>_<shortId>
    let alias = deviceName;
    let publicKey = device.id; // Use device ID as fallback

    const match = deviceName.match(/P01_(.+)_([A-Z0-9]+)/i);
    if (match) {
      alias = match[1];
      publicKey = match[2];
    }

    // Check if this is a known peer
    const knownPeer = knownPeers.find(p => p.publicKey === publicKey || p.id === device.id);

    peers.push({
      id: device.id,
      alias: knownPeer?.alias || alias,
      publicKey: knownPeer?.publicKey || publicKey,
      lastSeen: Date.now(),
      rssi: device.rssi || -100,
      distance: estimateDistance(device.rssi || -100),
      isConnected: false,
      isTrusted: knownPeer?.isTrusted || false,
    });
  });

  // Sort by signal strength (closest first)
  peers.sort((a, b) => b.rssi - a.rssi);

  return peers;
}

/**
 * Load known peers from storage
 */
async function loadKnownPeers(): Promise<MeshPeer[]> {
  try {
    const stored = await AsyncStorage.getItem(DISCOVERED_PEERS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

/**
 * Save peer to known peers
 */
export async function savePeerToKnown(peer: MeshPeer): Promise<void> {
  try {
    const peers = await loadKnownPeers();
    const existingIndex = peers.findIndex(p => p.id === peer.id);

    if (existingIndex >= 0) {
      peers[existingIndex] = { ...peers[existingIndex], ...peer };
    } else {
      peers.push(peer);
    }

    await AsyncStorage.setItem(DISCOVERED_PEERS_KEY, JSON.stringify(peers));
  } catch (error) {
    console.error('Failed to save peer:', error);
  }
}

/**
 * Connect to a peer device
 */
export async function connectToPeer(deviceId: string): Promise<Device | null> {
  try {
    const manager = getBleManager();
    const device = await manager.connectToDevice(deviceId, {
      timeout: 10000,
    });

    console.log('Connected to device:', device.id);

    // Discover services
    await device.discoverAllServicesAndCharacteristics();

    return device;
  } catch (error) {
    console.error('Failed to connect to peer:', error);
    return null;
  }
}

/**
 * Disconnect from a peer
 */
export async function disconnectFromPeer(deviceId: string): Promise<void> {
  try {
    const manager = getBleManager();
    await manager.cancelDeviceConnection(deviceId);
    console.log('Disconnected from device:', deviceId);
  } catch (error) {
    console.error('Failed to disconnect:', error);
  }
}

/**
 * Get current scanning state
 */
export function isScanningActive(): boolean {
  return isScanning;
}

/**
 * Get list of currently discovered peers
 */
export async function getDiscoveredPeers(): Promise<MeshPeer[]> {
  return convertDevicesToPeers();
}

/**
 * Clean up BLE manager
 */
export function destroyBleManager(): void {
  stopScanning();
  if (bleManager) {
    bleManager.destroy();
    bleManager = null;
  }
  discoveredDevices.clear();
}

/**
 * Set device name for advertising (if supported)
 * Note: react-native-ble-plx doesn't support peripheral mode directly
 * This is a placeholder for future implementation with a peripheral library
 */
export async function setAdvertisingName(): Promise<void> {
  try {
    const identity = await getOrCreateIdentity();
    const advertisingName = `P01_${identity.alias}_${identity.id.slice(-8)}`;
    console.log('Advertising name would be:', advertisingName);
    // Note: Actual advertising requires native code or a peripheral library
    // For now, we rely on users having their device Bluetooth name set
  } catch (error) {
    console.error('Failed to set advertising name:', error);
  }
}

/**
 * Get Bluetooth state as string
 */
export async function getBluetoothState(): Promise<string> {
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
