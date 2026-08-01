use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::state::SubscriptionVault;

/// Claim one or more accrued periods from a subscription vault, and close the
/// vault once its funding is spent.
///
/// Only the retailer can claim. Works for both normal and private vaults.
///
/// Claimable periods = floor(effective_elapsed / interval_slots) - claimed_periods
/// where effective_elapsed = current_slot - start_slot - total_paused_slots
///
/// This is the ONLY instruction that can close a `SubscriptionVault`. The two
/// cancel instructions used to be, and they are gone: a subscription is a
/// one-way prepaid envelope, so every lamport that entered the vault leaves it
/// toward the retailer and nothing returns to the subscriber. Concretely, the
/// final claim pays out
///
///   * the periods claimed in this call,
///   * the sub-period remainder `total_deposited % rate`, which never bought a
///     period and used to be the "refund",
///   * the vault's rent, and for SPL the rent of the vault token account.
///
/// A paused vault cannot be claimed and therefore cannot be closed: the
/// `!vault.is_paused` account constraint below rejects the instruction before
/// the handler runs. Pause moves WHEN the retailer is paid, never HOW MUCH, and
/// it cannot be closed out from under a subscriber who still has funding left.
#[derive(Accounts)]
pub struct ClaimPeriod<'info> {
    /// Retailer claiming the payment. Also receives the vault's rent on the
    /// final claim — the subscriber has no refund path, so the rent cannot go
    /// back to them.
    #[account(
        mut,
        constraint = retailer.key() == vault.retailer @ ZkShieldedError::Unauthorized
    )]
    pub retailer: Signer<'info>,

    /// Subscription vault. Closed by the handler on the final claim.
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

    /// Vault's token account (optional, only for SPL tokens). Closed to the
    /// retailer on the final claim so its rent is not stranded either.
    #[account(mut)]
    pub vault_token_account: Option<Account<'info, TokenAccount>>,

    /// Retailer's token account (optional, only for SPL tokens)
    #[account(mut)]
    pub retailer_token_account: Option<Account<'info, TokenAccount>>,
}

