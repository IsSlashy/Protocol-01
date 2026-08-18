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
// Session password cache
// ---------------------------------------------------------------------------
//
// 🚨 IN-MEMORY ALONE MADE THE SESSION USELESS FOR ITS ONLY PURPOSE.
//
// `saveSession` encrypts the secret key WITH this password and writes it to
// chrome.storage.local, so the ciphertext survives anything. The password did
// not: it lived in this module's heap, and an extension popup closes the
// moment it loses focus — clicking the page behind it, switching tab, opening
// another window. The ciphertext was then undecryptable and `tryAutoUnlock`
// could never succeed, which is why the wallet re-locked every single time.
//
// MEASURED 2026-08-18: a wallet unlocked, then locked again on the next click
// outside the popup, on every attempt, so a dApp signature could not be
// approved at all.
//
// So it also goes to `chrome.storage.session`: memory-backed, never written to
// disk, wiped when the browser closes. That is the storage area MV3 added for
// exactly this, and it is what every extension that stays unlocked across a
// popup close uses.
//
// ⚠️ It IS a real weakening, and worth naming rather than burying: anything
// with extension-context access reads it while unlocked, where before it had
// to catch the popup open. The alternative is a wallet that cannot stay
// unlocked, and a user who is asked for a password they have already given.
// `clearSessionPassword` removes both copies, and lock still means locked.

const SESSION_PW_KEY = 'p01-session-password';

let _sessionPassword: string | null = null;

export function setSessionPassword(password: string): void {
  _sessionPassword = password;
  // Best effort: the heap copy is what this context uses; the stored copy is
  // what the NEXT context reads after this one is gone.
  void chrome.storage?.session?.set({ [SESSION_PW_KEY]: password }).catch(() => {});
}

/**
 * The cached password for THIS context, or null.
 *
 * Synchronous, so it cannot see the stored copy. Callers that run at startup —
 * auto-unlock above all — must use `loadSessionPassword` instead, because at
 * that moment the heap is empty by definition.
 */
export function getSessionPassword(): string | null {
  return _sessionPassword;
}

/**
 * The cached password, falling back to the one a previous context stored.
 *
 * This is the call that makes auto-unlock possible: a freshly opened popup has
 * an empty heap and a full session store.
 */
export async function loadSessionPassword(): Promise<string | null> {
  if (_sessionPassword) return _sessionPassword;
  try {
    const got = await chrome.storage.session.get(SESSION_PW_KEY);
    const pw = got?.[SESSION_PW_KEY];
    if (typeof pw === 'string' && pw) {
      _sessionPassword = pw;
      return pw;
    }
  } catch {
    /* no session storage in this context */
  }
  return null;
}

/**
 * Wipe the cached session password (called on wallet lock).
 */
export function clearSessionPassword(): void {
  _sessionPassword = null;
  // Both copies, or lock does not mean locked.
  void chrome.storage?.session?.remove(SESSION_PW_KEY).catch(() => {});
}
