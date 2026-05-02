use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::pool_v3::DenominatedPoolV3;
use crate::state::merkle_tree_v3::MerkleTreeStateV3;

/// Initialize a new V3 denominated shielded pool.
///
/// Mirrors v2's `init_denominated_pool` exactly except:
///   - PDA seed uses `DenominatedPoolV3::SEED_PREFIX` (`denominated_pool_v3`)
///   - Allocates `MerkleTreeStateV3` (Goldilocks Poseidon) instead of v2's
///     `MerkleTreeState` (BN254 Poseidon)
///
/// V3 pools are fresh — no migration of v2 commitments. v2 pools stay live
/// for the 30-day deprecation window.
///
/// PDA: [b"denominated_pool_v3", token_mint, denomination_le_bytes]
#[derive(Accounts)]
#[instruction(vk_hash: [u8; 32], token_mint: Pubkey, denomination: u64, epoch_delay: u64)]
pub struct InitDenominatedPoolV3<'info> {
    /// Authority that will manage the pool
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Denominated pool V3 account (PDA)
    #[account(
        init,
        payer = authority,
        space = DenominatedPoolV3::LEN,
        seeds = [
            DenominatedPoolV3::SEED_PREFIX,
            token_mint.as_ref(),
            &denomination.to_le_bytes()
        ],
        bump
    )]
    pub denominated_pool: Account<'info, DenominatedPoolV3>,

    /// Merkle tree V3 state account (PDA derived from pool key)
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

    /// System program
    pub system_program: Program<'info, System>,

    /// Rent sysvar
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<InitDenominatedPoolV3>,
    vk_hash: [u8; 32],
    token_mint: Pubkey,
    denomination: u64,
    epoch_delay: u64,
) -> Result<()> {
    require!(denomination > 0, ZkShieldedError::InvalidDenomination);
    require!(epoch_delay > 0, ZkShieldedError::InvalidEpochDelay);

    let clock = Clock::get()?;

    // Initialize denominated pool V3
    let pool = &mut ctx.accounts.denominated_pool;
    pool.authority = ctx.accounts.authority.key();
    pool.token_mint = token_mint;
    pool.denomination = denomination;
    pool.epoch_delay = epoch_delay;
    pool.tree_depth = DenominatedPoolV3::DEFAULT_TREE_DEPTH;
    pool.next_leaf_index = 0;
    pool.vk_hash = vk_hash;
    pool.total_shielded = 0;
    pool.note_count = 0;
    pool.is_active = true;
    pool.historical_roots =
        Vec::with_capacity(DenominatedPoolV3::MAX_HISTORICAL_ROOTS as usize);
    pool.max_historical_roots = DenominatedPoolV3::MAX_HISTORICAL_ROOTS;
    pool.created_at = clock.unix_timestamp;
    pool.last_tx_at = clock.unix_timestamp;
    pool.bump = ctx.bumps.denominated_pool;

    // Dynamic delay fields
    let current_epoch = DenominatedPoolV3::current_epoch(clock.slot);
    pool.mature_note_count = 0;
    pool.last_maturity_update_epoch = current_epoch;
    pool.epoch_note_counts = [0u64; 32];
    pool.epoch_note_start = current_epoch;
    pool.vk_update_slot = 0;
    pool.root_write_index = 0;

    // Initialize V3 Merkle tree (Goldilocks Poseidon)
    let merkle_tree = &mut ctx.accounts.merkle_tree;
    merkle_tree.initialize(pool.key(), DenominatedPoolV3::DEFAULT_TREE_DEPTH);
    merkle_tree.bump = ctx.bumps.merkle_tree;

    // Set initial root
    pool.merkle_root = merkle_tree.root;

    msg!(
        "Initialized denominated pool V3: {} lamports/note, {} epoch delay",
        denomination,
        epoch_delay
    );

    Ok(())
}
