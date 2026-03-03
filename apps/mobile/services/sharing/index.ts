/**
 * ShareService — Orchestrates BLE and NFC note sharing
 *
 * Singleton that bridges transport layers (BLE / NFC) with the existing
 * ZK Shielded and Denominated Pool export/import logic.
 */

import nacl from 'tweetnacl';
import { Buffer } from 'buffer';
import { BleTransport, type BleTransportCallbacks } from './transport/ble';
import { NfcTransport, type NfcTransportCallbacks } from './transport/nfc';
import {
  generateEphemeralKeyPair,
  encryptNote,
  decryptNote,
  computeChecksum,
  type EphemeralKeyPair,
} from './crypto/sessionCrypto';
import { computeFingerprint } from './crypto/fingerprint';
import type {
  NotePayload,
  NoteType,
  EncryptedNotePayload,
  PeerInfo,
  ShareSession,
  ShareRecord,
} from './types';

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: ShareService | null = null;

export function getShareService(): ShareService {
  if (!_instance) {
    _instance = new ShareService();
  }
  return _instance;
}

// ---------------------------------------------------------------------------
// Callbacks (for store integration)
// ---------------------------------------------------------------------------

export interface ShareServiceCallbacks {
  onSessionUpdate: (session: Partial<ShareSession>) => void;
  onPeerDiscovered: (peer: PeerInfo) => void;
  onPeerRemoved: (peerId: string) => void;
  onNoteReceived: (payload: NotePayload) => void;
  onError: (error: string) => void;
  onShareComplete: (record: ShareRecord) => void;
}

// ---------------------------------------------------------------------------
// ShareService
// ---------------------------------------------------------------------------

export class ShareService {
  private bleTransport: BleTransport | null = null;
  private nfcTransport: NfcTransport | null = null;
  private ephemeralKeyPair: EphemeralKeyPair | null = null;
  private remotePubKey: Uint8Array | null = null;
  private callbacks: ShareServiceCallbacks | null = null;
  private currentSession: Partial<ShareSession> = {};

  setCallbacks(cb: ShareServiceCallbacks): void {
    this.callbacks = cb;
  }

  // -----------------------------------------------------------------------
  // Prepare note payload (wraps existing export functions)
  // -----------------------------------------------------------------------

  /**
   * Wrap exported note data into a universal NotePayload.
   *
   * @param noteType   - 'zk-shielded' or 'denominated-pool'
   * @param exportedData - Raw output of exportNote() from the respective service
   *   - ZK Shielded: string from ZkService.exportNote() (format: "p01note:<base64>")
   *   - Denominated Pool: string from encodeShareableNote() (base64 JSON)
   */
  prepareNote(noteType: NoteType, exportedData: string): NotePayload {
    return {
      version: 1,
      type: noteType,
      data: exportedData,
      ts: Date.now(),
      checksum: computeChecksum(exportedData),
    };
  }

  // -----------------------------------------------------------------------
  // Import received note (wraps existing import functions)
  // -----------------------------------------------------------------------

  /**
   * Validate checksum of a received NotePayload.
   * The actual import (on-chain verification etc.) is done by the caller
   * via the respective store's importNote().
   */
  validatePayload(payload: NotePayload): void {
    if (payload.version !== 1) {
      throw new Error(`Unsupported payload version: ${payload.version}`);
    }
    const expected = computeChecksum(payload.data);
    if (expected !== payload.checksum) {
      throw new Error('Note checksum mismatch — data may be corrupted');
    }
  }

  // -----------------------------------------------------------------------
  // BLE — Sender flow
  // -----------------------------------------------------------------------

