/**
 * Crypto service for secure encryption/decryption
 * Uses Web Crypto API for AES-GCM encryption
 */

// Derive a key from password using PBKDF2
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.buffer as ArrayBuffer,
      iterations: 100000,
      hash: 'SHA-256',
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Generate random bytes
function generateRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

// Convert ArrayBuffer to base64
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Convert base64 to ArrayBuffer
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer as ArrayBuffer;
}

export interface EncryptedData {
  ciphertext: string; // base64
  iv: string; // base64
  salt: string; // base64
}

/**
 * Encrypt data with a password
 */
export async function encrypt(data: string, password: string): Promise<EncryptedData> {
  const encoder = new TextEncoder();
  const salt = generateRandomBytes(16);
  const iv = generateRandomBytes(12);

  const key = await deriveKey(password, salt);

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    encoder.encode(data)
  );

  return {
    ciphertext: arrayBufferToBase64(encrypted),
    iv: arrayBufferToBase64(iv.buffer as ArrayBuffer),
    salt: arrayBufferToBase64(salt.buffer as ArrayBuffer),
  };
}

/**
 * Decrypt data with a password
 */
export async function decrypt(encryptedData: EncryptedData, password: string): Promise<string> {
  const salt = new Uint8Array(base64ToArrayBuffer(encryptedData.salt));
  const iv = new Uint8Array(base64ToArrayBuffer(encryptedData.iv));
  const ciphertext = base64ToArrayBuffer(encryptedData.ciphertext);

  const key = await deriveKey(password, salt);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    ciphertext
  );

  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

// ---------------------------------------------------------------------------
// Constant-time comparison (prevents timing side-channels)
// ---------------------------------------------------------------------------

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i];
  return result === 0;
}

// ---------------------------------------------------------------------------
// Password hashing — PBKDF2 with random salt
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/**
 * Legacy unsalted hash (SHA-256 only) — kept for migration of existing hashes.
 * @deprecated Use hashPassword() which uses PBKDF2 + salt.
 */
async function legacyHashPassword(password: string): Promise<string> {
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return arrayBufferToBase64(hash);
}

/**
 * Hash a password with PBKDF2 + random salt.
 * Returns "salt:hash" as base64-encoded strings.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  // Store salt:hash as base64
  return arrayBufferToBase64(salt.buffer as ArrayBuffer) + ':' + arrayBufferToBase64(derived);
}

/**
 * Verify a password against a stored hash.
 * Supports both new (salt:hash) and legacy (unsalted SHA-256) formats.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [saltB64, hashB64] = storedHash.split(':');
  if (!saltB64 || !hashB64) {
    // Legacy unsalted format — verify old way then caller should re-hash to migrate
    const legacyHash = await legacyHashPassword(password);
    return constantTimeEqual(encoder.encode(legacyHash), encoder.encode(storedHash));
  }
  const salt = base64ToArrayBuffer(saltB64);
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new Uint8Array(salt), iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  const expected = base64ToArrayBuffer(hashB64);
  return constantTimeEqual(new Uint8Array(derived), new Uint8Array(expected));
}

// --- Brute-force protection ---

const UNLOCK_ATTEMPTS_KEY = 'p01_unlock_attempts';
const UNLOCK_LOCKOUT_KEY = 'p01_unlock_lockout_until';

interface UnlockAttemptData {
  count: number;
  lockoutUntil: number; // epoch ms, 0 = no lockout
}

/**
 * Progressive lockout thresholds matching mobile:
 * 5 fails → 30s, 8 fails → 60s, 10 fails → 300s
 */
function getLockoutDuration(attempts: number): number {
  if (attempts >= 10) return 300_000;
  if (attempts >= 8) return 60_000;
  if (attempts >= 5) return 30_000;
  return 0;
}

async function getAttemptData(): Promise<UnlockAttemptData> {
  try {
    const result = await chrome.storage.local.get([UNLOCK_ATTEMPTS_KEY, UNLOCK_LOCKOUT_KEY]);
    return {
      count: result[UNLOCK_ATTEMPTS_KEY] ?? 0,
      lockoutUntil: result[UNLOCK_LOCKOUT_KEY] ?? 0,
    };
  } catch {
    return { count: 0, lockoutUntil: 0 };
  }
}

/**
 * Returns remaining lockout time in milliseconds. 0 means no lockout.
 */
export async function getLockoutRemaining(): Promise<number> {
  const data = await getAttemptData();
  if (data.lockoutUntil <= 0) return 0;
  const remaining = data.lockoutUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

/**
 * Get current failed attempt count.
 */
export async function getUnlockAttempts(): Promise<number> {
  const data = await getAttemptData();
  return data.count;
}

/**
 * Record a failed unlock attempt. Returns the lockout duration imposed (ms), 0 if none.
 */
export async function recordFailedAttempt(): Promise<number> {
  const data = await getAttemptData();
  const newCount = data.count + 1;
  const lockoutMs = getLockoutDuration(newCount);
  const lockoutUntil = lockoutMs > 0 ? Date.now() + lockoutMs : 0;

  await chrome.storage.local.set({
    [UNLOCK_ATTEMPTS_KEY]: newCount,
    [UNLOCK_LOCKOUT_KEY]: lockoutUntil,
  });

  return lockoutMs;
}

/**
 * Reset unlock attempts on successful unlock.
 */
export async function resetUnlockAttempts(): Promise<void> {
  await chrome.storage.local.remove([UNLOCK_ATTEMPTS_KEY, UNLOCK_LOCKOUT_KEY]);
}
