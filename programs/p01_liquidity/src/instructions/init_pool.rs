use anchor_lang::prelude::*;

use crate::errors::LiquidityError;
use crate::state::LiquidityPool;

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = LiquidityPool::LEN,
        seeds = [LiquidityPool::SEED_PREFIX],
        bump
    )]
    pub pool: Account<'info, LiquidityPool>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitPool>,
    prefund_fee_bps: u16,
    settler_reward_bps: u16,
) -> Result<()> {
    require!(
        prefund_fee_bps <= LiquidityPool::MAX_PREFUND_FEE_BPS,
        LiquidityError::FeeTooHigh
    );
    require!(
        settler_reward_bps <= LiquidityPool::MAX_SETTLER_REWARD_BPS,
        LiquidityError::RewardTooHigh
    );

    let pool = &mut ctx.accounts.pool;
    pool.admin = ctx.accounts.admin.key();
    pool.total_shares = 0;
    pool.reserve_lamports = 0;
    pool.prefund_fee_bps = prefund_fee_bps;
    pool.settler_reward_bps = settler_reward_bps;
    pool.is_active = true;
    pool.bump = ctx.bumps.pool;
    Ok(())
}
