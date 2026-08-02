use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::stark_buffer::{
    parse_stark_proof_buffer, StarkProofBufferView, STARK_VERIFIER_PROGRAM_ID,
};
use crate::state::SubscriptionVault;

/// Resume a private (ZK-based) subscription vault using STARK proof (quantum-resistant).
/// Requires a pre-verified STARK proof buffer proving subscriber ownership.
#[derive(Accounts)]
pub struct ResumePrivateStark<'info> {
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

    /// STARK proof buffer from p01_stark_verifier (circuit 0: subscriber_ownership).
    /// Must be verified (verified == true) and owned by the payer.
    /// CHECK: Validated manually by reading account data and checking:
    /// - Owner is p01_stark_verifier program
    /// - Discriminator matches ProofBuffer
    /// - Authority matches payer
    /// - Circuit ID is 0 (subscriber_ownership)
    /// - Verified flag is true
    /// - Public inputs hash matches vault commitment
    /// Marked mut because we invalidate (set verified=false) after use.
    #[account(mut)]
    pub stark_proof_buffer: AccountInfo<'info>,
}

pub fn handler(ctx: Context<ResumePrivateStark>) -> Result<()> {
    let clock = Clock::get()?;

    let _commitment = ctx.accounts.vault.subscriber_commitment
        .ok_or(ZkShieldedError::ExpectedPrivateMode)?;

    // -----------------------------------------------------------------------
    // STARK proof verification (replaces Groth16 inline verify)
    // -----------------------------------------------------------------------
    let proof_info = &ctx.accounts.stark_proof_buffer;

    // Must be owned by the STARK verifier program
    require!(
        *proof_info.owner == STARK_VERIFIER_PROGRAM_ID,
        ZkShieldedError::InvalidProof
    );

    let proof_data = proof_info.try_borrow_data()?;
    // `deep_ali_verified` is deliberately not required here: this instruction
    // consumes circuit 0 (subscriber_ownership), the one circuit that still
    // runs DEEP-ALI inside phase 1, so the flag stays false on an honest
    // buffer. `circuit_id == 0` is required below and is what makes that safe.
    let StarkProofBufferView {
        authority,
        circuit_id,
        verified,
        public_inputs_hash: stored_inputs_hash,
        ..
    } = parse_stark_proof_buffer(&proof_data)?;

    // Authority must be the payer (prevents using someone else's proof)
    require!(
        authority == ctx.accounts.payer.key(),
        ZkShieldedError::InvalidProof
    );

    // Must be subscriber_ownership circuit (ID 0)
    require!(circuit_id == 0, ZkShieldedError::InvalidProof);

    // Must be verified
    require!(verified, ZkShieldedError::InvalidProof);

    // Verify the proof was generated for THIS vault's commitment by checking
    // the public inputs hash. The STARK verifier v1 stores sha256(commitment_u64_le).
    // The vault's subscriber_commitment [u8; 32] stores the Goldilocks u64 in bytes 0..8.
    {
        let commitment_u64 = u64::from_le_bytes(_commitment[..8].try_into().unwrap());
        let commitment_bytes = commitment_u64.to_le_bytes();
        let expected_hash = solana_sha256_hasher::hashv(&[&commitment_bytes]).to_bytes();
        require!(
            stored_inputs_hash == expected_hash,
            ZkShieldedError::InvalidProof
        );
    }

    drop(proof_data);

    // NOTE: Replay prevention handled by vault state. Proof buffer owned by
    // p01_stark_verifier — cannot write to it from zk_shielded. Caller closes it.

    // -----------------------------------------------------------------------
    // Resume vault (identical to Groth16 version)
    // -----------------------------------------------------------------------
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

    emit!(ResumeVaultPrivateStarkEvent {
        vault: vault.key(),
        resumed_at_slot: clock.slot as i64,
        paused_duration,
        total_paused_slots: vault.total_paused_slots,
    });

    Ok(())
}

#[event]
pub struct ResumeVaultPrivateStarkEvent {
    pub vault: Pubkey,
    pub resumed_at_slot: i64,
    pub paused_duration: i64,
    pub total_paused_slots: i64,
}
