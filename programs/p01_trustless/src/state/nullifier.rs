use anchor_lang::prelude::*;

/// A PDA account whose existence proves a nullifier has been spent.
///
/// PERMANENT. IMMUTABLE. TRUSTLESS.
///
/// Seeds: [b"nullifier", pool_key, nullifier_hash]
/// If this account exists, the nullifier is spent. Period.
/// No false positives, no size limits, scales to millions of nullifiers.
/// Rent (~0.00089 SOL) paid by the transaction submitter.
///
/// This is the core double-spend prevention mechanism.
/// The math creates the nullifier. The chain records it. Nobody can override it.
#[account]
pub struct NullifierAccount {
    /// The raw nullifier hash (32 bytes)
    pub nullifier: [u8; 32],

    /// Slot at which this nullifier was spent
    pub spent_at_slot: u64,

    /// Bump seed for PDA
    pub bump: u8,
}

impl NullifierAccount {
    pub const SEED_PREFIX: &'static [u8] = b"nullifier";

    pub const LEN: usize = 8   // discriminator
        + 32  // nullifier
        + 8   // spent_at_slot
        + 1;  // bump
}
