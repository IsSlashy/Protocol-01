//! [ERAS 2026-09-06] Open era `n + 1` of a denomination, permissionlessly.
//!
//! Anyone may call this once the directory's active tree is within
//! `margin_leaves` of full. The caller pays the rent of the new pool and tree
//! (about 0.07 SOL) and the directory is re-pointed; deposit clients that read
//! the directory land in the new era from the next slot on. If the next era's
//! accounts already exist (created early through `init_pool_era`), nothing is
//! allocated and only the directory moves.
//!
//! # Why the accounts are created by hand rather than by `init_if_needed`
//!
//! Anchor allocates `init`/`init_if_needed` accounts BEFORE the handler runs,
//! so the margin check would come after the rent was spent: a call made too
//! early would leave a funded era-`n+1` pool nobody points at, paid for by
//! whoever called. The margin check has to come first, so the two PDAs are
//! `UncheckedAccount`s, verified against their seeds here, and created by CPI
//! only after the check passes.
//!
//! # Idempotence
//!
//! Two keepers racing: the first call moves the directory to era `n+1`, whose
//! tree is empty, so the second call fails `EraMarginNotReached` and allocates
//! nothing. A call for an era that already exists re-points the directory and
//! allocates nothing.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::ZkShieldedError;
use crate::instructions::init_pool_era::fill_era_pool;
use crate::state::merkle_tree_v3::MerkleTreeStateV3;
use crate::state::pool_directory::{EraOpened, PoolDirectory};
use crate::state::pool_v3::DenominatedPoolV3;

