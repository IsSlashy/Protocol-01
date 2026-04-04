use anchor_lang::prelude::*;
use crate::errors::MugenError;
use crate::state::*;

#[derive(Accounts)]
pub struct DisputeEscrow<'info> {
    pub disputer: Signer<'info>,

    #[account(mut)]
    pub escrow: Account<'info, MugenEscrow>,
}

pub fn handler(ctx: Context<DisputeEscrow>, reason: u8) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;
    let disputer = ctx.accounts.disputer.key();

    // Only participants can dispute
    require!(
        disputer == escrow.maker || disputer == escrow.taker,
        MugenError::UnauthorizedParticipant,
    );

    // Can only dispute from awaiting_payment or payment_confirmed
    require!(
        escrow.status == ESCROW_AWAITING_PAYMENT || escrow.status == ESCROW_PAYMENT_CONFIRMED,
        MugenError::EscrowNotDisputable,
    );

    escrow.status = ESCROW_DISPUTED;
    escrow.dispute_initiator = disputer;
    escrow.dispute_reason = reason;

    msg!("Mugen dispute opened on escrow {} by {}", escrow.key(), disputer);
    Ok(())
}
