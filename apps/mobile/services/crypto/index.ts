// Re-export from encryption (SL3 implementation)
export {
  ENCRYPTION_CONFIG,
  type SessionKey,
  type EncryptionKeyPair as SL3EncryptionKeyPair,
  type EncryptedMessage as EncryptedData,
  type SignedMessage,
  generateKeyPair,
  getOrCreateKeys,
  getSessionKey,
  encryptMessage as encryptData,
  decryptMessage as decryptData,
  signMessage,
  verifySignature,
  deriveAddressKey,
  createEncryptedPayload,
} from './encryption';

// Re-export from messaging (E2E chat encryption with tweetnacl)
export {
  type EncryptedMessage,
  type EncryptionKeyPair,
  uint8ArrayToBase64,
  base64ToUint8Array,
  deriveEncryptionKeys,
  encryptMessage,
  decryptMessage,
} from './messaging';
