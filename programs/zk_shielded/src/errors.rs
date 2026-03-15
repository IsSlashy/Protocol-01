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

    #[msg("Denomination must be greater than zero")]
    InvalidDenomination,

    #[msg("Deposit amount must equal pool denomination")]
    AmountMustEqualDenomination,

    #[msg("Epoch delay not met - note is too young")]
    EpochDelayNotMet,

    #[msg("Epoch delay must be greater than zero")]
    InvalidEpochDelay,

    // Subscription Vault errors
    #[msg("Subscription vault is not active")]
    VaultNotActive,

    #[msg("Subscription vault is already paused")]
    VaultAlreadyPaused,

    #[msg("Subscription vault is not paused")]
    VaultNotPaused,

    #[msg("Unauthorized vault subscriber")]
    UnauthorizedVaultSubscriber,

    #[msg("No claimable periods available")]
    NoClaimablePeriods,

    #[msg("Insufficient vault balance for claim")]
    InsufficientVaultBalance,

    #[msg("Invalid vault mode for this operation")]
    InvalidVaultMode,

    #[msg("Subscription rate must be greater than zero")]
    InvalidRate,

    #[msg("Subscription interval must be greater than zero")]
    InvalidInterval,

    #[msg("Expected normal (wallet) mode vault")]
    ExpectedNormalMode,

    #[msg("Expected private (ZK) mode vault")]
    ExpectedPrivateMode,

    #[msg("Invalid protocol fee wallet")]
    InvalidFeeWallet,

    #[msg("VK update cooldown period has not elapsed (24h between updates)")]
    VkUpdateCooldown,

    #[msg("No pending authority transfer")]
    NoPendingAuthority,

    #[msg("Pending authority does not match signer")]
    PendingAuthorityMismatch,

    // Privacy Router errors
    #[msg("Invalid split denomination — source denomination must equal num_outputs * target denomination")]
    InvalidSplitDenomination,

    #[msg("Too many split outputs — maximum is 20")]
    TooManyOutputs,

    #[msg("Invalid output count — must be between 1 and 20")]
    InvalidOutputCount,

    #[msg("Privacy route is not active")]
    RouteNotActive,

    #[msg("Unauthorized route access — not route authority")]
    UnauthorizedRoute,
}
