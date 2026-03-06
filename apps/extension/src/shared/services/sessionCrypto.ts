/**
 * Session Crypto Service
 *
 * Encrypts sensitive session data (secret keys, spending keys, ZK seeds) at rest
 * in chrome.storage.local using AES-256-GCM with PBKDF2-derived keys.
 *
 * This prevents plaintext key material from sitting in browser storage where it
 * could be exfiltrated by other extensions, malware, or forensic tools.
 *
 * Flow:
 *   1. User enters password at unlock time
 *   2. We derive a session encryption key via PBKDF2(password, salt)
 *   3. All secret material written to chrome.storage.local is encrypted with
 *      this key before storage and decrypted on read
 *   4. On lock, the in-memory session key is wiped
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EncryptedBlob {
  /** Base64-encoded AES-256-GCM ciphertext */
  ct: string;
  /** Base64-encoded 12-byte IV */
  iv: string;
  /** Base64-encoded 16-byte PBKDF2 salt */
  salt: string;
  /** Marker so we can distinguish encrypted from legacy plaintext */
  _enc: true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer as ArrayBuffer;
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

const PBKDF2_ITERATIONS = 100_000;

async function deriveSessionKey(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.buffer as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypt arbitrary string data for storage. Returns an EncryptedBlob that
 * can be safely serialized to JSON and stored in chrome.storage.local.
 */
export async function encryptForSession(
  plaintext: string,
  password: string,
): Promise<EncryptedBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveSessionKey(password, salt);

  const encoder = new TextEncoder();
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    encoder.encode(plaintext),
  );

  return {
    ct: arrayBufferToBase64(cipherBuf),
    iv: arrayBufferToBase64(iv.buffer as ArrayBuffer),
    salt: arrayBufferToBase64(salt.buffer as ArrayBuffer),
    _enc: true,
  };
}

/**
 * Decrypt an EncryptedBlob back to the original plaintext string.
 * Throws if the password is wrong or data is corrupted.
 */
export async function decryptFromSession(
  blob: EncryptedBlob,
  password: string,
): Promise<string> {
  const salt = new Uint8Array(base64ToArrayBuffer(blob.salt));
  const iv = new Uint8Array(base64ToArrayBuffer(blob.iv));
  const cipherBuf = base64ToArrayBuffer(blob.ct);

  const key = await deriveSessionKey(password, salt);

  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    cipherBuf,
  );

  return new TextDecoder().decode(plainBuf);
}

/**
 * Check whether a value stored in chrome.storage.local is an EncryptedBlob
 * (as opposed to legacy plaintext data).
 */
export function isEncryptedBlob(value: unknown): value is EncryptedBlob {
  if (value === null || value === undefined || typeof value !== 'object') {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    obj._enc === true &&
    typeof obj.ct === 'string' &&
    typeof obj.iv === 'string' &&
    typeof obj.salt === 'string'
  );
}

// ---------------------------------------------------------------------------
// Session password cache (in-memory only, never persisted)
// ---------------------------------------------------------------------------

let _sessionPassword: string | null = null;

/**
 * Cache the user's password in memory for the duration of the session.
 * This is required so that we can encrypt/decrypt session secrets without
 * re-prompting the user every time we touch chrome.storage.local.
 *
 * The password is ONLY held in JS heap memory and is cleared on lock.
 */
export function setSessionPassword(password: string): void {
  _sessionPassword = password;
}

/**
 * Retrieve the cached session password, or null if the wallet is locked.
 */
export function getSessionPassword(): string | null {
  return _sessionPassword;
}

/**
 * Wipe the cached session password (called on wallet lock).
 */
export function clearSessionPassword(): void {
  _sessionPassword = null;
}
