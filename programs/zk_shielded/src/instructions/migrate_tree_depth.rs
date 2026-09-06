//! [DEPTH-19 2026-09-06] Deepen a live pool's tree in place.
//!
//! A depth-15 tree holds 32,768 leaves. The program already walks
//! `tree_depth - INSERT_SUBTREE_DEPTH` levels on chain for every deposit and
//! every spend, up to `MAX_TOP_LEVELS = 8`, so a depth-19 tree (524,288 leaves)
//! needs no circuit change -- only more levels walked, at ~34,469 CU per
//! Poseidon hash. What it does need is that the pool's ROOTS move with the
//! depth: a root is a hash of the whole tree, and the whole tree just gained
//! four empty levels above the old one.
//!
//! `MerkleTreeStateV3::lift_root` does that: it is the fold `fold_insertion`
//! performs at a left turn, applied through `ZEROS[old_depth..new_depth]`.
//! It is applied to the current root, and to the newest `keep_roots` entries
//! of the pool's historical ring (see below for why not all of them), so a
//! spend whose proof was prepared against one of those roots still resolves
//! -- through its (now longer) sibling walk -- to a root the pool vouches for. The client must send `new_depth - 11` siblings from
//! then on; the extra ones are `ZEROS[15..19]` for every leaf that existed
//! before the migration.
//!
//! # The ring is NOT lifted whole, and the number says why
//!
//! MEASURED 2026-09-06 in litesvm: one lifted root is `new_depth - old_depth`
//! Poseidon hashes at ~34,469 CU each, so 15 -> 19 costs ~138,000 CU PER ROOT.
//! A ring of 100 is 13.8M CU, ten transactions of budget, and 255 is more. The
//! first version of this handler lifted every entry and blew the 200k default
//! with a ring of three. So the caller says how many of the NEWEST ring roots
//! to keep (`keep_roots`); those are lifted and the rest are dropped. A proof
//! prepared against a dropped root fails its pre-flight (`V4Unprovable`) and
//! is re-prepared against the current root, one proof, seconds, which is what
//! happens today whenever a root ages out of the ring. Seven kept roots at
//! four levels fit under 1.4M CU with the current root.
//!
//! Authority-only, and it cannot be undone: a shallower tree could not hold
//! the leaves a deeper one accepted.

use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::merkle_tree_v3::MerkleTreeStateV3;
use crate::state::pool_directory::TreeDepthMigrated;
use crate::state::pool_v3::DenominatedPoolV3;

#[derive(Accounts)]
pub struct MigrateTreeDepth<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ ZkShieldedError::Unauthorized,
    )]
    pub denominated_pool: Account<'info, DenominatedPoolV3>,

    #[account(
        mut,
        seeds = [
            MerkleTreeStateV3::SEED_PREFIX,
            denominated_pool.key().as_ref()
        ],
        bump = merkle_tree.bump
    )]
    pub merkle_tree: Account<'info, MerkleTreeStateV3>,
}

pub fn handler(ctx: Context<MigrateTreeDepth>, new_depth: u8, keep_roots: u8) -> Result<()> {
    let pool_key = ctx.accounts.denominated_pool.key();
    ctx.accounts.denominated_pool.require_pool_pda(
        &pool_key,
        ctx.accounts.merkle_tree.era,
        ctx.program_id,
    )?;

    let pool = &mut ctx.accounts.denominated_pool;
    let tree = &mut ctx.accounts.merkle_tree;

    // The two depths are one number written twice; a migration that finds
    // them apart is looking at a corrupted pool, not at a job to do.
    require!(pool.tree_depth == tree.depth, ZkShieldedError::InvalidMerkleRoot);
    require!(
        pool.merkle_root == tree.root,
        ZkShieldedError::InvalidMerkleRoot
    );

    let (old_depth, old_root) = tree.migrate_depth(new_depth)?;

    // Lift the NEWEST `keep_roots` ring entries (see the module header for
    // why not all of them) and drop the rest. The ring is a circular buffer
    // keyed by `root_write_index` once it is full, so "newest" is read through
    // that index rather than off the Vec order.
    let len = pool.historical_roots.len();
    let max = pool.max_historical_roots as usize;
    let keep = (keep_roots as usize).min(len);
    let mut kept: Vec<[u8; 32]> = Vec::with_capacity(keep);
    for k in (len - keep)..len {
        let idx = if len < max || max == 0 {
            k
        } else {
            (pool.root_write_index as usize + k) % max
        };
        kept.push(MerkleTreeStateV3::lift_root(
            pool.historical_roots[idx],
            old_depth,
            new_depth,
        )?);
    }
    let dropped = len - keep;
    pool.historical_roots = kept;
    pool.root_write_index = keep as u64;
    pool.merkle_root = tree.root;
    pool.tree_depth = new_depth;
    msg!("ring: {} roots lifted, {} dropped", keep, dropped);

    emit!(TreeDepthMigrated {
        pool: pool_key,
        old_depth,
        new_depth,
        old_root,
        new_root: tree.root,
        leaf_count: tree.leaf_count,
    });

    msg!(
        "tree depth {} -> {} ({} leaves kept, {} now possible)",
        old_depth,
        new_depth,
        tree.leaf_count,
        1u64 << new_depth
    );
    Ok(())
}
