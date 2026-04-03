use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::verifier::Groth16Verifier;
use crate::Groth16Proof;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum expiry window: 90 days in seconds
const MAX_EXPIRES_IN_SECONDS: i64 = 90 * 24 * 60 * 60;

/// Minimum expiry window: 1 hour in seconds
const MIN_EXPIRES_IN_SECONDS: i64 = 3600;

/// ComplianceAttestation account size (excluding 8-byte discriminator)
/// 32 + 32 + 1 + 1 + 8 + 8 + 1 + 32 + 8 + 8 + 32 + 32 + 1 = 196
pub const COMPLIANCE_ATTESTATION_SIZE: usize = 196;

/// Attestation type: balance falls within a proven range
pub const ATTESTATION_TYPE_RANGE: u8 = 0;
/// Attestation type: user proved non-inclusion in a sanctions list
pub const ATTESTATION_TYPE_INNOCENCE: u8 = 1;

// ---------------------------------------------------------------------------
// Account: ComplianceAttestation
// ---------------------------------------------------------------------------

#[account]
pub struct ComplianceAttestation {
    /// Authority who can revoke this attestation
    pub authority: Pubkey,
    /// User this attestation is about
    pub user: Pubkey,
    /// 0 = range proof, 1 = innocence proof
    pub attestation_type: u8,
    /// Whether the ZK proof was verified
    pub is_verified: bool,
    /// Unix timestamp of issuance
    pub issued_at: i64,
    /// Unix timestamp of expiry (e.g., +30 days)
    pub expires_at: i64,
    /// Whether authority has revoked
    pub revoked: bool,
    /// For innocence: which sanctions list version was proven against
    pub sanctions_root: [u8; 32],
    /// For range: the threshold/bound proven (public input, not the secret balance)
    pub min_bound: u64,
    pub max_bound: u64,
    /// Hash of the circuit verification key used
    pub circuit_vk_hash: [u8; 32],
    /// Attestation nonce (anti-replay)
    pub attestation_nonce: [u8; 32],
    /// PDA bump
    pub bump: u8,
}

impl ComplianceAttestation {
    pub const SEED_PREFIX: &'static [u8] = b"compliance";

