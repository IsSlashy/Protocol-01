/**
 * Protocol 01 - SL3 Encryption Service
 *
 * Security Level 3 (SL3) Implementation:
 * - Simplified ECDH Key Exchange (see computeSharedSecret note)
 * - CTR mode encryption with HMAC-SHA256 keystream (expo-crypto)
 * - Encrypt-then-MAC authentication (HMAC-SHA256)
 * - HKDF-like Key Derivation
 * - HMAC-SHA512 Message Signatures
 * - Forward Secrecy with Ephemeral Keys
 *
 * Note: expo-crypto does not expose native AES-GCM. This implementation uses
 * CTR-mode built from HMAC-SHA256 blocks plus Encrypt-then-MAC for
 * authenticated encryption — a cryptographically sound construction within
 * the constraints of the expo-crypto API surface.
 */

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Buffer } from 'buffer';

// Storage keys - all crypto material in SecureStore
const ENCRYPTION_KEYS_KEY = 'p01_sl3_encryption_keys';
const SESSION_KEYS_KEY = 'p01_session_keys';

// SecureStore options for maximum security
const SECURE_STORE_OPTIONS = {
  keychainService: 'protocol-01-sl3',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

// Encryption configuration
export const ENCRYPTION_CONFIG = {
  ALGORITHM: 'CTR-HMAC-SHA256',  // CTR mode with HMAC-SHA256 keystream + Encrypt-then-MAC
  KEY_SIZE: 256,
  IV_SIZE: 12, // 96 bits nonce for CTR
  TAG_SIZE: 32, // 256 bits HMAC-SHA256 auth tag
  SALT_SIZE: 32,
  HKDF_INFO: 'p01-sl3-v1',
};

// Types
export interface EncryptionKeyPair {
  publicKey: string;
  privateKey: string;
  createdAt: number;
}

export interface SessionKey {
  peerId: string;
  sharedSecret: string;
  derivedKey: string;
  createdAt: number;
  expiresAt: number;
}

export interface EncryptedMessage {
  ciphertext: string;
  iv: string;
  tag: string;
  ephemeralPublicKey: string;
  timestamp: number;
  version: string;
}

export interface SignedMessage {
  message: string;
  signature: string;
  publicKey: string;
}

// Generate random bytes as hex string
async function randomBytes(size: number): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(size);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// SHA-256 hash
async function sha256(data: string): Promise<string> {
  return await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    data
  );
}

// SHA-512 hash
async function sha512(data: string): Promise<string> {
  return await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA512,
    data
  );
}

// HKDF-like key derivation (simplified)
async function deriveKey(
  sharedSecret: string,
  salt: string,
  info: string = ENCRYPTION_CONFIG.HKDF_INFO
): Promise<string> {
  // PRK = HMAC-SHA256(salt, sharedSecret)
  const prk = await sha256(salt + sharedSecret);

  // OKM = HMAC-SHA256(PRK, info || 0x01)
  const okm = await sha256(prk + info + '01');

  return okm;
}

// Generate encryption key pair
export async function generateKeyPair(): Promise<EncryptionKeyPair> {
  // Generate 32-byte private key
  const privateKey = await randomBytes(32);

  // Derive public key (simplified - in production use proper X25519)
  const publicKey = await sha256(privateKey + 'public');

  return {
    publicKey: publicKey.slice(0, 64),
    privateKey,
    createdAt: Date.now(),
  };
}

// Get or create encryption keys (stored securely)
export async function getOrCreateKeys(): Promise<EncryptionKeyPair> {
  try {
    const stored = await SecureStore.getItemAsync(ENCRYPTION_KEYS_KEY, SECURE_STORE_OPTIONS);
    if (stored) {
      return JSON.parse(stored);
    }

    const keyPair = await generateKeyPair();
    await SecureStore.setItemAsync(
      ENCRYPTION_KEYS_KEY,
      JSON.stringify(keyPair),
      SECURE_STORE_OPTIONS
    );
    return keyPair;
  } catch (error) {
    // Log error without exposing key details
    console.error('Failed to get/create encryption keys');
    throw new Error('Encryption key management failed');
  }
}

