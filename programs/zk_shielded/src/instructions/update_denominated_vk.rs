use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::DenominatedPool;

/// Update the verification key hash on a denominated pool (admin only)
/// Used when migrating to a new circuit (e.g., adding enforce_maturity input)
#[derive(Accounts)]
#[instruction(new_vk_hash: [u8; 32])]
pub struct UpdateDenominatedVk<'info> {
    /// Pool authority
    #[account(
        constraint = authority.key() == denominated_pool.authority @ ZkShieldedError::Unauthorized
    )]
    pub authority: Signer<'info>,

    /// Denominated pool to update
    #[account(
        mut,
        seeds = [
            DenominatedPool::SEED_PREFIX,
            denominated_pool.token_mint.as_ref(),
            &denominated_pool.denomination.to_le_bytes()
        ],
        bump = denominated_pool.bump
    )]
    pub denominated_pool: Account<'info, DenominatedPool>,
}

pub fn handler(ctx: Context<UpdateDenominatedVk>, new_vk_hash: [u8; 32]) -> Result<()> {
    let pool = &mut ctx.accounts.denominated_pool;
    let old_vk_hash = pool.vk_hash;

    pool.vk_hash = new_vk_hash;

    msg!("Denominated pool VK updated");
    msg!("Pool: {}", pool.key());
    msg!("Old VK hash: {:?}", &old_vk_hash[..8]);
    msg!("New VK hash: {:?}", &new_vk_hash[..8]);

    Ok(())
}
