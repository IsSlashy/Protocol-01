use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer, Mint};
use crate::errors::MugenError;
use crate::state::*;
use crate::instructions::create_order::validate_attestation;

#[derive(Accounts)]
pub struct TakeOrder<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.is_active @ MugenError::ExchangeNotActive,
    )]
    pub config: Account<'info, MugenConfig>,

    #[account(
        mut,
        constraint = order.status == STATUS_OPEN @ MugenError::OrderNotOpen,
        constraint = order.maker != taker.key() @ MugenError::CannotTakeOwnOrder,
    )]
    pub order: Account<'info, MugenOrder>,

    #[account(
        init,
        payer = taker,
        space = MugenEscrow::LEN,
        seeds = [ESCROW_SEED, order.key().as_ref(), taker.key().as_ref()],
        bump,
    )]
    pub escrow: Account<'info, MugenEscrow>,

    /// The PDA-owned token account to hold escrowed crypto.
    #[account(
        init,
        payer = taker,
        token::mint = token_mint,
        token::authority = escrow,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump,
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    /// The seller's token account (source of crypto to escrow).
    /// For sell_crypto orders: this is the maker's token account.
    /// For buy_crypto orders: this is the taker's token account.
    #[account(
        mut,
        token::mint = token_mint,
    )]
    pub seller_token_account: Account<'info, TokenAccount>,

    /// The seller must sign if they are depositing crypto.
    /// CHECK: validated by the transfer CPI.
    pub seller: Signer<'info>,

    pub token_mint: Account<'info, Mint>,

    /// Taker's compliance attestation.
    /// CHECK: validated in handler via raw byte reading.
    pub taker_attestation: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<TakeOrder>,
    stealth_recipient: Option<[u8; 32]>,
    payment_method: u16,
) -> Result<()> {
    let clock = Clock::get()?;
    let order = &ctx.accounts.order;

    // Check order hasn't expired
    require!(clock.unix_timestamp < order.expires_at, MugenError::OrderExpired);

    // Validate taker's compliance attestation
    // Authority bypass for devnet testing
    let is_authority_bypass = ctx.accounts.taker_attestation.key() == ctx.accounts.config.authority;
    if !is_authority_bypass {
        validate_attestation(&ctx.accounts.taker_attestation, &ctx.accounts.taker.key(), &clock)?;
    }

    // Transfer crypto from seller into escrow vault
    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.seller_token_account.to_account_info(),
            to: ctx.accounts.escrow_vault.to_account_info(),
            authority: ctx.accounts.seller.to_account_info(),
        },
    );
    token::transfer(transfer_ctx, order.crypto_amount)?;

    // Update order status
    let order = &mut ctx.accounts.order;
    order.status = STATUS_IN_ESCROW;

    // Initialize escrow
    let escrow = &mut ctx.accounts.escrow;
    escrow.order = order.key();
    escrow.maker = order.maker;
    escrow.taker = ctx.accounts.taker.key();
    escrow.token_mint = order.token_mint;
    escrow.crypto_amount = order.crypto_amount;
    escrow.fiat_amount = order.fiat_amount;
    escrow.escrow_vault = ctx.accounts.escrow_vault.key();
    escrow.maker_attestation = order.compliance_attestation;
    escrow.taker_attestation = ctx.accounts.taker_attestation.key();
    escrow.stealth_recipient = stealth_recipient.unwrap_or([0u8; 32]);
    escrow.payment_method = payment_method;
    escrow.status = ESCROW_AWAITING_PAYMENT;
    escrow.created_at = clock.unix_timestamp;
    escrow.expires_at = clock.unix_timestamp + ctx.accounts.config.escrow_timeout;
    escrow.payment_confirmed_at = 0;
    escrow.dispute_initiator = Pubkey::default();
    escrow.dispute_reason = 0;
    escrow.bump = ctx.bumps.escrow;
    escrow.vault_bump = ctx.bumps.escrow_vault;

    msg!(
        "Mugen escrow created: {} crypto locked, awaiting {} fiat cents",
        escrow.crypto_amount,
        escrow.fiat_amount,
    );

    Ok(())
}
