use anchor_lang::prelude::*;

/// A confidential balance account for trustless zkSPL operations.
/// Balance is stored as a Poseidon hash commitment -- nobody can see the actual balance.
///
/// Balance commitment = Poseidon(balance, salt, owner_pubkey, token_mint)
#[account]
#[derive(Default)]
pub struct ConfidentialAccount {
    /// Solana wallet that owns this account
    pub owner: Pubkey,

    /// The SPL token mint
    pub mint: Pubkey,

    /// Current balance commitment: Poseidon(balance, salt, owner_pubkey, token_mint)
    pub balance_commitment: [u8; 32],

    /// Anti-replay nonce (incremented on every state change)
    pub nonce: u64,

    /// Whether this account is initialized and active
    pub is_initialized: bool,

    /// Creation timestamp
    pub created_at: i64,

    /// Last operation timestamp
    pub last_tx_at: i64,

    /// PDA bump
    pub bump: u8,
}

impl ConfidentialAccount {
    pub const LEN: usize = 8   // discriminator
        + 32  // owner
        + 32  // mint
        + 32  // balance_commitment
        + 8   // nonce
        + 1   // is_initialized
        + 8   // created_at
        + 8   // last_tx_at
        + 1;  // bump

    pub const SEED_PREFIX: &'static [u8] = b"trustless_account";
}
