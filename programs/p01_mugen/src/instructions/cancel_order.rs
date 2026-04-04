use anchor_lang::prelude::*;
use crate::errors::MugenError;
use crate::state::*;

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(
        mut,
        seeds = [ORDER_SEED, maker.key().as_ref(), order.nonce.as_ref()],
        bump = order.bump,
        constraint = order.maker == maker.key() @ MugenError::UnauthorizedMaker,
        constraint = order.status == STATUS_OPEN @ MugenError::OrderNotOpen,
    )]
    pub order: Account<'info, MugenOrder>,
}

pub fn handler(ctx: Context<CancelOrder>) -> Result<()> {
    let order = &mut ctx.accounts.order;
    order.status = STATUS_CANCELLED;

    msg!("Mugen order cancelled: {}", order.key());
    Ok(())
}
