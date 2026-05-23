use anchor_lang::prelude::*;

#[error_code]
pub enum QWalletError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Insufficient wallet balance")]
    InsufficientBalance,
    #[msg("Withdrawal would leave wallet below rent-exempt minimum")]
    InsufficientFundsForRent,
    #[msg("STARK proof buffer not owned by p01_stark_verifier")]
    InvalidProofOwner,
    #[msg("STARK proof buffer discriminator mismatch")]
    InvalidProofDiscriminator,
    #[msg("STARK proof has not been verified")]
    ProofNotVerified,
    #[msg("STARK proof was generated for a different authority")]
    ProofAuthorityMismatch,
    #[msg("STARK proof was generated for a different circuit")]
    ProofCircuitMismatch,
    #[msg("STARK public inputs hash does not match the wallet commitment")]
    ProofInputsMismatch,
    #[msg("Wallet nonce mismatch — replay protection")]
    NonceMismatch,
    #[msg("Recovery key is not configured for this wallet")]
    NoRecoveryKey,
    #[msg("SPHINCS+ signature buffer is bound to a different wallet")]
    SphincsBufferWalletMismatch,
    #[msg("SPHINCS+ signature buffer has not been fully populated")]
    IncompleteSphincsSignature,
    #[msg("SPHINCS+ signature buffer chunk exceeds declared sig_size")]
    SphincsChunkOutOfBounds,
    #[msg("SPHINCS+ signature size is invalid for the selected variant")]
    InvalidSphincsSignatureSize,
    #[msg("SPHINCS+ on-chain verifier is not yet wired (slh-dsa integration pending)")]
    SphincsVerifierNotWired,
    #[msg("SPHINCS+ signature verification failed")]
    SphincsVerificationFailed,
}
