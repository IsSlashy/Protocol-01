/**
 * @protocol-01/arcium-sdk -- Multi-party computation (MPC) privacy layer for Protocol 01.
 *
 * Powered by the Arcium Network, this SDK provides encrypted computation
 * across 8 privacy modules. All sensitive data is encrypted client-side
 * with x25519 + RescueCipher before submission; MPC nodes operate on
 * secret shares and never see plaintext inputs.
 *
 * @packageDocumentation
 */

// ── Core Client ────────────────────────────────────────────────────────────
export { ArciumClient, P01_ARCIUM_PROGRAM_ID, ARCIUM_CLUSTER_OFFSET, CIRCUITS } from './client';
export type { ArciumClientConfig, EncryptedPayload, ComputationResult, CircuitName } from './client';

// ── UC1: Confidential Relay -- Phase D Alt 1 (recipient-only) ─────────────
export {
  submitConfidentialRelayJob,
  awaitRecipientDecryption,
  relayRecipient,
  getRelayJobAddress,
} from './relay';
export type { ConfidentialRelayJob, DecryptedRecipient } from './relay';

// ── UC2: Anonymous Registry Lookup -- private meta-address query ───────────
export { privateLookup, getRegistryAddress } from './registry';
export type { PrivateLookupResult } from './registry';

// ── UC3: Hidden Nullifier Commitment -- unlinkable spent-note tracking ─────
export {
  commitNullifier,
  checkNullifierSpent,
  getNullifierSetAddress,
  getNullifierCommitmentAddress,
} from './nullifier';
export type { NullifierCommitment, NullifierCheckResult } from './nullifier';

// ── UC4: Confidential Balance Audit -- solvency proof ──────────────────────
export {
  submitBalanceForAudit,
  finalizeAudit,
  getAuditAccumulatorAddress,
} from './audit';
export type { AuditSubmission, AuditResult } from './audit';

// ── UC5: Threshold Stealth Scanning -- protected viewing key ───────────────
export {
  registerViewingKey,
  scanAnnouncements,
  getViewingKeyAddress,
} from './stealth';
export type { StealthScanRequest, StealthScanResult, ViewingKeySetup } from './stealth';

// ── UC6: Private Governance Voting -- encrypted ballot tallying ────────────
export {
  createProposal,
  castVote,
  finalizeTally,
  getProposalAddress,
  getBallotAddress,
} from './governance';
export type { ProposalConfig, VoteReceipt, TallyResult } from './governance';

// ── UC7: Sealed-Bid Auction -- encrypted bids + shielded pool escrow ──────
export {
  createAuction,
  submitSealedBid,
  finalizeAuction,
  writeEscrowOutcome,
  releaseEscrow,
  getAuctionAddress,
  getEscrowAddress,
  nullifierToChunks,
  chunksToNullifier,
} from './auction';
export type { AuctionConfig, BidReceipt, AuctionResult } from './auction';

// ── UC8: Mugen P2P -- Encrypted order matching (Privacy Layer 8) ──────────
export {
  submitEncryptedOffer,
  blindTakeOrder,
  cancelEncryptedOffer,
  currencyToHash,
  generateNonce,
  MUGEN_CIRCUITS,
} from './mugen';
export type { EncryptedOfferParams, BlindTakeParams, OfferReceipt, MatchResult } from './mugen';
