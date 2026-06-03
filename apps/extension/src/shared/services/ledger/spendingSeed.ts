/**
 * Hardware-wallet ZK SPENDING SEED (extension).
 *
 * CANONICAL INVARIANT (docs/pairing-ledger-spec.md §0 — load-bearing):
 *   A Ledger co-signs the on-chain transaction ONLY. The ZK note identity is a
 *   SEPARATE, CSPRNG-generated 32-byte value (the "spending seed") that the
 *   Ledger never holds. This seed is fed RAW to the SAME note consumers, in the
 *   SAME position, as a local wallet's `secretKey.slice(0, 32)`:
 *     - denominated → as `walletSeed` into deriveNoteMaterial /
 *       noteCrypto.deriveNoteEncryptionKeys (which apply their OWN HKDF, IKM =
 *       the raw 32 bytes)
 *     - shielded → hex-encoded into zk.ts so `SHA-256(hex + ':spending_key')`
 *       runs over it (getSeedPhrase hardware branch)
 *   It is NEVER pre-run through `deriveP01IdentityFromSeed` (HKDF) — doing so
 *   would yield DIFFERENT 32 bytes and make every hardware note unspendable.
 *
 * AT REST: AES-256-GCM with PBKDF2-600k (services/crypto.ts `encrypt`), under
 * `chrome.storage.local` keyed by the Ledger public key. The Ledger recovery
 * phrase does NOT regenerate this random seed → a storage wipe is total note
 * loss unless the user took the encrypted identity backup (services/backup.ts).
 *
 * The password that protects the seed at rest is the wallet's unlock password
 * (cached in the session, like the seed-phrase blob). Decrypt only for proving,
 * `fill(0)` the bytes immediately after use.
 */

import { encrypt, decrypt, type EncryptedData } from '../crypto';

/** Per-pubkey storage key prefix for the encrypted hardware spending seed. */
const SEED_KEY_PREFIX = 'p01_ledger_spend_seed_';

function seedStorageKey(publicKey: string): string {
  return `${SEED_KEY_PREFIX}${publicKey}`;
}

/** Generate a fresh CSPRNG 32-byte spending seed (raw — never HKDF'd, per §0). */
export function generateSpendingSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** True if an encrypted spending seed already exists for this Ledger pubkey. */
export async function hasSpendingSeed(publicKey: string): Promise<boolean> {
  try {
    const res = await chrome.storage.local.get(seedStorageKey(publicKey));
    return !!res[seedStorageKey(publicKey)];
  } catch {
    return false;
  }
}

/**
 * Encrypt + persist a spending seed for a Ledger pubkey. Stored as an
 * {@link EncryptedData} blob (AES-GCM, PBKDF2-600k). The raw `seed` buffer is
 * zeroized after encryption — keep your own copy if you still need it.
 */
export async function storeSpendingSeed(
  publicKey: string,
  seed: Uint8Array,
  password: string,
): Promise<void> {
  const seedHex = bytesToHex(seed);
  const blob = await encrypt(seedHex, password);
  await chrome.storage.local.set({ [seedStorageKey(publicKey)]: blob });
  seed.fill(0);
}

/**
 * Decrypt the spending seed for a Ledger pubkey. Returns the RAW 32 bytes (per
 * §0) — the CALLER must `fill(0)` it after feeding the note pipeline. Throws if
 * no seed is stored or the password is wrong.
 */
export async function getSpendingSeed(
  publicKey: string,
  password: string,
): Promise<Uint8Array> {
  const res = await chrome.storage.local.get(seedStorageKey(publicKey));
  const blob = res[seedStorageKey(publicKey)] as EncryptedData | undefined;
  if (!blob) {
    throw new Error(
      'No hardware spending seed found for this Ledger. Reconnect the device, or ' +
        'restore from your encrypted identity backup.',
    );
  }
  const seedHex = await decrypt(blob, password);
  return hexToBytes(seedHex);
}

/**
 * Import a spending seed coming from an encrypted identity backup (restore flow).
 * Re-encrypts it at rest under the current password. The input `seed` buffer is
 * zeroized after persisting.
 */
export async function importSpendingSeed(
  publicKey: string,
  seed: Uint8Array,
  password: string,
): Promise<void> {
  await storeSpendingSeed(publicKey, seed, password);
}

/** Remove the stored seed for a Ledger pubkey (on disconnect / wallet delete). */
export async function removeSpendingSeed(publicKey: string): Promise<void> {
  try {
    await chrome.storage.local.remove(seedStorageKey(publicKey));
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// hex helpers (the seed is stored hex so it round-trips cleanly through the
// string-based crypto.encrypt/decrypt without base64 ambiguity)
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid spending-seed hex length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
