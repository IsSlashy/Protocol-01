//! [ERAS 2026-09-06] Create the `PoolDirectory` for an existing era-0 pool.
//!
//! Run once per live denomination, by the pool authority, before anyone can
//! call `open_next_era` for it. Era pools created afterwards inherit the
//! directory's authority.

use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::merkle_tree_v3::MerkleTreeStateV3;
use crate::state::pool_directory::PoolDirectory;
use crate::state::pool_v3::DenominatedPoolV3;

#[derive(Accounts)]
pub struct InitPoolDirectory<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(has_one = authority @ ZkShieldedError::Unauthorized)]
    pub denominated_pool: Account<'info, DenominatedPoolV3>,

    #[account(
        seeds = [
            MerkleTreeStateV3::SEED_PREFIX,
            denominated_pool.key().as_ref()
        ],
        bump = merkle_tree.bump
    )]
    pub merkle_tree: Account<'info, MerkleTreeStateV3>,

    #[account(
        init,
        payer = authority,
        space = PoolDirectory::LEN,
        seeds = [
            PoolDirectory::SEED_PREFIX,
            denominated_pool.token_mint.as_ref(),
            &denominated_pool.denomination.to_le_bytes()
        ],
        bump
    )]
    pub directory: Account<'info, PoolDirectory>,

    pub system_program: Program<'info, System>,
}

/// `margin_leaves == 0` selects `PoolDirectory::DEFAULT_MARGIN_LEAVES`.
pub fn handler(ctx: Context<InitPoolDirectory>, margin_leaves: u64) -> Result<()> {
    let pool = &ctx.accounts.denominated_pool;
    let tree = &ctx.accounts.merkle_tree;
    pool.require_pool_pda(&pool.key(), tree.era, ctx.program_id)?;

    let d = &mut ctx.accounts.directory;
    d.authority = pool.authority;
    d.token_mint = pool.token_mint;
    d.denomination = pool.denomination;
    d.active_era = tree.era;
    d.active_pool = pool.key();
    d.margin_leaves = if margin_leaves == 0 {
        PoolDirectory::DEFAULT_MARGIN_LEAVES
    } else {
        margin_leaves
    };
    d.bump = ctx.bumps.directory;

    msg!(
        "pool directory: era {} active at {}, margin {} leaves",
        d.active_era,
        d.active_pool,
        d.margin_leaves
    );
    Ok(())
}
