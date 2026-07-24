// Stealth address generation
export {
  generateStealthMetaAddress,
  parseStealthMetaAddress,
  generateStealthAddress,
  generateMultipleStealthAddresses,
  createStealthAnnouncement,
  parseStealthAnnouncement,
  generateStealthTransferData,
} from './generate';

// Stealth key derivation
export {
  deriveStealthPublicKey,
  deriveStealthPublicKeyFromEncoded,
  deriveStealthPrivateKey,
  verifyStealthOwnership,
  computeStealthAddress,
} from './derive';

// Payment scanning
export {
  StealthScanner,
  scanForPayments,
  createScanner,
  subscribeToPayments,
} from './scan';

// Post-quantum claim proofs (P4.3)
export {
  deriveStealthWotsKeypair,
  deriveStealthWotsFromRecipient,
  buildClaimProofPQ,
  verifyClaimProofPQ,
  type PQClaimContext,
  type PQClaimProof,
} from './quantum';

// On-chain v2 hybrid announcement — chunked ML-KEM ciphertext transport.
// The single source of truth for the init_stealth_v2 / write_stealth_kem_chunk
// instruction encoding + announcement PDA. Clients MUST use these (not a copy)
// or the on-chain program will reject the announcement.
export {
  buildInitStealthV2Ix,
  buildWriteKemChunkIx,
  buildKemChunkIxs,
  deriveAnnouncementPda,
  decodeStealthV2,
  STEALTH_V2_SEED,
  STEALTH_V2_ACCOUNT_LEN,
  MLKEM768_CIPHERTEXT_LEN,
  KEM_CHUNK_SIZE,
  IX_INIT_STEALTH_V2,
  IX_WRITE_KEM_CHUNK,
  ACCT_STEALTH_V2,
} from './announcement-v2';
