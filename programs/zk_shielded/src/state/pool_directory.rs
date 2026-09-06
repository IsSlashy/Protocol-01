//! [ERAS 2026-09-06] One `PoolDirectory` per `(token_mint, denomination)`
//! names the era that is currently accepting deposits.
//!
//! # Why eras exist
//!
//! A pool's Merkle tree has a fixed depth and therefore a fixed number of
//! leaves: 32,768 at depth 15, 524,288 at depth 19 (`migrate_tree_depth`).
//! Once `leaf_count` reaches it, `insert_with_root_v3` returns
//! `MerkleTreeFull` and, before this module, nothing anywhere could take the
//! next deposit: the pool PDA is seeded on `(mint, denomination)` and there was
//! exactly one.
//!
//! An era is a second (third, ...) pool of the same denomination, seeded on a
//! fourth seed `era.to_le_bytes()`. Notes carry the pool they were deposited
//! into, so spending is unaffected: a note spends against its own pool's root
//! ring, whatever era that pool is. Only DEPOSITS need to know where to go, and
//! that is what this account answers.
//!
//! # Why the switch is permissionless
//!
//! `open_next_era` may be called by anyone once the active tree is within
//! `margin_leaves` of full. The caller pays the rent of the two new accounts
//! (about 0.07 SOL at devnet rent) and gets nothing for it, so there is no
//! incentive to call it early -- and the margin check refuses to spend that
//! rent early anyway. A keeper does it on a schedule; a wallet that finds the
//! tree full can do it itself in the same flow. No key anyone has to keep
//! online is involved, which is the whole point.
//!
//! # What it does not change
//!
//! The anonymity set is bounded per era. That was already true per pool; an
//! era is a pool.

use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct PoolDirectory {
    /// Copied from the era-0 pool at `init_pool_directory`; gates
    /// `init_pool_era` (the manual path). `open_next_era` needs no authority.
    pub authority: Pubkey,
    /// The denomination this directory serves.
    pub token_mint: Pubkey,
    pub denomination: u64,
    /// The era whose pool takes deposits now.
    pub active_era: u16,
    /// That era's pool PDA, so a client needs one read, not a derivation.
    pub active_pool: Pubkey,
    /// `open_next_era` succeeds once `leaf_count + margin_leaves >= 2^depth`
    /// on the active tree. Large enough that a keeper on an hourly schedule
    /// opens the next era before anyone hits `MerkleTreeFull`; small enough
    /// that rent is not spent on a pool nobody needs for a year.
    pub margin_leaves: u64,
    pub bump: u8,
}

impl PoolDirectory {
    pub const LEN: usize = 8  // discriminator
        + 32  // authority
        + 32  // token_mint
        + 8   // denomination
        + 2   // active_era
        + 32  // active_pool
        + 8   // margin_leaves
        + 1;  // bump

    /// Seeds: `[b"pool_directory", token_mint, denomination_le]`.
    pub const SEED_PREFIX: &'static [u8] = b"pool_directory";

    /// 1,024 leaves of headroom. At the traffic the deposit path can carry
    /// after the upload rework (a deposit every few seconds per client), an
    /// hourly keeper still has hours of margin.
    pub const DEFAULT_MARGIN_LEAVES: u64 = 1_024;

    pub fn pda(token_mint: &Pubkey, denomination: u64, program_id: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[Self::SEED_PREFIX, token_mint.as_ref(), &denomination.to_le_bytes()],
            program_id,
        )
    }
}

/// Emitted by `open_next_era` when a new era's pool and tree exist and the
/// directory points at them. `opened_by` is the rent payer.
#[event]
pub struct EraOpened {
    pub token_mint: Pubkey,
    pub denomination: u64,
    pub era: u16,
    pub pool: Pubkey,
    pub merkle_tree: Pubkey,
    pub opened_by: Pubkey,
    /// True when this call created the accounts; false when it only pointed
    /// the directory at an era somebody had already created by hand.
    pub created: bool,
}

/// Emitted by `migrate_tree_depth`. `old_root` and `new_root` are the same
/// tree seen at two depths; every root in the ring was lifted the same way.
#[event]
pub struct TreeDepthMigrated {
    pub pool: Pubkey,
    pub old_depth: u8,
    pub new_depth: u8,
    pub old_root: [u8; 32],
    pub new_root: [u8; 32],
    pub leaf_count: u64,
}

/// Emitted by `migrate_pool_capacity`.
#[event]
pub struct PoolCapacityMigrated {
    pub pool: Pubkey,
    pub old_len: u64,
    pub new_len: u64,
    pub max_historical_roots: u8,
}
