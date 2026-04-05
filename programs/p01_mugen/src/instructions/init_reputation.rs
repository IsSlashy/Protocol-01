use anchor_lang::prelude::*;
use crate::state::*;

#[derive(Accounts)]
#[instruction(commitment: [u8; 32])]
pub struct InitReputation<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = MugenReputation::LEN,
        seeds = [REPUTATION_SEED, commitment.as_ref()],
        bump,
    )]
    pub reputation: Account<'info, MugenReputation>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitReputation>, commitment: [u8; 32]) -> Result<()> {
    let rep = &mut ctx.accounts.reputation;
    rep.commitment = commitment;
    rep.trades_completed = 0;
    rep.trades_disputed = 0;
    rep.total_volume = 0;
    rep.avg_payment_time = 0;
    rep.positive_feedback = 0;
    rep.negative_feedback = 0;
    rep.first_trade_at = 0;
    rep.last_trade_at = 0;
    rep.bump = ctx.bumps.reputation;

    msg!("Mugen reputation initialized: {:?}...", &commitment[..4]);
    Ok(())
}
