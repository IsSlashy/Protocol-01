use anchor_lang::prelude::*;

use crate::errors::LiquidityError;
use crate::state::LiquidityPool;

#[derive(Accounts)]
pub struct UpdateParams<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [LiquidityPool::SEED_PREFIX],
        bump = pool.bump,
        has_one = admin @ LiquidityError::Unauthorized
    )]
    pub pool: Account<'info, LiquidityPool>,
}

pub fn handler(
    ctx: Context<UpdateParams>,
    prefund_fee_bps: Option<u16>,
    settler_reward_bps: Option<u16>,
    is_active: Option<bool>,
) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    if let Some(fee) = prefund_fee_bps {
        require!(fee <= LiquidityPool::MAX_PREFUND_FEE_BPS, LiquidityError::FeeTooHigh);
        pool.prefund_fee_bps = fee;
    }
    if let Some(reward) = settler_reward_bps {
        require!(reward <= LiquidityPool::MAX_SETTLER_REWARD_BPS, LiquidityError::RewardTooHigh);
        pool.settler_reward_bps = reward;
    }
    if let Some(active) = is_active {
        pool.is_active = active;
    }
    Ok(())
}
