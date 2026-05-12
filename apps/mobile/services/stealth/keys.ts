/**
 * Persistent stealth keys for Protocol 01.
 *
 * Each user has ONE set of stealth keys derived from secure random bytes
 * and persisted in SecureStore. These keys form the user's "meta-address"
 * which can be shared publicly for receiving private payments.
 *
 * Meta-address format: st:01<base58(spending_pub + viewing_pub)>
 *   - Anyone can derive one-time stealth addresses from this
 *   - Only the owner (with viewing secret key) can detect payments
 *   - Only the owner (with spending secret key) can spend the funds
 *
 * Security: keys stored in SecureStore (hardware-backed on iOS, encrypted on Android).
 */

import { Keypair } from '@solana/web3.js';
import * as SecureStore from 'expo-secure-store';
import nacl from 'tweetnacl';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  createMetaAddress,
  generateStealthAddress,
  type StealthKeys,
  type StealthAddress,
  type ParsedMetaAddress,
  parseMetaAddress,
  isMetaAddress,
} from '../../utils/crypto/stealth';

// SecureStore keys
const SPENDING_SEED_KEY = 'p01_stealth_spending_seed';
const VIEWING_SEED_KEY = 'p01_stealth_viewing_seed';
const META_ADDRESS_KEY = 'p01_stealth_meta_address';

let _cachedKeys: StealthKeys | null = null;
let _cachedMetaAddress: string | null = null;

/**
 * Get or create persistent stealth keys.
 * Generated once, stored in SecureStore, reused across sessions.
 */
export async function getOrCreateStealthKeys(): Promise<StealthKeys> {
  if (_cachedKeys) return _cachedKeys;

  // Try to load existing keys
  const spendingSeedHex = await SecureStore.getItemAsync(SPENDING_SEED_KEY);
  const viewingSeedHex = await SecureStore.getItemAsync(VIEWING_SEED_KEY);

  if (spendingSeedHex && viewingSeedHex) {
    const spendingSeed = hexToBytes(spendingSeedHex);
    const viewingSeed = hexToBytes(viewingSeedHex);

    const spendingKey = Keypair.fromSeed(spendingSeed);
    const viewingKeypair = nacl.box.keyPair.fromSecretKey(viewingSeed);

    _cachedKeys = {
      spendingKey,
      viewingSecretKey: viewingKeypair.secretKey,
      viewingPublicKey: viewingKeypair.publicKey,
      spendingPublicKey: spendingKey.publicKey.toBase58(),
    };

    console.log('[StealthKeys] Loaded existing keys');
    return _cachedKeys;
  }

  // Generate new keys (first time)
  console.log('[StealthKeys] Generating new stealth keys...');

  const spendingSeed = nacl.randomBytes(32);
  const viewingSeed = nacl.randomBytes(32);

  const spendingKey = Keypair.fromSeed(spendingSeed);
  const viewingKeypair = nacl.box.keyPair.fromSecretKey(viewingSeed);

  // Persist in SecureStore
  await SecureStore.setItemAsync(SPENDING_SEED_KEY, bytesToHex(spendingSeed));
  await SecureStore.setItemAsync(VIEWING_SEED_KEY, bytesToHex(viewingSeed));

  _cachedKeys = {
    spendingKey,
    viewingSecretKey: viewingKeypair.secretKey,
    viewingPublicKey: viewingKeypair.publicKey,
    spendingPublicKey: spendingKey.publicKey.toBase58(),
  };

  console.log('[StealthKeys] New keys generated and persisted');
  return _cachedKeys;
}

/**
 * Get the user's meta-address for sharing.
 * This is the persistent "receive address" that anyone can use to derive
 * one-time stealth payment addresses.
 */
export async function getMetaAddress(): Promise<string> {
  if (_cachedMetaAddress) return _cachedMetaAddress;

  // Try cache in SecureStore
  const cached = await SecureStore.getItemAsync(META_ADDRESS_KEY);
  if (cached) {
    _cachedMetaAddress = cached;
    return cached;
  }

  const keys = await getOrCreateStealthKeys();
  const metaAddress = createMetaAddress(keys);

  await SecureStore.setItemAsync(META_ADDRESS_KEY, metaAddress);
  _cachedMetaAddress = metaAddress;

  console.log('[StealthKeys] Meta-address created:', metaAddress.slice(0, 20) + '...');
  return metaAddress;
}

/**
 * Derive a one-time stealth address for sending to a meta-address recipient.
 * Used by Private Send when the destination is a meta-address.
 */
export function deriveStealthForRecipient(recipientMetaAddress: string): StealthAddress {
  const parsed: ParsedMetaAddress = parseMetaAddress(recipientMetaAddress);

  return generateStealthAddress(
    parsed.spendingPubKey,
    parsed.viewingPubKey,
    parsed.kemPubKey,
  );
}

/**
 * Return the user's v1 stealth meta address as 64 raw bytes:
 * `[spending_ed25519_pub(32) | viewing_x25519_pub(32)]`.
 *
 * This is the on-chain layout expected by `SubscriptionVault.client_stealth_meta`
 * (refund-via-relayer): the keeper splits it into the two 32-byte halves to
 * derive a one-time stealth address for the refund note.
 *
 * - Loads or derives the user's persistent stealth keypairs via
 *   `getOrCreateStealthKeys` (cached, persisted in SecureStore).
 * - Drops any v2 KEM material — only the v1 portion (spending + viewing) is
 *   encoded since the on-chain field is fixed-size `[u8; 64]`.
 *
 * Stable across sessions: re-invoking on the same device returns the same
 * 64 bytes, which is what enables cross-session refund-note recovery.
 */
export async function getOrCreateStealthMetaV1(): Promise<Uint8Array> {
  const keys = await getOrCreateStealthKeys();
  const spendingBytes = keys.spendingKey.publicKey.toBytes(); // 32 bytes (Ed25519)
  const viewingBytes = keys.viewingPublicKey;                 // 32 bytes (X25519)

  if (spendingBytes.length !== 32 || viewingBytes.length !== 32) {
    throw new Error(
      `[getOrCreateStealthMetaV1] unexpected key sizes: spending=${spendingBytes.length}, viewing=${viewingBytes.length}`,
    );
  }

  const out = new Uint8Array(64);
  out.set(spendingBytes, 0);
  out.set(viewingBytes, 32);
  return out;
}

export { isMetaAddress, parseMetaAddress };
