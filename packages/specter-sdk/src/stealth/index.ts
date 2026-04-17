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
