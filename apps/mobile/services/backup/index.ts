/**
 * Encrypted Backup Service
 *
 * Bundles wallet seed (OR hardware spending seed) + denominated pool notes + app
 * settings into a single password-encrypted backup payload.
 *
 * Encryption: XSalsa20-Poly1305 (nacl.secretbox).
 *
 * KDF (spec §1C / Finding #11, locked decision):
 *   - v2 (current): PBKDF2-HMAC-SHA512, 600,000 iterations. Matches the
 *     extension's PBKDF2-600k for cross-platform consistency.
 *   - v1 (legacy):  iterated nacl.hash (SHA-512) ×100,000. KEPT READ-COMPAT.
 *
 * Migration: decrypt accepts BOTH versions (the envelope `v` selects the KDF).
 * A decrypted v1 backup is flagged `legacy` so the UI re-encrypts at v2 on the
 * next save ("re-encrypt existing on next open"). New backups are always v2.
 *
 * Payload `kind`:
 *   - 'seed'     : has `mnemonic` (local keypair wallet). Default.
 *   - 'hardware' : has `p01SpendingSeed` (hex) + `ledgerPath`, NO `mnemonic`.
 *                  Restoring writes the RAW spending seed to SecureStore and sets
 *                  walletKind='hardware' WITHOUT importWallet (a Ledger has no
 *                  mnemonic on this device). The seed is RAW per spec §0.
 *
 * Backup envelope (base64-encoded JSON):
 * {
 *   v: 1 | 2,                   // format/KDF version
 *   n, ct, salt: string(base64),
 *   hint: string,
 *   createdAt: number,
 * }
 * publicKey/noteCount/kind live INSIDE the encrypted payload only (L7).
 */

import nacl from 'tweetnacl';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { Buffer } from 'buffer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getMnemonic, getPublicKey, getWalletKind, setHardwareWallet } from '../solana/wallet';
import { useDenominatedPoolStore } from '../../stores/denominatedPoolStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { getCluster } from '../solana/connection';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current envelope/KDF version. */
const CURRENT_BACKUP_VERSION = 2 as const;
/** PBKDF2 iterations for v2 (matches extension PBKDF2-600k). */
const PBKDF2_ITERATIONS = 600_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BackupVersion = 1 | 2;

export interface BackupEnvelope {
  v: BackupVersion;
  n: string;       // nonce base64
  ct: string;       // ciphertext base64
  salt: string;     // salt base64
  hint: string;     // password hint
  createdAt: number;
  // publicKey/noteCount/kind are inside the encrypted payload only (L7).
}

export type BackupWalletKind = 'seed' | 'hardware';

