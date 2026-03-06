/**
 * Relay job encryption.
 *
 * v1 (classic): X25519 ECDH + HKDF + XSalsa20-Poly1305
 *   Wire: 0x01 || ephemeral_pubkey (32) || nonce (24) || ciphertext+tag
 *
 * v2 (hybrid PQ): X25519 ECDH + ML-KEM-768 + HKDF + XSalsa20-Poly1305
 *   Wire: 0x02 || ephemeral_pubkey (32) || kem_ciphertext (1088) || nonce (24) || ciphertext+tag
 *
 * Auto-selects v2 when relayerKemKey is provided.
 */

import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { ml_kem768 } from '@noble/post-quantum/ml-kem';
import { KEM_PUBLIC_KEY_SIZE } from './types';

const RELAY_HKDF_INFO_V1 = 'p01_relay_job_v1';
const RELAY_HKDF_INFO_V2 = 'p01_relay_job_hybrid_v2';
const KEM_CIPHERTEXT_SIZE = 1088;

/**
 * Encrypt a transaction payload for a specific relayer.
 * Uses hybrid encryption (v2) when relayerKemKey is provided.
 *
 * @param payload - Serialized transaction bytes
 * @param relayerEncryptionKey - Relayer's X25519 public key (32 bytes)
 * @param relayerKemKey - Relayer's ML-KEM-768 public key (1184 bytes, optional)
 * @returns Encrypted blob with version prefix
 */
export function encryptForRelayer(
  payload: Uint8Array,
  relayerEncryptionKey: Uint8Array,
  relayerKemKey?: Uint8Array,
): Uint8Array {
  const ephemeral = nacl.box.keyPair();
  const classicSecret = nacl.scalarMult(ephemeral.secretKey, relayerEncryptionKey);

  let symmetricKey: Uint8Array;
  let kemCiphertext: Uint8Array | undefined;

  if (relayerKemKey && relayerKemKey.length === KEM_PUBLIC_KEY_SIZE) {
    const kem = ml_kem768.encapsulate(relayerKemKey);
    kemCiphertext = kem.cipherText;

    const combined = new Uint8Array(classicSecret.length + kem.sharedSecret.length);
    combined.set(classicSecret);
    combined.set(kem.sharedSecret, classicSecret.length);
    symmetricKey = hkdf(sha256, combined, undefined, RELAY_HKDF_INFO_V2, 32);
  } else {
    symmetricKey = hkdf(sha256, classicSecret, undefined, RELAY_HKDF_INFO_V1, 32);
  }

  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ciphertext = nacl.secretbox(payload, nonce, symmetricKey);

  if (kemCiphertext) {
    // v2: version(1) + ephemeral(32) + kem_ct(1088) + nonce(24) + ciphertext
    const result = new Uint8Array(1 + 32 + KEM_CIPHERTEXT_SIZE + nonce.length + ciphertext.length);
    result[0] = 0x02;
    result.set(ephemeral.publicKey, 1);
    result.set(kemCiphertext, 33);
    result.set(nonce, 33 + KEM_CIPHERTEXT_SIZE);
    result.set(ciphertext, 33 + KEM_CIPHERTEXT_SIZE + nonce.length);
    return result;
  }

  // v1: version(1) + ephemeral(32) + nonce(24) + ciphertext
  const result = new Uint8Array(1 + 32 + nonce.length + ciphertext.length);
  result[0] = 0x01;
  result.set(ephemeral.publicKey, 1);
  result.set(nonce, 33);
  result.set(ciphertext, 33 + nonce.length);
  return result;
}

/**
 * Decrypt a relay job payload (used by relayer nodes).
 * Supports both v1 and v2 wire formats.
 *
 * @param encrypted - Encrypted blob from encryptForRelayer
 * @param relayerSecretKey - Relayer's X25519 private key (32 bytes)
 * @param relayerKemSecretKey - Relayer's ML-KEM-768 secret key (2400 bytes, for v2)
 * @returns Decrypted transaction bytes, or null if decryption fails
 */
export function decryptRelayJob(
  encrypted: Uint8Array,
  relayerSecretKey: Uint8Array,
  relayerKemSecretKey?: Uint8Array,
): Uint8Array | null {
  if (encrypted.length < 2) return null;

  const version = encrypted[0];

  if (version === 0x02) {
    // v2 hybrid
    if (!relayerKemSecretKey) return null;
    const minLen = 1 + 32 + KEM_CIPHERTEXT_SIZE + nacl.secretbox.nonceLength + nacl.secretbox.overheadLength;
    if (encrypted.length < minLen) return null;

    const ephemeralPubKey = encrypted.slice(1, 33);
    const kemCt = encrypted.slice(33, 33 + KEM_CIPHERTEXT_SIZE);
    const nonce = encrypted.slice(33 + KEM_CIPHERTEXT_SIZE, 33 + KEM_CIPHERTEXT_SIZE + nacl.secretbox.nonceLength);
    const ciphertext = encrypted.slice(33 + KEM_CIPHERTEXT_SIZE + nacl.secretbox.nonceLength);

    const classicSecret = nacl.scalarMult(relayerSecretKey, ephemeralPubKey);
    const kemSharedSecret = ml_kem768.decapsulate(kemCt, relayerKemSecretKey);

    const combined = new Uint8Array(classicSecret.length + kemSharedSecret.length);
    combined.set(classicSecret);
    combined.set(kemSharedSecret, classicSecret.length);
    const symmetricKey = hkdf(sha256, combined, undefined, RELAY_HKDF_INFO_V2, 32);

    return nacl.secretbox.open(ciphertext, nonce, symmetricKey);
  }

  if (version === 0x01) {
    // v1 classic
    const minLen = 1 + 32 + nacl.secretbox.nonceLength + nacl.secretbox.overheadLength;
    if (encrypted.length < minLen) return null;

    const ephemeralPubKey = encrypted.slice(1, 33);
    const nonce = encrypted.slice(33, 33 + nacl.secretbox.nonceLength);
    const ciphertext = encrypted.slice(33 + nacl.secretbox.nonceLength);

    const rawSecret = nacl.scalarMult(relayerSecretKey, ephemeralPubKey);
    const symmetricKey = hkdf(sha256, rawSecret, undefined, RELAY_HKDF_INFO_V1, 32);

    return nacl.secretbox.open(ciphertext, nonce, symmetricKey);
  }

  // Legacy format (no version byte) — treat first 32 bytes as ephemeral key
  if (encrypted.length < 32 + nacl.secretbox.nonceLength + nacl.secretbox.overheadLength) {
    return null;
  }

  const ephemeralPubKey = encrypted.slice(0, 32);
  const nonce = encrypted.slice(32, 32 + nacl.secretbox.nonceLength);
  const ciphertext = encrypted.slice(32 + nacl.secretbox.nonceLength);

  const rawSecret = nacl.scalarMult(relayerSecretKey, ephemeralPubKey);
  const symmetricKey = hkdf(sha256, rawSecret, undefined, RELAY_HKDF_INFO_V1, 32);

  return nacl.secretbox.open(ciphertext, nonce, symmetricKey);
}
