use anchor_lang::prelude::*;

#[error_code]
pub enum LiquidityError {
    #[msg("Liquidity pool is inactive")]
    PoolInactive,
    #[msg("Insufficient liquidity to prefund this request")]
    InsufficientLiquidity,
    #[msg("Deposit amount must be non-zero")]
    ZeroDeposit,
    #[msg("Withdrawal amount must be non-zero")]
    ZeroWithdraw,
    #[msg("Requested shares exceed depositor balance")]
    InsufficientShares,
    #[msg("Share math overflow")]
    ShareMathOverflow,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,

    #[msg("STARK proof buffer owner is not the stark verifier program")]
    InvalidProofOwner,
    #[msg("STARK proof buffer is malformed")]
    InvalidProofBuffer,
    #[msg("STARK proof buffer is for the wrong circuit")]
    WrongCircuit,
    #[msg("STARK proof buffer is not verified")]
    ProofNotVerified,
    #[msg("Public-inputs hash in proof buffer does not match prefund args")]
    InputsHashMismatch,
    #[msg("Proof buffer authority does not match the ephemeral signer")]
    AuthorityMismatch,

    #[msg("Prefund amount does not match pool denomination")]
    AmountMismatch,
    #[msg("Prefund is not yet mature — settlement must wait for epoch delay")]
    NotMature,
    #[msg("Prefund record does not match the provided nullifier")]
    PrefundMismatch,
    #[msg("Settler reward exceeds cap")]
    RewardTooHigh,
    #[msg("Fee bps exceed cap")]
    FeeTooHigh,

    #[msg("Caller is not the pool admin")]
    Unauthorized,
    #[msg("Pool already initialized")]
    AlreadyInitialized,

    // NOTE: new variants go at the END. Anchor assigns error codes by
    // declaration index from 6000, so inserting above renumbers every
    // downstream code and silently changes what an already-deployed client
    // thinks it is reading.
    #[msg("prefund/settle is closed: zk_shielded::unshield_denominated_stark was retired and its v3 replacement carries no prefund path, so a prefund could never be settled — see p01_liquidity/src/settlement_path.rs")]
    SettlementPathRetired,
}
