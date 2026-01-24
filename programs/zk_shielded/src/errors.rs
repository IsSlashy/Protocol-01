use anchor_lang::prelude::*;

#[error_code]
pub enum ZkShieldedError {
    #[msg("Invalid ZK proof - verification failed")]
    InvalidProof,

    #[msg("Nullifier has already been spent")]
    NullifierAlreadySpent,

    #[msg("Invalid Merkle root - not a known root")]
    InvalidMerkleRoot,

    #[msg("Pool is not active")]
    PoolNotActive,

    #[msg("Unauthorized - not pool authority")]
    Unauthorized,

    #[msg("Invalid amount - must be greater than zero")]
    InvalidAmount,

    #[msg("Merkle tree is full")]
    MerkleTreeFull,

    #[msg("Insufficient shielded balance")]
    InsufficientBalance,

    #[msg("Invalid commitment format")]
    InvalidCommitment,

    #[msg("Invalid verification key")]
    InvalidVerificationKey,

    #[msg("Bloom filter indicates potential double spend")]
    BloomFilterHit,

    #[msg("Token mint mismatch")]
    TokenMintMismatch,

    #[msg("Relayer fee exceeds maximum allowed")]
    RelayerFeeExceedsMax,

    #[msg("Invalid public inputs")]
    InvalidPublicInputs,

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

    #[msg("Insufficient pool balance for withdrawal")]
    InsufficientPoolBalance,
}
