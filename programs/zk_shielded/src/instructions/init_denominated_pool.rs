use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::{DenominatedPool, MerkleTreeState};

/// Initialize a new denominated shielded pool for a specific token + denomination pair.
///
/// Each pool has a fixed denomination (e.g. 0.1 SOL = 100_000_000 lamports).
/// All notes in the pool are indistinguishable — same denomination, same structure.
///
/// Nullifier tracking uses PDA-per-nullifier (Tornado Cash model) so no
/// NullifierSet / Bloom filter is needed at pool init time.
///
/// PDA: [b"denominated_pool", token_mint, denomination_le_bytes]
#[derive(Accounts)]
#[instruction(vk_hash: [u8; 32], token_mint: Pubkey, denomination: u64, epoch_delay: u64)]
pub struct InitDenominatedPool<'info> {
    /// Authority that will manage the pool
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Denominated pool account (PDA)
    #[account(
        init,
        payer = authority,
        space = DenominatedPool::LEN,
        seeds = [
            DenominatedPool::SEED_PREFIX,
            token_mint.as_ref(),
            &denomination.to_le_bytes()
        ],
        bump
    )]
    pub denominated_pool: Account<'info, DenominatedPool>,

    /// Merkle tree state account (PDA derived from pool key)
    #[account(
        init,
        payer = authority,
        space = MerkleTreeState::LEN,
        seeds = [
            MerkleTreeState::SEED_PREFIX,
            denominated_pool.key().as_ref()
        ],
        bump
    )]
    pub merkle_tree: Account<'info, MerkleTreeState>,

    /// System program
    pub system_program: Program<'info, System>,

    /// Rent sysvar
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<InitDenominatedPool>,
    vk_hash: [u8; 32],
    token_mint: Pubkey,
    denomination: u64,
    epoch_delay: u64,
) -> Result<()> {
    require!(denomination > 0, ZkShieldedError::InvalidDenomination);
    require!(epoch_delay > 0, ZkShieldedError::InvalidEpochDelay);

    let clock = Clock::get()?;

    // Initialize denominated pool
    let pool = &mut ctx.accounts.denominated_pool;
    pool.authority = ctx.accounts.authority.key();
    pool.token_mint = token_mint;
    pool.denomination = denomination;
    pool.epoch_delay = epoch_delay;
    pool.tree_depth = DenominatedPool::DEFAULT_TREE_DEPTH;
    pool.next_leaf_index = 0;
    pool.vk_hash = vk_hash;
    pool.total_shielded = 0;
    pool.note_count = 0;
    pool.is_active = true;
    pool.historical_roots = Vec::with_capacity(DenominatedPool::MAX_HISTORICAL_ROOTS as usize);
    pool.max_historical_roots = DenominatedPool::MAX_HISTORICAL_ROOTS;
    pool.created_at = clock.unix_timestamp;
    pool.last_tx_at = clock.unix_timestamp;
    pool.bump = ctx.bumps.denominated_pool;

    // Dynamic delay fields
    let current_epoch = DenominatedPool::current_epoch(clock.slot);
    pool.mature_note_count = 0;
    pool.last_maturity_update_epoch = current_epoch;
    pool.epoch_note_counts = [0u64; 32];
    pool.epoch_note_start = current_epoch;

    // Initialize Merkle tree
    let merkle_tree = &mut ctx.accounts.merkle_tree;
    merkle_tree.initialize(pool.key(), DenominatedPool::DEFAULT_TREE_DEPTH);
    merkle_tree.bump = ctx.bumps.merkle_tree;

    // Set initial root
    pool.merkle_root = merkle_tree.root;

    // No NullifierSet needed — denominated pools use PDA-per-nullifier
    // (each spent nullifier creates a tiny PDA account at unshield time)

    msg!(
        "Initialized denominated pool: {} lamports/note, {} epoch delay",
        denomination,
        epoch_delay
    );

    Ok(())
}
