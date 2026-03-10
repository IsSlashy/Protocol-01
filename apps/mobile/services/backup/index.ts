/**
 * Encrypted Backup Service
 *
 * Bundles wallet seed + denominated pool notes + app settings into a single
 * password-encrypted backup payload.
 *
 * Encryption: XSalsa20-Poly1305 (nacl.secretbox) with key derived from
 * password via SHA-512 (nacl.hash) + domain separation.
 *
 * Backup format: base64-encoded JSON envelope:
 * {
 *   v: 1,                       // format version
 *   n: string,                  // nonce (base64)
 *   ct: string,                 // ciphertext (base64)
 *   salt: string,               // salt (base64)
 *   hint: string,               // user-provided password hint
 *   createdAt: number,          // timestamp
 *   publicKey: string,          // wallet public key (for identification)
 *   noteCount: number,          // number of notes included
 * }
 */

import nacl from 'tweetnacl';
import { Buffer } from 'buffer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getMnemonic, getPublicKey } from '../solana/wallet';
import { useDenominatedPoolStore } from '../../stores/denominatedPoolStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { getCluster } from '../solana/connection';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackupEnvelope {
  v: 1;
  n: string;       // nonce base64
  ct: string;       // ciphertext base64
  salt: string;     // salt base64
  hint: string;     // password hint
  createdAt: number;
  // publicKey and noteCount are inside the encrypted payload only (L7: no metadata leakage)
}

export interface BackupPayload {
  version: 1;
  mnemonic: string;
  publicKey: string;
  notes: string[];           // base64-encoded shareable notes
  settings: {
    currency: string;
    network: string;
    hideBalanceByDefault: boolean;
  };
  createdAt: number;
}

export interface BackupMetadata {
  createdAt: number;
  hint: string;
}

// Storage key for backup status
const BACKUP_STATUS_KEY = 'p01_backup_status';
const LAST_BACKUP_KEY = 'p01_last_backup_at';

// ---------------------------------------------------------------------------
// Key Derivation
// ---------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/**
 * Derive a 32-byte symmetric key from password + salt.
 * Uses nacl.hash (SHA-512) with domain separation, iterated 100,000 times
 * for proper key stretching. Salt is re-incorporated each iteration.
 */
function deriveKey(password: string, salt: Uint8Array): Uint8Array {
  const domain = 'P01_BACKUP_V1';
  let key = nacl.hash(new TextEncoder().encode(`${domain}:${toBase64(salt)}:${password}`));

  // 100,000 iterations of SHA-512 with salt re-incorporation
  for (let i = 0; i < 100_000; i++) {
    const combined = new Uint8Array(key.length + salt.length);
    combined.set(key, 0);
    combined.set(salt, key.length);
    key = nacl.hash(combined);
  }

  return key.slice(0, 32); // 32 bytes for nacl.secretbox
}

// ---------------------------------------------------------------------------
// Backup Status Persistence
// ---------------------------------------------------------------------------

export async function getBackupStatus(): Promise<{ backedUp: boolean; lastBackupAt: number | null }> {
  try {
    const [status, lastBackup] = await Promise.all([
      AsyncStorage.getItem(BACKUP_STATUS_KEY),
      AsyncStorage.getItem(LAST_BACKUP_KEY),
    ]);
    return {
      backedUp: status === 'true',
      lastBackupAt: lastBackup ? parseInt(lastBackup, 10) : null,
    };
  } catch {
    return { backedUp: false, lastBackupAt: null };
  }
}

export async function setBackupStatus(backedUp: boolean): Promise<void> {
  await AsyncStorage.setItem(BACKUP_STATUS_KEY, backedUp ? 'true' : 'false');
  if (backedUp) {
    await AsyncStorage.setItem(LAST_BACKUP_KEY, String(Date.now()));
  }
}

// ---------------------------------------------------------------------------
// Export (Create Backup)
// ---------------------------------------------------------------------------

/**
 * Create an encrypted backup of the wallet + notes.
 * Returns a base64 string that can be saved/shared.
 */
