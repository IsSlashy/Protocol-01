use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::SpecterError;
use crate::state::{SpecterWallet, StreamAccount};

/// Create a new streaming payment
///
/// Funds are locked in an escrow and released linearly to the recipient
/// over the specified duration.
#[derive(Accounts)]
pub struct CreateStream<'info> {
    /// The sender creating the stream
    #[account(mut)]
    pub sender: Signer<'info>,

    /// Sender's Specter wallet (optional, for private streams)
    #[account(
        seeds = [SpecterWallet::SEED_PREFIX, sender.key().as_ref()],
        bump = sender_wallet.bump,
        constraint = sender_wallet.owner == sender.key() @ SpecterError::UnauthorizedWalletAccess
    )]
    pub sender_wallet: Account<'info, SpecterWallet>,

    /// The recipient of the stream
    /// CHECK: Validated as not equal to sender
    pub recipient: AccountInfo<'info>,

    /// The stream account PDA to be created
    #[account(
        init,
        payer = sender,
        space = StreamAccount::LEN,
        seeds = [
            StreamAccount::SEED_PREFIX,
            sender.key().as_ref(),
            recipient.key().as_ref(),
            &Clock::get()?.unix_timestamp.to_le_bytes()
        ],
        bump
    )]
    pub stream_account: Account<'info, StreamAccount>,

    /// Token mint for the stream
    /// CHECK: Validated by token program
    pub token_mint: AccountInfo<'info>,

    /// Sender's token account (source of funds)
    #[account(
        mut,
        constraint = sender_token_account.owner == sender.key() @ SpecterError::UnauthorizedWalletAccess
    )]
    pub sender_token_account: Account<'info, TokenAccount>,

    /// Stream escrow token account (holds streamed funds)
    #[account(
        mut,
        constraint = escrow_token_account.mint == sender_token_account.mint @ SpecterError::InvalidTokenMint
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    /// Token program
    pub token_program: Program<'info, Token>,

    /// System program
    pub system_program: Program<'info, System>,
}

/// Handler for create_stream instruction
pub fn handler(
    ctx: Context<CreateStream>,
    total_amount: u64,
    duration_seconds: i64,
    is_private: bool,
) -> Result<()> {
    // Validate amount
    if total_amount == 0 {
        return Err(SpecterError::InvalidStreamAmount.into());
    }

    // Validate duration
    if !StreamAccount::validate_duration(duration_seconds) {
        return Err(SpecterError::InvalidStreamDuration.into());
    }

    // Validate recipient is not sender
    if ctx.accounts.recipient.key() == ctx.accounts.sender.key() {
        return Err(SpecterError::RecipientIsSender.into());
    }

    // Check sender has sufficient balance
    if ctx.accounts.sender_token_account.amount < total_amount {
        return Err(SpecterError::InsufficientBalance.into());
    }

    // Get current timestamp
    let clock = Clock::get()?;
    let start_time = clock.unix_timestamp;
    let end_time = start_time
        .checked_add(duration_seconds)
        .ok_or(SpecterError::ArithmeticOverflow)?;

    // Transfer tokens to escrow
    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.sender_token_account.to_account_info(),
            to: ctx.accounts.escrow_token_account.to_account_info(),
            authority: ctx.accounts.sender.to_account_info(),
        },
    );
    token::transfer(transfer_ctx, total_amount)?;

    // Initialize stream account
    let stream_account = &mut ctx.accounts.stream_account;
    let bump = ctx.bumps.stream_account;

    stream_account.initialize(
        ctx.accounts.sender.key(),
        ctx.accounts.recipient.key(),
        ctx.accounts.token_mint.key(),
        total_amount,
        start_time,
        end_time,
        is_private,
        bump,
    );

    msg!("Stream created successfully");
    msg!("Stream PDA: {}", stream_account.key());
    msg!("Sender: {}", ctx.accounts.sender.key());
    msg!("Recipient: {}", ctx.accounts.recipient.key());
    msg!("Total amount: {}", total_amount);
    msg!("Duration: {} seconds", duration_seconds);
    msg!("Is private: {}", is_private);
    msg!("Start time: {}", start_time);
    msg!("End time: {}", end_time);

    Ok(())
}
