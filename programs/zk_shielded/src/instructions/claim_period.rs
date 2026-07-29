use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::state::SubscriptionVault;

/// Claim one or more accrued periods from a subscription vault.
/// Only the retailer can claim. Works for both normal and private vaults.
///
/// Claimable periods = floor(effective_elapsed / interval_slots) - claimed_periods
/// where effective_elapsed = current_slot - start_slot - total_paused_slots
#[derive(Accounts)]
pub struct ClaimPeriod<'info> {
    /// Retailer claiming the payment
    #[account(
        mut,
        constraint = retailer.key() == vault.retailer @ ZkShieldedError::Unauthorized
    )]
    pub retailer: Signer<'info>,

    /// Subscription vault
    #[account(
        mut,
        seeds = [
            SubscriptionVault::SEED_PREFIX,
            vault.retailer.as_ref(),
            vault.subscriber_id_bytes().as_ref(),
            vault.token_mint.as_ref()
        ],
        bump = vault.bump,
        constraint = vault.is_active @ ZkShieldedError::VaultNotActive,
        constraint = !vault.is_paused @ ZkShieldedError::VaultAlreadyPaused
    )]
    pub vault: Account<'info, SubscriptionVault>,

    pub system_program: Program<'info, System>,

    /// Token program (optional, for SPL token transfers)
    pub token_program: Option<Program<'info, Token>>,

    /// Vault's token account (optional, only for SPL tokens)
    #[account(mut)]
    pub vault_token_account: Option<Account<'info, TokenAccount>>,

    /// Retailer's token account (optional, only for SPL tokens)
    #[account(mut)]
    pub retailer_token_account: Option<Account<'info, TokenAccount>>,
}

pub fn handler(ctx: Context<ClaimPeriod>) -> Result<()> {
    let clock = Clock::get()?;
    let vault = &ctx.accounts.vault;

    let claimable = vault.claimable_periods(clock.slot as i64);
    require!(claimable > 0, ZkShieldedError::NoClaimablePeriods);

    let claim_amount = claimable
        .checked_mul(vault.rate)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;

    // Clamp to available balance
    let vault_balance = vault.total_deposited
        .saturating_sub(vault.claimed_periods * vault.rate);
    let actual_amount = claim_amount.min(vault_balance);
    require!(actual_amount > 0, ZkShieldedError::InsufficientVaultBalance);

    let is_native_sol = vault.token_mint == system_program::ID;

    // Build signer seeds for vault PDA
    let retailer_key = vault.retailer;
    let subscriber_id = vault.subscriber_id_bytes();
    let token_mint = vault.token_mint;
    let bump = vault.bump;
    let seeds = &[
        SubscriptionVault::SEED_PREFIX,
        retailer_key.as_ref(),
        subscriber_id.as_ref(),
        token_mint.as_ref(),
        &[bump],
    ];
    let signer_seeds = &[&seeds[..]];

    if is_native_sol {
        let vault_lamports = ctx.accounts.vault.to_account_info().lamports();
        let rent = Rent::get()?;
        let min_rent = rent.minimum_balance(ctx.accounts.vault.to_account_info().data_len());
        require!(
            vault_lamports.saturating_sub(min_rent) >= actual_amount,
            ZkShieldedError::InsufficientVaultBalance
        );

        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= actual_amount;
        **ctx.accounts.retailer.to_account_info().try_borrow_mut_lamports()? += actual_amount;
    } else {
        let token_program = ctx.accounts.token_program
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenProgram)?;
        let vault_token = ctx.accounts.vault_token_account
            .as_ref()
            .ok_or(ZkShieldedError::MissingPoolVault)?;
        let retailer_token = ctx.accounts.retailer_token_account
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenAccount)?;

        require!(vault_token.mint == vault.token_mint, ZkShieldedError::InvalidTokenMint);
        require!(retailer_token.mint == vault.token_mint, ZkShieldedError::InvalidTokenMint);

        let transfer_ctx = CpiContext::new_with_signer(
            token_program.to_account_info(),
            TokenTransfer {
                from: vault_token.to_account_info(),
                to: retailer_token.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, actual_amount)?;
    }

    // Update vault state
    let vault = &mut ctx.accounts.vault;
    vault.claimed_periods = vault
        .claimed_periods
        .checked_add(claimable)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;

    emit!(ClaimPeriodEvent {
        vault: vault.key(),
        retailer: ctx.accounts.retailer.key(),
        periods_claimed: claimable,
        amount_claimed: actual_amount,
        total_claimed_periods: vault.claimed_periods,
        slot: clock.slot as i64,
    });

    Ok(())
}

#[event]
pub struct ClaimPeriodEvent {
    pub vault: Pubkey,
    pub retailer: Pubkey,
    pub periods_claimed: u64,
    pub amount_claimed: u64,
    pub total_claimed_periods: u64,
    pub slot: i64,
}