#[derive(Accounts)]
pub struct OpenNextEra<'info> {
    /// Pays the rent of the new era's accounts when they do not exist yet.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [
            PoolDirectory::SEED_PREFIX,
            directory.token_mint.as_ref(),
            &directory.denomination.to_le_bytes()
        ],
        bump = directory.bump,
    )]
    pub directory: Account<'info, PoolDirectory>,

    #[account(
        constraint = active_pool.key() == directory.active_pool @ ZkShieldedError::DirectoryMismatch,
    )]
    pub active_pool: Account<'info, DenominatedPoolV3>,

    #[account(
        seeds = [
            MerkleTreeStateV3::SEED_PREFIX,
            active_pool.key().as_ref()
        ],
        bump = active_tree.bump
    )]
    pub active_tree: Account<'info, MerkleTreeStateV3>,

    /// CHECK: the era-`n+1` pool PDA; verified against its four seeds in the
    /// handler and created there by CPI when empty.
    #[account(mut)]
    pub next_pool: UncheckedAccount<'info>,

    /// CHECK: the tree PDA of `next_pool`; same treatment.
    #[account(mut)]
    pub next_tree: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<OpenNextEra>) -> Result<()> {
    let directory = &ctx.accounts.directory;
    let active_pool = &ctx.accounts.active_pool;
    let active_tree = &ctx.accounts.active_tree;

    // The directory, the pool and the tree must describe one era.
    require!(
        active_tree.era == directory.active_era,
        ZkShieldedError::DirectoryMismatch
    );
    require!(
        active_pool.token_mint == directory.token_mint
            && active_pool.denomination == directory.denomination,
        ZkShieldedError::DirectoryMismatch
    );
    active_pool.require_pool_pda(&active_pool.key(), active_tree.era, ctx.program_id)?;

    // The margin, BEFORE anything is allocated.
    let max_leaves = 1u64 << active_tree.depth;
    require!(
        active_tree.leaf_count.saturating_add(directory.margin_leaves) >= max_leaves,
        ZkShieldedError::EraMarginNotReached
    );

    let next_era = directory
        .active_era
        .checked_add(1)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    let token_mint = directory.token_mint;
    let denomination = directory.denomination;
    let denom_bytes = denomination.to_le_bytes();
    let era_bytes = next_era.to_le_bytes();

    let (pool_pda, pool_bump) =
        DenominatedPoolV3::pool_pda(&token_mint, denomination, next_era, ctx.program_id);
    require!(
        ctx.accounts.next_pool.key() == pool_pda,
        ZkShieldedError::InvalidPda
    );
    let (tree_pda, tree_bump) = Pubkey::find_program_address(
        &[MerkleTreeStateV3::SEED_PREFIX, pool_pda.as_ref()],
        ctx.program_id,
    );
    require!(
        ctx.accounts.next_tree.key() == tree_pda,
        ZkShieldedError::InvalidPda
    );

    let created = ctx.accounts.next_pool.data_is_empty();
    if created {
        let rent = Rent::get()?;
        let clock = Clock::get()?;

        // Pool account.
        let pool_signer: &[&[u8]] = &[
            DenominatedPoolV3::SEED_PREFIX,
            token_mint.as_ref(),
            &denom_bytes,
            &era_bytes,
            &[pool_bump],
        ];
        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.next_pool.to_account_info(),
                },
                &[pool_signer],
            ),
            rent.minimum_balance(DenominatedPoolV3::LEN),
            DenominatedPoolV3::LEN as u64,
            ctx.program_id,
        )?;

        // Tree account.
        require!(
            ctx.accounts.next_tree.data_is_empty(),
            ZkShieldedError::InvalidPda
        );
        let tree_signer: &[&[u8]] = &[
            MerkleTreeStateV3::SEED_PREFIX,
            pool_pda.as_ref(),
            &[tree_bump],
        ];
        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.next_tree.to_account_info(),
                },
                &[tree_signer],
            ),
            rent.minimum_balance(MerkleTreeStateV3::LEN),
            MerkleTreeStateV3::LEN as u64,
            ctx.program_id,
        )?;

        let mut pool = DenominatedPoolV3::default();
        let mut tree = MerkleTreeStateV3::default();
        fill_era_pool(
            &mut pool,
            &mut tree,
            pool_pda,
            // The era-0 pool's authority carries over: the same key migrates
            // and administers every era of the denomination.
            active_pool.authority,
            active_pool.vk_hash,
            token_mint,
            denomination,
            active_pool.epoch_delay,
            next_era,
            pool_bump,
            tree_bump,
            &clock,
        );

        {
            let info = ctx.accounts.next_pool.to_account_info();
            let mut data = info.try_borrow_mut_data()?;
            let mut cursor: &mut [u8] = &mut data;
            pool.try_serialize(&mut cursor)?;
        }
        {
            let info = ctx.accounts.next_tree.to_account_info();
            let mut data = info.try_borrow_mut_data()?;
            let mut cursor: &mut [u8] = &mut data;
            tree.try_serialize(&mut cursor)?;
        }
    } else {
        // Created earlier by `init_pool_era`: it must be OUR pool for THIS
        // denomination and era, or the directory would point at a stranger.
        require!(
            *ctx.accounts.next_pool.owner == *ctx.program_id,
            ZkShieldedError::DirectoryMismatch
        );
        let existing = {
            let info = ctx.accounts.next_pool.to_account_info();
            let data = info.try_borrow_data()?;
            let mut sl: &[u8] = &data;
            DenominatedPoolV3::try_deserialize(&mut sl)
                .map_err(|_| error!(ZkShieldedError::DirectoryMismatch))?
        };
        require!(
            existing.token_mint == token_mint && existing.denomination == denomination,
            ZkShieldedError::DirectoryMismatch
        );
        require!(
            *ctx.accounts.next_tree.owner == *ctx.program_id
                && !ctx.accounts.next_tree.data_is_empty(),
            ZkShieldedError::DirectoryMismatch
        );
        let existing_tree = {
            let info = ctx.accounts.next_tree.to_account_info();
            let data = info.try_borrow_data()?;
            let mut sl: &[u8] = &data;
            MerkleTreeStateV3::try_deserialize(&mut sl)
                .map_err(|_| error!(ZkShieldedError::DirectoryMismatch))?
        };
        require!(existing_tree.era == next_era, ZkShieldedError::DirectoryMismatch);
    }

    let directory = &mut ctx.accounts.directory;
    directory.active_era = next_era;
    directory.active_pool = pool_pda;

    emit!(EraOpened {
        token_mint,
        denomination,
        era: next_era,
        pool: pool_pda,
        merkle_tree: tree_pda,
        opened_by: ctx.accounts.payer.key(),
        created,
    });
    msg!(
        "era {} open at {} (created: {}); deposits go there now",
        next_era,
        pool_pda,
        created
    );
    Ok(())
}
