use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::SubscriptionVault;

/// STARK Proof Buffer account layout (from p01_stark_verifier).
/// We read this account to check that a STARK proof was verified.
const STARK_PROOF_BUFFER_DISCRIMINATOR: [u8; 8] = [71, 133, 225, 94, 9, 130, 40, 161];

// DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs
const STARK_VERIFIER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0xb6, 0x47, 0x0c, 0x5e, 0xb3, 0x56, 0x43, 0x7f,
    0xef, 0xf9, 0x2e, 0xd1, 0x86, 0x9b, 0x02, 0x2b,
    0xc4, 0x60, 0x2e, 0x12, 0xb1, 0x13, 0x07, 0x44,
    0xb3, 0x7a, 0x18, 0x7d, 0xe6, 0x39, 0xce, 0xd8,
]);

/// Parse a verified STARK proof buffer.
/// Layout: 8 disc + 32 authority + 1 circuit_id + 4 proof_size + 4 bytes_written + 1 verified + 32 public_inputs_hash
fn parse_stark_proof_buffer(data: &[u8]) -> Result<(Pubkey, u8, bool, [u8; 32])> {
    require!(data.len() >= 82, ZkShieldedError::InvalidProof);
    require!(
        data[..8] == STARK_PROOF_BUFFER_DISCRIMINATOR,
        ZkShieldedError::InvalidProof
    );
    let authority = Pubkey::try_from(&data[8..40]).unwrap();
    let circuit_id = data[40];
    let verified = data[49] == 1;
    let mut public_inputs_hash = [0u8; 32];
    public_inputs_hash.copy_from_slice(&data[50..82]);
    Ok((authority, circuit_id, verified, public_inputs_hash))
}

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
    let (authority, circuit_id, verified, stored_inputs_hash) = parse_stark_proof_buffer(&proof_data)?;

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
    // the public inputs hash against the vault commitment.
    {
        use anchor_lang::solana_program::hash::hashv;
        let commitment_u64 = u64::from_le_bytes(_commitment[..8].try_into().unwrap());
        let expected_hash = hashv(&[&commitment_u64.to_le_bytes()]).to_bytes();
        require!(
            stored_inputs_hash == expected_hash,
            ZkShieldedError::InvalidProof
        );
    }

    drop(proof_data);

    // Invalidate the proof buffer after use to prevent replay.
    // Set verified = false by writing directly to the account data.
    {
        let mut proof_data_mut = proof_info.try_borrow_mut_data()?;
        proof_data_mut[49] = 0;
    }

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
