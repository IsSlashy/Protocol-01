/**
 * P2P Note Sharing — Types
 *
 * Defines types for BLE and NFC note sharing between devices.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export type NoteType = 'zk-shielded' | 'denominated-pool';
export type TransportType = 'ble' | 'nfc';

export type ShareSessionState =
  | 'idle'
  | 'scanning'
  | 'connecting'
  | 'key-exchange'
  | 'verifying-fingerprint'
  | 'encrypting'
  | 'sending'
  | 'receiving'
  | 'decrypting'
  | 'importing'
  | 'success'
  | 'error';

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/** Cleartext note payload — wraps either export format */
export interface NotePayload {
  /** Protocol version */
  version: 1;
  /** Which circuit/pool system the note belongs to */
  type: NoteType;
  /** Raw output of exportNote() — base64 string or encoded JSON */
  data: string;
  /** Timestamp (ms) when the payload was created */
  ts: number;
  /** SHA-256 hex of `data` for integrity check */
  checksum: string;
}

/** Encrypted payload for BLE (asymmetric via nacl.box) */
export interface EncryptedNotePayload {
  /** Sender ephemeral X25519 public key (base64) */
  epk: string;
  /** Ciphertext (base64) */
  ct: string;
  /** Nonce (base64) */
  n: string;
  /** Protocol version */
  v: 1;
}

/** Encrypted payload for NFC (symmetric via nacl.secretbox) */
export interface SymmetricEncryptedPayload {
  /** Ciphertext (base64) */
  ct: string;
  /** Nonce (base64) */
  n: string;
  /** MIME type tag */
  mime: 'application/vnd.p01.note';
  /** Protocol version */
  v: 1;
}

// ---------------------------------------------------------------------------
// Peers & Sessions
// ---------------------------------------------------------------------------

export interface PeerInfo {
  /** Unique device ID (BLE peripheral ID or NFC tag ID) */
  id: string;
  /** Peer's X25519 public key (base64) — set after key exchange */
  publicKey: string;
  /** Optional display name advertised by the peer */
  displayName?: string;
  /** Which transport was used to discover this peer */
  transport: TransportType;
  /** BLE signal strength (dBm), undefined for NFC */
  rssi?: number;
  /** Timestamp of last seen */
  lastSeen: number;
}

export interface ShareSession {
  /** Unique session ID */
  id: string;
  /** Current session state */
  state: ShareSessionState;
  /** Transport in use */
  transport: TransportType;
  /** Remote peer (set after connection) */
  peer?: PeerInfo;
  /** Our ephemeral keypair public key (base64) for this session */
  localPublicKey?: string;
  /** Visual fingerprint for MITM verification (BLE only) */
  fingerprint?: string;
  /** Note being sent or received */
  notePayload?: NotePayload;
  /** Error message if state === 'error' */
  error?: string;
  /** Whether we are the sender (true) or receiver (false) */
  isSender: boolean;
  /** Session creation timestamp */
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Share history
// ---------------------------------------------------------------------------

export interface ShareRecord {
  id: string;
  noteType: NoteType;
  transport: TransportType;
  direction: 'sent' | 'received';
  peerDisplayName?: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// BLE Constants
// ---------------------------------------------------------------------------

/** P01 Note Sharing BLE Service UUID (compatible AnonMesh schema) */
export const BLE_SERVICE_UUID = 'F47B5E2D-4A9E-4C5A-9B3F-8E1D2C3A4B5A';

/** Characteristic for public key exchange */
export const BLE_PUBKEY_CHAR_UUID = 'F47B5E2D-4A9E-4C5A-9B3F-8E1D2C3A4B5B';

/** Characteristic for encrypted data exchange */
export const BLE_DATA_CHAR_UUID = 'F47B5E2D-4A9E-4C5A-9B3F-8E1D2C3A4B5C';

/** Target MTU for BLE data transfer */
export const BLE_TARGET_MTU = 512;

/** BLE advertising local name */
export const BLE_LOCAL_NAME = 'P01-Share';

// ---------------------------------------------------------------------------
// Fragment header for BLE chunked transfer
// ---------------------------------------------------------------------------

/** 4-byte header: [type(1), seq(1), totalChunks(1), reserved(1)] */
export interface FragmentHeader {
  /** Message type: 0x01 = pubkey, 0x02 = encrypted note, 0x03 = ack */
  type: number;
  /** Sequence number (0-indexed) */
  seq: number;
  /** Total number of chunks */
  totalChunks: number;
}

export const FRAGMENT_HEADER_SIZE = 4;
export const MSG_TYPE_PUBKEY = 0x01;
export const MSG_TYPE_NOTE = 0x02;
export const MSG_TYPE_ACK = 0x03;

// ---------------------------------------------------------------------------
// NFC Constants
// ---------------------------------------------------------------------------

export const NFC_MIME_TYPE = 'application/vnd.p01.note';
export const NFC_KEY_DOMAIN = 'P01_NFC_';