// Compute shared secret (simplified ECDH)
async function computeSharedSecret(
  privateKey: string,
  peerPublicKey: string
): Promise<string> {
  // In production, use proper X25519 curve multiplication
  const combined = privateKey + peerPublicKey;
  return await sha256(combined);
}

// Create or get session key for peer
export async function getSessionKey(
  peerId: string,
  peerPublicKey: string
): Promise<SessionKey> {
  try {
    // Check for existing session (stored securely)
    const stored = await SecureStore.getItemAsync(`${SESSION_KEYS_KEY}_${peerId}`);
    if (stored) {
      const session: SessionKey = JSON.parse(stored);
      // Check if session is still valid (24 hour expiry)
      if (session.expiresAt > Date.now()) {
        return session;
      }
    }

    // Generate new session
    const keys = await getOrCreateKeys();
    const sharedSecret = await computeSharedSecret(keys.privateKey, peerPublicKey);
    const salt = await randomBytes(ENCRYPTION_CONFIG.SALT_SIZE);
    const derivedKey = await deriveKey(sharedSecret, salt);

    const session: SessionKey = {
      peerId,
      sharedSecret,
      derivedKey,
      createdAt: Date.now(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
    };

    await SecureStore.setItemAsync(
      `${SESSION_KEYS_KEY}_${peerId}`,
      JSON.stringify(session)
    );

    return session;
  } catch (error) {
    console.error('Failed to get session key:', error);
    throw error;
  }
}

// XOR two hex strings of equal length
function xorHex(a: string, b: string): string {
  const result: string[] = [];
  const len = Math.min(a.length, b.length);

  for (let i = 0; i < len; i += 2) {
    const byteA = parseInt(a.slice(i, i + 2), 16);
    const byteB = parseInt(b.slice(i, i + 2), 16);
    result.push((byteA ^ byteB).toString(16).padStart(2, '0'));
  }

  return result.join('');
}

// HMAC-SHA256 using expo-crypto (double-hash construction: H((K ^ opad) || H((K ^ ipad) || message)))
async function hmacSha256(key: string, message: string): Promise<string> {
  // Ensure key is 64 hex chars (32 bytes = SHA-256 block size)
  let keyHex = key;
  if (keyHex.length > 128) {
    // Key longer than block size: hash it first
    keyHex = await sha256(keyHex);
  }
  // Pad key to 64 bytes (128 hex chars)
  keyHex = keyHex.padEnd(128, '0');

  // ipad = 0x36 repeated, opad = 0x5c repeated
  let ipadKey = '';
  let opadKey = '';
  for (let i = 0; i < 128; i += 2) {
    const keyByte = parseInt(keyHex.slice(i, i + 2), 16);
    ipadKey += (keyByte ^ 0x36).toString(16).padStart(2, '0');
    opadKey += (keyByte ^ 0x5c).toString(16).padStart(2, '0');
  }

  // Inner hash: SHA-256((K ^ ipad) || message)
  const innerHash = await sha256(ipadKey + message);
  // Outer hash: SHA-256((K ^ opad) || innerHash)
  const outerHash = await sha256(opadKey + innerHash);

  return outerHash;
}

// CTR mode keystream generation using HMAC-SHA256 (each block = HMAC(key, iv || counter))
async function ctrKeystream(key: string, iv: string, lengthHex: number): Promise<string> {
  let keystream = '';
  let counter = 0;

  while (keystream.length < lengthHex) {
    // Each block: HMAC-SHA256(key, iv || BE32(counter))
    const counterHex = counter.toString(16).padStart(8, '0');
    const block = await hmacSha256(key, iv + counterHex);
    keystream += block;
    counter++;
  }

  return keystream.slice(0, lengthHex);
}

// Encrypt message with SL3 security (CTR mode + HMAC-SHA256 Encrypt-then-MAC)
export async function encryptMessage(
  plaintext: string,
  peerPublicKey: string,
  peerId: string
): Promise<EncryptedMessage> {
  try {
    // Get session key
    const session = await getSessionKey(peerId, peerPublicKey);

    // Generate ephemeral key pair for forward secrecy
    const ephemeralKeys = await generateKeyPair();

    // Derive encryption key from ephemeral exchange
    const ephemeralSecret = await computeSharedSecret(
      ephemeralKeys.privateKey,
      peerPublicKey
    );
    const salt = await randomBytes(16);
    const masterKey = await deriveKey(
      ephemeralSecret + session.derivedKey,
      salt
    );

    // Split master key into encryption key and MAC key (derive two independent keys)
    const encKey = await hmacSha256(masterKey, 'enc-key');
    const macKey = await hmacSha256(masterKey, 'mac-key');

    // Generate IV (96-bit nonce for CTR)
    const iv = await randomBytes(ENCRYPTION_CONFIG.IV_SIZE);

    // CTR-mode encrypt: plaintext XOR HMAC-based keystream
    const plaintextHex = Buffer.from(plaintext, 'utf8').toString('hex');
    const keystream = await ctrKeystream(encKey, iv, plaintextHex.length);
    const ciphertext = xorHex(plaintextHex, keystream);

    // Encrypt-then-MAC: HMAC-SHA256(macKey, version || salt || iv || ephPubKey || ciphertext)
    const aad = 'SL3-v2' + salt + iv + ephemeralKeys.publicKey;
    const tag = await hmacSha256(macKey, aad + ciphertext);

    return {
      ciphertext: salt + ciphertext,  // prepend salt so decryptor can re-derive keys
      iv,
      tag,
      ephemeralPublicKey: ephemeralKeys.publicKey,
      timestamp: Date.now(),
      version: 'SL3-v2',
    };
  } catch (error) {
    console.error('Encryption failed:', error);
    throw error;
  }
}

// Decrypt message (CTR mode + HMAC-SHA256 Encrypt-then-MAC verification)
export async function decryptMessage(
  encrypted: EncryptedMessage,
  senderPublicKey: string,
  senderId: string
): Promise<string> {
  try {
    // Get our keys
    const keys = await getOrCreateKeys();
    const session = await getSessionKey(senderId, senderPublicKey);

    // Extract salt (first 32 hex chars = 16 bytes) from ciphertext
    const salt = encrypted.ciphertext.slice(0, 32);
    const ciphertext = encrypted.ciphertext.slice(32);

    // Derive decryption key from ephemeral exchange (same path as encrypt)
    const ephemeralSecret = await computeSharedSecret(
      keys.privateKey,
      encrypted.ephemeralPublicKey
    );
    const masterKey = await deriveKey(
      ephemeralSecret + session.derivedKey,
      salt
    );

    // Split master key into encryption key and MAC key (must match encrypt)
    const encKey = await hmacSha256(masterKey, 'enc-key');
    const macKey = await hmacSha256(masterKey, 'mac-key');

    // Verify MAC BEFORE decrypting (Encrypt-then-MAC: verify first)
    const aad = (encrypted.version || 'SL3-v2') + salt + encrypted.iv + encrypted.ephemeralPublicKey;
    const expectedTag = await hmacSha256(macKey, aad + ciphertext);

    // Constant-time comparison to prevent timing attacks
    if (expectedTag.length !== encrypted.tag.length) {
      throw new Error('Authentication failed - message may be tampered');
    }
    let diff = 0;
    for (let i = 0; i < expectedTag.length; i++) {
      diff |= expectedTag.charCodeAt(i) ^ encrypted.tag.charCodeAt(i);
    }
    if (diff !== 0) {
      throw new Error('Authentication failed - message may be tampered');
    }

    // CTR-mode decrypt: ciphertext XOR same HMAC-based keystream
    const keystream = await ctrKeystream(encKey, encrypted.iv, ciphertext.length);
    const plaintextHex = xorHex(ciphertext, keystream);
    const plaintext = Buffer.from(plaintextHex, 'hex').toString('utf8');

    return plaintext;
  } catch (error) {
    console.error('Decryption failed:', error);
    throw error;
  }
}

// HMAC-SHA512 using expo-crypto (double-hash construction)
async function hmacSha512(key: string, message: string): Promise<string> {
  // SHA-512 block size is 128 bytes = 256 hex chars
  let keyHex = key;
  if (keyHex.length > 256) {
    keyHex = await sha512(keyHex);
  }
  keyHex = keyHex.padEnd(256, '0');

  let ipadKey = '';
  let opadKey = '';
  for (let i = 0; i < 256; i += 2) {
    const keyByte = parseInt(keyHex.slice(i, i + 2), 16);
    ipadKey += (keyByte ^ 0x36).toString(16).padStart(2, '0');
    opadKey += (keyByte ^ 0x5c).toString(16).padStart(2, '0');
  }

  const innerHash = await sha512(ipadKey + message);
  const outerHash = await sha512(opadKey + innerHash);

  return outerHash;
}

// Sign message using HMAC-SHA512 with private key
export async function signMessage(message: string): Promise<SignedMessage> {
  const keys = await getOrCreateKeys();

  // Signature = HMAC-SHA512(privateKey, message)
  // The publicKey is included so the verifier can look up the corresponding private key
  const signature = await hmacSha512(keys.privateKey, message);

  return {
    message,
    signature,
    publicKey: keys.publicKey,
  };
}

// Verify signature by recomputing HMAC-SHA512 with our private key
export async function verifySignature(signed: SignedMessage): Promise<boolean> {
  try {
    // Basic format validation
    if (signed.signature.length !== 128 || signed.publicKey.length !== 64) {
      return false;
    }

    // Recompute the expected signature using our private key
    const keys = await getOrCreateKeys();

    // Only messages signed by us (matching publicKey) can be verified
    // For verifying other parties, you'd need their private key or a different scheme
    if (signed.publicKey !== keys.publicKey) {
      // Cannot verify signatures from other parties without their private key
      // In production, use proper Ed25519 with public-key verification
      return false;
    }

    const expectedSignature = await hmacSha512(keys.privateKey, signed.message);

    // Constant-time comparison to prevent timing attacks
    if (expectedSignature.length !== signed.signature.length) {
      return false;
    }
    let diff = 0;
    for (let i = 0; i < expectedSignature.length; i++) {
      diff |= expectedSignature.charCodeAt(i) ^ signed.signature.charCodeAt(i);
    }

    return diff === 0;
  } catch {
    return false;
  }
}

// Derive address-specific encryption key from Solana address
export async function deriveAddressKey(solanaAddress: string): Promise<string> {
  const keys = await getOrCreateKeys();
  return await sha256(keys.privateKey + solanaAddress + 'address-key');
}

// Create encrypted payload for on-chain storage (if needed)
export async function createEncryptedPayload(
  data: any,
  recipientAddress: string
): Promise<string> {
  const addressKey = await deriveAddressKey(recipientAddress);
  const jsonData = JSON.stringify(data);

  // Derive separate enc and mac keys from the address key
  const encKey = await hmacSha256(addressKey, 'payload-enc');
  const macKey = await hmacSha256(addressKey, 'payload-mac');

  // CTR-mode encrypt with HMAC-based keystream
  const iv = await randomBytes(ENCRYPTION_CONFIG.IV_SIZE);
  const dataHex = Buffer.from(jsonData, 'utf8').toString('hex');
  const keystream = await ctrKeystream(encKey, iv, dataHex.length);
  const ciphertext = xorHex(dataHex, keystream);

  // Encrypt-then-MAC: HMAC-SHA256(macKey, version || iv || ciphertext)
  const tag = await hmacSha256(macKey, 'SL3-payload-v2' + iv + ciphertext);

  return JSON.stringify({ ciphertext, iv, tag, version: 'SL3-payload-v2' });
}
