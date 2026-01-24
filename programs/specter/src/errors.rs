use anchor_lang::prelude::*;

#[error_code]
pub enum P01Error {
    // Wallet Errors (6000-6009)
    #[msg("Wallet already initialized")]
    WalletAlreadyInitialized,

    #[msg("Invalid viewing key provided")]
    InvalidViewingKey,

    #[msg("Invalid spending key provided")]
    InvalidSpendingKey,

    #[msg("Unauthorized access to wallet")]
    UnauthorizedWalletAccess,

    // Stealth Payment Errors (6010-6019)
    #[msg("Invalid stealth address")]
    InvalidStealthAddress,

    #[msg("Stealth payment already claimed")]
    StealthAlreadyClaimed,

    #[msg("Invalid claim proof")]
    InvalidClaimProof,

    #[msg("Stealth payment expired")]
    StealthPaymentExpired,

    #[msg("Invalid decoy level (must be 0-4)")]
    InvalidDecoyLevel,

    #[msg("Insufficient funds for stealth payment")]
    InsufficientFundsForStealth,

    // Stream Errors (6020-6039)
    #[msg("Stream not yet started")]
    StreamNotStarted,

    #[msg("Stream already ended")]
    StreamEnded,

    #[msg("Stream is paused")]
    StreamPaused,

    #[msg("No funds available to withdraw")]
    NoFundsAvailable,

    #[msg("Stream already cancelled")]
    StreamAlreadyCancelled,

    #[msg("Unauthorized stream access")]
    UnauthorizedStreamAccess,

    #[msg("Invalid stream duration")]
    InvalidStreamDuration,

    #[msg("Invalid stream amount")]
    InvalidStreamAmount,

    #[msg("Stream recipient cannot be sender")]
    RecipientIsSender,

    #[msg("Stream is still active")]
    StreamStillActive,

    // Token Errors (6040-6049)
    #[msg("Invalid token mint")]
    InvalidTokenMint,

    #[msg("Token transfer failed")]
    TokenTransferFailed,

    #[msg("Insufficient token balance")]
    InsufficientBalance,

    // Cryptographic Errors (6050-6059)
    #[msg("Encryption failed")]
    EncryptionFailed,

    #[msg("Decryption failed")]
    DecryptionFailed,

    #[msg("Invalid signature")]
    InvalidSignature,

    #[msg("Proof verification failed")]
    ProofVerificationFailed,

    // General Errors (6060-6069)
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,

    #[msg("Invalid account data")]
    InvalidAccountData,

    #[msg("Account not initialized")]
    AccountNotInitialized,

    #[msg("Invalid bump seed")]
    InvalidBumpSeed,
}
