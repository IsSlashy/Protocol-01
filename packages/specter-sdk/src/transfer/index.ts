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
  type ClaimOptions,
} from './claim';
