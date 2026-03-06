// Send operations
export {
  sendPrivate,
  sendPublic,
  estimateTransferFee,
  type SendOptions,
} from './send';

// Claim operations
export {
  claimStealth,
  claimMultiple,
  getStealthBalance,
  canClaim,
  estimateClaimFee,
  closeStealthAccount,
  buildClaimProof,
  buildClaimProofV2,
  type ClaimOptions,
} from './claim';
