use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::DenominatedPool;

/// Update the escrow bid verification key hash on a denominated pool (admin only).
#[derive(Accounts)]
#[instruction(new_vk_hash: [u8; 32])]
pub struct UpdateEscrowVk<'info> {
    /// Pool authority
    #[account(
        constraint = authority.key() == denominated_pool.authority @ ZkShieldedError::Unauthorized
    )]
    pub authority: Signer<'info>,

    /// Denominated pool to update
    #[account(mut)]
    pub denominated_pool: Account<'info, DenominatedPool>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<UpdateEscrowVk>, new_vk_hash: [u8; 32]) -> Result<()> {
    let pool = &mut ctx.accounts.denominated_pool;
    let clock = Clock::get()?;

    // Enforce 24h cooldown between VK updates
    if pool.vk_update_slot > 0 {
        require!(
            clock.unix_timestamp - pool.vk_update_slot > DenominatedPool::VK_UPDATE_COOLDOWN,
            ZkShieldedError::VkUpdateCooldown
        );
    }

    msg!("Old escrow VK hash: {:?}", &pool.vk_hash_escrow[..8]);
    pool.vk_hash_escrow = new_vk_hash;
    pool.vk_update_slot = clock.unix_timestamp;
    msg!("New escrow VK hash: {:?}", &new_vk_hash[..8]);
    msg!("Denominated pool escrow VK updated");

    Ok(())
}
