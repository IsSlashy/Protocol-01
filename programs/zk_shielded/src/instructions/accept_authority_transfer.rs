use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::ShieldedPool;

/// Accept a pending authority transfer for the shielded pool.
/// Must be signed by the proposed new authority.
#[derive(Accounts)]
pub struct AcceptAuthorityTransfer<'info> {
    /// The proposed new authority (must match pending_authority)
    pub new_authority: Signer<'info>,

    /// Shielded pool with pending transfer
    #[account(
        mut,
        seeds = [
            ShieldedPool::SEED_PREFIX,
            shielded_pool.token_mint.as_ref()
        ],
        bump = shielded_pool.bump,
        constraint = shielded_pool.pending_authority.is_some() @ ZkShieldedError::NoPendingAuthority,
        constraint = shielded_pool.pending_authority == Some(new_authority.key()) @ ZkShieldedError::PendingAuthorityMismatch
    )]
    pub shielded_pool: Account<'info, ShieldedPool>,
}

pub fn handler(ctx: Context<AcceptAuthorityTransfer>) -> Result<()> {
    let pool = &mut ctx.accounts.shielded_pool;
    let old_authority = pool.authority;
    let new_authority = ctx.accounts.new_authority.key();

    pool.authority = new_authority;
    pool.pending_authority = None;

    msg!("Authority transferred from {} to {}", old_authority, new_authority);

    emit!(AuthorityTransferAccepted {
        pool: pool.key(),
        old_authority,
        new_authority,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct AuthorityTransferAccepted {
    pub pool: Pubkey,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
    pub timestamp: i64,
}