export async function createEncryptedBackup(
  password: string,
  hint: string = '',
): Promise<string> {
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  // Gather data
  const mnemonic = await getMnemonic();
  if (!mnemonic) {
    throw new Error('No wallet found — cannot create backup');
  }

  const publicKey = await getPublicKey();
  if (!publicKey) {
    throw new Error('Wallet public key not found');
  }

  // Export denominated pool notes
  const poolStore = useDenominatedPoolStore.getState();
  const notes = poolStore.exportAllNotes();

  // Get settings
  const settingsStore = useSettingsStore.getState();

  const payload: BackupPayload = {
    version: 1,
    mnemonic,
    publicKey,
    notes,
    settings: {
      currency: settingsStore.currency ?? 'USD',
      network: getCluster() ?? 'devnet',
      hideBalanceByDefault: false,
    },
    createdAt: Date.now(),
  };

  // Encrypt
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const salt = nacl.randomBytes(32);
  const key = deriveKey(password, salt);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength); // 24 bytes

  const ciphertext = nacl.secretbox(plaintext, nonce, key);
  if (!ciphertext) {
    throw new Error('Encryption failed');
  }

  const envelope: BackupEnvelope = {
    v: 1,
    n: toBase64(nonce),
    ct: toBase64(ciphertext),
    salt: toBase64(salt),
    hint,
    createdAt: Date.now(),
    // publicKey and noteCount omitted — inside encrypted payload only (L7)
  };

  // Mark as backed up
  await setBackupStatus(true);

  return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

// ---------------------------------------------------------------------------
// Import (Restore Backup)
// ---------------------------------------------------------------------------

/**
 * Parse backup metadata without decrypting (for preview).
 */
export function parseBackupMetadata(encoded: string): BackupMetadata | null {
  try {
    const json = Buffer.from(encoded, 'base64').toString('utf-8');
    const envelope: BackupEnvelope = JSON.parse(json);

    if (envelope.v !== 1) return null;

    return {
      createdAt: envelope.createdAt,
      hint: envelope.hint,
      // publicKey and noteCount are inside the encrypted payload (L7)
    };
  } catch {
    return null;
  }
}

/**
 * Decrypt an encrypted backup with the given password.
 * Returns the raw payload for the caller to restore.
 */
export function decryptBackup(encoded: string, password: string): BackupPayload {
  let json: string;
  try {
    json = Buffer.from(encoded, 'base64').toString('utf-8');
  } catch {
    throw new Error('Invalid backup format — not valid base64');
  }

  let envelope: BackupEnvelope;
  try {
    envelope = JSON.parse(json);
  } catch {
    throw new Error('Invalid backup format — not valid JSON');
  }

  if (envelope.v !== 1) {
    throw new Error(`Unsupported backup version: ${envelope.v}`);
  }

  const salt = fromBase64(envelope.salt);
  const nonce = fromBase64(envelope.n);
  const ciphertext = fromBase64(envelope.ct);
  const key = deriveKey(password, salt);

  const plaintext = nacl.secretbox.open(ciphertext, nonce, key);
  if (!plaintext) {
    throw new Error('Wrong password — decryption failed');
  }

  let payload: BackupPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error('Corrupted backup — decrypted data is not valid JSON');
  }

  if (payload.version !== 1) {
    throw new Error(`Unsupported payload version: ${payload.version}`);
  }

  return payload;
}

/**
 * Restore notes from a decrypted backup payload.
 * Returns the number of notes imported.
 */
export function restoreNotes(payload: BackupPayload): number {
  if (!payload.notes || payload.notes.length === 0) return 0;

  const poolStore = useDenominatedPoolStore.getState();
  let imported = 0;

  for (const encodedNote of payload.notes) {
    try {
      poolStore.importNote(encodedNote, 'imported_backup');
      imported++;
    } catch (err) {
      // Skip invalid notes — may already exist or be from different network
      console.warn('[Backup] Failed to import note:', (err as Error).message);
    }
  }

  return imported;
}
