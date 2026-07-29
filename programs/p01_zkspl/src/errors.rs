use anchor_lang::prelude::*;

#[error_code]
pub enum ZkSplError {
    #[msg("Invalid ZK proof — verification failed")]
    InvalidProof,

    #[msg("Mint is not active")]
    MintNotActive,

    #[msg("Account is not initialized")]
    AccountNotInitialized,

    #[msg("Unauthorized — not account owner")]
    Unauthorized,

    #[msg("Invalid amount — must be greater than zero")]
    InvalidAmount,

    #[msg("Invalid commitment format")]
    InvalidCommitment,

    #[msg("Invalid verification key")]
    InvalidVerificationKey,

    #[msg("Invalid public inputs")]
    InvalidPublicInputs,

    #[msg("Nonce mismatch — proof uses stale state")]
    NonceMismatch,

    #[msg("Too many pending credits — apply existing ones first")]
    TooManyPendingCredits,

    #[msg("No pending credit matches this amount_hash")]
    PendingCreditNotFound,

    #[msg("Too many viewer keys")]
    TooManyViewerKeys,

    #[msg("Viewer key already exists")]
    ViewerKeyAlreadyExists,

    #[msg("Viewer key not found")]
    ViewerKeyNotFound,

    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,

    #[msg("Missing token program for SPL token operation")]
    MissingTokenProgram,

    #[msg("Missing user token account")]
    MissingTokenAccount,

    #[msg("Missing pool vault")]
    MissingPoolVault,

    #[msg("Invalid token mint")]
    InvalidTokenMint,

    #[msg("Invalid token account owner")]
    InvalidTokenOwner,

    #[msg("Insufficient pool vault balance for withdrawal")]
    InsufficientVaultBalance,
}
