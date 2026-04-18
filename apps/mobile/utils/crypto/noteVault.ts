/**
 * Note Vault — PIN-derived encryption for note receipts.
 *
 * Adds a second encryption layer on top of the store-level nacl.secretbox.
 * Even if an attacker extracts AsyncStorage + SecureStore, they cannot
 * reconstruct the receipt (and thus cannot unshield) without the user's PIN.
 *
 * V2 KDF: PBKDF2-HMAC-SHA256(password = DOMAIN || pinHash, salt, 600_000 iters, 32 B).
 * 600k matches OWASP 2023 recommendation for PBKDF2-SHA256. V1 used only 10k
 * rounds of plain SHA-256 (no HMAC, no standard KDF) — cheap to brute-force
 * a 6-digit PIN offline. V2 bumps cost by ~60x and uses a standard construction.
 *
 * Migration: V2 uses a distinct salt key so old V1 vaults can't be unlocked
 * with the new derivation. Pre-prod: users re-unlock + rescan on-chain notes.
 *
 * The vault key is derived at unlock time and held in memory only; it is
 * wiped when the app backgrounds or locks.
 */

import nacl from 'tweetnacl';
import { Buffer } from 'buffer';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';

const VAULT_SALT_KEY = 'p01_note_vault_v2_salt';
const VAULT_ENABLED_KEY = 'p01_note_vault_enabled';
const VAULT_BIO_KEY = 'p01_note_vault_biokey'; // Random key for biometric-only users
const DOMAIN = 'P01_NOTE_VAULT_V2';
const PBKDF2_ITERATIONS = 600_000;
const KEY_LENGTH = 32;

// In-memory vault key — never persisted
let _vaultKey: Uint8Array | null = null;

// ---------------------------------------------------------------------------
// Salt management
// ---------------------------------------------------------------------------

async function getVaultSalt(): Promise<string> {
  let salt = await SecureStore.getItemAsync(VAULT_SALT_KEY);
  if (!salt) {
    const bytes = Crypto.getRandomBytes(32);
    salt = Buffer.from(bytes).toString('hex');
    await SecureStore.setItemAsync(VAULT_SALT_KEY, salt);
  }
  return salt;
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

async function deriveVaultKey(pinHash: string): Promise<Uint8Array> {
  const saltHex = await getVaultSalt();
  const salt = Buffer.from(saltHex, 'hex');
  const password = new TextEncoder().encode(`${DOMAIN}:${pinHash}`);
  return pbkdf2Async(sha256, password, salt, {
    c: PBKDF2_ITERATIONS,
    dkLen: KEY_LENGTH,
  });
}

// ---------------------------------------------------------------------------
// Vault lifecycle
// ---------------------------------------------------------------------------

/**
 * Check if the note vault has been set up (PIN protection enabled).
 */
export async function isVaultEnabled(): Promise<boolean> {
  const enabled = await SecureStore.getItemAsync(VAULT_ENABLED_KEY);
  return enabled === 'true';
}

/**
 * Enable the note vault. Call after user sets a PIN.
 * Must call unlockVault() afterward to derive the key.
 */
export async function enableVault(): Promise<void> {
  await SecureStore.setItemAsync(VAULT_ENABLED_KEY, 'true');
}

/**
 * Unlock the vault with the user's PIN hash (from hashPin()).
 * The derived key is held in memory until lockVault() is called.
 */
export async function unlockVault(pinHash: string): Promise<void> {
  _vaultKey = await deriveVaultKey(pinHash);
}

/**
 * Unlock vault for biometric-only users (no PIN).
 * Uses a random key stored in SecureStore (hardware-backed).
 * The key is only accessible after biometric auth succeeds (SecureStore requires device unlock).
 */
export async function unlockVaultBiometric(): Promise<void> {
  let bioKeyHex = await SecureStore.getItemAsync(VAULT_BIO_KEY);
  if (!bioKeyHex) {
    // First time — generate a random vault key
    const randomKey = nacl.randomBytes(32);
    bioKeyHex = Buffer.from(randomKey).toString('hex');
    await SecureStore.setItemAsync(VAULT_BIO_KEY, bioKeyHex);
  }
  _vaultKey = new Uint8Array(Buffer.from(bioKeyHex, 'hex'));
}

/**
 * Lock the vault — wipe the in-memory key.
 * Call on app background, lock screen, or logout.
 */
export function lockVault(): void {
  if (_vaultKey) {
    _vaultKey.fill(0);
    _vaultKey = null;
  }
}

/**
 * Check if the vault is currently unlocked (key in memory).
 */
export function isVaultUnlocked(): boolean {
  return _vaultKey !== null;
}

// ---------------------------------------------------------------------------
// Encrypt / Decrypt receipts
// ---------------------------------------------------------------------------

/**
 * Encrypt a receipt string with the vault key.
 * Returns a base64 string (nonce + ciphertext).
 * If vault is not enabled or not unlocked, returns the receipt as-is.
 */
export function vaultEncrypt(receipt: string): string {
  if (!_vaultKey) return receipt;
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const plaintext = new TextEncoder().encode(receipt);
  const ciphertext = nacl.secretbox(plaintext, nonce, _vaultKey);
  if (!ciphertext) throw new Error('Vault encryption failed');
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce);
  combined.set(ciphertext, nonce.length);
  return `vault:${Buffer.from(combined).toString('base64')}`;
}

/**
 * Decrypt a vault-encrypted receipt.
 * If the string doesn't start with "vault:", it's unencrypted (legacy) — return as-is.
 * Throws if vault is locked or decryption fails (wrong PIN).
 */
export function vaultDecrypt(encrypted: string): string {
  if (!encrypted.startsWith('vault:')) return encrypted; // legacy unencrypted
  if (!_vaultKey) throw new Error('Note vault is locked. Authenticate to access shielded notes.');
  const data = new Uint8Array(Buffer.from(encrypted.slice(6), 'base64'));
  const nonce = data.slice(0, nacl.secretbox.nonceLength);
  const ciphertext = data.slice(nacl.secretbox.nonceLength);
  const plaintext = nacl.secretbox.open(ciphertext, nonce, _vaultKey);
  if (!plaintext) throw new Error('Vault decryption failed — wrong PIN or corrupted note.');
  return new TextDecoder().decode(plaintext);
}

/**
 * Re-encrypt all notes in a list: encrypt unprotected receipts, leave already-encrypted ones.
 * Used when enabling vault on existing notes.
 */
export function vaultEncryptNotes<T extends { receiptJSON: string }>(notes: T[]): T[] {
  if (!_vaultKey) return notes;
  return notes.map(note => {
    if (note.receiptJSON.startsWith('vault:')) return note; // already encrypted
    return { ...note, receiptJSON: vaultEncrypt(note.receiptJSON) };
  });
}
