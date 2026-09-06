//! [ERAS 2026-09-06] Create era `n >= 1` of a denomination by hand.
//!
//! The automatic path is `open_next_era`, which anyone can call once the
//! active tree is nearly full and which copies every parameter from the
//! active pool. This instruction is the manual form: the directory's authority
//! chooses the parameters and creates the accounts early, and `open_next_era`
//! later finds them and only re-points the directory.
//!
//! Era pools are born at `ERA_TREE_DEPTH` (19) with a ring of
//! `MAX_HISTORICAL_ROOTS`.

use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::merkle_tree_v3::MerkleTreeStateV3;
use crate::state::pool_directory::PoolDirectory;
use crate::state::pool_v3::DenominatedPoolV3;

#[derive(Accounts)]
#[instruction(vk_hash: [u8; 32], token_mint: Pubkey, denomination: u64, epoch_delay: u64, era: u16)]
pub struct InitPoolEra<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [
            PoolDirectory::SEED_PREFIX,
            token_mint.as_ref(),
            &denomination.to_le_bytes()
        ],
        bump = directory.bump,
        has_one = authority @ ZkShieldedError::Unauthorized,
    )]
    pub directory: Account<'info, PoolDirectory>,

    /// Era `n >= 1`: FOUR seeds. Three-seed era-0 addresses cannot collide.
    #[account(
        init,
        payer = authority,
        space = DenominatedPoolV3::LEN,
        seeds = [
            DenominatedPoolV3::SEED_PREFIX,
            token_mint.as_ref(),
            &denomination.to_le_bytes(),
            &era.to_le_bytes()
        ],
        bump
    )]
    pub denominated_pool: Account<'info, DenominatedPoolV3>,

    #[account(
        init,
        payer = authority,
        space = MerkleTreeStateV3::LEN,
        seeds = [
            MerkleTreeStateV3::SEED_PREFIX,
            denominated_pool.key().as_ref()
        ],
        bump
    )]
    pub merkle_tree: Account<'info, MerkleTreeStateV3>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitPoolEra>,
    vk_hash: [u8; 32],
    token_mint: Pubkey,
    denomination: u64,
    epoch_delay: u64,
    era: u16,
) -> Result<()> {
    require!(era >= 1, ZkShieldedError::DirectoryMismatch);
    require!(denomination > 0, ZkShieldedError::InvalidDenomination);
    require!(epoch_delay > 0, ZkShieldedError::InvalidEpochDelay);

    let clock = Clock::get()?;
    let pool_key = ctx.accounts.denominated_pool.key();
    let pool = &mut ctx.accounts.denominated_pool;
    let tree = &mut ctx.accounts.merkle_tree;

    fill_era_pool(
        pool,
        tree,
        pool_key,
        ctx.accounts.authority.key(),
        vk_hash,
        token_mint,
        denomination,
        epoch_delay,
        era,
        ctx.bumps.denominated_pool,
        ctx.bumps.merkle_tree,
        &clock,
    );

    msg!(
        "era {} pool for {} x {}: depth {}, ring {}",
        era,
        denomination,
        token_mint,
        pool.tree_depth,
        pool.max_historical_roots
    );
    Ok(())
}

/// Write a fresh era pool and its tree. Shared with `open_next_era`, which
/// builds the same state into accounts it created by CPI.
#[allow(clippy::too_many_arguments)]
pub fn fill_era_pool(
    pool: &mut DenominatedPoolV3,
    tree: &mut MerkleTreeStateV3,
    pool_key: Pubkey,
    authority: Pubkey,
    vk_hash: [u8; 32],
    token_mint: Pubkey,
    denomination: u64,
    epoch_delay: u64,
    era: u16,
    pool_bump: u8,
    tree_bump: u8,
    clock: &Clock,
) {
    let depth = DenominatedPoolV3::ERA_TREE_DEPTH;
    let current_epoch = DenominatedPoolV3::current_epoch(clock.slot);

    pool.authority = authority;
    pool.token_mint = token_mint;
    pool.denomination = denomination;
    pool.epoch_delay = epoch_delay;
    pool.tree_depth = depth;
    pool.next_leaf_index = 0;
    pool.vk_hash = vk_hash;
    pool.total_shielded = 0;
    pool.note_count = 0;
    pool.is_active = true;
    pool.historical_roots = Vec::with_capacity(DenominatedPoolV3::MAX_HISTORICAL_ROOTS as usize);
    pool.max_historical_roots = DenominatedPoolV3::MAX_HISTORICAL_ROOTS;
    pool.created_at = clock.unix_timestamp;
    pool.last_tx_at = clock.unix_timestamp;
    pool.bump = pool_bump;
    pool.mature_note_count = 0;
    pool.last_maturity_update_epoch = current_epoch;
    pool.epoch_note_counts = [0u64; 32];
    pool.epoch_note_start = current_epoch;
    pool.vk_hash_transfer = [0u8; 32];
    pool.vk_update_slot = 0;
    pool.root_write_index = 0;
    pool.vk_hash_escrow = [0u8; 32];

    tree.initialize(pool_key, depth);
    tree.bump = tree_bump;
    tree.era = era;

    pool.merkle_root = tree.root;
}
