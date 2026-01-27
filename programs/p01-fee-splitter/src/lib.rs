use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("7xwX64ZxMVyw7xWJPaPuy8WFcvvhJrDDWEkc64nUMDCu");

/// P-01 Network Fee Splitter
/// Automatically takes a fee on incoming transfers and forwards the rest to the recipient.
///
/// Fee: 0.5% (50 basis points) by default
/// Fee Wallet: Configurable per-transfer or uses global config

/// Fee in basis points (50 = 0.5%)
pub const DEFAULT_FEE_BPS: u16 = 50;

/// Maximum fee: 5% (500 basis points)
pub const MAX_FEE_BPS: u16 = 500;

/// Minimum transfer amount (to avoid dust attacks)
pub const MIN_TRANSFER_LAMPORTS: u64 = 10_000; // 0.00001 SOL

#[program]
pub mod p01_fee_splitter {
    use super::*;

    /// Initialize the global fee configuration
    /// Only called once by the program authority
    pub fn initialize(
        ctx: Context<Initialize>,
        fee_bps: u16,
        fee_wallet: Pubkey,
    ) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, ErrorCode::FeeTooHigh);

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.fee_wallet = fee_wallet;
        config.fee_bps = fee_bps;
        config.total_fees_collected = 0;
        config.total_transfers = 0;
        config.bump = ctx.bumps.config;

        msg!("P-01 Fee Splitter initialized: {}bps fee to {}", fee_bps, fee_wallet);
        Ok(())
    }

    /// Update fee configuration (authority only)
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_fee_bps: Option<u16>,
        new_fee_wallet: Option<Pubkey>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;

        if let Some(fee_bps) = new_fee_bps {
            require!(fee_bps <= MAX_FEE_BPS, ErrorCode::FeeTooHigh);
            config.fee_bps = fee_bps;
        }

        if let Some(fee_wallet) = new_fee_wallet {
            config.fee_wallet = fee_wallet;
        }

        msg!("Config updated: {}bps fee to {}", config.fee_bps, config.fee_wallet);
        Ok(())
    }

    /// Split a SOL transfer: take fee and forward rest to recipient
    pub fn split_sol(
        ctx: Context<SplitSol>,
        amount: u64,
    ) -> Result<()> {
        require!(amount >= MIN_TRANSFER_LAMPORTS, ErrorCode::AmountTooSmall);

        let config = &ctx.accounts.config;

        // Calculate fee
        let fee_amount = calculate_fee(amount, config.fee_bps);
        let recipient_amount = amount.checked_sub(fee_amount)
            .ok_or(ErrorCode::MathOverflow)?;

        // Transfer fee to fee wallet
        if fee_amount > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.sender.to_account_info(),
                        to: ctx.accounts.fee_wallet.to_account_info(),
                    },
                ),
                fee_amount,
            )?;
        }

        // Transfer remainder to recipient
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.sender.to_account_info(),
                    to: ctx.accounts.recipient.to_account_info(),
                },
            ),
            recipient_amount,
        )?;

        // Update stats
        let config = &mut ctx.accounts.config;
        config.total_fees_collected = config.total_fees_collected
            .checked_add(fee_amount)
            .ok_or(ErrorCode::MathOverflow)?;
        config.total_transfers = config.total_transfers
            .checked_add(1)
            .ok_or(ErrorCode::MathOverflow)?;

        msg!(
            "P-01 Split: {} lamports -> {} to recipient, {} fee",
            amount, recipient_amount, fee_amount
        );

        emit!(SplitEvent {
            sender: ctx.accounts.sender.key(),
            recipient: ctx.accounts.recipient.key(),
            amount,
            fee_amount,
            recipient_amount,
            token_mint: None,
        });

        Ok(())
    }

    /// Split an SPL token transfer: take fee and forward rest to recipient
    pub fn split_token(
        ctx: Context<SplitToken>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, ErrorCode::AmountTooSmall);

        let config = &ctx.accounts.config;

        // Calculate fee
        let fee_amount = calculate_fee(amount, config.fee_bps);
        let recipient_amount = amount.checked_sub(fee_amount)
            .ok_or(ErrorCode::MathOverflow)?;

        // Transfer fee to fee wallet's token account
        if fee_amount > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.sender_token_account.to_account_info(),
                        to: ctx.accounts.fee_token_account.to_account_info(),
                        authority: ctx.accounts.sender.to_account_info(),
                    },
                ),
                fee_amount,
            )?;
        }

        // Transfer remainder to recipient's token account
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.sender_token_account.to_account_info(),
                    to: ctx.accounts.recipient_token_account.to_account_info(),
                    authority: ctx.accounts.sender.to_account_info(),
                },
            ),
            recipient_amount,
        )?;

        // Update stats
        let config = &mut ctx.accounts.config;
        config.total_fees_collected = config.total_fees_collected
            .checked_add(fee_amount)
            .ok_or(ErrorCode::MathOverflow)?;
        config.total_transfers = config.total_transfers
            .checked_add(1)
            .ok_or(ErrorCode::MathOverflow)?;

        msg!(
            "P-01 Token Split: {} -> {} to recipient, {} fee",
            amount, recipient_amount, fee_amount
        );

        emit!(SplitEvent {
            sender: ctx.accounts.sender.key(),
            recipient: ctx.accounts.recipient_token_account.key(),
            amount,
            fee_amount,
            recipient_amount,
            token_mint: Some(ctx.accounts.sender_token_account.mint),
        });

        Ok(())
    }

    /// Direct transfer with inline fee (no config account needed)
    /// Useful for simple integrations
    pub fn split_sol_direct(
        ctx: Context<SplitSolDirect>,
        amount: u64,
        fee_bps: u16,
    ) -> Result<()> {
        require!(amount >= MIN_TRANSFER_LAMPORTS, ErrorCode::AmountTooSmall);
        require!(fee_bps <= MAX_FEE_BPS, ErrorCode::FeeTooHigh);

        // Calculate fee
        let fee_amount = calculate_fee(amount, fee_bps);
        let recipient_amount = amount.checked_sub(fee_amount)
            .ok_or(ErrorCode::MathOverflow)?;

        // Transfer fee to fee wallet
        if fee_amount > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.sender.to_account_info(),
                        to: ctx.accounts.fee_wallet.to_account_info(),
                    },
                ),
                fee_amount,
            )?;
        }

        // Transfer remainder to recipient
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.sender.to_account_info(),
                    to: ctx.accounts.recipient.to_account_info(),
                },
            ),
            recipient_amount,
        )?;

        msg!(
            "P-01 Direct Split: {} lamports -> {} to recipient, {} fee ({}bps)",
            amount, recipient_amount, fee_amount, fee_bps
        );

        emit!(SplitEvent {
            sender: ctx.accounts.sender.key(),
            recipient: ctx.accounts.recipient.key(),
            amount,
            fee_amount,
            recipient_amount,
            token_mint: None,
        });

        Ok(())
    }
}

