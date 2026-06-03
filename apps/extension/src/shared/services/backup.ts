/**
 * Encrypted IDENTITY backup (`p01id1:` blobs) — extension.
 *
 * WHY (docs/pairing-ledger-spec.md §1B, Finding #11): a hardware wallet's ZK
 * spending seed is a random CSPRNG value (services/ledger/spendingSeed.ts) that
 * the Ledger recovery phrase does NOT regenerate. If chrome.storage.local is
 * wiped (extension reinstall, profile reset), that seed — and therefore every
 * shielded/denominated note keyed to it — is gone forever. This module produces
 * a portable, password-encrypted backup of the identity so the user can restore
 * the seed on a new install. The backup is near-mandatory for hardware wallets;
 * the UI prompts for it on connect and again on first shield.
 *
 * FORMAT: `p01id1:` + base64(JSON(EncryptedData)). The EncryptedData payload is
 * AES-256-GCM with PBKDF2-600k (services/crypto.ts), so a backup blob is safe to
 * store anywhere the user keeps secrets (password manager, paper). The plaintext
 * inside is a JSON {@link BackupPayload}.
 *
 * VARIANTS:
 *   - hardware: { walletKind:'hardware', p01SpendingSeed (hex), ledgerPath,
 *     publicKey } — the load-bearing fields to reconstruct the ZK identity. NO
 *     mnemonic (a Ledger has none in the extension).
 *   - seed:     { walletKind:'local-seed', mnemonic, publicKey } — optional
 *     parity backup for local wallets (the mnemonic already fully regenerates
 *     everything, so this is just an alternative export channel).
 *
 * The decrypted `p01SpendingSeed` is fed RAW to the note pipelines on restore
 * (per §0); it is NEVER pre-HKDF'd.
 */

import { encrypt, decrypt, type EncryptedData } from './crypto';

/** Blob prefix for an encrypted identity backup. */
export const IDENTITY_BACKUP_PREFIX = 'p01id1:';

/** Wallet kinds carried in the backup payload (mirrors the wallet store). */
export type BackupWalletKind = 'local-seed' | 'hardware';

/** Current backup payload schema version. */
export const BACKUP_PAYLOAD_VERSION = 1;

export interface HardwareBackupPayload {
  v: typeof BACKUP_PAYLOAD_VERSION;
  walletKind: 'hardware';
  /** RAW 32-byte CSPRNG spending seed, hex-encoded (§0 — fed raw on restore). */
  p01SpendingSeed: string;
  /** BIP44 path the device signs with (persisted for a future account chooser). */
  ledgerPath: string;
  /** base58 public key of the Ledger account. */
  publicKey: string;
}

export interface SeedBackupPayload {
  v: typeof BACKUP_PAYLOAD_VERSION;
  walletKind: 'local-seed';
  /** BIP39 mnemonic (regenerates everything deterministically). */
  mnemonic: string;
  /** base58 public key derived from the mnemonic. */
  publicKey: string;
}

export type BackupPayload = HardwareBackupPayload | SeedBackupPayload;

// ---------------------------------------------------------------------------
// base64 helpers (popup + node both have btoa/atob)
// ---------------------------------------------------------------------------

function b64encode(s: string): string {
  // s is JSON (ASCII-safe after JSON.stringify of our fields); encode bytes.
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64decode(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// hex helpers
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex length in backup');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Create a `p01id1:` backup blob for a HARDWARE wallet. `spendingSeed` is the
 * RAW 32 bytes; it is copied into the (hex) payload and the input is NOT mutated.
 */
export async function exportHardwareBackup(params: {
  spendingSeed: Uint8Array;
  ledgerPath: string;
  publicKey: string;
  password: string;
}): Promise<string> {
  const payload: HardwareBackupPayload = {
    v: BACKUP_PAYLOAD_VERSION,
    walletKind: 'hardware',
    p01SpendingSeed: bytesToHex(params.spendingSeed),
    ledgerPath: params.ledgerPath,
    publicKey: params.publicKey,
  };
  const blob = await encrypt(JSON.stringify(payload), params.password);
  return IDENTITY_BACKUP_PREFIX + b64encode(JSON.stringify(blob));
}

/** Create a `p01id1:` backup blob for a LOCAL-SEED wallet (optional export). */
export async function exportSeedBackup(params: {
  mnemonic: string;
  publicKey: string;
  password: string;
}): Promise<string> {
  const payload: SeedBackupPayload = {
    v: BACKUP_PAYLOAD_VERSION,
    walletKind: 'local-seed',
    mnemonic: params.mnemonic,
    publicKey: params.publicKey,
  };
  const blob = await encrypt(JSON.stringify(payload), params.password);
  return IDENTITY_BACKUP_PREFIX + b64encode(JSON.stringify(blob));
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/** True if `s` looks like a `p01id1:` identity-backup blob. */
export function isIdentityBackupBlob(s: string): boolean {
  return typeof s === 'string' && s.trim().startsWith(IDENTITY_BACKUP_PREFIX);
}

/**
 * Decrypt + parse a `p01id1:` backup blob. Throws on a malformed blob, a wrong
 * password (GCM auth failure), or an unknown payload shape.
 */
export async function importIdentityBackup(
  blob: string,
  password: string,
): Promise<BackupPayload> {
  const trimmed = blob.trim();
  if (!isIdentityBackupBlob(trimmed)) {
    throw new Error('Not a Protocol-01 identity backup (expected a p01id1: blob).');
  }
  const json = b64decode(trimmed.slice(IDENTITY_BACKUP_PREFIX.length));
  const encrypted = JSON.parse(json) as EncryptedData;
  const plaintext = await decrypt(encrypted, password);
  const payload = JSON.parse(plaintext) as BackupPayload;

  if (payload.walletKind === 'hardware') {
    if (!payload.p01SpendingSeed || !payload.publicKey || !payload.ledgerPath) {
      throw new Error('Corrupt hardware backup: missing required fields.');
    }
  } else if (payload.walletKind === 'local-seed') {
    if (!payload.mnemonic || !payload.publicKey) {
      throw new Error('Corrupt seed backup: missing required fields.');
    }
  } else {
    throw new Error('Unknown backup wallet kind.');
  }
  return payload;
}

/**
 * Convenience: decode the RAW 32-byte spending seed out of a hardware backup
 * payload. The caller owns zeroization after feeding the note pipeline (§0).
 */
export function spendingSeedFromBackup(payload: HardwareBackupPayload): Uint8Array {
  return hexToBytes(payload.p01SpendingSeed);
}