  async initBle(): Promise<void> {
    if (this.bleTransport) return;

    const callbacks: BleTransportCallbacks = {
      onPeerDiscovered: (peer) => this.callbacks?.onPeerDiscovered(peer),
      onPeerConnected: (peer) => {
        this.updateSession({ state: 'key-exchange', peer });
      },
      onPeerDisconnected: (peerId) => {
        this.callbacks?.onPeerRemoved(peerId);
        if (this.currentSession.peer?.id === peerId) {
          this.updateSession({ state: 'error', error: 'Peer disconnected' });
        }
      },
      onPublicKeyReceived: (peerId, pubKeyB64) => {
        this.remotePubKey = new Uint8Array(Buffer.from(pubKeyB64, 'base64'));

        const localPubB64 = this.ephemeralKeyPair
          ? Buffer.from(this.ephemeralKeyPair.publicKey).toString('base64')
          : '';

        // If we're the receiver (peripheral mode), send our pubkey back via notification
        if (!this.currentSession.isSender && this.bleTransport?.isPeripheralActive() && localPubB64) {
          this.bleTransport.sendPublicKeyAsPeripheral(localPubB64).catch((err) => {
            this.callbacks?.onError(`Failed to send pubkey: ${(err as Error).message}`);
          });
        }

        const fingerprint = computeFingerprint(localPubB64, pubKeyB64);

        const updatedPeer: PeerInfo = {
          ...(this.currentSession.peer || { id: peerId, transport: 'ble', lastSeen: Date.now() }),
          publicKey: pubKeyB64,
        };

        this.updateSession({
          state: 'verifying-fingerprint',
          peer: updatedPeer,
          fingerprint,
        });
      },
      onEncryptedNoteReceived: (peerId, encrypted) => {
        this.handleReceivedNote(encrypted);
      },
      onAckReceived: () => {
        this.updateSession({ state: 'success' });
        this.emitShareRecord('sent');
      },
      onError: (error) => {
        this.callbacks?.onError(error.message);
        this.updateSession({ state: 'error', error: error.message });
      },
    };

    this.bleTransport = new BleTransport(callbacks);
  }

  async startBleScan(): Promise<void> {
    await this.initBle();
    this.ephemeralKeyPair = generateEphemeralKeyPair();
    this.updateSession({
      state: 'scanning',
      transport: 'ble',
      isSender: true,
      localPublicKey: Buffer.from(this.ephemeralKeyPair.publicKey).toString('base64'),
      createdAt: Date.now(),
    });
    await this.bleTransport!.startScanning();
  }

  stopBleScan(): void {
    this.bleTransport?.stopScanning();
  }

  async connectToPeer(peerId: string): Promise<void> {
    if (!this.bleTransport) throw new Error('BLE not initialized');

    this.updateSession({ state: 'connecting' });
    await this.bleTransport.connectToPeer(peerId);

    // Send our public key
    if (this.ephemeralKeyPair) {
      const pubB64 = Buffer.from(this.ephemeralKeyPair.publicKey).toString('base64');
      await this.bleTransport.sendPublicKey(pubB64);
    }
  }

  /**
   * User confirmed fingerprint matches — proceed to send the note.
   */
  async confirmFingerprintAndSend(payload: NotePayload): Promise<void> {
    if (!this.bleTransport || !this.ephemeralKeyPair || !this.remotePubKey) {
      throw new Error('BLE session not ready');
    }

    this.updateSession({ state: 'encrypting', notePayload: payload });

    const encrypted = encryptNote(payload, this.remotePubKey, this.ephemeralKeyPair);

    this.updateSession({ state: 'sending' });
    await this.bleTransport.sendEncryptedNote(encrypted);

    // Wait for ACK — the callback will transition to 'success'
  }

  // -----------------------------------------------------------------------
  // BLE — Receiver flow
  // -----------------------------------------------------------------------

  async startBleReceiver(): Promise<void> {
    await this.initBle();
    this.ephemeralKeyPair = generateEphemeralKeyPair();
    this.updateSession({
      state: 'scanning', // "scanning" = advertising/waiting for receiver
      transport: 'ble',
      isSender: false,
      localPublicKey: Buffer.from(this.ephemeralKeyPair.publicKey).toString('base64'),
      createdAt: Date.now(),
    });
    // Receiver: advertise via native GATT server so sender can find us
    await this.bleTransport!.startPeripheral();
  }

  async confirmFingerprintAndReceive(): Promise<void> {
    // Fingerprint verified — just wait for the encrypted note
    // The BLE callback onEncryptedNoteReceived will handle the rest
    this.updateSession({ state: 'receiving' });
  }

