use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::ShieldedPool;

/// Propose a two-step authority transfer for the shielded pool.
/// The current authority proposes a new authority; the new authority
/// must accept before the transfer is finalized.
#[derive(Accounts)]
pub struct ProposeAuthorityTransfer<'info> {
    /// Current pool authority
    #[account(
        constraint = authority.key() == shielded_pool.authority @ ZkShieldedError::Unauthorized
    )]
    pub authority: Signer<'info>,

    /// Shielded pool to transfer
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

pub fn handler(ctx: Context<ProposeAuthorityTransfer>, new_authority: Pubkey) -> Result<()> {
    let pool = &mut ctx.accounts.shielded_pool;
    pool.pending_authority = Some(new_authority);

    msg!("Authority transfer proposed to: {}", new_authority);

    emit!(AuthorityTransferProposed {
        pool: pool.key(),
        current_authority: ctx.accounts.authority.key(),
        proposed_authority: new_authority,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct AuthorityTransferProposed {
    pub pool: Pubkey,
    pub current_authority: Pubkey,
    pub proposed_authority: Pubkey,
    pub timestamp: i64,
}
