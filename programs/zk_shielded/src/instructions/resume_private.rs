use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::SubscriptionVault;
use crate::verifier::Groth16Verifier;
use crate::Groth16Proof;

/// Resume a private (ZK-based) subscription vault after it was paused.
/// Requires a ZK proof of knowledge of the subscriber secret.
#[derive(Accounts)]
#[instruction(proof: Groth16Proof)]
pub struct ResumePrivate<'info> {
    pub payer: Signer<'info>,

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
        constraint = vault.is_private_mode() @ ZkShieldedError::ExpectedPrivateMode
    )]
    pub vault: Account<'info, SubscriptionVault>,

    /// Subscriber ownership VK data
    /// CHECK: Validated by hash comparison
    pub subscriber_vk_data: AccountInfo<'info>,
}

pub fn handler(ctx: Context<ResumePrivate>, proof: Groth16Proof) -> Result<()> {
    let clock = Clock::get()?;
    let vault = &ctx.accounts.vault;

    let commitment = vault.subscriber_commitment
        .ok_or(ZkShieldedError::ExpectedPrivateMode)?;

    // Load and validate subscriber ownership VK
    let vk_data = ctx.accounts.subscriber_vk_data.try_borrow_data()?;
    let computed_vk_hash = Groth16Verifier::hash_verification_key(&vk_data);
    require!(
        computed_vk_hash == vault.vk_hash_subscriber,
        ZkShieldedError::InvalidVerificationKey
    );

    // Verify subscriber ownership proof
    let is_valid = Groth16Verifier::verify_subscriber_ownership(
        &proof,
        &commitment,
        &vk_data,
    )?;
    require!(is_valid, ZkShieldedError::InvalidProof);

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

    emit!(ResumeVaultPrivateEvent {
        vault: vault.key(),
        resumed_at_slot: clock.slot as i64,
        paused_duration,
        total_paused_slots: vault.total_paused_slots,
    });

    Ok(())
}

#[event]
pub struct ResumeVaultPrivateEvent {
    pub vault: Pubkey,
    pub resumed_at_slot: i64,
    pub paused_duration: i64,
    pub total_paused_slots: i64,
}
