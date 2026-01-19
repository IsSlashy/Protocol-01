use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::SpecterError;
use crate::state::StreamAccount;

/// Cancel an active stream and return remaining funds to sender
///
/// Only the sender can cancel a stream. The recipient keeps any funds
/// that were already unlocked, and the remaining funds return to sender.
#[derive(Accounts)]
pub struct CancelStream<'info> {
    /// The sender cancelling the stream
    #[account(mut)]
    pub sender: Signer<'info>,

    /// The stream account
    #[account(
        mut,
        seeds = [
            StreamAccount::SEED_PREFIX,
            sender.key().as_ref(),
            stream_account.recipient.as_ref(),
            &stream_account.start_time.to_le_bytes()
        ],
        bump = stream_account.bump,
        constraint = stream_account.sender == sender.key() @ SpecterError::UnauthorizedStreamAccess,
        constraint = !stream_account.cancelled @ SpecterError::StreamAlreadyCancelled
    )]
    pub stream_account: Account<'info, StreamAccount>,

    /// Stream escrow token account (source of remaining funds)
    #[account(
        mut,
        constraint = escrow_token_account.mint == stream_account.token_mint @ SpecterError::InvalidTokenMint
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    /// Sender's token account (destination for remaining funds)
    #[account(
        mut,
        constraint = sender_token_account.owner == sender.key() @ SpecterError::UnauthorizedStreamAccess,
        constraint = sender_token_account.mint == stream_account.token_mint @ SpecterError::InvalidTokenMint
    )]
    pub sender_token_account: Account<'info, TokenAccount>,

    /// Recipient's token account (for unlocked funds)
    #[account(
        mut,
        constraint = recipient_token_account.owner == stream_account.recipient @ SpecterError::UnauthorizedStreamAccess,
        constraint = recipient_token_account.mint == stream_account.token_mint @ SpecterError::InvalidTokenMint
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

/// Handler for cancel_stream instruction
pub fn handler(ctx: Context<CancelStream>) -> Result<()> {
    let stream_account = &ctx.accounts.stream_account;

    // Get current timestamp
    let clock = Clock::get()?;
    let current_time = clock.unix_timestamp;

    // Calculate amounts
    let unlocked = stream_account.unlocked_amount(current_time);
    let withdrawable = unlocked.saturating_sub(stream_account.withdrawn_amount);
    let remaining = stream_account.remaining_amount(current_time);

    // Create signer seeds for escrow authority PDA
    let stream_key = ctx.accounts.stream_account.key();
    let authority_bump = ctx.bumps.escrow_authority;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"stream_escrow",
        stream_key.as_ref(),
        &[authority_bump],
    ]];

    // Transfer unlocked funds to recipient (if any)
    if withdrawable > 0 {
        let transfer_to_recipient = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_token_account.to_account_info(),
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.escrow_authority.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_to_recipient, withdrawable)?;
    }

    // Transfer remaining funds back to sender
    if remaining > 0 {
        let transfer_to_sender = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_token_account.to_account_info(),
                to: ctx.accounts.sender_token_account.to_account_info(),
                authority: ctx.accounts.escrow_authority.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_to_sender, remaining)?;
    }

    // Mark stream as cancelled
    let stream_account = &mut ctx.accounts.stream_account;
    stream_account.cancel();
    stream_account.withdraw(withdrawable);

    msg!("Stream cancelled successfully");
    msg!("Funds to recipient: {}", withdrawable);
    msg!("Funds returned to sender: {}", remaining);
    msg!("Stream: {}", ctx.accounts.stream_account.key());

    Ok(())
}
