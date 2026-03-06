use anchor_lang::prelude::*;

#[error_code]
pub enum TrustlessError {
    #[msg("Nullifier has already been spent -- double-spend rejected")]
    NullifierAlreadySpent,

    #[msg("Invalid ZK proof -- Groth16 verification failed")]
    InvalidProof,

    #[msg("Invalid Merkle root -- not a known current or historical root")]
    InvalidMerkleRoot,

    #[msg("Insufficient pool balance for withdrawal")]
    InsufficientPoolBalance,

    #[msg("Invalid denomination -- must be greater than zero")]
    InvalidDenomination,

    #[msg("Invalid public inputs -- wrong number or format")]
    InvalidPublicInputs,

    #[msg("Invalid verification key")]
    InvalidVerificationKey,

    #[msg("Pool is not active")]
    PoolNotActive,

    #[msg("Unauthorized -- not pool authority")]
    Unauthorized,

    #[msg("Merkle tree is full")]
    MerkleTreeFull,

    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,

    #[msg("Missing token program for SPL token operation")]
    MissingTokenProgram,

    #[msg("Missing user token account for SPL token operation")]
    MissingTokenAccount,

    #[msg("Missing pool vault for SPL token operation")]
    MissingPoolVault,

    #[msg("Invalid token mint")]
    InvalidTokenMint,

    #[msg("Invalid token account owner")]
    InvalidTokenOwner,

    #[msg("Invalid commitment format")]
    InvalidCommitment,

    #[msg("Invalid amount -- must be greater than zero")]
    InvalidAmount,

    #[msg("Epoch delay not met -- note is too young")]
    EpochDelayNotMet,

    #[msg("Account is not initialized")]
    AccountNotInitialized,

    #[msg("Nonce mismatch -- proof uses stale state")]
    NonceMismatch,

    #[msg("Cannot deposit and withdraw simultaneously")]
    InvalidCreditDebit,

    #[msg("Insufficient vault balance for withdrawal")]
    InsufficientVaultBalance,
}
