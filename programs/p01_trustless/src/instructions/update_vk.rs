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

/// 24-hour cooldown between VK hash updates (in seconds)
const VK_UPDATE_COOLDOWN: i64 = 86400;

pub fn handler(
    ctx: Context<UpdateVkHash>,
    new_vk_hash: [u8; 32],
) -> Result<()> {
    let pool = &mut ctx.accounts.pool;

    // Enforce 24h cooldown between VK updates to prevent instant malicious swaps
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp - pool.vk_update_timestamp >= VK_UPDATE_COOLDOWN,
        TrustlessError::VkUpdateCooldown
    );

    let old_hash = pool.verification_key_hash;
    pool.verification_key_hash = new_vk_hash;
    pool.vk_update_timestamp = clock.unix_timestamp;

    msg!(
        "VK hash updated: {:?} -> {:?}",
        &old_hash[..4],
        &new_vk_hash[..4]
    );

    Ok(())
}