  private handleReceivedNote(encrypted: EncryptedNotePayload): void {
    try {
      if (!this.ephemeralKeyPair || !this.remotePubKey) {
        throw new Error('Session keys not available');
      }

      this.updateSession({ state: 'decrypting' });

      const payload = decryptNote(encrypted, this.remotePubKey, this.ephemeralKeyPair.secretKey);

      // Validate checksum
      this.validatePayload(payload);

      this.updateSession({ state: 'importing', notePayload: payload });
      this.callbacks?.onNoteReceived(payload);

      // Send ACK — use peripheral notification if in receiver mode, else central write
      if (this.bleTransport?.isPeripheralActive()) {
        this.bleTransport.sendAckAsPeripheral().catch(() => {});
      } else {
        this.bleTransport?.sendAck().catch(() => {});
      }

      this.updateSession({ state: 'success' });
      this.emitShareRecord('received');
    } catch (error) {
      const msg = (error as Error).message;
      this.callbacks?.onError(msg);
      this.updateSession({ state: 'error', error: msg });
    }
  }

  // -----------------------------------------------------------------------
  // NFC — Sender flow
  // -----------------------------------------------------------------------

  async initNfc(): Promise<boolean> {
    if (!this.nfcTransport) {
      const callbacks: NfcTransportCallbacks = {
        onNfcAvailable: () => {},
        onNoteReceived: (payload) => {
          this.validatePayload(payload);
          this.updateSession({ state: 'success', notePayload: payload });
          this.callbacks?.onNoteReceived(payload);
          this.emitShareRecord('received');
        },
        onWriteComplete: () => {
          this.updateSession({ state: 'success' });
          this.emitShareRecord('sent');
        },
        onError: (error) => {
          this.callbacks?.onError(error.message);
          this.updateSession({ state: 'error', error: error.message });
        },
      };
      this.nfcTransport = new NfcTransport(callbacks);
    }
    return this.nfcTransport.checkAvailable();
  }

  async sendViaNfc(payload: NotePayload, pin: string): Promise<void> {
    await this.initNfc();
    this.updateSession({
      state: 'sending',
      transport: 'nfc',
      isSender: true,
      notePayload: payload,
      createdAt: Date.now(),
    });
    await this.nfcTransport!.prepareToSend(payload, pin);
  }

  async startNfcReceiver(pin: string): Promise<void> {
    await this.initNfc();
    this.updateSession({
      state: 'receiving',
      transport: 'nfc',
      isSender: false,
      createdAt: Date.now(),
    });
    await this.nfcTransport!.startReceiving(pin);
  }

  generateNfcPin(): string {
    if (!this.nfcTransport) {
      // Quick init just for PIN generation
      const n = Math.floor(Math.random() * 1_000_000);
      return n.toString().padStart(6, '0');
    }
    return this.nfcTransport.generatePin();
  }

  // -----------------------------------------------------------------------
  // Availability checks
  // -----------------------------------------------------------------------

  async isBleAvailable(): Promise<boolean> {
    await this.initBle();
    return this.bleTransport!.isAvailable();
  }

  async isNfcAvailable(): Promise<boolean> {
    return this.initNfc();
  }

  // -----------------------------------------------------------------------
  // Session helpers
  // -----------------------------------------------------------------------

  private updateSession(updates: Partial<ShareSession>): void {
    this.currentSession = { ...this.currentSession, ...updates };
    this.callbacks?.onSessionUpdate(this.currentSession);
  }

  private emitShareRecord(direction: 'sent' | 'received'): void {
    const payload = this.currentSession.notePayload;
    if (!payload || !this.callbacks) return;

    const record: ShareRecord = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      noteType: payload.type,
      transport: this.currentSession.transport || 'ble',
      direction,
      peerDisplayName: this.currentSession.peer?.displayName,
      timestamp: Date.now(),
    };

    this.callbacks.onShareComplete(record);
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  async cancelSession(): Promise<void> {
    await this.bleTransport?.disconnect();
    await this.nfcTransport?.destroy();
    this.ephemeralKeyPair = null;
    this.remotePubKey = null;
    this.currentSession = {};
    this.updateSession({ state: 'idle' });
  }

  async destroy(): Promise<void> {
    await this.bleTransport?.destroy();
    await this.nfcTransport?.destroy();
    this.bleTransport = null;
    this.nfcTransport = null;
    this.ephemeralKeyPair = null;
    this.remotePubKey = null;
    this.currentSession = {};
    _instance = null;
  }
}
