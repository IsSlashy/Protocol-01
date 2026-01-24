use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::P01Error;
use crate::state::{DecoyLevel, P01Wallet, StealthAccount};

/// Send a private payment using stealth addressing
///
/// Creates a one-time stealth address that only the recipient can identify
/// and claim using their viewing/spending keys.
#[derive(Accounts)]
#[instruction(amount: u64, stealth_address: [u8; 32])]
pub struct SendPrivate<'info> {
    /// The sender of the payment
    #[account(mut)]
    pub sender: Signer<'info>,

    /// Sender's Protocol 01 wallet (for nonce increment)
    #[account(
        mut,
        seeds = [P01Wallet::SEED_PREFIX, sender.key().as_ref()],
        bump = sender_wallet.bump,
        constraint = sender_wallet.owner == sender.key() @ P01Error::UnauthorizedWalletAccess
    )]
    pub sender_wallet: Account<'info, P01Wallet>,

    /// The stealth account PDA to be created
    #[account(
        init,
        payer = sender,
        space = StealthAccount::LEN,
        seeds = [StealthAccount::SEED_PREFIX, &stealth_address],
        bump
    )]
    pub stealth_account: Account<'info, StealthAccount>,

    /// Token mint (for SPL tokens, use Pubkey::default() for native SOL)
    /// CHECK: Validated by token program
    pub token_mint: AccountInfo<'info>,

    /// Sender's token account (source of funds)
    #[account(
        mut,
        constraint = sender_token_account.owner == sender.key() @ P01Error::UnauthorizedWalletAccess
    )]
    pub sender_token_account: Account<'info, TokenAccount>,

    /// Stealth escrow token account (destination for funds)
    #[account(
        mut,
        constraint = escrow_token_account.mint == sender_token_account.mint @ P01Error::InvalidTokenMint
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    /// Token program
    pub token_program: Program<'info, Token>,

    /// System program
    pub system_program: Program<'info, System>,
}

/// Handler for send_private instruction
pub fn handler(
    ctx: Context<SendPrivate>,
    amount: u64,
    stealth_address: [u8; 32],
    encrypted_amount: [u8; 32],
    decoy_level: u8,
) -> Result<()> {
    // Validate amount
    if amount == 0 {
        return Err(P01Error::InvalidStreamAmount.into());
    }

    // Validate decoy level
    let _decoy = DecoyLevel::from_u8(decoy_level)
        .ok_or(P01Error::InvalidDecoyLevel)?;

    // Validate stealth address is not empty
    if stealth_address == [0u8; 32] {
        return Err(P01Error::InvalidStealthAddress.into());
    }

    // Check sender has sufficient balance
    if ctx.accounts.sender_token_account.amount < amount {
        return Err(P01Error::InsufficientFundsForStealth.into());
    }

    // Transfer tokens to escrow
    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.sender_token_account.to_account_info(),
            to: ctx.accounts.escrow_token_account.to_account_info(),
            authority: ctx.accounts.sender.to_account_info(),
        },
    );
    token::transfer(transfer_ctx, amount)?;

    // Get current timestamp
    let clock = Clock::get()?;
    let current_time = clock.unix_timestamp;

    // Initialize stealth account
    let stealth_account = &mut ctx.accounts.stealth_account;
    let bump = ctx.bumps.stealth_account;

    stealth_account.initialize(
        stealth_address,
        encrypted_amount,
        ctx.accounts.token_mint.key(),
        current_time,
        bump,
    );

    // Increment sender's nonce
    let sender_wallet = &mut ctx.accounts.sender_wallet;
    let new_nonce = sender_wallet.increment_nonce();

    msg!("Private payment sent successfully");
    msg!("Amount: {} (encrypted)", amount);
    msg!("Stealth address: {:?}", &stealth_address[..8]);
    msg!("Decoy level: {}", decoy_level);
    msg!("New nonce: {}", new_nonce);

    Ok(())
}

/// Context for native SOL transfers (alternative to SPL tokens)
#[derive(Accounts)]
#[instruction(amount: u64, stealth_address: [u8; 32])]
pub struct SendPrivateNative<'info> {
    /// The sender of the payment
    #[account(mut)]
    pub sender: Signer<'info>,

    /// Sender's Protocol 01 wallet
    #[account(
        mut,
        seeds = [P01Wallet::SEED_PREFIX, sender.key().as_ref()],
        bump = sender_wallet.bump,
        constraint = sender_wallet.owner == sender.key() @ P01Error::UnauthorizedWalletAccess
    )]
    pub sender_wallet: Account<'info, P01Wallet>,

    /// The stealth account PDA
    #[account(
        init,
        payer = sender,
        space = StealthAccount::LEN,
        seeds = [StealthAccount::SEED_PREFIX, &stealth_address],
        bump
    )]
    pub stealth_account: Account<'info, StealthAccount>,

    /// Escrow account to hold native SOL
    /// CHECK: PDA owned by program
    #[account(
        mut,
        seeds = [b"escrow", &stealth_address],
        bump
    )]
    pub escrow: AccountInfo<'info>,

    /// System program
    pub system_program: Program<'info, System>,
}
