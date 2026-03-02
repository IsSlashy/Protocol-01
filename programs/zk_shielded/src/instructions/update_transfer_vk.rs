use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::DenominatedPool;

/// Update the transfer verification key hash on a denominated pool (admin only).
#[derive(Accounts)]
#[instruction(new_vk_hash: [u8; 32])]
pub struct UpdateTransferVk<'info> {
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

pub fn handler(ctx: Context<UpdateTransferVk>, new_vk_hash: [u8; 32]) -> Result<()> {
    let pool = &mut ctx.accounts.denominated_pool;

    msg!("Old transfer VK hash: {:?}", &pool.vk_hash_transfer[..8]);
    pool.vk_hash_transfer = new_vk_hash;
    msg!("New transfer VK hash: {:?}", &new_vk_hash[..8]);
    msg!("Denominated pool transfer VK updated");

    Ok(())
}
