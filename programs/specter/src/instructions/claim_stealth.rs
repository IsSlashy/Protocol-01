use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash as sha256;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use ed25519_dalek::{Signature, VerifyingKey};

use crate::errors::P01Error;
use crate::state::{P01Wallet, StealthAccount};

/// Claim a stealth payment by providing proof of ownership
///
/// The recipient must prove they own the private key corresponding to
/// the stealth address by providing a valid signature/proof.
#[derive(Accounts)]
pub struct ClaimStealth<'info> {
    /// The claimer of the payment
    #[account(mut)]
    pub claimer: Signer<'info>,

    /// Claimer's Protocol 01 wallet (verifies ownership)
    #[account(
        seeds = [P01Wallet::SEED_PREFIX, claimer.key().as_ref()],
        bump = claimer_wallet.bump,
        constraint = claimer_wallet.owner == claimer.key() @ P01Error::UnauthorizedWalletAccess
    )]
    pub claimer_wallet: Account<'info, P01Wallet>,

    /// The stealth account being claimed
    #[account(
        mut,
        seeds = [StealthAccount::SEED_PREFIX, &stealth_account.recipient_key],
        bump = stealth_account.bump,
        constraint = !stealth_account.claimed @ P01Error::StealthAlreadyClaimed
    )]
    pub stealth_account: Account<'info, StealthAccount>,

    /// Escrow token account holding the funds
    #[account(
        mut,
        constraint = escrow_token_account.mint == stealth_account.token_mint @ P01Error::InvalidTokenMint
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    /// Claimer's token account (destination for funds)
    #[account(
        mut,
        constraint = claimer_token_account.owner == claimer.key() @ P01Error::UnauthorizedWalletAccess,
        constraint = claimer_token_account.mint == stealth_account.token_mint @ P01Error::InvalidTokenMint
    )]
    pub claimer_token_account: Account<'info, TokenAccount>,

    /// Escrow authority PDA
    /// CHECK: PDA authority for escrow
    #[account(
        seeds = [b"escrow_authority", stealth_account.key().as_ref()],
        bump
    )]
    pub escrow_authority: AccountInfo<'info>,

    /// Token program
    pub token_program: Program<'info, Token>,

    /// System program
    pub system_program: Program<'info, System>,
}

/// Handler for claim_stealth instruction
pub fn handler(ctx: Context<ClaimStealth>, proof: [u8; 64]) -> Result<()> {
    let stealth_account = &ctx.accounts.stealth_account;
    let claimer_wallet = &ctx.accounts.claimer_wallet;

    // Get current timestamp
    let clock = Clock::get()?;
    let current_time = clock.unix_timestamp;

    // Check if payment has expired
    if stealth_account.is_expired(current_time) {
        return Err(P01Error::StealthPaymentExpired.into());
    }

    // Verify the claim proof
    // The proof should be a signature over the stealth_account pubkey
    // using the claimer's spending key
    if !verify_claim_proof(&proof, &stealth_account.recipient_key, &claimer_wallet.spending_key) {
        return Err(P01Error::InvalidClaimProof.into());
    }

    // Get the amount from escrow
    let amount = ctx.accounts.escrow_token_account.amount;

    // Create signer seeds for escrow authority PDA
    let stealth_key = ctx.accounts.stealth_account.key();
    let authority_bump = ctx.bumps.escrow_authority;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"escrow_authority",
        stealth_key.as_ref(),
        &[authority_bump],
    ]];

    // Transfer tokens from escrow to claimer
    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.escrow_token_account.to_account_info(),
            to: ctx.accounts.claimer_token_account.to_account_info(),
            authority: ctx.accounts.escrow_authority.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(transfer_ctx, amount)?;

    // Mark stealth account as claimed
    let stealth_account = &mut ctx.accounts.stealth_account;
    stealth_account.mark_claimed();

    msg!("Stealth payment claimed successfully");
    msg!("Amount: {}", amount);
    msg!("Claimer: {}", ctx.accounts.claimer.key());

    Ok(())
}

/// Domain separator for v1 claim proofs to prevent cross-context replay.
const CLAIM_DOMAIN_V1: &[u8] = b"p01:claim:v1";

