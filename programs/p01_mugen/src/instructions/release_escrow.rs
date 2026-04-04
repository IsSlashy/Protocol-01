use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::errors::MugenError;
use crate::state::*;

#[derive(Accounts)]
pub struct ReleaseEscrow<'info> {
    /// The seller (crypto provider) who confirms fiat was received.
    pub seller: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, MugenConfig>,

    #[account(
        mut,
        constraint = escrow.status == ESCROW_PAYMENT_CONFIRMED @ MugenError::EscrowNotPaymentConfirmed,
    )]
    pub escrow: Account<'info, MugenEscrow>,

    /// The escrow vault token account holding the crypto.
    #[account(
        mut,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump = escrow.vault_bump,
        token::authority = escrow,
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    /// The buyer's token account (receives the crypto minus fees).
    #[account(mut)]
    pub buyer_token_account: Account<'info, TokenAccount>,

    /// P01 Protocol fee wallet token account.
    #[account(mut)]
    pub p01_fee_account: Account<'info, TokenAccount>,

    /// Mugen Exchange fee wallet token account.
    #[account(mut)]
    pub mugen_fee_account: Account<'info, TokenAccount>,

    /// Treasury fee wallet token account.
    #[account(mut)]
    pub treasury_fee_account: Account<'info, TokenAccount>,

    /// Maker reputation PDA (gets updated on completion).
    #[account(
        mut,
        seeds = [REPUTATION_SEED, maker_reputation.commitment.as_ref()],
        bump = maker_reputation.bump,
    )]
    pub maker_reputation: Account<'info, MugenReputation>,

    /// Taker reputation PDA (gets updated on completion).
    #[account(
        mut,
        seeds = [REPUTATION_SEED, taker_reputation.commitment.as_ref()],
        bump = taker_reputation.bump,
    )]
    pub taker_reputation: Account<'info, MugenReputation>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ReleaseEscrow>) -> Result<()> {
    let clock = Clock::get()?;
    let escrow = &ctx.accounts.escrow;
    let seller = ctx.accounts.seller.key();

    // Verify seller is a participant
    let is_seller = seller == escrow.maker || seller == escrow.taker;
    require!(is_seller, MugenError::UnauthorizedSeller);

    let config = &ctx.accounts.config;

    // ── Calculate 3-way fee split ───────────────────────────────────────
    let total_fee = escrow
        .crypto_amount
        .checked_mul(config.fee_bps as u64)
        .and_then(|v| v.checked_div(10_000))
        .ok_or(MugenError::MathOverflow)?;

    // P01 Protocol share (e.g. 20%)
    let p01_fee = total_fee
        .checked_mul(config.p01_fee_share as u64)
        .and_then(|v| v.checked_div(10_000))
        .ok_or(MugenError::MathOverflow)?;

    // Mugen Exchange share (e.g. 65%)
    let mugen_fee = total_fee
        .checked_mul(config.mugen_fee_share as u64)
        .and_then(|v| v.checked_div(10_000))
        .ok_or(MugenError::MathOverflow)?;

    // Treasury gets the remainder (avoids rounding dust)
    let treasury_fee = total_fee
        .checked_sub(p01_fee)
        .and_then(|v| v.checked_sub(mugen_fee))
        .ok_or(MugenError::MathOverflow)?;

    // Amount buyer receives = total - all fees
    let buyer_amount = escrow
        .crypto_amount
        .checked_sub(total_fee)
        .ok_or(MugenError::MathOverflow)?;

    // ── PDA signer seeds ────────────────────────────────────────────────
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

    // ── Transfer crypto to buyer ────────────────────────────────────────
    let transfer_to_buyer = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.escrow_vault.to_account_info(),
            to: ctx.accounts.buyer_token_account.to_account_info(),
            authority: ctx.accounts.escrow.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(transfer_to_buyer, buyer_amount)?;

    // ── Transfer fee to P01 Protocol ────────────────────────────────────
    if p01_fee > 0 {
        let transfer_p01 = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_vault.to_account_info(),
                to: ctx.accounts.p01_fee_account.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_p01, p01_fee)?;
    }

    // ── Transfer fee to Mugen Exchange ──────────────────────────────────
    if mugen_fee > 0 {
        let transfer_mugen = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_vault.to_account_info(),
                to: ctx.accounts.mugen_fee_account.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_mugen, mugen_fee)?;
    }

    // ── Transfer fee to Treasury ────────────────────────────────────────
    if treasury_fee > 0 {
        let transfer_treasury = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_vault.to_account_info(),
                to: ctx.accounts.treasury_fee_account.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_treasury, treasury_fee)?;
    }

    // ── Update escrow status ────────────────────────────────────────────
    let escrow = &mut ctx.accounts.escrow;
    escrow.status = ESCROW_RELEASED;

    // ── Update config stats ─────────────────────────────────────────────
    let config = &mut ctx.accounts.config;
    config.total_trades = config.total_trades.saturating_add(1);
    config.total_volume = config.total_volume.saturating_add(escrow.crypto_amount);
    config.total_fees_collected = config.total_fees_collected.saturating_add(total_fee);

    // ── Update reputations ──────────────────────────────────────────────
    let payment_time = if escrow.payment_confirmed_at > 0 {
        (escrow.payment_confirmed_at - escrow.created_at) as u32
    } else {
        0
    };

    update_reputation(&mut ctx.accounts.maker_reputation, escrow.crypto_amount, payment_time, &clock);
    update_reputation(&mut ctx.accounts.taker_reputation, escrow.crypto_amount, payment_time, &clock);

    msg!(
        "Mugen escrow released: {} to buyer | fees: P01={} Mugen={} Treasury={}",
        buyer_amount,
        p01_fee,
        mugen_fee,
        treasury_fee,
    );

    Ok(())
}

fn update_reputation(rep: &mut Account<MugenReputation>, volume: u64, payment_time: u32, clock: &Clock) {
    rep.trades_completed = rep.trades_completed.saturating_add(1);
    rep.total_volume = rep.total_volume.saturating_add(volume);
    rep.positive_feedback = rep.positive_feedback.saturating_add(1);
    rep.last_trade_at = clock.unix_timestamp;

    if rep.trades_completed > 1 {
        let prev_total = (rep.avg_payment_time as u64) * ((rep.trades_completed - 1) as u64);
        let new_total = prev_total.saturating_add(payment_time as u64);
        rep.avg_payment_time = (new_total / rep.trades_completed as u64) as u32;
    } else {
        rep.avg_payment_time = payment_time;
    }

    if rep.first_trade_at == 0 {
        rep.first_trade_at = clock.unix_timestamp;
    }
}