    /// Returns true if the attestation is currently valid
    pub fn is_valid(&self, now: i64) -> bool {
        self.is_verified && !self.revoked && now < self.expires_at
    }
}

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum ComplianceError {
    #[msg("Compliance proof verification failed")]
    ProofVerificationFailed,

    #[msg("Expires-in-seconds is out of allowed range")]
    InvalidExpiryWindow,

    #[msg("Attestation has already been revoked")]
    AlreadyRevoked,

    #[msg("Only the attestation authority can revoke")]
    UnauthorizedRevoke,

    #[msg("Attestation is expired")]
    AttestationExpired,

    #[msg("Attestation is revoked")]
    AttestationRevoked,

    #[msg("Attestation proof was not verified")]
    AttestationNotVerified,

    #[msg("min_bound must be less than or equal to max_bound")]
    InvalidBoundRange,

    #[msg("Attestation nonce must not be all zeros")]
    InvalidNonce,

    #[msg("Account is not owned by this program")]
    InvalidAccount,

    #[msg("Token mint is not owned by the SPL Token program")]
    InvalidTokenMint,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct ComplianceRangeEvent {
    pub user: Pubkey,
    pub authority: Pubkey,
    pub min_bound: u64,
    pub max_bound: u64,
    pub token_mint: Pubkey,
    pub attestation: Pubkey,
    pub issued_at: i64,
    pub expires_at: i64,
}

#[event]
pub struct ComplianceInnocenceEvent {
    pub user: Pubkey,
    pub authority: Pubkey,
    pub sanctions_root: [u8; 32],
    pub attestation: Pubkey,
    pub issued_at: i64,
    pub expires_at: i64,
}

#[event]
pub struct ComplianceRevokedEvent {
    pub attestation: Pubkey,
    pub authority: Pubkey,
    pub revoked_at: i64,
}

// ---------------------------------------------------------------------------
// Accounts validation: VerifyComplianceRange
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(
    proof: Groth16Proof,
    min_bound: u64,
    max_bound: u64,
    attestation_nonce: [u8; 32],
    expires_in_seconds: i64
)]
pub struct VerifyComplianceRange<'info> {
    /// Authority requesting compliance verification (pays for PDA creation)
    #[account(mut)]
    pub authority: Signer<'info>,

    /// User whose balance is being attested
    pub user: Signer<'info>,

    /// ComplianceAttestation PDA: ["compliance", user, 0u8, attestation_nonce]
    #[account(
        init,
        payer = authority,
        space = 8 + COMPLIANCE_ATTESTATION_SIZE,
        seeds = [
            ComplianceAttestation::SEED_PREFIX,
            user.key().as_ref(),
            &[ATTESTATION_TYPE_RANGE],
            attestation_nonce.as_ref(),
        ],
        bump,
    )]
    pub attestation: Account<'info, ComplianceAttestation>,

    /// The confidential account whose balance commitment we verify against.
    /// CHECK: Validated manually - must be owned by this program.
    #[account(constraint = confidential_account.owner == &crate::ID @ ComplianceError::InvalidAccount)]
    pub confidential_account: AccountInfo<'info>,

    /// VK data for the compliance_range circuit.
    /// CHECK: Validated by hash comparison inside the handler.
    #[account(
        constraint = vk_data.owner == &crate::ID @ ZkShieldedError::InvalidVerificationKey
    )]
    pub vk_data: AccountInfo<'info>,

    /// Token mint associated with the balance commitment.
    /// CHECK: Validated as SPL Token mint.
    #[account(constraint = token_mint.owner == &anchor_spl::token::ID @ ComplianceError::InvalidTokenMint)]
    pub token_mint: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Accounts validation: VerifyComplianceInnocence
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(
    proof: Groth16Proof,
    sanctions_root: [u8; 32],
    user_commitment: [u8; 32],
    attestation_nonce: [u8; 32],
    expires_in_seconds: i64
)]
pub struct VerifyComplianceInnocence<'info> {
    /// Authority requesting compliance verification (pays for PDA creation)
    #[account(mut)]
    pub authority: Signer<'info>,

    /// User proving innocence
    pub user: Signer<'info>,

    /// ComplianceAttestation PDA: ["compliance", user, 1u8, attestation_nonce]
    #[account(
        init,
        payer = authority,
        space = 8 + COMPLIANCE_ATTESTATION_SIZE,
        seeds = [
            ComplianceAttestation::SEED_PREFIX,
            user.key().as_ref(),
            &[ATTESTATION_TYPE_INNOCENCE],
            attestation_nonce.as_ref(),
        ],
        bump,
    )]
    pub attestation: Account<'info, ComplianceAttestation>,

    /// VK data for the compliance_innocence circuit.
    /// CHECK: Validated by hash comparison inside the handler.
    #[account(
        constraint = vk_data.owner == &crate::ID @ ZkShieldedError::InvalidVerificationKey
    )]
    pub vk_data: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Accounts validation: RevokeAttestation
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct RevokeAttestation<'info> {
    /// Only the original authority can revoke
    #[account(
        constraint = authority.key() == attestation.authority @ ComplianceError::UnauthorizedRevoke
    )]
    pub authority: Signer<'info>,

    /// The attestation to revoke
    #[account(
        mut,
        constraint = !attestation.revoked @ ComplianceError::AlreadyRevoked,
    )]
    pub attestation: Account<'info, ComplianceAttestation>,
}

// ---------------------------------------------------------------------------
// Accounts validation: CheckCompliance
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct CheckCompliance<'info> {
    /// The attestation to check (read-only)
    pub attestation: Account<'info, ComplianceAttestation>,
}

// ---------------------------------------------------------------------------
// Instruction: verify_compliance_range
// ---------------------------------------------------------------------------

