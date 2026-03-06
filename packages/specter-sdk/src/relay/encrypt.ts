/**
 * Relay job encryption: X25519 ECDH + NaCl secretbox (XSalsa20-Poly1305).
 *
 * The user encrypts the serialized transaction to the assigned relayer's
 * X25519 public key. Only that relayer can decrypt it.
 *
 * Format: ephemeral_pubkey (32) || nonce (24) || ciphertext+tag
 */

import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';

const RELAY_HKDF_INFO = 'p01_relay_job_v1';

/**
 * Encrypt a transaction payload for a specific relayer.
 *
 * @param payload - Serialized transaction bytes
 * @param relayerEncryptionKey - Relayer's X25519 public key (32 bytes)
 * @returns Encrypted blob: ephemeral_pubkey || nonce || ciphertext
 */
export function encryptForRelayer(
  payload: Uint8Array,
  relayerEncryptionKey: Uint8Array,
): Uint8Array {
  // Generate ephemeral X25519 keypair
  const ephemeral = nacl.box.keyPair();

  // ECDH shared secret
  const rawSecret = nacl.scalarMult(ephemeral.secretKey, relayerEncryptionKey);

  // Derive symmetric key via HKDF
  const symmetricKey = hkdf(sha256, rawSecret, undefined, RELAY_HKDF_INFO, 32);

  // Encrypt with NaCl secretbox (XSalsa20-Poly1305)
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ciphertext = nacl.secretbox(payload, nonce, symmetricKey);

  // Combine: ephemeral_pubkey (32) || nonce (24) || ciphertext
  const result = new Uint8Array(32 + nonce.length + ciphertext.length);
  result.set(ephemeral.publicKey, 0);
  result.set(nonce, 32);
  result.set(ciphertext, 32 + nonce.length);

  return result;
}

/**
 * Decrypt a relay job payload (used by relayer nodes).
 *
 * @param encrypted - Encrypted blob from encryptForRelayer
 * @param relayerSecretKey - Relayer's X25519 private key (32 bytes)
 * @returns Decrypted transaction bytes, or null if decryption fails
 */
export function decryptRelayJob(
  encrypted: Uint8Array,
  relayerSecretKey: Uint8Array,
): Uint8Array | null {
  if (encrypted.length < 32 + nacl.secretbox.nonceLength + nacl.secretbox.overheadLength) {
    return null;
  }

  const ephemeralPubKey = encrypted.slice(0, 32);
  const nonce = encrypted.slice(32, 32 + nacl.secretbox.nonceLength);
  const ciphertext = encrypted.slice(32 + nacl.secretbox.nonceLength);

  // ECDH shared secret
  const rawSecret = nacl.scalarMult(relayerSecretKey, ephemeralPubKey);

  // Derive symmetric key
  const symmetricKey = hkdf(sha256, rawSecret, undefined, RELAY_HKDF_INFO, 32);

  // Decrypt
  return nacl.secretbox.open(ciphertext, nonce, symmetricKey);
}
