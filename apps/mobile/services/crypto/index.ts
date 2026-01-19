// Re-export from encryption (SL3 implementation)
export {
  ENCRYPTION_CONFIG,
  type SessionKey,
  type EncryptedData,
  initializeEncryptionKeys,
  getEncryptionKeys,
  deriveSessionKey,
  encryptData,
  decryptData,
  encryptForStorage,
  decryptFromStorage,
  rotateEncryptionKeys,
  clearEncryptionKeys,
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
  getConversationId,
} from './messaging';
