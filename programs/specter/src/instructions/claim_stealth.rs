use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

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

/// Verify the claim proof
///
/// In a production implementation, this would verify an Ed25519 signature
/// or a zero-knowledge proof. For the hackathon, we use a simplified check.
fn verify_claim_proof(
    proof: &[u8; 64],
    recipient_key: &[u8; 32],
    spending_key: &[u8; 32],
) -> bool {
    // Simplified verification for hackathon:
    // The proof should contain:
    // - First 32 bytes: hash of (recipient_key || spending_key)
    // - Last 32 bytes: signature component

    // For production, implement proper Ed25519 signature verification
    // or use a ZK-SNARK proof system

    // Basic validation: proof should not be all zeros
    if proof == &[0u8; 64] {
        return false;
    }

    // Verify the first part matches expected hash
    // This is a placeholder - real implementation would use proper crypto
    let mut expected_prefix = [0u8; 32];
    for i in 0..32 {
        expected_prefix[i] = recipient_key[i] ^ spending_key[i];
    }

    // Check if first 32 bytes of proof match expected prefix
    proof[..32] == expected_prefix
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_verify_claim_proof_rejects_zeros() {
        let proof = [0u8; 64];
        let recipient_key = [1u8; 32];
        let spending_key = [2u8; 32];

        assert!(!verify_claim_proof(&proof, &recipient_key, &spending_key));
    }

    #[test]
    fn test_verify_claim_proof_valid() {
        let recipient_key = [1u8; 32];
        let spending_key = [2u8; 32];

        // Create valid proof with XOR of keys in first 32 bytes
        let mut proof = [0u8; 64];
        for i in 0..32 {
            proof[i] = recipient_key[i] ^ spending_key[i];
        }
        // Fill signature component with non-zero values
        for i in 32..64 {
            proof[i] = (i as u8) + 1;
        }

        assert!(verify_claim_proof(&proof, &recipient_key, &spending_key));
    }
}
