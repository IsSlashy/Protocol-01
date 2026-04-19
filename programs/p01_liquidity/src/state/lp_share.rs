use anchor_lang::prelude::*;

/// Per-depositor share balance. One PDA per (owner, pool).
#[account]
pub struct LPShare {
    pub owner: Pubkey,
    pub pool: Pubkey,
    pub shares: u128,
    pub bump: u8,
}

impl LPShare {
    pub const SEED_PREFIX: &'static [u8] = b"lp_share";

    /// 8 disc + 32 owner + 32 pool + 16 shares + 1 bump
    pub const LEN: usize = 8 + 32 + 32 + 16 + 1;
}
