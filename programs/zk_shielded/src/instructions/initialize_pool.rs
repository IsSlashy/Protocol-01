use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::state::{MerkleTreeState, NullifierSet, ShieldedPool};

/// Initialize a new shielded pool for a specific token
/// Creates the pool configuration, Merkle tree, and nullifier set
#[derive(Accounts)]
#[instruction(vk_hash: [u8; 32])]
pub struct InitializePool<'info> {
    /// Authority that will manage the pool
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Token mint for the shielded pool
    /// Use System Program ID for native SOL
    pub token_mint: Account<'info, Mint>,

    /// Shielded pool account (PDA)
    #[account(
        init,
        payer = authority,
        space = ShieldedPool::LEN,
        seeds = [
            ShieldedPool::SEED_PREFIX,
            token_mint.key().as_ref()
        ],
        bump
    )]
    pub shielded_pool: Account<'info, ShieldedPool>,

    /// Merkle tree state account (PDA)
    #[account(
        init,
        payer = authority,
        space = MerkleTreeState::LEN,
        seeds = [
            MerkleTreeState::SEED_PREFIX,
            shielded_pool.key().as_ref()
        ],
        bump
    )]
    pub merkle_tree: Account<'info, MerkleTreeState>,

    /// Nullifier set account (PDA) - zero-copy for large bloom filter
    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<NullifierSet>(),
        seeds = [
            NullifierSet::SEED_PREFIX,
            shielded_pool.key().as_ref()
        ],
        bump
    )]
    pub nullifier_set: AccountLoader<'info, NullifierSet>,

    /// System program
    pub system_program: Program<'info, System>,

    /// Rent sysvar
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<InitializePool>, vk_hash: [u8; 32]) -> Result<()> {
    let clock = Clock::get()?;

    // Initialize shielded pool
    let pool = &mut ctx.accounts.shielded_pool;
    pool.authority = ctx.accounts.authority.key();
    pool.token_mint = ctx.accounts.token_mint.key();
    pool.tree_depth = ShieldedPool::DEFAULT_TREE_DEPTH;
    pool.next_leaf_index = 0;
    pool.vk_hash = vk_hash;
    pool.total_shielded = 0;
    pool.is_active = true;
    pool.historical_roots = Vec::with_capacity(ShieldedPool::MAX_HISTORICAL_ROOTS as usize);
    pool.max_historical_roots = ShieldedPool::MAX_HISTORICAL_ROOTS;
    pool.created_at = clock.unix_timestamp;
    pool.last_tx_at = clock.unix_timestamp;
    pool.relayer_fee_bps = 10; // 0.1% default
    pool.relayer = ctx.accounts.authority.key(); // Authority is default relayer
    pool.bump = ctx.bumps.shielded_pool;

    // Initialize Merkle tree
    let merkle_tree = &mut ctx.accounts.merkle_tree;
    merkle_tree.initialize(pool.key(), ShieldedPool::DEFAULT_TREE_DEPTH);
    merkle_tree.bump = ctx.bumps.merkle_tree;

    // Set initial root
    pool.merkle_root = merkle_tree.root;

    // Initialize nullifier set (zero-copy)
    let mut nullifier_set = ctx.accounts.nullifier_set.load_init()?;
    nullifier_set.pool = pool.key();
    nullifier_set.count = 0;
    nullifier_set.num_hash_functions = 7;
    nullifier_set.bump = ctx.bumps.nullifier_set;
    nullifier_set._padding = [0u8; 6];
    nullifier_set.bloom_filter = [0u64; 256];

    msg!("Initialized shielded pool for token mint: {}", pool.token_mint);
    msg!("Merkle tree depth: {}", pool.tree_depth);
    msg!("Initial root: {:?}", pool.merkle_root);

    Ok(())
}
