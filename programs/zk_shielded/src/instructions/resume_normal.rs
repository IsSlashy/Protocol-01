use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::SubscriptionVault;

/// Resume a normal (wallet-based) subscription vault after it was paused.
/// Accumulates the paused time into total_paused_slots.
#[derive(Accounts)]
pub struct ResumeNormal<'info> {
    #[account(
        constraint = subscriber.key() == vault.subscriber_pubkey.unwrap() @ ZkShieldedError::UnauthorizedVaultSubscriber
    )]
    pub subscriber: Signer<'info>,

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
        constraint = vault.is_paused @ ZkShieldedError::VaultNotPaused,
        constraint = vault.is_normal_mode() @ ZkShieldedError::ExpectedNormalMode
    )]
    pub vault: Account<'info, SubscriptionVault>,
}

pub fn handler(ctx: Context<ResumeNormal>) -> Result<()> {
    let clock = Clock::get()?;
    let vault = &mut ctx.accounts.vault;

    let pause_slot = vault.pause_slot
        .ok_or(ZkShieldedError::VaultNotPaused)?;

    let paused_duration = (clock.slot as i64) - pause_slot;
    vault.total_paused_slots = vault
        .total_paused_slots
        .checked_add(paused_duration)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;

    vault.is_paused = false;
    vault.pause_slot = None;

    emit!(ResumeVaultEvent {
        vault: vault.key(),
        resumed_at_slot: clock.slot as i64,
        paused_duration,
        total_paused_slots: vault.total_paused_slots,
        is_private: false,
    });

    Ok(())
}

#[event]
pub struct ResumeVaultEvent {
    pub vault: Pubkey,
    pub resumed_at_slot: i64,
    pub paused_duration: i64,
    pub total_paused_slots: i64,
    pub is_private: bool,
}
