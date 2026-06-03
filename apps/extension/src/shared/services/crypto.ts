/**
 * Crypto service for secure encryption/decryption
 * Uses Web Crypto API for AES-GCM encryption
 */

// PBKDF2 work factor.
//   - CURRENT: 600k (OWASP 2023 floor for PBKDF2-HMAC-SHA256). All NEW
//     encryptions and password hashes use this.
//   - LEGACY: 100k. Data/hashes written before this bump have no embedded
//     iteration count; we detect that and decrypt/verify at 100k, then the
//     caller re-encrypts / re-hashes at 600k on next write (see verifyPassword
//     `needsRehash` + decrypt's legacy-iteration handling). Existing wallets are
//     NEVER locked out.
export const PBKDF2_ITERATIONS = 600000;
export const PBKDF2_ITERATIONS_LEGACY = 100000;

// Derive a key from password using PBKDF2.
// `iterations` defaults to the current 600k cost; legacy blobs pass 100k.
async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
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
      iterations,
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
  /**
   * PBKDF2 iteration count used to derive the AES key. ABSENT on legacy blobs
   * written before the 600k bump → treated as 100k on decrypt (back-compat).
   * Present (600k) on every blob written going forward.
   */
  iterations?: number;
}

/**
 * Encrypt data with a password. Always uses the CURRENT (600k) work factor and
 * stamps the blob with `iterations` so future decrypts know the cost.
 */
export async function encrypt(data: string, password: string): Promise<EncryptedData> {
  const encoder = new TextEncoder();
  const salt = generateRandomBytes(16);
  const iv = generateRandomBytes(12);

  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    encoder.encode(data)
  );

  return {
    ciphertext: arrayBufferToBase64(encrypted),
    iv: arrayBufferToBase64(iv.buffer as ArrayBuffer),
    salt: arrayBufferToBase64(salt.buffer as ArrayBuffer),
    iterations: PBKDF2_ITERATIONS,
  };
}

/**
 * Decrypt data with a password.
 *
 * Back-compat: legacy blobs have no `iterations` field → decrypt at the legacy
 * 100k cost. Blobs written after the bump carry `iterations: 600000`. Callers
 * that want to migrate an at-rest blob to 600k can re-`encrypt()` the plaintext
 * once decrypted (`wasLegacyEncrypted` helps decide when).
 */
export async function decrypt(encryptedData: EncryptedData, password: string): Promise<string> {
  const salt = new Uint8Array(base64ToArrayBuffer(encryptedData.salt));
  const iv = new Uint8Array(base64ToArrayBuffer(encryptedData.iv));
  const ciphertext = base64ToArrayBuffer(encryptedData.ciphertext);

  const iterations = encryptedData.iterations ?? PBKDF2_ITERATIONS_LEGACY;
  const key = await deriveKey(password, salt, iterations);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    ciphertext
  );

  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

/**
 * True if this blob was written with the legacy (100k) work factor — i.e. it
 * has no embedded iteration count. Callers can use this to decide whether to
 * re-encrypt the data at the current 600k cost on next write.
 */
export function wasLegacyEncrypted(encryptedData: EncryptedData): boolean {
  return (encryptedData.iterations ?? PBKDF2_ITERATIONS_LEGACY) < PBKDF2_ITERATIONS;
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

async function pbkdf2Bits(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations, hash: 'SHA-256' },
    key, 256
  );
}

/**
 * Hash a password with PBKDF2 + random salt at the CURRENT (600k) work factor.
 * Returns "salt:hash:iterations" (all base64 except the trailing decimal count).
 *
 * Format history (all still VERIFIABLE — see verifyPassword):
 *   - legacy unsalted : "<base64(sha256(pw))>"        (no ':')
 *   - legacy salted   : "<salt>:<hash>"               (2 parts, 100k implied)
 *   - current         : "<salt>:<hash>:<iterations>"  (3 parts)
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await pbkdf2Bits(password, salt, PBKDF2_ITERATIONS);
  return (
    arrayBufferToBase64(salt.buffer as ArrayBuffer) +
    ':' + arrayBufferToBase64(derived) +
    ':' + String(PBKDF2_ITERATIONS)
  );
}

/**
 * Verify a password against a stored hash. Supports the three formats above.
 * For legacy (unsalted or 100k-salted) hashes this still returns true on the
 * correct password; the caller should then re-hash via {@link hashPassword} to
 * migrate to 600k (use {@link passwordHashNeedsRehash} to decide).
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(':');
  const [saltB64, hashB64, iterB64] = parts;
  if (!saltB64 || !hashB64) {
    // Legacy unsalted format — verify old way then caller should re-hash to migrate
    const legacyHash = await legacyHashPassword(password);
    return constantTimeEqual(encoder.encode(legacyHash), encoder.encode(storedHash));
  }
  // 2-part = legacy 100k; 3-part = explicit iteration count.
  const iterations = iterB64 ? Number(iterB64) : PBKDF2_ITERATIONS_LEGACY;
  const salt = base64ToArrayBuffer(saltB64);
  const derived = await pbkdf2Bits(password, new Uint8Array(salt), iterations);
  const expected = base64ToArrayBuffer(hashB64);
  return constantTimeEqual(new Uint8Array(derived), new Uint8Array(expected));
}

/**
 * True if a stored password hash uses a weaker-than-current work factor (legacy
 * unsalted, or salted below 600k) and should be re-hashed after a successful
 * verify. Non-destructive: callers re-hash on the next successful unlock.
 */
export function passwordHashNeedsRehash(storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length < 2) return true; // legacy unsalted
  const iterations = parts[2] ? Number(parts[2]) : PBKDF2_ITERATIONS_LEGACY;
  return !Number.isFinite(iterations) || iterations < PBKDF2_ITERATIONS;
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
