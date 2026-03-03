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
import { Platform, PermissionsAndroid, NativeModules, NativeEventEmitter } from 'react-native';
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

    const device = await this.manager.connectToDevice(peerId, {
      requestMTU: BLE_TARGET_MTU,
    });

    await device.discoverAllServicesAndCharacteristics();

    try {
      const mtuDevice = await device.requestMTU(BLE_TARGET_MTU);
      this.negotiatedMtu = mtuDevice.mtu;
    } catch {
      this.negotiatedMtu = 20;
    }

    this.connectedDevice = device;

    device.onDisconnected(() => {
      this.connectedDevice = null;
      this.callbacks.onPeerDisconnected(peerId);
    });

    // Subscribe to notifications from peripheral
    this.monitorCharacteristic(device, BLE_PUBKEY_CHAR_UUID, peerId);
    this.monitorCharacteristic(device, BLE_DATA_CHAR_UUID, peerId);

    const peer = this.discoveredPeers.get(peerId);
    if (peer) {
      this.callbacks.onPeerConnected(peer);
    }

    return device;
  }

  // -----------------------------------------------------------------------
  // Central mode — Send (write to peripheral's characteristics)
  // -----------------------------------------------------------------------

  async sendPublicKey(publicKeyBase64: string): Promise<void> {
    if (!this.connectedDevice) throw new Error('Not connected');

    const data = Buffer.from(publicKeyBase64, 'utf-8');
    const chunks = this.fragment(MSG_TYPE_PUBKEY, new Uint8Array(data));

    for (const chunk of chunks) {
      await this.connectedDevice.writeCharacteristicWithResponseForService(
        BLE_SERVICE_UUID,
        BLE_PUBKEY_CHAR_UUID,
        Buffer.from(chunk).toString('base64'),
      );
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
    const data = Buffer.from(publicKeyBase64, 'utf-8');
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
        this.callbacks.onPublicKeyReceived(peerId, decoded);
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
  }

  async destroy(): Promise<void> {
    await this.disconnect();
    this.discoveredPeers.clear();
  }

  getDiscoveredPeers(): PeerInfo[] {
    return Array.from(this.discoveredPeers.values());
  }

  isConnected(): boolean {
    return this.connectedDevice !== null || this.peripheralPeerId !== null;
  }
}
