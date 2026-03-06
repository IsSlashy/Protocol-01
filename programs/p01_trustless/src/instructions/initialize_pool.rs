use anchor_lang::prelude::*;

use crate::errors::TrustlessError;
use crate::state::{MerkleTreeState, PoolState};

/// Initialize a new trustless shielded pool.
///
/// This is the ONLY instruction that requires authority.
/// After initialization, all pool operations are permissionless --
/// the ZK proof IS the authorization.
///
/// PDA: [b"trustless_pool", token_mint, denomination_le_bytes]
#[derive(Accounts)]
#[instruction(vk_hash: [u8; 32], zkspl_vk_hash: [u8; 32], token_mint: Pubkey, denomination: u64)]
pub struct InitializePool<'info> {
    /// Authority that will manage pool settings (VK updates only)
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Pool state account (PDA)
    #[account(
        init,
        payer = authority,
        space = PoolState::LEN,
        seeds = [
            PoolState::SEED_PREFIX,
            token_mint.as_ref(),
            &denomination.to_le_bytes()
        ],
        bump
    )]
    pub pool: Account<'info, PoolState>,

    /// Merkle tree state account (PDA derived from pool key)
    #[account(
        init,
        payer = authority,
        space = MerkleTreeState::LEN,
        seeds = [
            MerkleTreeState::SEED_PREFIX,
            pool.key().as_ref()
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
    ctx: Context<InitializePool>,
    vk_hash: [u8; 32],
    zkspl_vk_hash: [u8; 32],
    token_mint: Pubkey,
    denomination: u64,
) -> Result<()> {
    require!(denomination > 0, TrustlessError::InvalidDenomination);

    let clock = Clock::get()?;

    // Initialize pool state
    let pool = &mut ctx.accounts.pool;
    pool.authority = ctx.accounts.authority.key();
    pool.token_mint = token_mint;
    pool.denomination = denomination;
    pool.verification_key_hash = vk_hash;
    pool.zkspl_vk_hash = zkspl_vk_hash;
    pool.tree_depth = PoolState::DEFAULT_TREE_DEPTH;
    pool.leaf_count = 0;
    pool.total_shielded = 0;
    pool.note_count = 0;
    pool.is_active = true;
    pool.historical_roots = Vec::with_capacity(PoolState::MAX_HISTORICAL_ROOTS as usize);
    pool.max_historical_roots = PoolState::MAX_HISTORICAL_ROOTS;
    pool.created_at = clock.unix_timestamp;
    pool.last_tx_at = clock.unix_timestamp;
    pool.bump = ctx.bumps.pool;
    pool.epoch_delay = PoolState::DEFAULT_EPOCH_DELAY;
    pool.vault = Pubkey::default(); // Set when first SPL deposit creates it

    // Dynamic delay fields
    let current_epoch = PoolState::current_epoch(clock.slot);
    pool.mature_note_count = 0;
    pool.last_maturity_update_epoch = current_epoch;
    pool.epoch_note_counts = [0u64; 32];
    pool.epoch_note_start = current_epoch;

    // Initialize Merkle tree
    let merkle_tree = &mut ctx.accounts.merkle_tree;
    merkle_tree.initialize(pool.key(), PoolState::DEFAULT_TREE_DEPTH);
    merkle_tree.bump = ctx.bumps.merkle_tree;

    // Set initial root from tree
    pool.merkle_root = merkle_tree.root;

    msg!(
        "Trustless pool initialized: {} lamports/note, token={}",
        denomination,
        token_mint
    );

    emit!(PoolInitializedEvent {
        pool: pool.key(),
        authority: pool.authority,
        token_mint,
        denomination,
        tree_depth: pool.tree_depth,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct PoolInitializedEvent {
    pub pool: Pubkey,
    pub authority: Pubkey,
    pub token_mint: Pubkey,
    pub denomination: u64,
    pub tree_depth: u8,
    pub timestamp: i64,
}
