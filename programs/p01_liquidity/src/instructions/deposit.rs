use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::LiquidityError;
use crate::state::{LPShare, LiquidityPool};

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        mut,
        seeds = [LiquidityPool::SEED_PREFIX],
        bump = pool.bump
    )]
    pub pool: Account<'info, LiquidityPool>,

    #[account(
        init_if_needed,
        payer = depositor,
        space = LPShare::LEN,
        seeds = [LPShare::SEED_PREFIX, depositor.key().as_ref(), pool.key().as_ref()],
        bump
    )]
    pub share: Account<'info, LPShare>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, LiquidityError::ZeroDeposit);

    let pool = &mut ctx.accounts.pool;

    // Compute shares BEFORE transferring (read the pre-deposit state).
    let minted_shares = pool
        .shares_for_deposit(amount)
        .ok_or(LiquidityError::ShareMathOverflow)?;

    // Transfer lamports: depositor → pool PDA.
    let cpi_ctx = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        system_program::Transfer {
            from: ctx.accounts.depositor.to_account_info(),
            to: pool.to_account_info(),
        },
    );
    system_program::transfer(cpi_ctx, amount)?;

    pool.reserve_lamports = pool
        .reserve_lamports
        .checked_add(amount)
        .ok_or(LiquidityError::ArithmeticOverflow)?;
    pool.total_shares = pool
        .total_shares
        .checked_add(minted_shares)
        .ok_or(LiquidityError::ShareMathOverflow)?;

    // Per-depositor balance (init_if_needed — on first call, owner/pool/bump are zeroed).
    let share = &mut ctx.accounts.share;
    if share.owner == Pubkey::default() {
        share.owner = ctx.accounts.depositor.key();
        share.pool = pool.key();
        share.bump = ctx.bumps.share;
    }
    share.shares = share
        .shares
        .checked_add(minted_shares)
        .ok_or(LiquidityError::ShareMathOverflow)?;

    Ok(())
}