/// Calculate fee amount from total and basis points
fn calculate_fee(amount: u64, fee_bps: u16) -> u64 {
    // fee = amount * fee_bps / 10000
    // Using u128 to prevent overflow
    let fee = (amount as u128)
        .checked_mul(fee_bps as u128)
        .unwrap_or(0)
        .checked_div(10_000)
        .unwrap_or(0);
    fee as u64
}

// ============== Accounts ==============

#[account]
#[derive(Default)]
pub struct FeeConfig {
    /// Authority that can update the config
    pub authority: Pubkey,
    /// Wallet that receives fees
    pub fee_wallet: Pubkey,
    /// Fee in basis points (50 = 0.5%)
    pub fee_bps: u16,
    /// Total fees collected (for stats)
    pub total_fees_collected: u64,
    /// Total number of transfers processed
    pub total_transfers: u64,
    /// PDA bump
    pub bump: u8,
}

impl FeeConfig {
    pub const SIZE: usize = 8 + // discriminator
        32 + // authority
        32 + // fee_wallet
        2 +  // fee_bps
        8 +  // total_fees_collected
        8 +  // total_transfers
        1 +  // bump
        32;  // padding for future use
}

// ============== Contexts ==============

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = FeeConfig::SIZE,
        seeds = [b"p01-fee-config"],
        bump
    )]
    pub config: Account<'info, FeeConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [b"p01-fee-config"],
        bump = config.bump,
        has_one = authority
    )]
    pub config: Account<'info, FeeConfig>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct SplitSol<'info> {
    #[account(
        mut,
        seeds = [b"p01-fee-config"],
        bump = config.bump
    )]
    pub config: Account<'info, FeeConfig>,

    #[account(mut)]
    pub sender: Signer<'info>,

    /// CHECK: Recipient can be any account
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    /// CHECK: Fee wallet from config
    #[account(
        mut,
        constraint = fee_wallet.key() == config.fee_wallet @ ErrorCode::InvalidFeeWallet
    )]
    pub fee_wallet: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SplitToken<'info> {
    #[account(
        mut,
        seeds = [b"p01-fee-config"],
        bump = config.bump
    )]
    pub config: Account<'info, FeeConfig>,

    #[account(mut)]
    pub sender: Signer<'info>,

    #[account(
        mut,
        constraint = sender_token_account.owner == sender.key()
    )]
    pub sender_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub recipient_token_account: Account<'info, TokenAccount>,

    /// Fee wallet's token account for this mint
    #[account(
        mut,
        constraint = fee_token_account.owner == config.fee_wallet @ ErrorCode::InvalidFeeWallet
    )]
    pub fee_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SplitSolDirect<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,

    /// CHECK: Recipient can be any account
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    /// CHECK: Fee wallet specified by caller
    #[account(mut)]
    pub fee_wallet: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

// ============== Events ==============

#[event]
pub struct SplitEvent {
    pub sender: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub fee_amount: u64,
    pub recipient_amount: u64,
    pub token_mint: Option<Pubkey>,
}

// ============== Errors ==============

#[error_code]
pub enum ErrorCode {
    #[msg("Fee exceeds maximum allowed (5%)")]
    FeeTooHigh,
    #[msg("Transfer amount too small")]
    AmountTooSmall,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Invalid fee wallet")]
    InvalidFeeWallet,
}
