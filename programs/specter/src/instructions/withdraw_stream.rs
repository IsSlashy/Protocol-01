use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::P01Error;
use crate::state::StreamAccount;

/// Withdraw available funds from an active stream
///
/// The recipient can withdraw any unlocked funds that have accumulated
/// since the last withdrawal.
#[derive(Accounts)]
pub struct WithdrawStream<'info> {
    /// The recipient withdrawing funds
    #[account(mut)]
    pub recipient: Signer<'info>,

    /// The stream account
    #[account(
        mut,
        seeds = [
            StreamAccount::SEED_PREFIX,
            stream_account.sender.as_ref(),
            recipient.key().as_ref(),
            &stream_account.start_time.to_le_bytes()
        ],
        bump = stream_account.bump,
        constraint = stream_account.recipient == recipient.key() @ P01Error::UnauthorizedStreamAccess,
        constraint = !stream_account.cancelled @ P01Error::StreamAlreadyCancelled,
        constraint = !stream_account.paused @ P01Error::StreamPaused
    )]
    pub stream_account: Account<'info, StreamAccount>,

    /// Stream escrow token account (source of funds)
    #[account(
        mut,
        constraint = escrow_token_account.mint == stream_account.token_mint @ P01Error::InvalidTokenMint
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    /// Recipient's token account (destination for funds)
    #[account(
        mut,
        constraint = recipient_token_account.owner == recipient.key() @ P01Error::UnauthorizedStreamAccess,
        constraint = recipient_token_account.mint == stream_account.token_mint @ P01Error::InvalidTokenMint
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    /// Escrow authority PDA
    /// CHECK: PDA authority for escrow
    #[account(
        seeds = [b"stream_escrow", stream_account.key().as_ref()],
        bump
    )]
    pub escrow_authority: AccountInfo<'info>,

    /// Token program
    pub token_program: Program<'info, Token>,
}

/// Handler for withdraw_stream instruction
pub fn handler(ctx: Context<WithdrawStream>) -> Result<()> {
    let stream_account = &ctx.accounts.stream_account;

    // Get current timestamp
    let clock = Clock::get()?;
    let current_time = clock.unix_timestamp;

    // Check if stream has started
    if !stream_account.has_started(current_time) {
        return Err(P01Error::StreamNotStarted.into());
    }

    // Calculate withdrawable amount
    let withdrawable = stream_account.withdrawable_amount(current_time);

    if withdrawable == 0 {
        return Err(P01Error::NoFundsAvailable.into());
    }

    // Create signer seeds for escrow authority PDA
    let stream_key = ctx.accounts.stream_account.key();
    let authority_bump = ctx.bumps.escrow_authority;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"stream_escrow",
        stream_key.as_ref(),
        &[authority_bump],
    ]];

    // Transfer tokens from escrow to recipient
    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.escrow_token_account.to_account_info(),
            to: ctx.accounts.recipient_token_account.to_account_info(),
            authority: ctx.accounts.escrow_authority.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(transfer_ctx, withdrawable)?;

    // Update stream account
    let stream_account = &mut ctx.accounts.stream_account;
    stream_account.withdraw(withdrawable);

    msg!("Stream withdrawal successful");
    msg!("Amount withdrawn: {}", withdrawable);
    msg!("Total withdrawn: {}", stream_account.withdrawn_amount);
    msg!("Remaining: {}", stream_account.total_amount.saturating_sub(stream_account.withdrawn_amount));

    Ok(())
}
