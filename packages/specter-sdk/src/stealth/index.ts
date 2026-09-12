// Stealth address generation — key math only, nothing here touches the chain
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

// Post-quantum claim proofs (P4.3) — WOTS+ over a claim message, off-chain
export {
  deriveStealthWotsKeypair,
  deriveStealthWotsFromRecipient,
  buildClaimProofPQ,
  verifyClaimProofPQ,
  type PQClaimContext,
  type PQClaimProof,
} from './quantum';

// [2026-09-13] `./scan` (StealthScanner, scanForPayments, createScanner,
// subscribeToPayments) and `./announcement-v2` (the init_stealth_v2 /
// write_stealth_kem_chunk builders and the announcement PDA) are gone: both
// read or wrote the `specter` program, closed on devnet on 2026-09-13.
