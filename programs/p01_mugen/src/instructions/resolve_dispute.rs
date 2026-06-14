use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::errors::MugenError;
use crate::state::*;

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    /// Config authority resolves the dispute (MVP: centralized, later: MPC/DAO).
    pub authority: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.authority == authority.key() @ MugenError::UnauthorizedAuthority,
    )]
    pub config: Box<Account<'info, MugenConfig>>,

    #[account(
        mut,
        constraint = escrow.status == ESCROW_DISPUTED @ MugenError::EscrowNotDisputed,
    )]
    pub escrow: Box<Account<'info, MugenEscrow>>,

    /// The escrow vault holding the crypto.
    #[account(
        mut,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump = escrow.vault_bump,
        token::authority = escrow,
    )]
    pub escrow_vault: Box<Account<'info, TokenAccount>>,

    /// Recipient of the resolved funds (buyer or seller depending on outcome).
    /// Must match one of the token accounts bound at escrow creation — prevents
    /// an attacker from passing an arbitrary token account to siphon funds.
    #[account(
        mut,
        constraint = (
            recipient_token_account.key() == escrow.buyer_token_account ||
            recipient_token_account.key() == escrow.seller_token_account
        ) @ MugenError::UnauthorizedParticipant,
    )]
    pub recipient_token_account: Box<Account<'info, TokenAccount>>,

    /// Loser reputation PDA (gets dispute count incremented).
    #[account(
        mut,
        seeds = [REPUTATION_SEED, loser_reputation.commitment.as_ref()],
        bump = loser_reputation.bump,
    )]
    pub loser_reputation: Box<Account<'info, MugenReputation>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ResolveDispute>, outcome: u8) -> Result<()> {
    require!(
        outcome == DISPUTE_RELEASE_TO_BUYER || outcome == DISPUTE_REFUND_TO_SELLER,
        MugenError::InvalidDisputeOutcome,
    );

    let escrow = &ctx.accounts.escrow;

    // Outcome must match the recipient side (buyer release vs seller refund).
    let recipient_key = ctx.accounts.recipient_token_account.key();
    match outcome {
        DISPUTE_RELEASE_TO_BUYER => require_keys_eq!(
            recipient_key,
            escrow.buyer_token_account,
            MugenError::InvalidDisputeOutcome
        ),
        DISPUTE_REFUND_TO_SELLER => require_keys_eq!(
            recipient_key,
            escrow.seller_token_account,
            MugenError::InvalidDisputeOutcome
        ),
        _ => return err!(MugenError::InvalidDisputeOutcome),
    }

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

    // Transfer full amount to resolution recipient (no fee on disputed trades)
    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.escrow_vault.to_account_info(),
            to: ctx.accounts.recipient_token_account.to_account_info(),
            authority: ctx.accounts.escrow.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(transfer_ctx, escrow.crypto_amount)?;

    // Update escrow
    let escrow = &mut ctx.accounts.escrow;
    if outcome == DISPUTE_RELEASE_TO_BUYER {
        escrow.status = ESCROW_RELEASED;
    } else {
        escrow.status = ESCROW_REFUNDED;
    }

    // Increment dispute count on the loser's reputation
    ctx.accounts.loser_reputation.trades_disputed = ctx
        .accounts
        .loser_reputation
        .trades_disputed
        .saturating_add(1);
    ctx.accounts.loser_reputation.negative_feedback = ctx
        .accounts
        .loser_reputation
        .negative_feedback
        .saturating_add(1);

    msg!(
        "Mugen dispute resolved: outcome={}, escrow={}",
        outcome,
        ctx.accounts.escrow.key(),
    );

    Ok(())
}
