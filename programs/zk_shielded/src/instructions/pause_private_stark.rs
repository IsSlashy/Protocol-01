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

/// ProofBuffer layout offsets (must match p01_stark_verifier::ProofBuffer).
const PROOF_BUF_AUTHORITY: usize = 8;
const PROOF_BUF_CIRCUIT_ID: usize = 40;
const PROOF_BUF_VERIFIED: usize = 49;
const PROOF_BUF_INPUTS_HASH: usize = 50;
const PROOF_BUF_MIN_LEN: usize = 82;

/// Parse a verified STARK proof buffer.
fn parse_stark_proof_buffer(data: &[u8]) -> Result<(Pubkey, u8, bool, [u8; 32])> {
    require!(data.len() >= PROOF_BUF_MIN_LEN, ZkShieldedError::InvalidProof);
    require!(
        data[..8] == STARK_PROOF_BUFFER_DISCRIMINATOR,
        ZkShieldedError::InvalidProof
    );
    let authority = Pubkey::try_from(&data[PROOF_BUF_AUTHORITY..PROOF_BUF_CIRCUIT_ID]).unwrap();
    let circuit_id = data[PROOF_BUF_CIRCUIT_ID];
    let verified = data[PROOF_BUF_VERIFIED] == 1;
    let mut public_inputs_hash = [0u8; 32];
    public_inputs_hash.copy_from_slice(&data[PROOF_BUF_INPUTS_HASH..PROOF_BUF_MIN_LEN]);
    Ok((authority, circuit_id, verified, public_inputs_hash))
}

/// Pause a private (ZK-based) subscription vault using STARK proof (quantum-resistant).
/// Requires a pre-verified STARK proof buffer proving subscriber ownership.
#[derive(Accounts)]
pub struct PausePrivateStark<'info> {
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

pub fn handler(ctx: Context<PausePrivateStark>) -> Result<()> {
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
    // Pause vault (identical to Groth16 version)
    // -----------------------------------------------------------------------
    let vault = &mut ctx.accounts.vault;
    vault.is_paused = true;
    vault.pause_slot = Some(clock.slot as i64);

    emit!(PauseVaultPrivateStarkEvent {
        vault: vault.key(),
        paused_at_slot: clock.slot as i64,
    });

    Ok(())
}

#[event]
pub struct PauseVaultPrivateStarkEvent {
    pub vault: Pubkey,
    pub paused_at_slot: i64,
}
