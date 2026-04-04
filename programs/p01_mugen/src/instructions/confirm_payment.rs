use anchor_lang::prelude::*;
use crate::errors::MugenError;
use crate::state::*;

#[derive(Accounts)]
pub struct ConfirmPayment<'info> {
    pub buyer: Signer<'info>,

    #[account(
        mut,
        constraint = escrow.status == ESCROW_AWAITING_PAYMENT @ MugenError::EscrowNotAwaitingPayment,
    )]
    pub escrow: Account<'info, MugenEscrow>,
}

pub fn handler(ctx: Context<ConfirmPayment>) -> Result<()> {
    let clock = Clock::get()?;
    let escrow = &mut ctx.accounts.escrow;
    let buyer = ctx.accounts.buyer.key();

    // Check escrow hasn't expired
    require!(clock.unix_timestamp < escrow.expires_at, MugenError::EscrowExpired);

    // Determine who the buyer is based on order type:
    // - sell_crypto order: taker is the buyer (paying fiat)
    // - buy_crypto order: maker is the buyer (paying fiat)
    // In both cases, the buyer is the one who sends fiat and confirms payment.
    let is_buyer = buyer == escrow.taker || buyer == escrow.maker;
    require!(is_buyer, MugenError::UnauthorizedBuyer);

    escrow.status = ESCROW_PAYMENT_CONFIRMED;
    escrow.payment_confirmed_at = clock.unix_timestamp;

    msg!("Mugen payment confirmed for escrow: {}", escrow.key());
    Ok(())
}