/// Build the challenge message that the claimer must sign.
///
/// challenge = SHA-256(domain || stealth_address || spending_key)
///
/// The stealth address (recipient_key) binds the proof to this specific
/// payment, while the spending key binds it to the claimer's on-chain
/// wallet. The domain separator prevents cross-version replay.
fn build_claim_challenge_v1(
    recipient_key: &[u8; 32],
    spending_key: &[u8; 32],
) -> [u8; 32] {
    let mut data = Vec::with_capacity(CLAIM_DOMAIN_V1.len() + 64);
    data.extend_from_slice(CLAIM_DOMAIN_V1);
    data.extend_from_slice(recipient_key);
    data.extend_from_slice(spending_key);
    sha256(&data).to_bytes()
}

/// Verify the claim proof using Ed25519 signature verification.
///
/// The claimer proves ownership of the stealth private key by signing a
/// deterministic challenge derived from the stealth address and spending
/// key. The 64-byte proof is an Ed25519 signature verified against the
/// `recipient_key` (stealth public key).
fn verify_claim_proof(
    proof: &[u8; 64],
    recipient_key: &[u8; 32],
    spending_key: &[u8; 32],
) -> bool {
    // Parse the stealth public key (recipient_key IS the Ed25519 public key)
    let verifying_key = match VerifyingKey::from_bytes(recipient_key) {
        Ok(k) => k,
        Err(_) => return false,
    };

    // Parse the 64-byte proof as an Ed25519 signature
    let signature = Signature::from_bytes(proof);

    // Reconstruct the challenge the claimer should have signed
    let challenge = build_claim_challenge_v1(recipient_key, spending_key);

    // Verify: signature over challenge, checked against stealth public key
    verifying_key.verify_strict(&challenge, &signature).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn test_verify_claim_proof_rejects_zeros() {
        let proof = [0u8; 64];
        let recipient_key = [1u8; 32];
        let spending_key = [2u8; 32];

        assert!(!verify_claim_proof(&proof, &recipient_key, &spending_key));
    }

    #[test]
    fn test_verify_claim_proof_valid() {
        // Generate a real Ed25519 keypair (simulates the stealth keypair)
        let signing_key = SigningKey::from_bytes(&[42u8; 32]);
        let recipient_key: [u8; 32] = signing_key.verifying_key().to_bytes();
        let spending_key = [0xCDu8; 32];

        // Build the challenge and sign it
        let challenge = build_claim_challenge_v1(&recipient_key, &spending_key);
        let signature = signing_key.sign(&challenge);
        let proof: [u8; 64] = signature.to_bytes();

        assert!(verify_claim_proof(&proof, &recipient_key, &spending_key));
    }

    #[test]
    fn test_verify_claim_proof_rejects_wrong_key() {
        // Sign with one key, verify against a different stealth address
        let signing_key = SigningKey::from_bytes(&[42u8; 32]);
        let wrong_recipient_key = [0xAAu8; 32]; // not the signing key's pubkey
        let spending_key = [0xCDu8; 32];

        let challenge = build_claim_challenge_v1(&wrong_recipient_key, &spending_key);
        let signature = signing_key.sign(&challenge);
        let proof: [u8; 64] = signature.to_bytes();

        assert!(!verify_claim_proof(&proof, &wrong_recipient_key, &spending_key));
    }

    #[test]
    fn test_verify_claim_proof_rejects_wrong_spending_key() {
        let signing_key = SigningKey::from_bytes(&[42u8; 32]);
        let recipient_key: [u8; 32] = signing_key.verifying_key().to_bytes();
        let spending_key = [0xCDu8; 32];
        let wrong_spending_key = [0xEEu8; 32];

        // Sign with correct spending_key
        let challenge = build_claim_challenge_v1(&recipient_key, &spending_key);
        let signature = signing_key.sign(&challenge);
        let proof: [u8; 64] = signature.to_bytes();

        // Verify with wrong spending_key — should fail
        assert!(!verify_claim_proof(&proof, &recipient_key, &wrong_spending_key));
    }
}