pub fn handler(ctx: Context<ClaimPeriod>) -> Result<()> {
    let clock = Clock::get()?;
    let vault = &ctx.accounts.vault;

    // All of the money arithmetic lives in `SubscriptionVault::settle`, which
    // the unit tests in `state/subscription_vault.rs` drive directly. `None`
    // means nothing accrued AND funding is still outstanding — a genuine no-op.
    //
    // A settled vault does NOT come back as `None`. Two of them reach this
    // point with nothing accruing and value still inside:
    //   * one whose funded periods were all claimed before this instruction
    //     learned how to close, leaving dust and rent behind;
    //   * one funded with less than one period's `rate`, for which
    //     `claimable_periods` is 0 from the first slot and always will be.
    // Both must be closable, or the deposit and the rent are stranded forever
    // now that no cancel instruction exists.
    let settlement = vault
        .settle(clock.slot as i64)
        .ok_or(ZkShieldedError::NoClaimablePeriods)?;

    let claimable = settlement.periods;
    let periods_after = settlement.claimed_periods_after;
    let is_final = settlement.is_final;
    let value_payout = settlement.payout;

    // Everything the retailer has not been paid yet, dust included. Re-derived
    // here so the payout is bounded by the account's own numbers rather than
    // trusted from the settlement.
    let unpaid = vault.unpaid_amount();
    require!(
        value_payout <= unpaid,
        ZkShieldedError::InsufficientVaultBalance
    );
    // A zero payout is only legitimate on the final claim of a vault that was
    // already paid out in full and just needs its rent released.
    require!(
        value_payout > 0 || is_final,
        ZkShieldedError::InsufficientVaultBalance
    );

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

    let vault_ai = ctx.accounts.vault.to_account_info();
    let retailer_ai = ctx.accounts.retailer.to_account_info();

    // Lamports the retailer receives on top of `value_payout` when the vault
    // closes: rent, plus for SPL the vault token account's rent.
    let mut rent_to_retailer: u64 = 0;
    // What actually moved as value, which for SPL is the whole token balance
    // (a donated token can only ever leave toward the retailer).
    let mut amount_moved = value_payout;

    if is_native_sol {
        let vault_lamports = vault_ai.lamports();

        if is_final {
            // `close` below moves EVERY lamport — final payout, dust and rent —
            // in one step, so there is no rent floor left to respect here.
            require!(
                vault_lamports >= value_payout,
                ZkShieldedError::InsufficientVaultBalance
            );
            rent_to_retailer = vault_lamports - value_payout;
        } else {
            let rent = Rent::get()?;
            let min_rent = rent.minimum_balance(vault_ai.data_len());
            require!(
                vault_lamports.saturating_sub(min_rent) >= value_payout,
                ZkShieldedError::InsufficientVaultBalance
            );

            **vault_ai.try_borrow_mut_lamports()? -= value_payout;
            **retailer_ai.try_borrow_mut_lamports()? += value_payout;
        }
    } else {
        let token_program = ctx
            .accounts
            .token_program
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenProgram)?;
        let vault_token = ctx
            .accounts
            .vault_token_account
            .as_ref()
            .ok_or(ZkShieldedError::MissingPoolVault)?;
        let retailer_token = ctx
            .accounts
            .retailer_token_account
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenAccount)?;

        require!(
            vault_token.mint == token_mint,
            ZkShieldedError::InvalidTokenMint
        );
        require!(
            retailer_token.mint == token_mint,
            ZkShieldedError::InvalidTokenMint
        );

        // On the final claim drain the token account outright: `close_account`
        // below requires a zero balance, and anything sitting above `unpaid`
        // has no other way out now that refunds are gone.
        if is_final {
            amount_moved = vault_token.amount;
        }

        if amount_moved > 0 {
            let transfer_ctx = CpiContext::new_with_signer(
                token_program.to_account_info(),
                TokenTransfer {
                    from: vault_token.to_account_info(),
                    to: retailer_token.to_account_info(),
                    authority: vault_ai.clone(),
                },
                signer_seeds,
            );
            token::transfer(transfer_ctx, amount_moved)?;
        }

        if is_final {
            // The vault token account's own rent would otherwise be stranded:
            // the vault PDA is its authority and nothing else can ever sign
            // for it again.
            rent_to_retailer = rent_to_retailer.saturating_add(vault_token.to_account_info().lamports());

            let close_ctx = CpiContext::new_with_signer(
                token_program.to_account_info(),
                CloseAccount {
                    account: vault_token.to_account_info(),
                    destination: retailer_ai.clone(),
                    authority: vault_ai.clone(),
                },
                signer_seeds,
            );
            token::close_account(close_ctx)?;

            rent_to_retailer = rent_to_retailer.saturating_add(vault_ai.lamports());
        }
    }

    // Update vault state. On the final claim this is bookkeeping for the event
    // only — the account is closed a few lines below and never serialized.
    let vault = &mut ctx.accounts.vault;
    vault.claimed_periods = periods_after;

    emit!(ClaimPeriodEvent {
        vault: vault.key(),
        retailer: ctx.accounts.retailer.key(),
        periods_claimed: claimable,
        amount_claimed: amount_moved,
        total_claimed_periods: vault.claimed_periods,
        slot: clock.slot as i64,
        vault_closed: is_final,
        rent_to_retailer,
    });

    if is_final {
        // Anchor's `close` moves every remaining lamport to the retailer,
        // assigns the account to the system program and truncates it. The
        // generated `exit` sees a closed account and skips serialization, so
        // the state written above is intentionally never persisted.
        ctx.accounts
            .vault
            .close(ctx.accounts.retailer.to_account_info())?;
    }

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
    // The two fields below are APPENDED, deliberately. Borsh decodes an event
    // sequentially, so inserting anything before `slot` would silently shift it
    // for every decoder built against the old layout. Appended, an old decoder
    // reads the first six fields correctly and ignores the tail.
    /// True when this claim exhausted the vault and closed it. No further
    /// claim is possible and the account no longer exists.
    pub vault_closed: bool,
    /// Lamports paid to the retailer on top of `amount_claimed` when the vault
    /// closed: the vault's rent, plus the vault token account's rent for SPL.
    pub rent_to_retailer: u64,
}