export interface BackupPayload {
  /** Payload schema version. 1 = original seed-only; 2 = adds `kind`/hardware. */
  version: 1 | 2;
  /** Wallet kind. Absent in legacy v1 payloads → treated as 'seed'. */
  kind?: BackupWalletKind;
  /** Present for seed wallets. */
  mnemonic?: string;
  /** Present for hardware wallets: RAW 32-byte spending seed, hex (spec §0). */
  p01SpendingSeed?: string;
  /** Present for hardware wallets: persisted BIP44 path. */
  ledgerPath?: string;
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
 * V1 (LEGACY, read-compat) key derivation.
 * nacl.hash (SHA-512) with domain separation, iterated 100,000 times, salt
 * re-incorporated each iteration. Kept ONLY to decrypt pre-existing v1 backups.
 */
function deriveKeyV1(password: string, salt: Uint8Array): Uint8Array {
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

/**
 * V2 key derivation: PBKDF2-HMAC-SHA512, 600k iterations (Finding #11, locked
 * decision). Domain-separated password input, 32-byte output for nacl.secretbox.
 */
function deriveKeyV2(password: string, salt: Uint8Array): Uint8Array {
  const domain = 'P01_BACKUP_V2';
  const pw = new TextEncoder().encode(`${domain}:${password}`);
  return pbkdf2(sha512, pw, salt, { c: PBKDF2_ITERATIONS, dkLen: 32 });
}

/** Version-dispatched key derivation. */
function deriveKey(password: string, salt: Uint8Array, version: BackupVersion): Uint8Array {
  return version === 1 ? deriveKeyV1(password, salt) : deriveKeyV2(password, salt);
}

// ---------------------------------------------------------------------------
// Pure envelope encrypt/decrypt core (no store/native deps — unit-testable)
// ---------------------------------------------------------------------------

/**
 * Encrypt an arbitrary payload object into a base64 envelope at the given KDF
 * version (defaults to current v2 / PBKDF2-600k). Pure: no SecureStore/store deps.
 */
export function encryptBackupPayload(
  payload: BackupPayload,
  password: string,
  hint = '',
  version: BackupVersion = CURRENT_BACKUP_VERSION,
): string {
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const salt = nacl.randomBytes(32);
  const key = deriveKey(password, salt, version);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ciphertext = nacl.secretbox(plaintext, nonce, key);
  if (!ciphertext) throw new Error('Encryption failed');

  const envelope: BackupEnvelope = {
    v: version,
    n: toBase64(nonce),
    ct: toBase64(ciphertext),
    salt: toBase64(salt),
    hint,
    createdAt: Date.now(),
  };
  return Buffer.from(JSON.stringify(envelope)).toString('base64');
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

  const publicKey = await getPublicKey();
  if (!publicKey) {
    throw new Error('Wallet public key not found');
  }

  // Export denominated pool notes
  const poolStore = useDenominatedPoolStore.getState();
  const notes = poolStore.exportAllNotes();

  // Get settings
  const settingsStore = useSettingsStore.getState();

  const baseSettings = {
    currency: settingsStore.currency ?? 'USD',
    network: getCluster() ?? 'devnet',
    hideBalanceByDefault: false,
  };

  // Build the kind-specific payload.
  const kind = await getWalletKind();
  let payload: BackupPayload;
  if (kind === 'hardware') {
    // Hardware: back up the RAW spending seed (hex) + ledger path. The Ledger
    // phrase does NOT regenerate this random seed, so this backup is the ONLY
    // recovery path for hardware-wallet notes (spec §1C).
    const { getHardwareSpendingSeed } = await import('../ledger/spendingSeed');
    const seed = await getHardwareSpendingSeed(publicKey);
    if (!seed) {
      throw new Error('No hardware spending seed found — connect your Ledger first.');
    }
    payload = {
      version: 2,
      kind: 'hardware',
      p01SpendingSeed: Buffer.from(seed).toString('hex'),
      ledgerPath: "44'/501'/0'/0'",
      publicKey,
      notes,
      settings: baseSettings,
      createdAt: Date.now(),
    };
  } else {
    const mnemonic = await getMnemonic();
    if (!mnemonic) {
      throw new Error('No wallet found — cannot create backup');
    }
    payload = {
      version: 2,
      kind: 'seed',
      mnemonic,
      publicKey,
      notes,
      settings: baseSettings,
      createdAt: Date.now(),
    };
  }

  // Encrypt with the current (v2 / PBKDF2-600k) KDF via the pure core.
  const encoded = encryptBackupPayload(payload, password, hint, CURRENT_BACKUP_VERSION);

  // Mark as backed up
  await setBackupStatus(true);

  return encoded;
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

    // Accept v1 (legacy) and v2 (current).
    if (envelope.v !== 1 && envelope.v !== 2) return null;

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
 * Returns the raw payload + the envelope version it was decrypted under.
 *
 * Supports v1 (legacy SHA-512×100k) and v2 (PBKDF2-600k). When `legacy` is true
 * the caller SHOULD re-encrypt at v2 on the next save (migration "on next open").
 */
export function decryptBackup(
  encoded: string,
  password: string,
): BackupPayload & { __backupVersion: BackupVersion; __legacy: boolean } {
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

  if (envelope.v !== 1 && envelope.v !== 2) {
    throw new Error(`Unsupported backup version: ${envelope.v}`);
  }

  const salt = fromBase64(envelope.salt);
  const nonce = fromBase64(envelope.n);
  const ciphertext = fromBase64(envelope.ct);
  const key = deriveKey(password, salt, envelope.v);

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

  if (payload.version !== 1 && payload.version !== 2) {
    throw new Error(`Unsupported payload version: ${payload.version}`);
  }

  return { ...payload, __backupVersion: envelope.v, __legacy: envelope.v === 1 };
}

/**
 * Restore a HARDWARE-wallet backup: write the RAW spending seed to SecureStore
 * and set walletKind='hardware' WITHOUT importWallet (a Ledger has no mnemonic).
 * The note pipelines then consume the RAW seed per spec §0. The user must still
 * physically connect the Ledger to sign on-chain txs.
 */
export async function restoreHardwareWallet(payload: BackupPayload): Promise<void> {
  if (payload.kind !== 'hardware' || !payload.p01SpendingSeed) {
    throw new Error('Not a hardware backup — no spending seed present.');
  }
  const seed = new Uint8Array(Buffer.from(payload.p01SpendingSeed, 'hex'));
  if (seed.length !== 32) {
    throw new Error('Corrupted hardware backup — spending seed is not 32 bytes.');
  }
  const { setHardwareSpendingSeed } = await import('../ledger/spendingSeed');
  await setHardwareSpendingSeed(payload.publicKey, seed);
  // Persist hardware wallet metadata (kind/pubkey/exists) so boot treats it as a
  // hardware wallet in the "reconnect" state.
  await setHardwareWallet(payload.publicKey);
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
