use anchor_lang::prelude::*;

use crate::errors::TrustlessError;
use crate::state::PoolState;

/// Update the unshield verification key hash on a trustless pool.
/// Admin-only: requires pool authority signature.
/// This is one of the few admin operations allowed after pool creation.
#[derive(Accounts)]
#[instruction(new_vk_hash: [u8; 32])]
pub struct UpdateVkHash<'info> {
    /// Pool authority (must sign)
    #[account(
        constraint = authority.key() == pool.authority @ TrustlessError::Unauthorized
    )]
    pub authority: Signer<'info>,

    /// Pool state
    #[account(
        mut,
        seeds = [
            PoolState::SEED_PREFIX,
            pool.token_mint.as_ref(),
            &pool.denomination.to_le_bytes()
        ],
        bump = pool.bump
    )]
    pub pool: Account<'info, PoolState>,
}

pub fn handler(
    ctx: Context<UpdateVkHash>,
    new_vk_hash: [u8; 32],
) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let old_hash = pool.verification_key_hash;
    pool.verification_key_hash = new_vk_hash;

    msg!(
        "VK hash updated: {:?} -> {:?}",
        &old_hash[..4],
        &new_vk_hash[..4]
    );

    Ok(())
}
