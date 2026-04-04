use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::errors::MugenError;
use crate::state::*;

#[derive(Accounts)]
pub struct ExpireEscrow<'info> {
    /// Permissionless — anyone can crank expired escrows.
    pub cranker: Signer<'info>,

    #[account(
        mut,
        constraint = (
            escrow.status == ESCROW_AWAITING_PAYMENT ||
            escrow.status == ESCROW_PAYMENT_CONFIRMED
        ) @ MugenError::EscrowNotDisputable,
    )]
    pub escrow: Account<'info, MugenEscrow>,

    #[account(
        mut,
        constraint = order.key() == escrow.order,
    )]
    pub order: Account<'info, MugenOrder>,

    /// The escrow vault holding the crypto.
    #[account(
        mut,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump = escrow.vault_bump,
        token::authority = escrow,
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    /// The seller's token account (refund destination).
    #[account(mut)]
    pub seller_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ExpireEscrow>) -> Result<()> {
    let clock = Clock::get()?;
    let escrow = &ctx.accounts.escrow;

    // Verify escrow has actually expired
    require!(
        clock.unix_timestamp >= escrow.expires_at,
        MugenError::EscrowNotExpired,
    );

    // PDA signer seeds
    let order_key = escrow.order;
    let taker_key = escrow.taker;
    let escrow_bump = escrow.bump;
    let bump_slice = [escrow_bump];
    let escrow_seeds: &[&[u8]] = &[
        ESCROW_SEED,
        order_key.as_ref(),
        taker_key.as_ref(),
        &bump_slice,
    ];
    let signer_seeds = &[escrow_seeds];

    // Refund crypto to seller
    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.escrow_vault.to_account_info(),
            to: ctx.accounts.seller_token_account.to_account_info(),
            authority: ctx.accounts.escrow.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(transfer_ctx, escrow.crypto_amount)?;

    // Update statuses
    let escrow = &mut ctx.accounts.escrow;
    escrow.status = ESCROW_EXPIRED;

    let order = &mut ctx.accounts.order;
    order.status = STATUS_OPEN; // Re-open the order for new takers

    msg!("Mugen escrow expired and refunded: {}", escrow.key());
    Ok(())
}
