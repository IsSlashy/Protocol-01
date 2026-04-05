/**
 * Route Cipher — Encrypted route storage using SecureStore.
 *
 * Privacy routes contain sensitive data (stealth secrets, nullifiers,
 * intermediate addresses) that must NEVER be stored in plaintext.
 *
 * Encryption: XSalsa20-Poly1305 (nacl.secretbox) with key derived from
 * HMAC-SHA256(spendingKeyHash, "route_cipher_key"). This matches the
 * encryption pattern used throughout the codebase (noteVault, backup, etc.).
 *
 * Storage: expo-secure-store only (hardware-backed on supported devices).
 * Route data is NEVER stored in AsyncStorage or synced to cloud.
 *
 * Index: A route index (JSON array of route IDs) is maintained in SecureStore
 * at key "p01_route_index" to allow listing all routes without decrypting each.
 */

import * as SecureStore from 'expo-secure-store';
import nacl from 'tweetnacl';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { PrivacyRoute } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** SecureStore key prefix for individual route data */
const ROUTE_KEY_PREFIX = 'p01_route_';

/** SecureStore key for the route index (array of route IDs) */
const ROUTE_INDEX_KEY = 'p01_route_index';

/** Domain separator for key derivation */
const CIPHER_KEY_DOMAIN = 'route_cipher_key';

/**
 * SecureStore has a value size limit (~2048 bytes on some platforms).
 * Routes are split into chunks if they exceed this threshold.
 * Each chunk is stored at key "{prefix}{routeId}_chunk_{n}".
 */
const CHUNK_SIZE = 2000;

// ---------------------------------------------------------------------------
// Encryption / Decryption
// ---------------------------------------------------------------------------

/**
 * Encrypt a privacy route into a storable string.
 *
 * @param route - The route to encrypt
 * @param spendingKeyHash - Hex-encoded spending key hash for key derivation
 * @returns Base64-encoded encrypted data (nonce + ciphertext)
 */
export async function encryptRoute(
  route: PrivacyRoute,
  spendingKeyHash: string,
): Promise<string> {
  const key = deriveCipherKey(spendingKeyHash);
  const plaintext = new TextEncoder().encode(JSON.stringify(route));
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);

  const ciphertext = nacl.secretbox(plaintext, nonce, key);
  if (!ciphertext) {
    throw new RouteCipherError('ENCRYPT_FAILED', 'Failed to encrypt route data');
  }

  // Combine nonce + ciphertext
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce);
  combined.set(ciphertext, nonce.length);

  return uint8ArrayToBase64(combined);
}

/**
 * Decrypt an encrypted route string back into a PrivacyRoute.
 *
 * @param encryptedData - Base64-encoded encrypted data from encryptRoute()
 * @param spendingKeyHash - Hex-encoded spending key hash for key derivation
 * @returns Decrypted PrivacyRoute
 * @throws RouteCipherError if decryption fails (wrong key or corrupted data)
 */
export async function decryptRoute(
  encryptedData: string,
  spendingKeyHash: string,
): Promise<PrivacyRoute> {
  const key = deriveCipherKey(spendingKeyHash);
  const combined = base64ToUint8Array(encryptedData);

  if (combined.length < nacl.secretbox.nonceLength) {
    throw new RouteCipherError('DECRYPT_FAILED', 'Encrypted data too short');
  }

  const nonce = combined.slice(0, nacl.secretbox.nonceLength);
  const ciphertext = combined.slice(nacl.secretbox.nonceLength);

  const plaintext = nacl.secretbox.open(ciphertext, nonce, key);
  if (!plaintext) {
    throw new RouteCipherError(
      'DECRYPT_FAILED',
      'Decryption failed -- wrong spending key or corrupted route data',
    );
  }

  try {
    const json = new TextDecoder().decode(plaintext);
    return JSON.parse(json) as PrivacyRoute;
  } catch {
    throw new RouteCipherError('DECRYPT_FAILED', 'Decrypted data is not valid JSON');
  }
}

// ---------------------------------------------------------------------------
// Storage operations
// ---------------------------------------------------------------------------

/**
 * Save an encrypted route to SecureStore.
 *
 * The route is encrypted, then stored. If the encrypted data exceeds
 * the SecureStore value size limit, it is split into chunks.
 * The route ID is also added to the route index.
 *
 * @param route - The route to save
 * @param spendingKeyHash - Hex-encoded spending key hash
 */
export async function saveRoute(
  route: PrivacyRoute,
  spendingKeyHash: string,
): Promise<void> {
  console.log(`[RouteCipher] Saving route ${route.id.slice(0, 8)}... (${route.hops.length} hops, status: ${route.status})`);
  const encrypted = await encryptRoute(route, spendingKeyHash);

  // Store route data (chunked if necessary)
  if (encrypted.length <= CHUNK_SIZE) {
    await SecureStore.setItemAsync(
      `${ROUTE_KEY_PREFIX}${route.id}`,
      encrypted,
    );
  } else {
    // Split into chunks
    const numChunks = Math.ceil(encrypted.length / CHUNK_SIZE);
    for (let i = 0; i < numChunks; i++) {
      const chunk = encrypted.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      await SecureStore.setItemAsync(
        `${ROUTE_KEY_PREFIX}${route.id}_chunk_${i}`,
        chunk,
      );
    }
    // Store chunk count as metadata
    await SecureStore.setItemAsync(
      `${ROUTE_KEY_PREFIX}${route.id}_meta`,
      JSON.stringify({ chunks: numChunks }),
    );
  }

  // Update route index
  await addToRouteIndex(route.id);
}

