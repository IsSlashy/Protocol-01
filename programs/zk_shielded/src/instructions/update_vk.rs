use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::ShieldedPool;

/// Update the verification key hash (admin only)
/// Used when migrating to a new circuit or fixing issues
#[derive(Accounts)]
#[instruction(new_vk_hash: [u8; 32])]
pub struct UpdateVerificationKey<'info> {
    /// Pool authority
    #[account(
        constraint = authority.key() == shielded_pool.authority @ ZkShieldedError::Unauthorized
    )]
    pub authority: Signer<'info>,

    /// Shielded pool to update
    #[account(
        mut,
        seeds = [
            ShieldedPool::SEED_PREFIX,
            shielded_pool.token_mint.as_ref()
        ],
        bump = shielded_pool.bump
    )]
    pub shielded_pool: Account<'info, ShieldedPool>,
}

pub fn handler(ctx: Context<UpdateVerificationKey>, new_vk_hash: [u8; 32]) -> Result<()> {
    let pool = &mut ctx.accounts.shielded_pool;
    let old_vk_hash = pool.vk_hash;

    pool.vk_hash = new_vk_hash;

    msg!("Verification key updated");
    msg!("Old VK hash: {:?}", old_vk_hash);
    msg!("New VK hash: {:?}", new_vk_hash);

    // Emit event
    emit!(VKUpdateEvent {
        pool: pool.key(),
        old_vk_hash,
        new_vk_hash,
        authority: ctx.accounts.authority.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

/// Event emitted when verification key is updated
#[event]
pub struct VKUpdateEvent {
    pub pool: Pubkey,
    pub old_vk_hash: [u8; 32],
    pub new_vk_hash: [u8; 32],
    pub authority: Pubkey,
    pub timestamp: i64,
}
