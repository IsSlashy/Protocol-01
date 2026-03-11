/**
 * NFC Transport — Phone-to-phone note sharing via HCE (Host Card Emulation)
 *
 * Android Beam was removed in Android 14, so we use HCE instead:
 *   - Sender: Native HCE service emulates an NFC tag containing the encrypted note
 *   - Receiver: Reads from the sender's HCE "tag" using IsoDep APDU commands
 *
 * Protocol:
 *   1. Sender displays a 6-digit PIN
 *   2. Receiver enters the PIN
 *   3. Sender encrypts note with PIN-derived key, sets data on HCE service
 *   4. Phones tap → receiver reads data via APDU, decrypts
 *
 * APDU protocol (custom AID: F050303100):
 *   SELECT AID   → SW 9000
 *   GET LENGTH   → [len_hi, len_lo, 90, 00]
 *   GET DATA(off)→ [chunk..., 90, 00]
 */

import NfcManager, { NfcTech } from 'react-native-nfc-manager';
import { NativeModules } from 'react-native';
import { Buffer } from 'buffer';
import * as Crypto from 'expo-crypto';
import type { NotePayload, SymmetricEncryptedPayload } from '../types';
import {
  encryptNoteSymmetric,
  decryptNoteSymmetricWithRetry,
  deriveNfcKey,
} from '../crypto/sessionCrypto';

const { NfcHceModule } = NativeModules;

// Our custom AID: F050303100
const SELECT_AID_CMD = [0x00, 0xA4, 0x04, 0x00, 0x05, 0xF0, 0x50, 0x30, 0x31, 0x00];
const GET_LENGTH_CMD = [0x00, 0xB1, 0x00, 0x00];
const SW_OK_HI = 0x90;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NfcTransportCallbacks {
  onNfcAvailable: (available: boolean) => void;
  onNoteReceived: (payload: NotePayload) => void;
  onWriteComplete: () => void;
  onError: (error: Error) => void;
}

// ---------------------------------------------------------------------------
// NfcTransport class
// ---------------------------------------------------------------------------

export class NfcTransport {
  private callbacks: NfcTransportCallbacks;
  private isInitialized = false;

  constructor(callbacks: NfcTransportCallbacks) {
    this.callbacks = callbacks;
  }

  // -----------------------------------------------------------------------
  // Availability
  // -----------------------------------------------------------------------

  async checkAvailable(): Promise<boolean> {
    try {
      const supported = await NfcManager.isSupported();
      if (!supported) {
        this.callbacks.onNfcAvailable(false);
        return false;
      }

      await NfcManager.start();
      this.isInitialized = true;
      const enabled = await NfcManager.isEnabled();
      this.callbacks.onNfcAvailable(enabled);
      return enabled;
    } catch {
      this.callbacks.onNfcAvailable(false);
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Generate PIN
  // -----------------------------------------------------------------------

  generatePin(): string {
    const bytes = Crypto.getRandomBytes(4);
    const n = new DataView(bytes.buffer).getUint32(0) % 1_000_000;
    return n.toString().padStart(6, '0');
  }

  // -----------------------------------------------------------------------
  // Sender — Set encrypted note on HCE service, wait for tap
  // -----------------------------------------------------------------------

  async prepareToSend(payload: NotePayload, pin: string): Promise<void> {
    if (!this.isInitialized) {
      await this.checkAvailable();
    }

    try {
      const key = deriveNfcKey(pin);
      const encrypted = encryptNoteSymmetric(payload, key);
      const jsonBytes = Buffer.from(JSON.stringify(encrypted), 'utf-8');
      const base64Data = jsonBytes.toString('base64');

      // Set data on the native HCE service — it will serve this when tapped
      if (!NfcHceModule) {
        throw new Error('NFC HCE module not available');
      }
      await NfcHceModule.setNoteData(base64Data);

      // Wait for the receiver to actually tap and read all the data.
      // The promise resolves when the HCE service detects a complete read.
      await NfcHceModule.waitForTransfer();

      // Clear data after successful transfer
      NfcHceModule.clearNoteData().catch(() => {});

      this.callbacks.onWriteComplete();
    } catch (error) {
      // Clean up
      NfcHceModule?.clearNoteData().catch(() => {});
      this.callbacks.onError(
        new Error(`NFC send failed: ${(error as Error).message}`),
      );
    }
  }

  // -----------------------------------------------------------------------
  // Receiver — Read encrypted note from sender's HCE service via IsoDep
  // -----------------------------------------------------------------------

  async startReceiving(pin: string): Promise<void> {
    if (!this.isInitialized) {
      await this.checkAvailable();
    }

    try {
      // Request IsoDep technology — waits for NFC tap
      await NfcManager.requestTechnology(NfcTech.IsoDep);

      // SELECT our custom AID
      const selectResp = await NfcManager.isoDepHandler.transceive(SELECT_AID_CMD);
      if (!checkSW(selectResp)) {
        throw new Error('NFC SELECT failed — sender may not be ready');
      }

      // GET LENGTH
      const lenResp = await NfcManager.isoDepHandler.transceive(GET_LENGTH_CMD);
      if (!checkSW(lenResp) || lenResp.length < 4) {
        throw new Error('NFC GET LENGTH failed — no data on sender');
      }
      const totalLen = ((lenResp[0] & 0xFF) << 8) | (lenResp[1] & 0xFF);

      if (totalLen === 0 || totalLen > 100_000) {
        throw new Error(`Invalid data length: ${totalLen}`);
      }

      // GET DATA in chunks
      const allBytes: number[] = [];
      let offset = 0;

      while (offset < totalLen) {
        const readCmd = [
          0x00, 0xB0,
          (offset >> 8) & 0xFF,
          offset & 0xFF,
        ];
        const chunkResp = await NfcManager.isoDepHandler.transceive(readCmd);

        if (!checkSW(chunkResp)) {
          throw new Error(`NFC read failed at offset ${offset}`);
        }

        // Data is everything except the last 2 bytes (SW)
        const chunkData = chunkResp.slice(0, chunkResp.length - 2);
        allBytes.push(...chunkData);
        offset += chunkData.length;
      }

      // Parse and decrypt — try current, previous, and next minute windows
      // to handle the race condition where sender encrypts at xx:59 and
      // receiver decrypts at xx+1:01 (different minute-rounded timestamps)
      const payloadStr = Buffer.from(allBytes).toString('utf-8');
      const encrypted: SymmetricEncryptedPayload = JSON.parse(payloadStr);
      const notePayload = decryptNoteSymmetricWithRetry(encrypted, pin);

      this.callbacks.onNoteReceived(notePayload);
    } catch (error) {
      const wrapped = new Error(`NFC receive failed: ${(error as Error).message}`);
      this.callbacks.onError(wrapped);
      // Re-throw so the caller (ShareService → sharingStore → UI) can also handle it
      throw wrapped;
    } finally {
      await this.cancelTechnology();
    }
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  private async cancelTechnology(): Promise<void> {
    try {
      await NfcManager.cancelTechnologyRequest();
    } catch {
      // Not in a technology session
    }
  }

  async destroy(): Promise<void> {
    await this.cancelTechnology();
    // Clear any pending HCE data
    NfcHceModule?.clearNoteData().catch(() => {});
    this.isInitialized = false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check that the last 2 bytes of an APDU response are SW 9000 (success). */
function checkSW(response: number[]): boolean {
  if (response.length < 2) return false;
  return (
    response[response.length - 2] === SW_OK_HI &&
    response[response.length - 1] === 0x00
  );
}
