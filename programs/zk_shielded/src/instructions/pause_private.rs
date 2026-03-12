use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::SubscriptionVault;
use crate::verifier::Groth16Verifier;
use crate::Groth16Proof;

/// Pause a private (ZK-based) subscription vault.
/// Requires a ZK proof of knowledge of the subscriber secret.
#[derive(Accounts)]
#[instruction(proof: Groth16Proof)]
pub struct PausePrivate<'info> {
    /// Transaction payer (can be anyone — enables relayer pattern)
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
        constraint = !vault.is_paused @ ZkShieldedError::VaultAlreadyPaused,
        constraint = vault.is_private_mode() @ ZkShieldedError::ExpectedPrivateMode
    )]
    pub vault: Account<'info, SubscriptionVault>,

    /// Subscriber ownership VK data
    /// CHECK: Validated by hash comparison + owner check
    #[account(
        constraint = subscriber_vk_data.owner == &crate::ID @ ZkShieldedError::InvalidVerificationKey
    )]
    pub subscriber_vk_data: AccountInfo<'info>,
}

pub fn handler(ctx: Context<PausePrivate>, proof: Groth16Proof) -> Result<()> {
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
    vault.is_paused = true;
    vault.pause_slot = Some(clock.slot as i64);

    emit!(PauseVaultPrivateEvent {
        vault: vault.key(),
        paused_at_slot: clock.slot as i64,
    });

    Ok(())
}

#[event]
pub struct PauseVaultPrivateEvent {
    pub vault: Pubkey,
    pub paused_at_slot: i64,
}
