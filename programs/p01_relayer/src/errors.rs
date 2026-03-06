use anchor_lang::prelude::*;

#[error_code]
pub enum RelayerError {
    #[msg("Unauthorized: signer is not the authority")]
    Unauthorized,

    #[msg("Relayer is not active")]
    RelayerNotActive,

    #[msg("Maximum number of relayers reached")]
    MaxRelayersReached,

    #[msg("Insufficient stake amount")]
    InsufficientStake,

    #[msg("Job is not in Pending status")]
    JobNotPending,

    #[msg("Job has not expired yet")]
    JobNotExpired,

    #[msg("Job is already completed")]
    JobAlreadyCompleted,

    #[msg("Cooldown period has not elapsed")]
    CooldownNotElapsed,

    #[msg("Invalid fee amount")]
    InvalidFee,

    #[msg("Protocol is paused")]
    ProtocolPaused,

    #[msg("Encrypted transaction data exceeds maximum size")]
    EncryptedTxTooLarge,

    #[msg("Relayer assignment does not match")]
    InvalidRelayerAssignment,

    #[msg("Relayer is still active — deactivate first")]
    RelayerStillActive,

    #[msg("Job deadline has passed")]
    JobExpired,

    #[msg("Submitter does not match job submitter")]
    InvalidSubmitter,

    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
}
