//! [RING-255 2026-09-06] Grow a legacy pool account to the current `LEN` and
//! raise its root ring from 100 to `MAX_HISTORICAL_ROOTS`.
//!
//! Every pool on devnet was allocated at `LEGACY_LEN` (3,760 bytes, ring of
//! 100). The ring is the number of deposits that may land between a client
//! preparing a proof and its spend executing; at the deposit rate the era
//! pools are built for, 100 is minutes. The account grows by 4,960 bytes,
//! under the 10,240-byte per-transaction realloc cap, so one call is enough.
//!
//! Idempotent: a pool already at `LEN` with the field already raised is left
//! alone and the call succeeds. Authority-only, because the authority pays the
//! rent difference.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::ZkShieldedError;
use crate::state::pool_directory::PoolCapacityMigrated;
use crate::state::pool_v3::DenominatedPoolV3;

#[derive(Accounts)]
pub struct MigratePoolCapacity<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ ZkShieldedError::Unauthorized,
    )]
    pub denominated_pool: Account<'info, DenominatedPoolV3>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<MigratePoolCapacity>) -> Result<()> {
    let info = ctx.accounts.denominated_pool.to_account_info();
    let old_len = info.data_len();
    let new_len = DenominatedPoolV3::LEN;

    if old_len < new_len {
        // Rent first, then the resize: the runtime rejects a transaction that
        // leaves an account rent-defective for its new length.
        let rent = Rent::get()?;
        let needed = rent.minimum_balance(new_len);
        let have = info.lamports();
        if needed > have {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.authority.to_account_info(),
                        to: info.clone(),
                    },
                ),
                needed - have,
            )?;
        }
        info.resize(new_len)?;
    }

    let pool = &mut ctx.accounts.denominated_pool;
    let before = pool.max_historical_roots;
    if before < DenominatedPoolV3::MAX_HISTORICAL_ROOTS {
        pool.max_historical_roots = DenominatedPoolV3::MAX_HISTORICAL_ROOTS;
    }

    emit!(PoolCapacityMigrated {
        pool: pool.key(),
        old_len: old_len as u64,
        new_len: info.data_len() as u64,
        max_historical_roots: pool.max_historical_roots,
    });
    msg!(
        "pool capacity: {} -> {} bytes, ring {} -> {}",
        old_len,
        info.data_len(),
        before,
        pool.max_historical_roots
    );
    Ok(())
}