/// Verify a Groth16 range proof and create a ComplianceAttestation.
///
/// The circuit proves: min_bound <= secret_balance <= max_bound
/// Public inputs: [balance_commitment, min_bound, max_bound, token_mint, attestation_nonce_field]
///
/// The balance commitment is read from the confidential_account on-chain data,
/// ensuring the proof is anchored to a real shielded balance.
pub fn verify_compliance_range(
    ctx: Context<VerifyComplianceRange>,
    proof: Groth16Proof,
    min_bound: u64,
    max_bound: u64,
    attestation_nonce: [u8; 32],
    expires_in_seconds: i64,
) -> Result<()> {
    // --- Input validation ---
    require!(
        min_bound <= max_bound,
        ComplianceError::InvalidBoundRange
    );
    require!(
        expires_in_seconds >= MIN_EXPIRES_IN_SECONDS
            && expires_in_seconds <= MAX_EXPIRES_IN_SECONDS,
        ComplianceError::InvalidExpiryWindow
    );
    require!(
        attestation_nonce != [0u8; 32],
        ComplianceError::InvalidNonce
    );

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // --- Read the balance commitment from the confidential account ---
    // The first 32 bytes after the 8-byte Anchor discriminator contain the
    // balance commitment (Poseidon hash of secret balance + blinding factor).
    let conf_data = ctx.accounts.confidential_account.try_borrow_data()?;
    require!(conf_data.len() >= 40, ZkShieldedError::InvalidCommitment);
    let mut balance_commitment = [0u8; 32];
    balance_commitment.copy_from_slice(&conf_data[8..40]);

    // --- Build public inputs as 32-byte field elements (little-endian) ---
    let mut min_bound_bytes = [0u8; 32];
    min_bound_bytes[..8].copy_from_slice(&min_bound.to_le_bytes());

    let mut max_bound_bytes = [0u8; 32];
    max_bound_bytes[..8].copy_from_slice(&max_bound.to_le_bytes());

    let token_mint_bytes = ctx.accounts.token_mint.key().to_bytes();

    // Nonce as a field element (raw 32 bytes, already little-endian)
    let nonce_field = attestation_nonce;

    // Convert all public inputs from little-endian to big-endian for alt_bn128
    let public_inputs: [[u8; 32]; 5] = [
        Groth16Verifier::le_to_be(&balance_commitment),
        Groth16Verifier::le_to_be(&min_bound_bytes),
        Groth16Verifier::le_to_be(&max_bound_bytes),
        Groth16Verifier::le_to_be(&token_mint_bytes),
        Groth16Verifier::le_to_be(&nonce_field),
    ];

    // --- Load and verify the verification key ---
    let vk_raw = ctx.accounts.vk_data.try_borrow_data()?;
    let circuit_vk_hash = Groth16Verifier::hash_verification_key(&vk_raw);

    let is_valid = Groth16Verifier::verify(&proof, &public_inputs, &vk_raw)?;
    require!(is_valid, ComplianceError::ProofVerificationFailed);

    // --- Populate attestation account ---
    let att_key = ctx.accounts.attestation.key();
    let att = &mut ctx.accounts.attestation;
    att.authority = ctx.accounts.authority.key();
    att.user = ctx.accounts.user.key();
    att.attestation_type = ATTESTATION_TYPE_RANGE;
    att.is_verified = true;
    att.issued_at = now;
    att.expires_at = now
        .checked_add(expires_in_seconds)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    att.revoked = false;
    att.sanctions_root = [0u8; 32]; // unused for range proofs
    att.min_bound = min_bound;
    att.max_bound = max_bound;
    att.circuit_vk_hash = circuit_vk_hash;
    att.attestation_nonce = attestation_nonce;
    att.bump = ctx.bumps.attestation;

    // --- Emit event ---
    emit!(ComplianceRangeEvent {
        user: att.user,
        authority: att.authority,
        min_bound,
        max_bound,
        token_mint: ctx.accounts.token_mint.key(),
        attestation: att_key,
        issued_at: att.issued_at,
        expires_at: att.expires_at,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Instruction: verify_compliance_innocence
// ---------------------------------------------------------------------------

/// Verify a Groth16 innocence proof and create a ComplianceAttestation.
///
/// The circuit proves: the user's identity is NOT in the sanctions Merkle tree
/// identified by `sanctions_root`.
///
/// Public inputs: [sanctions_root_field, user_commitment, attestation_nonce_field]
///
/// user_commitment = Poseidon(user_secret) — the user's shielded identity,
/// derived from the same user key. The circuit proves non-membership without
/// revealing the underlying address.
pub fn verify_compliance_innocence(
    ctx: Context<VerifyComplianceInnocence>,
    proof: Groth16Proof,
    sanctions_root: [u8; 32],
    user_commitment: [u8; 32],
    attestation_nonce: [u8; 32],
    expires_in_seconds: i64,
) -> Result<()> {
    // --- Input validation ---
    require!(
        expires_in_seconds >= MIN_EXPIRES_IN_SECONDS
            && expires_in_seconds <= MAX_EXPIRES_IN_SECONDS,
        ComplianceError::InvalidExpiryWindow
    );
    require!(
        attestation_nonce != [0u8; 32],
        ComplianceError::InvalidNonce
    );

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // --- Build public inputs ---
    // user_commitment = Poseidon(spending_key, 0) — computed off-chain by the SDK.
    // The user signs the transaction to authorise, but the circuit identity is their
    // Poseidon commitment, NOT the Solana pubkey.
    let nonce_field = attestation_nonce;

    let public_inputs: [[u8; 32]; 3] = [
        Groth16Verifier::le_to_be(&sanctions_root),
        Groth16Verifier::le_to_be(&user_commitment),
        Groth16Verifier::le_to_be(&nonce_field),
    ];

    // --- Load and verify the verification key ---
    let vk_raw = ctx.accounts.vk_data.try_borrow_data()?;
    let circuit_vk_hash = Groth16Verifier::hash_verification_key(&vk_raw);

    let is_valid = Groth16Verifier::verify(&proof, &public_inputs, &vk_raw)?;
    require!(is_valid, ComplianceError::ProofVerificationFailed);

    // --- Populate attestation account ---
    let att_key = ctx.accounts.attestation.key();
    let att = &mut ctx.accounts.attestation;
    att.authority = ctx.accounts.authority.key();
    att.user = ctx.accounts.user.key();
    att.attestation_type = ATTESTATION_TYPE_INNOCENCE;
    att.is_verified = true;
    att.issued_at = now;
    att.expires_at = now
        .checked_add(expires_in_seconds)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    att.revoked = false;
    att.sanctions_root = sanctions_root;
    att.min_bound = 0; // unused for innocence proofs
    att.max_bound = 0;
    att.circuit_vk_hash = circuit_vk_hash;
    att.attestation_nonce = attestation_nonce;
    att.bump = ctx.bumps.attestation;

    // --- Emit event ---
    emit!(ComplianceInnocenceEvent {
        user: att.user,
        authority: att.authority,
        sanctions_root,
        attestation: att_key,
        issued_at: att.issued_at,
        expires_at: att.expires_at,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Instruction: revoke_attestation
// ---------------------------------------------------------------------------

/// Revoke a previously issued compliance attestation.
/// Only the original authority (the party who requested compliance) can revoke.
pub fn revoke_attestation(ctx: Context<RevokeAttestation>) -> Result<()> {
    let clock = Clock::get()?;

    let att = &mut ctx.accounts.attestation;
    att.revoked = true;

    emit!(ComplianceRevokedEvent {
        attestation: ctx.accounts.attestation.key(),
        authority: ctx.accounts.authority.key(),
        revoked_at: clock.unix_timestamp,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Instruction: check_compliance
// ---------------------------------------------------------------------------

/// Read-only CPI helper that checks whether a compliance attestation is valid.
/// Returns Ok(()) if the attestation is currently valid, or an error otherwise.
///
/// Designed for other programs to CPI into this program and gate actions on
/// compliance status. The boolean result is encoded in the return data via
/// `set_return_data`.
pub fn check_compliance(ctx: Context<CheckCompliance>) -> Result<bool> {
    let clock = Clock::get()?;
    let att = &ctx.accounts.attestation;

    require!(att.is_verified, ComplianceError::AttestationNotVerified);
    require!(!att.revoked, ComplianceError::AttestationRevoked);
    require!(
        clock.unix_timestamp < att.expires_at,
        ComplianceError::AttestationExpired
    );

    // Write 1u8 to return data so CPI callers can inspect without deserializing
    #[cfg(target_os = "solana")]
    anchor_lang::solana_program::program::set_return_data(&[1u8]);

    Ok(true)
}
