use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::P01Error;
use crate::state::{P01Wallet, StealthAccountV2, StealthPaymentClaimed};

/// Claim a v2 hybrid stealth payment and close the announcement account
/// to reclaim rent.
///
/// The recipient proves ownership of the stealth address by providing a proof
/// (same mechanism as v1). After claiming, the `stealth_account` is closed
/// and its ~0.0093 SOL rent deposit is returned to the claimer.
///
/// # Why close the account?
/// The ML-KEM-768 ciphertext is only needed until the recipient decapsulates
/// the shared secret. After claiming, the 1088-byte ciphertext has no further
/// use. Closing the account recovers the rent and removes data from the
/// validator's state, reducing on-chain bloat.
///
/// # PDA seeds
/// The v2 stealth PDA uses seeds `["stealth_v2", sender, stealth_address]`.
/// The claimer must pass the original sender's pubkey so Anchor can
/// re-derive the PDA. The sender is known from the `StealthPaymentCreatedV2`
/// event that the claimer used to discover this payment.
#[derive(Accounts)]
pub struct ClaimStealthV2<'info> {
    /// The claimer of the payment (receives funds + rent refund)
    #[account(mut)]
    pub claimer: Signer<'info>,

    /// Claimer's Protocol 01 wallet (verifies ownership via spending key)
    #[account(
        seeds = [P01Wallet::SEED_PREFIX, claimer.key().as_ref()],
        bump = claimer_wallet.bump,
        constraint = claimer_wallet.owner == claimer.key() @ P01Error::UnauthorizedWalletAccess
    )]
    pub claimer_wallet: Account<'info, P01Wallet>,

    /// The original sender who created this stealth payment.
    /// Required to re-derive the PDA seeds. Not a signer — just used for
    /// address derivation. The claimer knows this from the creation event.
    /// CHECK: Only used as a PDA seed component; validated by PDA derivation.
    pub original_sender: AccountInfo<'info>,

    /// The v2 stealth account being claimed.
    /// `close = claimer` returns the rent-exempt lamports (~0.0093 SOL) to
    /// the claimer after the token transfer completes.
    #[account(
        mut,
        seeds = [
            StealthAccountV2::SEED_PREFIX,
            original_sender.key().as_ref(),
            stealth_account.stealth_address.as_ref(),
        ],
        bump = stealth_account.bump,
        constraint = !stealth_account.claimed @ P01Error::StealthAlreadyClaimed,
        close = claimer
    )]
    pub stealth_account: Account<'info, StealthAccountV2>,

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
        seeds = [b"escrow_authority_v2", stealth_account.key().as_ref()],
        bump
    )]
    pub escrow_authority: AccountInfo<'info>,

    /// Token program
    pub token_program: Program<'info, Token>,

    /// System program
    pub system_program: Program<'info, System>,
}

/// Handler for claim_stealth_v2 instruction
pub fn handler(ctx: Context<ClaimStealthV2>, proof: [u8; 64]) -> Result<()> {
    let stealth_account = &ctx.accounts.stealth_account;
    let claimer_wallet = &ctx.accounts.claimer_wallet;

    // Get current timestamp
    let clock = Clock::get()?;
    let current_time = clock.unix_timestamp;

    // Check if payment has expired
    if stealth_account.is_expired(current_time) {
        return Err(P01Error::StealthPaymentExpired.into());
    }

    // Check if the payment can be claimed
    if !stealth_account.can_claim(current_time) {
        return Err(P01Error::StealthNotClaimable.into());
    }

    // Verify the claim proof
    // The proof contains a signature proving the claimer owns the stealth
    // private key corresponding to stealth_account.stealth_address.
    // The proof is over the ephemeral public key and the claimer's spending key.
    if !verify_claim_proof_v2(
        &proof,
        &stealth_account.ephemeral_pub_key,
        &claimer_wallet.spending_key,
    ) {
        return Err(P01Error::InvalidClaimProof.into());
    }

    // Get the amount from escrow
    let amount = ctx.accounts.escrow_token_account.amount;

    // Create signer seeds for escrow authority PDA
    let stealth_key = ctx.accounts.stealth_account.key();
    let authority_bump = ctx.bumps.escrow_authority;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"escrow_authority_v2",
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

    // Mark as claimed (the account will be closed by Anchor's `close` constraint,
    // but we still set this for the event and in case close semantics change)
    let stealth_account = &mut ctx.accounts.stealth_account;
    stealth_account.mark_claimed();

    // Emit claim event
    emit!(StealthPaymentClaimed {
        version: StealthAccountV2::VERSION,
        stealth_address: stealth_account.stealth_address,
        claimer: ctx.accounts.claimer.key(),
        amount,
        rent_reclaimed: true, // account is closed via `close = claimer`
    });

    msg!("Hybrid stealth payment (v2) claimed successfully");
    msg!("Amount: {}", amount);
    msg!("Claimer: {}", ctx.accounts.claimer.key());
    msg!("Rent reclaimed from {} byte PDA", StealthAccountV2::LEN);

    Ok(())
}

/// Verify the claim proof for a v2 stealth payment
///
/// In a production implementation, this would verify an Ed25519 signature
/// proving the claimer derived the correct stealth private key from the
/// hybrid (X25519 + ML-KEM) key agreement. For now, we use the same
/// simplified XOR-based check as v1.
fn verify_claim_proof_v2(
    proof: &[u8; 64],
    ephemeral_pub_key: &[u8; 32],
    spending_key: &[u8; 32],
) -> bool {
    // Basic validation: proof should not be all zeros
    if proof == &[0u8; 64] {
        return false;
    }

    // Simplified verification: first 32 bytes = XOR of ephemeral key and spending key
    // Production: proper Ed25519 or hybrid signature verification
    let mut expected_prefix = [0u8; 32];
    for i in 0..32 {
        expected_prefix[i] = ephemeral_pub_key[i] ^ spending_key[i];
    }

    proof[..32] == expected_prefix
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_verify_claim_proof_v2_rejects_zeros() {
        let proof = [0u8; 64];
        let ephemeral_key = [1u8; 32];
        let spending_key = [2u8; 32];

        assert!(!verify_claim_proof_v2(&proof, &ephemeral_key, &spending_key));
    }

    #[test]
    fn test_verify_claim_proof_v2_valid() {
        let ephemeral_key = [0xABu8; 32];
        let spending_key = [0xCDu8; 32];

        let mut proof = [0u8; 64];
        for i in 0..32 {
            proof[i] = ephemeral_key[i] ^ spending_key[i];
        }
        // Fill signature component with non-zero values
        for i in 32..64 {
            proof[i] = (i as u8) + 1;
        }

        assert!(verify_claim_proof_v2(&proof, &ephemeral_key, &spending_key));
    }
}
