use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::state::SubscriptionVault;

/// Create a normal (wallet-based) subscription vault.
/// The subscriber deposits funds from their wallet into the vault PDA.
/// The retailer can then claim periodic payments.
#[derive(Accounts)]
#[instruction(
    rate: u64,
    interval_slots: u64,
    amount: u64,
    token_mint: Pubkey,
    vk_hash_subscriber: [u8; 32],
    license_commitment: Option<[u8; 32]>
)]
pub struct SubscribeNormal<'info> {
    /// Subscriber depositing funds
    #[account(mut)]
    pub subscriber: Signer<'info>,

    /// Retailer who will receive periodic payments
    /// CHECK: Any pubkey can be a retailer
    pub retailer: AccountInfo<'info>,

    /// Subscription vault PDA
    #[account(
        init,
        payer = subscriber,
        space = SubscriptionVault::LEN,
        seeds = [
            SubscriptionVault::SEED_PREFIX,
            retailer.key().as_ref(),
            subscriber.key().as_ref(),
            token_mint.as_ref()
        ],
        bump
    )]
    pub vault: Account<'info, SubscriptionVault>,

    pub system_program: Program<'info, System>,

    /// Token program (optional, for SPL token transfers)
    pub token_program: Option<Program<'info, Token>>,

    /// Subscriber's token account (optional, only for SPL tokens)
    #[account(mut)]
    pub subscriber_token_account: Option<Account<'info, TokenAccount>>,

    /// Vault's token account (optional, only for SPL tokens)
    #[account(mut)]
    pub vault_token_account: Option<Account<'info, TokenAccount>>,
}

pub fn handler(
    ctx: Context<SubscribeNormal>,
    rate: u64,
    interval_slots: u64,
    amount: u64,
    token_mint: Pubkey,
    vk_hash_subscriber: [u8; 32],
    license_commitment: Option<[u8; 32]>,
) -> Result<()> {
    require!(rate > 0, ZkShieldedError::InvalidRate);
    require!(interval_slots > 0, ZkShieldedError::InvalidInterval);
    require!(amount > 0, ZkShieldedError::InvalidAmount);

    let clock = Clock::get()?;
    let is_native_sol = token_mint == system_program::ID;

    // Transfer funds to vault
    if is_native_sol {
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.subscriber.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, amount)?;
    } else {
        let token_program = ctx.accounts.token_program
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenProgram)?;
        let sub_token = ctx.accounts.subscriber_token_account
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenAccount)?;
        let vault_token = ctx.accounts.vault_token_account
            .as_ref()
            .ok_or(ZkShieldedError::MissingPoolVault)?;

        require!(sub_token.mint == token_mint, ZkShieldedError::InvalidTokenMint);
        require!(vault_token.mint == token_mint, ZkShieldedError::InvalidTokenMint);

        let transfer_ctx = CpiContext::new(
            token_program.to_account_info(),
            TokenTransfer {
                from: sub_token.to_account_info(),
                to: vault_token.to_account_info(),
                authority: ctx.accounts.subscriber.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, amount)?;
    }

    // Initialize vault state
    let vault = &mut ctx.accounts.vault;
    vault.subscriber_pubkey = Some(ctx.accounts.subscriber.key());
    vault.subscriber_commitment = None;
    vault.retailer = ctx.accounts.retailer.key();
    vault.token_mint = token_mint;
    vault.total_deposited = amount;
    vault.rate = rate;
    vault.interval_slots = interval_slots;
    vault.start_slot = clock.slot as i64;
    vault.claimed_periods = 0;
    vault.is_active = true;
    vault.is_paused = false;
    vault.pause_slot = None;
    vault.total_paused_slots = 0;
    vault.vk_hash_subscriber = vk_hash_subscriber;
    vault.source_pool = None;
    vault.bump = ctx.bumps.vault;
    vault.license_commitment = license_commitment;

    emit!(SubscribeNormalEvent {
        vault: vault.key(),
        subscriber: ctx.accounts.subscriber.key(),
        retailer: ctx.accounts.retailer.key(),
        token_mint,
        amount,
        rate,
        interval_slots,
        start_slot: clock.slot as i64,
    });

    Ok(())
}

#[event]
pub struct SubscribeNormalEvent {
    pub vault: Pubkey,
    pub subscriber: Pubkey,
    pub retailer: Pubkey,
    pub token_mint: Pubkey,
    pub amount: u64,
    pub rate: u64,
    pub interval_slots: u64,
    pub start_slot: i64,
}
