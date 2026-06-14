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
    pub config: Box<Account<'info, MugenConfig>>,

    #[account(
        mut,
        constraint = order.status == STATUS_OPEN @ MugenError::OrderNotOpen,
        constraint = order.maker != taker.key() @ MugenError::CannotTakeOwnOrder,
    )]
    pub order: Box<Account<'info, MugenOrder>>,

    #[account(
        init,
        payer = taker,
        space = MugenEscrow::LEN,
        seeds = [ESCROW_SEED, order.key().as_ref(), taker.key().as_ref()],
        bump,
    )]
    pub escrow: Box<Account<'info, MugenEscrow>>,

    /// The PDA-owned token account to hold escrowed crypto.
    #[account(
        init,
        payer = taker,
        token::mint = token_mint,
        token::authority = escrow,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump,
    )]
    pub escrow_vault: Box<Account<'info, TokenAccount>>,

    /// The seller's token account (source of crypto to escrow).
    /// Bound to the `seller` signer below so a caller cannot pass an unrelated
    /// token account on finalization paths (resolve_dispute, expire_escrow).
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = seller,
    )]
    pub seller_token_account: Box<Account<'info, TokenAccount>>,

    /// The buyer's token account (destination for `release_escrow` / `resolve_dispute`).
    /// Captured at escrow creation so later finalization cannot be redirected.
    #[account(
        token::mint = token_mint,
    )]
    pub buyer_token_account: Box<Account<'info, TokenAccount>>,

    /// The seller must sign if they are depositing crypto.
    pub seller: Signer<'info>,

    pub token_mint: Box<Account<'info, Mint>>,

    /// Taker's compliance attestation.
    /// CHECK: validated in handler via raw byte reading.
    pub taker_attestation: AccountInfo<'info>,

    /// Maker reputation PDA — snapshotted into escrow at trade time.
    #[account(
        seeds = [REPUTATION_SEED, maker_reputation.commitment.as_ref()],
        bump = maker_reputation.bump,
    )]
    pub maker_reputation: Box<Account<'info, MugenReputation>>,

    /// Taker reputation PDA — snapshotted into escrow at trade time.
    #[account(
        seeds = [REPUTATION_SEED, taker_reputation.commitment.as_ref()],
        bump = taker_reputation.bump,
    )]
    pub taker_reputation: Box<Account<'info, MugenReputation>>,

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

    // Seller role is derived from order type — the caller cannot pick sides.
    // SELL order: maker lists crypto → maker is seller.
    // BUY order: maker wants crypto → taker supplies crypto → taker is seller.
    let expected_seller = match order.order_type {
        ORDER_TYPE_SELL_CRYPTO => order.maker,
        ORDER_TYPE_BUY_CRYPTO => ctx.accounts.taker.key(),
        _ => return err!(MugenError::InvalidOrderType),
    };
    require_keys_eq!(
        ctx.accounts.seller.key(),
        expected_seller,
        MugenError::UnauthorizedSeller
    );

    // Buyer is the other side; bind their token account so finalization can't be redirected.
    let expected_buyer = if expected_seller == order.maker {
        ctx.accounts.taker.key()
    } else {
        order.maker
    };
    require_keys_eq!(
        ctx.accounts.buyer_token_account.owner,
        expected_buyer,
        MugenError::UnauthorizedBuyer
    );

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

    // Snapshot reputations (Fix: prevents race between live rep updates and finalization).
    let maker_rep_snapshot = ctx.accounts.maker_reputation.trades_completed as u64;
    let taker_rep_snapshot = ctx.accounts.taker_reputation.trades_completed as u64;

    let seller_ta = ctx.accounts.seller_token_account.key();
    let buyer_ta = ctx.accounts.buyer_token_account.key();
    let escrow_vault_key = ctx.accounts.escrow_vault.key();
    let taker_attestation_key = ctx.accounts.taker_attestation.key();
    let taker_key = ctx.accounts.taker.key();
    let escrow_timeout = ctx.accounts.config.escrow_timeout;

    // Update order status
    let order = &mut ctx.accounts.order;
    order.status = STATUS_IN_ESCROW;
    let order_key = order.key();
    let order_maker = order.maker;
    let order_token_mint = order.token_mint;
    let order_crypto_amount = order.crypto_amount;
    let order_fiat_amount = order.fiat_amount;
    let order_attestation = order.compliance_attestation;

    // Initialize escrow
    let escrow = &mut ctx.accounts.escrow;
    escrow.order = order_key;
    escrow.maker = order_maker;
    escrow.taker = taker_key;
    escrow.token_mint = order_token_mint;
    escrow.crypto_amount = order_crypto_amount;
    escrow.fiat_amount = order_fiat_amount;
    escrow.escrow_vault = escrow_vault_key;
    escrow.maker_attestation = order_attestation;
    escrow.taker_attestation = taker_attestation_key;
    escrow.stealth_recipient = stealth_recipient.unwrap_or([0u8; 32]);
    escrow.payment_method = payment_method;
    escrow.status = ESCROW_AWAITING_PAYMENT;
    escrow.created_at = clock.unix_timestamp;
    escrow.expires_at = clock.unix_timestamp + escrow_timeout;
    escrow.payment_confirmed_at = 0;
    escrow.dispute_initiator = Pubkey::default();
    escrow.dispute_reason = 0;
    escrow.buyer_token_account = buyer_ta;
    escrow.seller_token_account = seller_ta;
    escrow.maker_reputation_snapshot = maker_rep_snapshot;
    escrow.taker_reputation_snapshot = taker_rep_snapshot;
    escrow.bump = ctx.bumps.escrow;
    escrow.vault_bump = ctx.bumps.escrow_vault;

    msg!(
        "Mugen escrow created: {} crypto locked, awaiting {} fiat cents",
        escrow.crypto_amount,
        escrow.fiat_amount,
    );

    Ok(())
}
