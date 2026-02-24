use anchor_lang::prelude::*;

/// Configuration for a zkSPL-enabled token mint.
/// Created once per SPL token to enable confidential operations.
/// Stores the verification keys and global settings.
#[account]
#[derive(Default)]
pub struct MintConfig {
    /// Authority that can update settings
    pub authority: Pubkey,

    /// The SPL token mint this config is for
    pub token_mint: Pubkey,

    /// Hash of the confidential_balance verification key
    pub balance_vk_hash: [u8; 32],

    /// Hash of the balance_proof verification key (for DeFi composability)
    pub proof_vk_hash: [u8; 32],

    /// Whether this mint accepts new confidential accounts
    pub is_active: bool,

    /// Total number of confidential accounts created
    pub account_count: u64,

    /// Creation timestamp
    pub created_at: i64,

    /// PDA bump
    pub bump: u8,
}

impl MintConfig {
    pub const LEN: usize = 8  // discriminator
        + 32  // authority
        + 32  // token_mint
        + 32  // balance_vk_hash
        + 32  // proof_vk_hash
        + 1   // is_active
        + 8   // account_count
        + 8   // created_at
        + 1;  // bump

    pub const SEED_PREFIX: &'static [u8] = b"zkspl_mint";
}
