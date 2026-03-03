use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::state::SubscriptionVault;

/// Cancel a normal (wallet-based) subscription vault.
/// Refunds remaining balance to the subscriber's wallet and closes the vault.
///
/// The retailer gets any outstanding claimable periods paid first,
/// then the remaining balance goes back to the subscriber.
#[derive(Accounts)]
pub struct CancelNormal<'info> {
    /// Subscriber cancelling the vault
    #[account(
        mut,
        constraint = subscriber.key() == vault.subscriber_pubkey.unwrap() @ ZkShieldedError::UnauthorizedVaultSubscriber
    )]
    pub subscriber: Signer<'info>,

    /// Retailer receives any outstanding claimable periods
    /// CHECK: Must match vault.retailer
    #[account(
        mut,
        constraint = retailer.key() == vault.retailer @ ZkShieldedError::Unauthorized
    )]
    pub retailer: AccountInfo<'info>,

    /// Subscription vault (closed after cancellation)
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
        constraint = vault.is_normal_mode() @ ZkShieldedError::ExpectedNormalMode,
        close = subscriber
    )]
    pub vault: Account<'info, SubscriptionVault>,

    pub system_program: Program<'info, System>,

    pub token_program: Option<Program<'info, Token>>,

    /// Vault's token account (optional, only for SPL tokens)
    #[account(mut)]
    pub vault_token_account: Option<Account<'info, TokenAccount>>,

    /// Subscriber's token account (optional, only for SPL tokens)
    #[account(mut)]
    pub subscriber_token_account: Option<Account<'info, TokenAccount>>,

    /// Retailer's token account (optional, only for SPL tokens)
    #[account(mut)]
    pub retailer_token_account: Option<Account<'info, TokenAccount>>,
}

pub fn handler(ctx: Context<CancelNormal>) -> Result<()> {
    let clock = Clock::get()?;
    let vault = &ctx.accounts.vault;

    // Compute final amounts
    let claimable = vault.claimable_periods(clock.slot as i64);
    let total_owed = (vault.claimed_periods + claimable)
        .checked_mul(vault.rate)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    let retailer_amount = claimable
        .checked_mul(vault.rate)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    let refund_amount = vault.total_deposited.saturating_sub(total_owed);

    let is_native_sol = vault.token_mint == system_program::ID;

    // Build vault signer seeds
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
        // Pay retailer any outstanding periods
        if retailer_amount > 0 {
            **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= retailer_amount;
            **ctx.accounts.retailer.try_borrow_mut_lamports()? += retailer_amount;
        }
        // Refund remaining to subscriber (the close = subscriber handles remaining lamports)
        // Note: `close = subscriber` will transfer remaining lamports including refund + rent
    } else {
        let token_program = ctx.accounts.token_program
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenProgram)?;
        let vault_token = ctx.accounts.vault_token_account
            .as_ref()
            .ok_or(ZkShieldedError::MissingPoolVault)?;

        // Pay retailer any outstanding periods
        if retailer_amount > 0 {
            let retailer_token = ctx.accounts.retailer_token_account
                .as_ref()
                .ok_or(ZkShieldedError::MissingTokenAccount)?;
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
            token::transfer(transfer_ctx, retailer_amount)?;
        }

        // Refund remaining to subscriber
        if refund_amount > 0 {
            let subscriber_token = ctx.accounts.subscriber_token_account
                .as_ref()
                .ok_or(ZkShieldedError::MissingTokenAccount)?;
            require!(subscriber_token.mint == vault.token_mint, ZkShieldedError::InvalidTokenMint);

            let transfer_ctx = CpiContext::new_with_signer(
                token_program.to_account_info(),
                TokenTransfer {
                    from: vault_token.to_account_info(),
                    to: subscriber_token.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            );
            token::transfer(transfer_ctx, refund_amount)?;
        }
    }

    // vault is closed by the `close = subscriber` constraint

    emit!(CancelNormalEvent {
        vault: ctx.accounts.vault.key(),
        subscriber: ctx.accounts.subscriber.key(),
        retailer: ctx.accounts.retailer.key(),
        retailer_amount,
        refund_amount,
        slot: clock.slot as i64,
    });

    Ok(())
}

#[event]
pub struct CancelNormalEvent {
    pub vault: Pubkey,
    pub subscriber: Pubkey,
    pub retailer: Pubkey,
    pub retailer_amount: u64,
    pub refund_amount: u64,
    pub slot: i64,
}
