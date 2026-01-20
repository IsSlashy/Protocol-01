use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("2ko4FQSTj3Bqrmy3nvWeGx1KEhs5f2dFCy7JYY6wyxbs");

#[program]
pub mod p01_stream {
    use super::*;

    /// Create a new payment stream (subscription)
    pub fn create_stream(
        ctx: Context<CreateStream>,
        amount_per_interval: u64,
        interval_seconds: i64,
        total_intervals: u64,
        stream_name: String,
    ) -> Result<()> {
        require!(amount_per_interval > 0, StreamError::InvalidAmount);
        require!(interval_seconds > 0, StreamError::InvalidInterval);
        require!(total_intervals > 0, StreamError::InvalidIntervals);
        require!(stream_name.len() <= 32, StreamError::NameTooLong);

        let stream = &mut ctx.accounts.stream;
        let clock = Clock::get()?;

        stream.sender = ctx.accounts.sender.key();
        stream.recipient = ctx.accounts.recipient.key();
        stream.mint = ctx.accounts.mint.key();
        stream.amount_per_interval = amount_per_interval;
        stream.interval_seconds = interval_seconds;
        stream.total_intervals = total_intervals;
        stream.intervals_paid = 0;
        stream.created_at = clock.unix_timestamp;
        stream.last_withdrawal_at = clock.unix_timestamp;
        stream.status = StreamStatus::Active;
        stream.stream_name = stream_name;
        stream.bump = ctx.bumps.stream;

        // Transfer first interval payment to escrow
        let total_deposit = amount_per_interval
            .checked_mul(total_intervals)
            .ok_or(StreamError::Overflow)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.sender_token_account.to_account_info(),
                    to: ctx.accounts.escrow_token_account.to_account_info(),
                    authority: ctx.accounts.sender.to_account_info(),
                },
            ),
            total_deposit,
        )?;

        emit!(StreamCreated {
            stream: stream.key(),
            sender: stream.sender,
            recipient: stream.recipient,
            amount_per_interval,
            interval_seconds,
            total_intervals,
            stream_name: stream.stream_name.clone(),
        });

        Ok(())
    }

    /// Withdraw available funds from stream (called by recipient)
    pub fn withdraw_from_stream(ctx: Context<WithdrawFromStream>) -> Result<()> {
        let stream = &mut ctx.accounts.stream;
        let clock = Clock::get()?;

        require!(
            stream.status == StreamStatus::Active,
            StreamError::StreamNotActive
        );

        // Calculate intervals that have elapsed since last withdrawal
        let time_elapsed = clock
            .unix_timestamp
            .checked_sub(stream.last_withdrawal_at)
            .ok_or(StreamError::Overflow)?;

        let intervals_elapsed = (time_elapsed / stream.interval_seconds) as u64;
        let intervals_remaining = stream
            .total_intervals
            .checked_sub(stream.intervals_paid)
            .ok_or(StreamError::Overflow)?;

        let intervals_to_pay = intervals_elapsed.min(intervals_remaining);

        require!(intervals_to_pay > 0, StreamError::NothingToWithdraw);

        let amount_to_withdraw = stream
            .amount_per_interval
            .checked_mul(intervals_to_pay)
            .ok_or(StreamError::Overflow)?;

        // Transfer from escrow to recipient
        let seeds = &[
            b"stream",
            stream.sender.as_ref(),
            stream.recipient.as_ref(),
            stream.mint.as_ref(),
            &[stream.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_token_account.to_account_info(),
                    to: ctx.accounts.recipient_token_account.to_account_info(),
                    authority: stream.to_account_info(),
                },
                signer_seeds,
            ),
            amount_to_withdraw,
        )?;

        stream.intervals_paid = stream
            .intervals_paid
            .checked_add(intervals_to_pay)
            .ok_or(StreamError::Overflow)?;
        stream.last_withdrawal_at = clock.unix_timestamp;

        // Check if stream is complete
        if stream.intervals_paid >= stream.total_intervals {
            stream.status = StreamStatus::Completed;
        }

        emit!(StreamWithdrawal {
            stream: stream.key(),
            recipient: stream.recipient,
            amount: amount_to_withdraw,
            intervals_paid: stream.intervals_paid,
        });

        Ok(())
    }

    /// Cancel stream and return remaining funds to sender
    pub fn cancel_stream(ctx: Context<CancelStream>) -> Result<()> {
        let stream = &mut ctx.accounts.stream;

        require!(
            stream.status == StreamStatus::Active,
            StreamError::StreamNotActive
        );

        // Calculate remaining funds
        let intervals_remaining = stream
            .total_intervals
            .checked_sub(stream.intervals_paid)
            .ok_or(StreamError::Overflow)?;

        let refund_amount = stream
            .amount_per_interval
            .checked_mul(intervals_remaining)
            .ok_or(StreamError::Overflow)?;

        if refund_amount > 0 {
            let seeds = &[
                b"stream",
                stream.sender.as_ref(),
                stream.recipient.as_ref(),
                stream.mint.as_ref(),
                &[stream.bump],
            ];
            let signer_seeds = &[&seeds[..]];

            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.escrow_token_account.to_account_info(),
                        to: ctx.accounts.sender_token_account.to_account_info(),
                        authority: stream.to_account_info(),
                    },
                    signer_seeds,
                ),
                refund_amount,
            )?;
        }

        stream.status = StreamStatus::Cancelled;

        emit!(StreamCancelled {
            stream: stream.key(),
            sender: stream.sender,
            refund_amount,
        });

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(amount_per_interval: u64, interval_seconds: i64, total_intervals: u64, stream_name: String)]
pub struct CreateStream<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,

    /// CHECK: Recipient can be any account
    pub recipient: AccountInfo<'info>,

    /// CHECK: Token mint
    pub mint: AccountInfo<'info>,

    #[account(
        init,
        payer = sender,
        space = 8 + Stream::INIT_SPACE,
        seeds = [b"stream", sender.key().as_ref(), recipient.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub stream: Account<'info, Stream>,

    #[account(
        mut,
        constraint = sender_token_account.owner == sender.key(),
        constraint = sender_token_account.mint == mint.key()
    )]
    pub sender_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = escrow_token_account.mint == mint.key()
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawFromStream<'info> {
    #[account(mut)]
    pub recipient: Signer<'info>,

    #[account(
        mut,
        constraint = stream.recipient == recipient.key(),
        seeds = [b"stream", stream.sender.as_ref(), stream.recipient.as_ref(), stream.mint.as_ref()],
        bump = stream.bump
    )]
    pub stream: Account<'info, Stream>,

    #[account(
        mut,
        constraint = escrow_token_account.mint == stream.mint
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = recipient_token_account.owner == recipient.key(),
        constraint = recipient_token_account.mint == stream.mint
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelStream<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,

    #[account(
        mut,
        constraint = stream.sender == sender.key(),
        seeds = [b"stream", stream.sender.as_ref(), stream.recipient.as_ref(), stream.mint.as_ref()],
        bump = stream.bump
    )]
    pub stream: Account<'info, Stream>,

    #[account(
        mut,
        constraint = escrow_token_account.mint == stream.mint
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = sender_token_account.owner == sender.key(),
        constraint = sender_token_account.mint == stream.mint
    )]
    pub sender_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Stream {
    pub sender: Pubkey,
    pub recipient: Pubkey,
    pub mint: Pubkey,
    pub amount_per_interval: u64,
    pub interval_seconds: i64,
    pub total_intervals: u64,
    pub intervals_paid: u64,
    pub created_at: i64,
    pub last_withdrawal_at: i64,
    pub status: StreamStatus,
    #[max_len(32)]
    pub stream_name: String,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum StreamStatus {
    Active,
    Paused,
    Cancelled,
    Completed,
}

#[error_code]
pub enum StreamError {
    #[msg("Invalid amount - must be greater than 0")]
    InvalidAmount,
    #[msg("Invalid interval - must be greater than 0")]
    InvalidInterval,
    #[msg("Invalid total intervals - must be greater than 0")]
    InvalidIntervals,
    #[msg("Stream name too long - max 32 characters")]
    NameTooLong,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Stream is not active")]
    StreamNotActive,
    #[msg("Nothing to withdraw yet")]
    NothingToWithdraw,
}

#[event]
pub struct StreamCreated {
    pub stream: Pubkey,
    pub sender: Pubkey,
    pub recipient: Pubkey,
    pub amount_per_interval: u64,
    pub interval_seconds: i64,
    pub total_intervals: u64,
    pub stream_name: String,
}

#[event]
pub struct StreamWithdrawal {
    pub stream: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub intervals_paid: u64,
}

#[event]
pub struct StreamCancelled {
    pub stream: Pubkey,
    pub sender: Pubkey,
    pub refund_amount: u64,
}
