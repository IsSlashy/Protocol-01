/**
 * Device-pairing helpers (extension ⇄ mobile, bidirectional).
 *
 * Single source of truth for the 2-QR pairing handshake so the extension and the
 * mobile app share ONE byte-identical implementation. See
 * docs/pairing-ledger-spec.md §1A and §3 (Stage S1).
 *
 *   box.ts      — hardened hybrid box (X25519 + ML-KEM-768 → HKDF → secretbox)
 *   protocol.ts — QR framing, SAS, chunking, replay/expiry guards
 */

export {
  // sizes / prefixes
  X25519_LEN,
  KEM_PUBLIC_LEN,
  KEM_SECRET_LEN,
  KEM_CIPHERTEXT_LEN,
  KEM_SEED_LEN,
  NONCE_LEN,
  PAIR_ENC_PREFIX,
  // key material
  generateEphemeralPairingKeys,
  // encrypt / decrypt
  encryptToPairingBundle,
  decryptWithEphemeral,
  parsePairingBlob,
  // base64 helpers
  b64encode,
  b64decode,
  // types
  type PairingEphemeralKeys,
  type PairingReceiveBundle,
  type ParsedPairingBlob,
} from './box';

export {
  // constants
  PAIRING_TTL_SECS,
  PAIR_QR1_PREFIX,
  PAIRING_QR1_VERSION,
  PAIRING_PAYLOAD_VERSION,
  PAIRING_WALLET_KIND_SEED,
  MAX_PAIRING_INPUT_CHARS,
  PAIR_CHUNK_PREFIX,
  // QR#1
  buildPairingQr1,
  parsePairingQr1,
  // QR#2 payload
  encodePairingPayload,
  decodePairingPayload,
  // SAS
  computeSAS,
  sasEqual,
  // chunking
  chunkPairingCiphertext,
  parsePairingChunk,
  reassemblePairingChunks,
  // replay guard
  ConsumedNonceSet,
  // helpers
  bytesEqual,
  // types
  type PairingQr1,
  type PairingPayload,
  type PairingChunk,
} from './protocol';
