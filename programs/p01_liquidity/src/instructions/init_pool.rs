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

    // Fail closed. `is_active` gates `prefund` and nothing else — deposit and
    // withdraw ignore it — so this creates the pool with LP accounting live and
    // instant-unshield off.
    //
    // It is off because `settle` cannot currently return the money. Settle CPIs
    // `sha256("global:unshield_denominated_stark")[..8]` into zk_shielded, and
    // that instruction's `#[program]` registration is commented out
    // (`zk_shielded/src/lib.rs:152-172`) in favour of
    // `unshield_denominated_stark_v3`. zk_shielded will not dispatch the
    // discriminator settle sends, so every prefund opened today is a permanent
    // loss from the reserve — a correct STARK proof does not make it
    // recoverable.
    //
    // Turning it on is one admin-signed `update_params(is_active = Some(true))`
    // and MUST wait for a v3 settle path. Gated by
    // `prefund_is_unreachable_on_a_pool_as_init_pool_creates_it` in
    // `tests/deep_ali_gate.rs`, which calls this instruction and then a real
    // prefund against SBF bytecode.
    pool.is_active = false;

    pool.bump = ctx.bumps.pool;
    Ok(())
}
