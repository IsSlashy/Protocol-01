/**
 * BLE Transport — Central + Peripheral modes for P2P note sharing
 *
 * Central mode (sender): Uses react-native-ble-plx to scan, connect, and write data.
 * Peripheral mode (receiver): Uses native BlePeripheralModule to advertise, accept
 * connections, and receive data via GATT server.
 *
 * 4-byte fragment header for chunked transfer over BLE MTU:
 *   [type(1), seq(1), totalChunks(1), reserved(1)]
 */

import { BleManager, Device, State } from 'react-native-ble-plx';
import { Platform, PermissionsAndroid, NativeModules, NativeEventEmitter, Linking } from 'react-native';
import { Buffer } from 'buffer';
import {
  BLE_SERVICE_UUID,
  BLE_PUBKEY_CHAR_UUID,
  BLE_DATA_CHAR_UUID,
  BLE_TARGET_MTU,
  FRAGMENT_HEADER_SIZE,
  MSG_TYPE_PUBKEY,
  MSG_TYPE_NOTE,
  MSG_TYPE_ACK,
  type PeerInfo,
  type FragmentHeader,
  type EncryptedNotePayload,
} from '../types';

// ---------------------------------------------------------------------------
// Native peripheral module (Android only)
// ---------------------------------------------------------------------------

const { BlePeripheralModule } = NativeModules;
const peripheralEmitter = BlePeripheralModule
  ? new NativeEventEmitter(BlePeripheralModule)
  : null;

// ---------------------------------------------------------------------------
// Singleton BLE manager (for central mode via ble-plx)
// ---------------------------------------------------------------------------

let _manager: BleManager | null = null;

function getManager(): BleManager {
  if (!_manager) {
    _manager = new BleManager();
  }
  return _manager;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BleTransportCallbacks {
  onPeerDiscovered: (peer: PeerInfo) => void;
  onPeerConnected: (peer: PeerInfo) => void;
  onPeerDisconnected: (peerId: string) => void;
  onPublicKeyReceived: (peerId: string, publicKey: string) => void;
  onEncryptedNoteReceived: (peerId: string, encrypted: EncryptedNotePayload) => void;
  onAckReceived: (peerId: string) => void;
  onError: (error: Error) => void;
}

interface ChunkBuffer {
  totalChunks: number;
  type: number;
  received: Map<number, Uint8Array>;
}

// ---------------------------------------------------------------------------
// BLE session nonce for replay prevention (M12)
// ---------------------------------------------------------------------------

/**
 * Generate a 16-byte session nonce using CSPRNG.
 * Both sides exchange nonces during key exchange and mix them into
 * the shared secret derivation to prevent replay of captured sessions.
 */
function generateSessionNonce(): Uint8Array {
  const nonce = new Uint8Array(16);
  // Use crypto.getRandomValues (available in RN via polyfill)
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(nonce);
  } else {
    // Fallback: use nacl.randomBytes
    const rand = require('tweetnacl').randomBytes(16);
    nonce.set(rand);
  }
  return nonce;
}

// ---------------------------------------------------------------------------
// BleTransport class
// ---------------------------------------------------------------------------

export class BleTransport {
  private manager: BleManager;
  private callbacks: BleTransportCallbacks;
  private isScanning = false;
  private _isPeripheralActive = false;
  private connectedDevice: Device | null = null;
  private peripheralPeerId: string | null = null; // Peer connected via peripheral mode
  private negotiatedMtu = 20;
  private chunkBuffers: Map<string, ChunkBuffer> = new Map();
  private discoveredPeers: Map<string, PeerInfo> = new Map();
  private peripheralSubscriptions: Array<{ remove: () => void }> = [];
  /** Session nonce for replay prevention (M12) — exchanged with peer during handshake */
  private localNonce: Uint8Array = generateSessionNonce();
  private remoteNonce: Uint8Array | null = null;

  constructor(callbacks: BleTransportCallbacks) {
    this.manager = getManager();
    this.callbacks = callbacks;
  }

  // -----------------------------------------------------------------------
  // Permissions
  // -----------------------------------------------------------------------

