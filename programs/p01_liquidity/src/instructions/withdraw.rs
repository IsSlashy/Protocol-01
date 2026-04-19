use anchor_lang::prelude::*;

use crate::errors::LiquidityError;
use crate::state::{LPShare, LiquidityPool};

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        mut,
        seeds = [LiquidityPool::SEED_PREFIX],
        bump = pool.bump
    )]
    pub pool: Account<'info, LiquidityPool>,

    #[account(
        mut,
        seeds = [LPShare::SEED_PREFIX, depositor.key().as_ref(), pool.key().as_ref()],
        bump = share.bump,
        has_one = owner,
        constraint = share.pool == pool.key() @ LiquidityError::Unauthorized
    )]
    pub share: Account<'info, LPShare>,

    /// Redundant but Anchor's has_one matcher needs a field by this name.
    /// CHECK: validated by has_one above.
    pub owner: AccountInfo<'info>,
}

pub fn handler(ctx: Context<Withdraw>, shares: u128) -> Result<()> {
    require!(shares > 0, LiquidityError::ZeroWithdraw);

    let pool = &mut ctx.accounts.pool;
    let share = &mut ctx.accounts.share;

    require!(share.shares >= shares, LiquidityError::InsufficientShares);

    // Compute payout from pre-withdrawal share price.
    let payout = pool
        .lamports_for_shares(shares)
        .ok_or(LiquidityError::ShareMathOverflow)?;

    // Can't pay out more than the FREE reserve (funds reserved for settlement are off-limits).
    require!(
        pool.reserve_lamports >= payout,
        LiquidityError::InsufficientLiquidity
    );

    pool.reserve_lamports = pool
        .reserve_lamports
        .checked_sub(payout)
        .ok_or(LiquidityError::ArithmeticOverflow)?;
    pool.total_shares = pool
        .total_shares
        .checked_sub(shares)
        .ok_or(LiquidityError::ShareMathOverflow)?;
    share.shares = share
        .shares
        .checked_sub(shares)
        .ok_or(LiquidityError::ShareMathOverflow)?;

    // Direct lamport transfer: pool PDA → depositor.
    **pool.to_account_info().try_borrow_mut_lamports()? = pool
        .to_account_info()
        .lamports()
        .checked_sub(payout)
        .ok_or(LiquidityError::InsufficientLiquidity)?;
    **ctx.accounts.depositor.to_account_info().try_borrow_mut_lamports()? = ctx
        .accounts
        .depositor
        .to_account_info()
        .lamports()
        .checked_add(payout)
        .ok_or(LiquidityError::ArithmeticOverflow)?;

    Ok(())
}
