use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::SubscriptionVault;

/// Pause a normal (wallet-based) subscription vault.
/// Requires the subscriber's wallet signature.
/// While paused, no periods accrue for the retailer.
#[derive(Accounts)]
pub struct PauseNormal<'info> {
    /// Subscriber pausing the vault
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
        constraint = !vault.is_paused @ ZkShieldedError::VaultAlreadyPaused,
        constraint = vault.is_normal_mode() @ ZkShieldedError::ExpectedNormalMode
    )]
    pub vault: Account<'info, SubscriptionVault>,
}

pub fn handler(ctx: Context<PauseNormal>) -> Result<()> {
    let clock = Clock::get()?;
    let vault = &mut ctx.accounts.vault;

    vault.is_paused = true;
    vault.pause_slot = Some(clock.slot as i64);

    emit!(PauseVaultEvent {
        vault: vault.key(),
        paused_at_slot: clock.slot as i64,
        is_private: false,
    });

    Ok(())
}

#[event]
pub struct PauseVaultEvent {
    pub vault: Pubkey,
    pub paused_at_slot: i64,
    pub is_private: bool,
}