/**
 * Load and decrypt a single route from SecureStore.
 *
 * @param routeId - The route ID to load
 * @param spendingKeyHash - Hex-encoded spending key hash
 * @returns Decrypted route, or null if not found
 */
export async function loadRoute(
  routeId: string,
  spendingKeyHash: string,
): Promise<PrivacyRoute | null> {
  try {
    const encrypted = await loadEncryptedRoute(routeId);
    if (!encrypted) return null;

    return await decryptRoute(encrypted, spendingKeyHash);
  } catch (error) {
    console.error(`[RouteCipher] Failed to load route ${routeId}:`, error);
    return null;
  }
}

/**
 * Load and decrypt all routes from SecureStore.
 *
 * @param spendingKeyHash - Hex-encoded spending key hash
 * @returns Array of decrypted routes (skips any that fail to decrypt)
 */
export async function loadAllRoutes(
  spendingKeyHash: string,
): Promise<PrivacyRoute[]> {
  const routeIds = await getRouteIndex();
  console.log(`[RouteCipher] Loading ${routeIds.length} routes from SecureStore`);
  const routes: PrivacyRoute[] = [];

  for (const routeId of routeIds) {
    try {
      const route = await loadRoute(routeId, spendingKeyHash);
      if (route) {
        routes.push(route);
      }
    } catch (error) {
      console.error(`[RouteCipher] Skipping route ${routeId}:`, error);
    }
  }

  return routes;
}

/**
 * Delete a route from SecureStore (including any chunks).
 *
 * @param routeId - The route ID to delete
 */
export async function deleteRoute(routeId: string): Promise<void> {
  // Check for chunked storage
  const metaRaw = await SecureStore.getItemAsync(
    `${ROUTE_KEY_PREFIX}${routeId}_meta`,
  );

  if (metaRaw) {
    try {
      const meta = JSON.parse(metaRaw) as { chunks: number };
      for (let i = 0; i < meta.chunks; i++) {
        await SecureStore.deleteItemAsync(
          `${ROUTE_KEY_PREFIX}${routeId}_chunk_${i}`,
        );
      }
      await SecureStore.deleteItemAsync(
        `${ROUTE_KEY_PREFIX}${routeId}_meta`,
      );
    } catch {
      // Best effort cleanup
    }
  } else {
    await SecureStore.deleteItemAsync(`${ROUTE_KEY_PREFIX}${routeId}`);
  }

  // Remove from index
  await removeFromRouteIndex(routeId);
}

// ---------------------------------------------------------------------------
// Route index management
// ---------------------------------------------------------------------------

/**
 * Get the list of all stored route IDs.
 */
async function getRouteIndex(): Promise<string[]> {
  try {
    const raw = await SecureStore.getItemAsync(ROUTE_INDEX_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

/**
 * Add a route ID to the index (idempotent).
 */
async function addToRouteIndex(routeId: string): Promise<void> {
  const index = await getRouteIndex();
  if (!index.includes(routeId)) {
    index.push(routeId);
    await SecureStore.setItemAsync(ROUTE_INDEX_KEY, JSON.stringify(index));
  }
}

/**
 * Remove a route ID from the index.
 */
async function removeFromRouteIndex(routeId: string): Promise<void> {
  const index = await getRouteIndex();
  const updated = index.filter((id) => id !== routeId);
  await SecureStore.setItemAsync(ROUTE_INDEX_KEY, JSON.stringify(updated));
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Derive a 32-byte encryption key from the spending key hash.
 *
 * Uses HMAC-SHA256(spendingKeyHash, "route_cipher_key") to produce
 * a deterministic key. The spending key hash itself is never stored.
 */
function deriveCipherKey(spendingKeyHash: string): Uint8Array {
  const keyBytes = hexToBytes(spendingKeyHash);
  const domainBytes = new TextEncoder().encode(CIPHER_KEY_DOMAIN);
  return hmac(sha256, keyBytes, domainBytes);
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class RouteCipherError extends Error {
  code: 'ENCRYPT_FAILED' | 'DECRYPT_FAILED' | 'STORAGE_FAILED';

  constructor(
    code: 'ENCRYPT_FAILED' | 'DECRYPT_FAILED' | 'STORAGE_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'RouteCipherError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Load raw encrypted data for a route (handles chunked storage).
 */
async function loadEncryptedRoute(routeId: string): Promise<string | null> {
  // Check for chunked storage first
  const metaRaw = await SecureStore.getItemAsync(
    `${ROUTE_KEY_PREFIX}${routeId}_meta`,
  );

  if (metaRaw) {
    try {
      const meta = JSON.parse(metaRaw) as { chunks: number };
      let encrypted = '';
      for (let i = 0; i < meta.chunks; i++) {
        const chunk = await SecureStore.getItemAsync(
          `${ROUTE_KEY_PREFIX}${routeId}_chunk_${i}`,
        );
        if (!chunk) return null;
        encrypted += chunk;
      }
      return encrypted;
    } catch {
      return null;
    }
  }

  // Try single-value storage
  return SecureStore.getItemAsync(`${ROUTE_KEY_PREFIX}${routeId}`);
}

/**
 * Convert a hex string to a Uint8Array.
 */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error('Invalid hex string: odd length');
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Convert a Uint8Array to a base64 string.
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Use Buffer which is polyfilled in React Native
  return Buffer.from(bytes).toString('base64');
}

/**
 * Convert a base64 string to a Uint8Array.
 */
function base64ToUint8Array(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
