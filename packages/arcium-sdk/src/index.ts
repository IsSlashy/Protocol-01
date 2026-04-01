// Protocol 01 × Arcium MPC Integration SDK
// Confidential computation layer for privacy-preserving operations

export { ArciumClient, P01_ARCIUM_PROGRAM_ID, ARCIUM_CLUSTER_OFFSET, CIRCUITS } from './client';
export type { ArciumClientConfig, EncryptedPayload, ComputationResult, CircuitName } from './client';

// UC1: Confidential Relay — threshold TX decryption
export {
  submitConfidentialRelayJob,
  awaitRelayCompletion,
  relayTransaction,
  getRelayJobAddress,
} from './relay';
export type { ConfidentialRelayJob, RelayResult } from './relay';

// UC2: Anonymous Registry Lookup — private meta-address query
export { privateLookup, getRegistryAddress } from './registry';
export type { PrivateLookupResult } from './registry';

// UC3: Hidden Nullifier Commitment — unlinkable spent-note tracking
export {
  commitNullifier,
  checkNullifierSpent,
  getNullifierSetAddress,
  getNullifierCommitmentAddress,
} from './nullifier';
export type { NullifierCommitment, NullifierCheckResult } from './nullifier';

// UC4: Confidential Balance Audit — solvency proof without individual exposure
export {
  submitBalanceForAudit,
  finalizeAudit,
  getAuditAccumulatorAddress,
} from './audit';
export type { AuditSubmission, AuditResult } from './audit';

// UC5: Threshold Stealth Scanning — distributed viewing key protection
export {
  registerViewingKey,
  scanAnnouncements,
  getViewingKeyAddress,
} from './stealth';
export type { StealthScanRequest, StealthScanResult, ViewingKeySetup } from './stealth';

// UC6: Private Governance Voting — encrypted ballot tallying
export {
  createProposal,
  castVote,
  finalizeTally,
  getProposalAddress,
  getBallotAddress,
} from './governance';
export type { ProposalConfig, VoteReceipt, TallyResult } from './governance';

// UC7: Sealed-Bid Auction — encrypted bids + shielded pool escrow
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
