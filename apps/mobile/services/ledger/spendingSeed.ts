/**
 * Hardware (Ledger) ZK spending seed — mobile.
 *
 * THE CANONICAL INVARIANT (spec §0): the P01 spending seed is the RAW 32 bytes
 * that the note pipelines consume directly. For a SOFTWARE wallet that is
 * `secretKey.slice(0,32)`. A Ledger never exposes a raw secret key, so for a
 * HARDWARE wallet we generate a CSPRNG 32-byte value ONCE and feed it RAW — in
 * the SAME position — to the SAME consumers:
 *   - denominated → IKM for deriveNoteMaterial / noteCrypto.deriveNoteEncryptionKeys
 *   - shielded    → hex(seed), into zk.ts so SHA-256(hex+':spending_key') runs over it
 *
 * We MUST NOT pre-run any HKDF (e.g. deriveP01IdentityFromSeed) on this seed —
 * doing so yields a DIFFERENT 32 bytes and the hardware wallet's notes become
 * unspendable. The seed is stored RAW.
 *
 * At rest: SecureStore, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, keyed by the Ledger's
 * base58 pubkey. The Ledger phrase does NOT regenerate this random seed, so an
 * encrypted backup (services/backup) is near-mandatory — storage wipe = total
 * note loss for the hardware wallet.
 */

import * as SecureStore from 'expo-secure-store';
import nacl from 'tweetnacl';

const SECURE_OPTIONS = {
  keychainService: 'protocol-01',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const KEY_PREFIX = 'p01_hw_spending_seed_';

function storageKey(ledgerPubkeyBase58: string): string {
  return `${KEY_PREFIX}${ledgerPubkeyBase58}`;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Generate 32 CSPRNG bytes. */
function randomSeed(): Uint8Array {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    const b = new Uint8Array(32);
    globalThis.crypto.getRandomValues(b);
    return b;
  }
  // Fallback: nacl CSPRNG (react-native-get-random-values polyfills crypto, but
  // be defensive on platforms where the global is missing at call time).
  return nacl.randomBytes(32);
}

/**
 * Persist a RAW 32-byte spending seed for a hardware wallet. Returns false if the
 * input is the wrong length.
 */
export async function setHardwareSpendingSeed(
  ledgerPubkeyBase58: string,
  seed: Uint8Array,
): Promise<boolean> {
  if (seed.length !== 32) return false;
  await SecureStore.setItemAsync(storageKey(ledgerPubkeyBase58), bytesToHex(seed), SECURE_OPTIONS);
  return true;
}

/**
 * Return the RAW 32-byte spending seed for a hardware wallet, creating + storing
 * a fresh CSPRNG seed on first use. Idempotent: subsequent calls return the same
 * persisted seed (so notes stay spendable).
 */
export async function getOrCreateHardwareSpendingSeed(
  ledgerPubkeyBase58: string,
): Promise<Uint8Array> {
  const key = storageKey(ledgerPubkeyBase58);
  const existing = await SecureStore.getItemAsync(key, SECURE_OPTIONS);
  if (existing) {
    return hexToBytes(existing);
  }
  const seed = randomSeed();
  await SecureStore.setItemAsync(key, bytesToHex(seed), SECURE_OPTIONS);
  return seed;
}

/**
 * Return the RAW 32-byte spending seed if one exists, else null (does NOT
 * create one). Used by backup/restore preflight.
 */
export async function getHardwareSpendingSeed(
  ledgerPubkeyBase58: string,
): Promise<Uint8Array | null> {
  const existing = await SecureStore.getItemAsync(storageKey(ledgerPubkeyBase58), SECURE_OPTIONS);
  return existing ? hexToBytes(existing) : null;
}

/** Delete the persisted hardware spending seed (logout / re-pair). */
export async function deleteHardwareSpendingSeed(ledgerPubkeyBase58: string): Promise<void> {
  await SecureStore.deleteItemAsync(storageKey(ledgerPubkeyBase58), SECURE_OPTIONS);
}
