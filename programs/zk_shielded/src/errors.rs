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

    // Auction Escrow errors
    #[msg("Auction escrow has already been settled")]
    EscrowAlreadySettled,

    #[msg("Auction escrow outcome has not been determined yet")]
    EscrowOutcomeNotSet,

    #[msg("Auction escrow has already been released")]
    EscrowAlreadyReleased,

    #[msg("Invalid auction ID — does not match escrow")]
    InvalidAuctionId,

    #[msg("Auction has not been finalized by MPC")]
    AuctionNotFinalized,

    #[msg("Recipient account missing from remaining_accounts")]
    MissingRecipient,

    #[msg("Recipient pubkey does not match recipient arg")]
    MismatchedRecipient,

    // DEAD, RESERVED. These three were raised only by the refund-via-relayer
    // path in `cancel_private_stark`, which has been deleted along with
    // cancellation and refunds. No instruction can return them any more.
    //
    // They are KEPT rather than removed because `#[error_code]` numbers
    // variants by position: deleting them would renumber `SlotMismatch` below,
    // which `sweep_fee_escrow` still raises, and every client error catalogue
    // and every already-deployed copy of this program would decode it wrong.
    // Same reasoning as the deprecated `SubscriptionVault` fields — the slot
    // costs nothing at runtime, moving it costs a client break.
    #[msg("DEPRECATED — unused since cancellation was removed")]
    MissingAccount,

    #[msg("DEPRECATED — unused since cancellation was removed")]
    InvalidProgramId,

    #[msg("DEPRECATED — unused since cancellation was removed")]
    InvalidPda,

    #[msg("Slot mismatch — caller-supplied slot must match current clock within drift window")]
    SlotMismatch,

    // === [C7] `unshield_denominated_stark_v4`. APPENDED, never inserted:
    // `#[error_code]` numbers variants by position, so a new code anywhere
    // above would renumber `SlotMismatch` and every already-deployed client
    // error catalogue would decode it wrong.
    //
    // These five are kept DISTINCT from `InvalidProof` on purpose. Four of them
    // are the CALLER's fault — a badly-shaped Merkle walk — and telling that
    // caller their PROOF is bad sends them off to spend three minutes
    // regenerating a proof that was fine.
    #[msg("Pool tree is not deeper than the depth-12 subtree circuit 7 proves")]
    SpendPoolShallowerThanCircuit,

    #[msg("Sibling/direction count must equal tree_depth - 12")]
    SpendWrongSiblingCount,

    #[msg("A Merkle direction bit was neither 0 nor 1")]
    SpendNonBinaryDirection,

    #[msg("A supplied value is not a canonical Goldilocks element")]
    SpendNonCanonicalFelt,

    // This one is NOT a shape error. It means the walk reached a root that is
    // not the one the caller named — i.e. the proof and the claimed root
    // disagree. Distinct from `InvalidMerkleRoot`, which means the named root
    // is well-formed but the pool never published it.
    #[msg("Derived pool root does not match the named merkle_root")]
    SpendRootMismatch,

    // The relayed spend path pays its relayer in lamports out of the note. On
    // an SPL pool the note is denominated in tokens, so there is nothing to
    // pay it FROM without inventing an exchange rate. Fails closed instead.
    #[msg("The relayed spend path is native-SOL only; this pool is SPL")]
    RelayerRewardUnsupportedForSpl,

    // The relayer reward comes OUT OF THE PROTOCOL FEE so that the payee gets
    // the same amount on both paths. On a denomination whose 0.5% fee is
    // smaller than the reward, the relayed path simply cannot pay for itself
    // and fails closed rather than reaching into the payee's share.
    // MEASURED: the 1 SOL pool charges 5,000,000 and covers it; the 0.1 SOL
    // pool charges 500,000 and does not.
    #[msg("This pool's protocol fee is smaller than the relayer reward")]
    RelayerRewardExceedsNote,
}