  async requestPermissions(): Promise<boolean> {
    if (Platform.OS === 'android' && Platform.Version >= 31) {
      const results = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);
      return Object.values(results).every(
        (r) => r === PermissionsAndroid.RESULTS.GRANTED,
      );
    }
    if (Platform.OS === 'android') {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      );
      return result === PermissionsAndroid.RESULTS.GRANTED;
    }
    return true;
  }

  // -----------------------------------------------------------------------
  // State check
  // -----------------------------------------------------------------------

  async isAvailable(): Promise<boolean> {
    const state = await this.manager.state();
    return state === State.PoweredOn;
  }

  async waitForPoweredOn(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sub = this.manager.onStateChange((state) => {
        if (state === State.PoweredOn) {
          sub.remove();
          resolve();
        } else if (state === State.Unsupported || state === State.Unauthorized) {
          sub.remove();
          reject(new Error(`BLE unavailable: ${state}`));
        }
      }, true);
    });
  }

  // =======================================================================
  // CENTRAL MODE — Sender scans, connects, writes
  // =======================================================================

  async startScanning(): Promise<void> {
    if (this.isScanning) return;

    const hasPerms = await this.requestPermissions();
    if (!hasPerms) throw new Error('BLE permissions denied');

    // On Android <12, BLE scanning requires Location Services to be ON
    // (not just the permission — the actual GPS/Location toggle in quick settings)
    if (Platform.OS === 'android' && Platform.Version < 31) {
      try {
        const { LocationServicesModule } = NativeModules;
        if (LocationServicesModule) {
          const enabled = await LocationServicesModule.isEnabled();
          if (!enabled) {
            throw new Error(
              'Location Services must be enabled for Bluetooth scanning. ' +
              'Please turn on Location in your phone settings.',
            );
          }
        }
      } catch (e: any) {
        // If the native module doesn't exist, just warn in console
        if (e.message?.includes('Location Services')) throw e;
        console.log('[BLE-DBG] Location check skipped (no native module)');
      }
    }

    await this.waitForPoweredOn();
    this.isScanning = true;

    this.manager.startDeviceScan(
      [BLE_SERVICE_UUID],
      { allowDuplicates: false },
      (error, device) => {
        if (error) {
          this.callbacks.onError(error as Error);
          return;
        }
        if (!device) return;

        const peer: PeerInfo = {
          id: device.id,
          publicKey: '',
          displayName: device.localName || device.name || 'P01 Device',
          transport: 'ble',
          rssi: device.rssi ?? undefined,
          lastSeen: Date.now(),
        };

        this.discoveredPeers.set(device.id, peer);
        this.callbacks.onPeerDiscovered(peer);
      },
    );
  }

  stopScanning(): void {
    if (!this.isScanning) return;
    this.manager.stopDeviceScan();
    this.isScanning = false;
  }

  async connectToPeer(peerId: string): Promise<Device> {
    this.stopScanning();

    console.log('[BLE-DBG] connectToPeer: connecting to', peerId);
    const device = await this.connectAndSetup(peerId);
    console.log('[BLE-DBG] connectToPeer: connected, MTU=', this.negotiatedMtu);

    this.connectedDevice = device;

    device.onDisconnected((err) => {
      console.log('[BLE-DBG] onDisconnected fired:', err?.message || 'no error');
      this.connectedDevice = null;
      this.callbacks.onPeerDisconnected(peerId);
    });

    // Subscribe to notifications from peripheral
    console.log('[BLE-DBG] connectToPeer: subscribing to notifications');
    this.monitorCharacteristic(device, BLE_PUBKEY_CHAR_UUID, peerId);
    this.monitorCharacteristic(device, BLE_DATA_CHAR_UUID, peerId);
    console.log('[BLE-DBG] connectToPeer: subscribed OK');

    const peer = this.discoveredPeers.get(peerId);
    if (peer) {
      this.callbacks.onPeerConnected(peer);
    }

    return device;
  }

  /**
   * Connect, discover services, and negotiate MTU.
   * Serialises GATT operations with small delays to avoid Samsung Exynos BLE bugs.
   */
  private async connectAndSetup(peerId: string): Promise<Device> {
    const device = await this.manager.connectToDevice(peerId);

    // Small delay before service discovery (Samsung GATT stability)
    await new Promise((r) => setTimeout(r, 300));

    await device.discoverAllServicesAndCharacteristics();

    // Small delay before MTU request
    await new Promise((r) => setTimeout(r, 200));

    // Negotiate MTU for larger chunks
    try {
      const mtuDevice = await device.requestMTU(BLE_TARGET_MTU);
      this.negotiatedMtu = mtuDevice.mtu;
    } catch {
      this.negotiatedMtu = 20;
    }

    return device;
  }

  // -----------------------------------------------------------------------
  // Central mode — Send (write to peripheral's characteristics)
  // -----------------------------------------------------------------------

  async sendPublicKey(publicKeyBase64: string): Promise<void> {
    console.log('[BLE-DBG] sendPublicKey: connectedDevice=', !!this.connectedDevice);
    if (!this.connectedDevice) throw new Error('Not connected');

    // M12: Prepend 16-byte session nonce to pubkey for replay prevention
    const nonceB64 = Buffer.from(this.localNonce).toString('base64');
    const data = Buffer.from(`${nonceB64}:${publicKeyBase64}`, 'utf-8');
    const chunks = this.fragment(MSG_TYPE_PUBKEY, new Uint8Array(data));
    console.log('[BLE-DBG] sendPublicKey: writing', chunks.length, 'chunks to', BLE_PUBKEY_CHAR_UUID);

    for (let i = 0; i < chunks.length; i++) {
      console.log('[BLE-DBG] sendPublicKey: writing chunk', i + 1, '/', chunks.length);
      try {
        await this.connectedDevice.writeCharacteristicWithResponseForService(
          BLE_SERVICE_UUID,
          BLE_PUBKEY_CHAR_UUID,
          Buffer.from(chunks[i]).toString('base64'),
        );
        console.log('[BLE-DBG] sendPublicKey: chunk', i + 1, 'written OK');
      } catch (err: any) {
        console.log('[BLE-DBG] sendPublicKey: chunk', i + 1, 'FAILED:', err?.reason, err?.message, err?.errorCode);
        throw err;
      }
    }
  }

  async sendEncryptedNote(encrypted: EncryptedNotePayload): Promise<void> {
    if (!this.connectedDevice) throw new Error('Not connected');

    const data = Buffer.from(JSON.stringify(encrypted), 'utf-8');
    const chunks = this.fragment(MSG_TYPE_NOTE, new Uint8Array(data));

    for (const chunk of chunks) {
      await this.connectedDevice.writeCharacteristicWithResponseForService(
        BLE_SERVICE_UUID,
        BLE_DATA_CHAR_UUID,
        Buffer.from(chunk).toString('base64'),
      );
    }
  }

  async sendAck(): Promise<void> {
    if (!this.connectedDevice) throw new Error('Not connected');

    const ack = new Uint8Array([MSG_TYPE_ACK, 0, 1, 0, 0x01]);
    await this.connectedDevice.writeCharacteristicWithResponseForService(
      BLE_SERVICE_UUID,
      BLE_DATA_CHAR_UUID,
      Buffer.from(ack).toString('base64'),
    );
  }

  // -----------------------------------------------------------------------
  // Central mode — Receive (monitor notifications from peripheral)
  // -----------------------------------------------------------------------

  private monitorCharacteristic(
    device: Device,
    charUUID: string,
    peerId: string,
  ): void {
    device.monitorCharacteristicForService(
      BLE_SERVICE_UUID,
      charUUID,
      (error, characteristic) => {
        if (error) {
          this.callbacks.onError(error as Error);
          return;
        }
        if (!characteristic?.value) return;

        const raw = new Uint8Array(Buffer.from(characteristic.value, 'base64'));
        this.processIncomingChunk(peerId, raw);
      },
    );
  }

  // =======================================================================
  // PERIPHERAL MODE — Receiver advertises, accepts connections, receives writes
  // =======================================================================

  async startPeripheral(): Promise<void> {
    if (this._isPeripheralActive) return;
    if (!BlePeripheralModule) {
      throw new Error('BLE peripheral mode not available on this platform');
    }

    const hasPerms = await this.requestPermissions();
    if (!hasPerms) throw new Error('BLE permissions denied');

    await this.waitForPoweredOn();

    // Set up native event listeners
    this.setupPeripheralListeners();

    // Start native GATT server + advertising
    await BlePeripheralModule.startPeripheral();
    this._isPeripheralActive = true;
  }

  async stopPeripheral(): Promise<void> {
    if (!this._isPeripheralActive) return;

    // Remove event listeners
    for (const sub of this.peripheralSubscriptions) {
      sub.remove();
    }
    this.peripheralSubscriptions = [];

    if (BlePeripheralModule) {
      try {
        await BlePeripheralModule.stopPeripheral();
      } catch {
        // Already stopped
      }
    }

    this._isPeripheralActive = false;
    this.peripheralPeerId = null;
  }

  private setupPeripheralListeners(): void {
    if (!peripheralEmitter) return;

    // Clean up any existing listeners
    for (const sub of this.peripheralSubscriptions) {
      sub.remove();
    }
    this.peripheralSubscriptions = [];

    // Peer connected to our GATT server
    this.peripheralSubscriptions.push(
      peripheralEmitter.addListener('BlePeripheralPeerConnected', (event: any) => {
        const { peerId, displayName } = event;
        this.peripheralPeerId = peerId;
        const peer: PeerInfo = {
          id: peerId,
          publicKey: '',
          displayName: displayName || 'P01 Device',
          transport: 'ble',
          lastSeen: Date.now(),
        };
        this.discoveredPeers.set(peerId, peer);
        this.callbacks.onPeerConnected(peer);
      }),
    );

    // Peer disconnected
    this.peripheralSubscriptions.push(
      peripheralEmitter.addListener('BlePeripheralPeerDisconnected', (event: any) => {
        const { peerId } = event;
        this.peripheralPeerId = null;
        this.callbacks.onPeerDisconnected(peerId);
      }),
    );

    // Data received via GATT write request — process chunks
    this.peripheralSubscriptions.push(
      peripheralEmitter.addListener('BlePeripheralDataReceived', (event: any) => {
        const { peerId, data } = event;
        const raw = new Uint8Array(Buffer.from(data, 'base64'));
        this.processIncomingChunk(peerId, raw);
      }),
    );

    // Native errors
    this.peripheralSubscriptions.push(
      peripheralEmitter.addListener('BlePeripheralError', (event: any) => {
        this.callbacks.onError(new Error(event.message || 'BLE peripheral error'));
      }),
    );
  }

  // -----------------------------------------------------------------------
  // Peripheral mode — Send via GATT notification to connected central
  // -----------------------------------------------------------------------

  async sendPublicKeyAsPeripheral(publicKeyBase64: string): Promise<void> {
    // M12: Prepend 16-byte session nonce to pubkey for replay prevention
    const nonceB64 = Buffer.from(this.localNonce).toString('base64');
    const data = Buffer.from(`${nonceB64}:${publicKeyBase64}`, 'utf-8');
    const chunks = this.fragment(MSG_TYPE_PUBKEY, new Uint8Array(data));

    for (const chunk of chunks) {
      await BlePeripheralModule.sendNotification(
        BLE_PUBKEY_CHAR_UUID,
        Buffer.from(chunk).toString('base64'),
      );
    }
  }

  async sendAckAsPeripheral(): Promise<void> {
    const ack = new Uint8Array([MSG_TYPE_ACK, 0, 1, 0, 0x01]);
    await BlePeripheralModule.sendNotification(
      BLE_DATA_CHAR_UUID,
      Buffer.from(ack).toString('base64'),
    );
  }

  isPeripheralActive(): boolean {
    return this._isPeripheralActive;
  }

  // =======================================================================
  // Shared — Fragmentation & reassembly
  // =======================================================================

  private maxPayloadPerChunk(): number {
    return Math.max(this.negotiatedMtu - 3 - FRAGMENT_HEADER_SIZE, 16);
  }

  private fragment(type: number, data: Uint8Array): Uint8Array[] {
    const chunkSize = this.maxPayloadPerChunk();
    const totalChunks = Math.ceil(data.length / chunkSize);
    const chunks: Uint8Array[] = [];

    for (let i = 0; i < totalChunks; i++) {
      const offset = i * chunkSize;
      const payload = data.slice(offset, offset + chunkSize);
      const chunk = new Uint8Array(FRAGMENT_HEADER_SIZE + payload.length);
      chunk[0] = type;
      chunk[1] = i;
      chunk[2] = totalChunks;
      chunk[3] = 0;
      chunk.set(payload, FRAGMENT_HEADER_SIZE);
      chunks.push(chunk);
    }

    return chunks;
  }

  private reassemble(peerId: string, chunk: Uint8Array): Uint8Array | null {
    if (chunk.length < FRAGMENT_HEADER_SIZE) return null;

    const header: FragmentHeader = {
      type: chunk[0],
      seq: chunk[1],
      totalChunks: chunk[2],
    };

    const bufferKey = `${peerId}:${header.type}`;
    let buffer = this.chunkBuffers.get(bufferKey);

    if (!buffer) {
      buffer = {
        totalChunks: header.totalChunks,
        type: header.type,
        received: new Map(),
      };
      this.chunkBuffers.set(bufferKey, buffer);
    }

    buffer.received.set(header.seq, chunk.slice(FRAGMENT_HEADER_SIZE));

    if (buffer.received.size >= buffer.totalChunks) {
      let totalLen = 0;
      for (const [, part] of buffer.received) totalLen += part.length;

      const result = new Uint8Array(totalLen);
      let offset = 0;
      for (let i = 0; i < buffer.totalChunks; i++) {
        const part = buffer.received.get(i)!;
        result.set(part, offset);
        offset += part.length;
      }

      this.chunkBuffers.delete(bufferKey);
      return result;
    }

    return null;
  }

  /**
   * Process an incoming raw chunk (from either central monitor or peripheral write request).
   * Reassembles and dispatches to the appropriate callback.
   */
  private processIncomingChunk(peerId: string, raw: Uint8Array): void {
    if (raw.length < FRAGMENT_HEADER_SIZE) return;

    const msgType = raw[0];
    const reassembled = this.reassemble(peerId, raw);
    if (!reassembled) return; // Still waiting for more chunks

    try {
      const decoded = Buffer.from(reassembled).toString('utf-8');

      if (msgType === MSG_TYPE_PUBKEY) {
        // M12: Parse nonce:pubkey format for replay prevention
        const colonIdx = decoded.indexOf(':');
        if (colonIdx > 0) {
          const remoteNonceB64 = decoded.slice(0, colonIdx);
          const pubKeyB64 = decoded.slice(colonIdx + 1);
          this.remoteNonce = new Uint8Array(Buffer.from(remoteNonceB64, 'base64'));
          this.callbacks.onPublicKeyReceived(peerId, pubKeyB64);
        } else {
          // Legacy format without nonce
          this.callbacks.onPublicKeyReceived(peerId, decoded);
        }
      } else if (msgType === MSG_TYPE_NOTE) {
        const encrypted: EncryptedNotePayload = JSON.parse(decoded);
        this.callbacks.onEncryptedNoteReceived(peerId, encrypted);
      } else if (msgType === MSG_TYPE_ACK) {
        this.callbacks.onAckReceived(peerId);
      }
    } catch (e) {
      this.callbacks.onError(
        new Error(`Failed to process BLE message: ${(e as Error).message}`),
      );
    }
  }

  // =======================================================================
  // Cleanup
  // =======================================================================

  async disconnect(): Promise<void> {
    if (this.connectedDevice) {
      try {
        await this.manager.cancelDeviceConnection(this.connectedDevice.id);
      } catch {
        // Already disconnected
      }
      this.connectedDevice = null;
    }
    this.stopScanning();
    await this.stopPeripheral();
    this.chunkBuffers.clear();
    // M12: Regenerate session nonce for next session (prevents replay)
    this.localNonce = generateSessionNonce();
    this.remoteNonce = null;
  }

  async destroy(): Promise<void> {
    await this.disconnect();
    this.discoveredPeers.clear();
  }

  /** M12: Get local+remote nonces for mixing into shared secret derivation */
  getSessionNonces(): { local: Uint8Array; remote: Uint8Array | null } {
    return { local: this.localNonce, remote: this.remoteNonce };
  }

  getDiscoveredPeers(): PeerInfo[] {
    return Array.from(this.discoveredPeers.values());
  }

  isConnected(): boolean {
    return this.connectedDevice !== null || this.peripheralPeerId !== null;
  }
}
